import assert from "node:assert/strict";
import test from "node:test";
import {
  A2AError,
  ErrorCode,
  assertValidMessage,
  canonicalJson,
  createSignedMessage,
  decryptJson,
  encryptJson,
  generateEncryptionIdentity,
  generateSigningIdentity,
  verifyMessageSignature,
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
