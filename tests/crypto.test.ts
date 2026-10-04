import assert from "node:assert/strict";
import test from "node:test";
import {
  A2AError,
  ErrorCode,
  assertAgentCard,
  assertValidMessage,
  canonicalJson,
  createSignedMessage,
  decryptJson,
  encryptJson,
  generateEncryptionIdentity,
  generateSigningIdentity,
  verifyMessageSignature,
  type AgentCard,
} from "../src/index.js";

test("canonical JSON is stable across object key order", () => {
  assert.equal(
    canonicalJson({ z: 1, nested: { b: true, a: null }, a: "value" }),
    canonicalJson({ a: "value", nested: { a: null, b: true }, z: 1 }),
  );
});

test("Ed25519 signatures detect envelope and payload tampering", () => {
  const identity = generateSigningIdentity("agent://sender");
  const message = createSignedMessage(identity, {
    kind: "request",
    recipient: "agent://receiver",
    payload: { task: "summarize", priority: 2 },
  });

  assert.equal(verifyMessageSignature(message, identity.publicKey), true);
  assert.equal(
    verifyMessageSignature(
      { ...message, recipient: "agent://attacker" },
      identity.publicKey,
    ),
    false,
  );
  assert.equal(
    verifyMessageSignature(
      { ...message, payload: { task: "delete", priority: 2 } },
      identity.publicKey,
    ),
    false,
  );
});

test("wire validation rejects undeclared fields and unnamespaced kinds", () => {
  const identity = generateSigningIdentity("agent://sender");
  const message = createSignedMessage(identity, {
    kind: "request",
    recipient: "agent://receiver",
    payload: {},
  });

  assert.throws(
    () => assertValidMessage({ ...message, unexpected: true }),
    (error: unknown) =>
      error instanceof A2AError && error.code === ErrorCode.InvalidMessage,
  );
  assert.throws(
    () => assertValidMessage({ ...message, kind: "custom" }),
    (error: unknown) =>
      error instanceof A2AError && error.code === ErrorCode.InvalidMessage,
  );
  assert.doesNotThrow(() =>
    assertValidMessage({ ...message, kind: "x-custom" }),
  );
});

test("agent card validation rejects malformed capabilities and transports", () => {
  const base: AgentCard = {
    agentId: "agent://coordinator",
    name: "Coordinator",
    protocolVersions: ["1.0"],
    endpoint: "http://127.0.0.1:4310",
    transports: ["http"],
    contentTypes: ["application/json"],
    authentication: {
      scheme: "A2A-Challenge",
      proofAlgorithm: "Ed25519",
      sessionTokenLocation: "Authorization",
    },
    publicKeys: [
      {
        keyId: "sig-1",
        algorithm: "Ed25519",
        publicKeyPem: "-----BEGIN PUBLIC KEY-----\n",
        status: "active",
      },
    ],
    capabilities: [],
    limits: { maxMessageBytes: 1024, maxTtlMs: 300_000 },
  };

  assert.doesNotThrow(() =>
    assertAgentCard({
      ...base,
      capabilities: [
        {
          name: "summarize",
          messageKinds: ["request", "x-custom"],
          requiredScopes: ["tasks:execute"],
          inputSchema: { type: "object" },
        },
      ],
    }),
  );

  const invalid: Array<[string, unknown]> = [
    ["non-object capability", [{ name: "x" }, "not-an-object"]],
    [
      "non-string capability name",
      [{ name: 42, messageKinds: ["request"], requiredScopes: [] }],
    ],
    [
      "empty messageKinds",
      [{ name: "x", messageKinds: [], requiredScopes: [] }],
    ],
    [
      "unnamespaced messageKinds",
      [{ name: "x", messageKinds: ["custom"], requiredScopes: [] }],
    ],
    [
      "non-array requiredScopes",
      [{ name: "x", messageKinds: ["request"], requiredScopes: null }],
    ],
    [
      "undeclared capability field",
      [
        {
          name: "x",
          messageKinds: ["request"],
          requiredScopes: [],
          surprise: true,
        },
      ],
    ],
  ];

  for (const [label, capabilities] of invalid) {
    assert.throws(
      () => assertAgentCard({ ...base, capabilities }),
      (error: unknown) =>
        error instanceof A2AError && error.code === ErrorCode.InvalidMessage,
      `expected rejection: ${label}`,
    );
  }

  assert.throws(
    () => assertAgentCard({ ...base, transports: ["carrier-pigeon"] }),
    (error: unknown) =>
      error instanceof A2AError && error.code === ErrorCode.InvalidMessage,
  );
  assert.throws(
    () => assertAgentCard({ ...base, transports: [] }),
    (error: unknown) =>
      error instanceof A2AError && error.code === ErrorCode.InvalidMessage,
  );
});

test("X25519 encryption authenticates ciphertext and associated data", () => {
  const receiver = generateEncryptionIdentity("receiver-key");
  const encrypted = encryptJson(
    { secret: "confidential" },
    receiver.publicKey,
    receiver.keyId,
    "message-123",
  );

  assert.deepEqual(
    decryptJson(encrypted, receiver, "message-123"),
    { secret: "confidential" },
  );
  assert.throws(
    () => decryptJson(encrypted, receiver, "another-message"),
    (error: unknown) =>
      error instanceof A2AError &&
      error.message === "Encrypted payload authentication failed",
  );
});
