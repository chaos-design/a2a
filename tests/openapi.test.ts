import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { load as loadYaml } from "js-yaml";
import {
  ReplicatedState,
  assertValidMessage,
  createSignedMessage,
  generateSigningIdentity,
  type StateDelta,
  type StateEntry,
  type StateSnapshot,
  type StateSyncResult,
  type VectorClock,
} from "../src/index.js";

// Guards openapi.yaml against drifting from what the implementation enforces.
// It treats the published spec as a machine-readable contract: messages the
// implementation emits must pass it, and messages the wire validator rejects
// must not pass it either.

interface OpenApiDocument {
  components: {
    schemas: Record<string, unknown>;
  };
}

const specPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "openapi.yaml",
);
const document = loadYaml(readFileSync(specPath, "utf8")) as OpenApiDocument;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({
  $id: "https://a2a.local/spec.json",
  components: document.components,
});

function validateAgainst(name: string, data: unknown): boolean {
  return ajv.validate(
    `https://a2a.local/spec.json#/components/schemas/${name}`,
    data,
  );
}

const identity = generateSigningIdentity("agent://spec-checker");

test("state-sync schemas accept what ReplicatedState actually emits", () => {
  const state = new ReplicatedState("agent://alpha", "workflow");
  state.set("step", 1, new Date("2026-10-06T00:00:00.000Z"));
  state.set("note", "hello", new Date("2026-10-06T00:00:00.000Z"));
  state.delete("note", new Date("2026-10-06T00:01:00.000Z"));

  const delta: StateDelta = state.createDelta({});
  const snapshot: StateSnapshot = state.snapshot();

  assert.equal(validateAgainst("StateDelta", delta), true);
  assert.equal(validateAgainst("StateSnapshot", snapshot), true);

  const result: StateSyncResult = {
    namespace: state.namespace,
    clock: snapshot.clock,
    applied: 2,
    delta,
  };
  assert.equal(validateAgainst("StateSyncResult", result), true);
});

test("state-sync schemas reject malformed payloads", () => {
  const clock: VectorClock = { "agent://alpha": 2 };
  const entry: StateEntry = {
    key: "k",
    value: { a: 1 },
    clock,
    updatedAt: "2026-10-06T00:00:00.000Z",
    updatedBy: "agent://alpha",
  };
  const delta: StateDelta = {
    namespace: "wf",
    baseClock: {},
    clock,
    changes: [entry],
  };

  const malformed: Array<[string, string, unknown]> = [
    ["StateEntry", "tombstone not boolean", { ...entry, tombstone: "yes" }],
    ["StateEntry", "bad updatedAt", { ...entry, updatedAt: "not-a-date" }],
    ["StateEntry", "negative counter", { ...entry, clock: { "agent://x": -1 } }],
    ["StateDelta", "changes not array", { ...delta, changes: {} }],
    [
      "StateSyncResult",
      "negative applied",
      { namespace: "wf", clock, applied: -1 },
    ],
    ["VectorClock", "empty agent id", { "": 1 }],
    ["StateDelta", "undeclared field", { ...delta, extra: 1 }],
  ];

  for (const [schema, label, data] of malformed) {
    assert.equal(
      validateAgainst(schema, data),
      false,
      `${schema} accepted a malformed payload: ${label}`,
    );
  }
});

test("Message.kind in the spec agrees with the wire validator", () => {
  // Every candidate must be accepted or rejected identically by both.
  const kinds = [
    "request",
    "response",
    "command",
    "event",
    "ack",
    "error",
    "state-delta",
    "state-snapshot",
    "x-custom",
    "custom",
    "billing-charge",
  ];

  for (const kind of kinds) {
    const message = createSignedMessage(identity, {
      kind: kind as never,
      recipient: "agent://peer",
      payload: {},
    });
    let implementationAccepts = true;
    try {
      assertValidMessage(message);
    } catch {
      implementationAccepts = false;
    }
    const specAccepts = validateAgainst("Message", message);
    assert.equal(
      specAccepts,
      implementationAccepts,
      `kind=${JSON.stringify(kind)}: spec and implementation disagree`,
    );
  }
});

test("Message.ttlMs has no hardcoded ceiling but keeps its floor", () => {
  // The real ceiling is the receiving agent's advertised limits.maxTtlMs, so
  // the spec must not pin the default value.
  for (const ttlMs of [30_000, 300_000, 600_000]) {
    const message = createSignedMessage(identity, {
      kind: "request",
      recipient: "agent://peer",
      ttlMs,
      payload: {},
    });
    assert.equal(
      validateAgainst("Message", message),
      true,
      `ttlMs=${ttlMs} should pass the spec`,
    );
  }

  const tooShort = createSignedMessage(identity, {
    kind: "request",
    recipient: "agent://peer",
    ttlMs: 1,
    payload: {},
  });
  const invalid = { ...tooShort, ttlMs: 0 };
  assert.equal(validateAgainst("Message", invalid), false);
});

test("every $ref in the spec resolves to a defined schema", () => {
  const source = readFileSync(specPath, "utf8");
  const refs = new Set(
    [...source.matchAll(/\$ref: "#\/components\/schemas\/([A-Za-z0-9]+)"/g)].map(
      (match) => match[1] as string,
    ),
  );
  const defined = new Set(Object.keys(document.components.schemas));
  const missing = [...refs].filter((name) => !defined.has(name));
  assert.deepEqual(missing, []);
});
