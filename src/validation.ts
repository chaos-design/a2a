import { canonicalJson, isJsonValue } from "./canonical-json.js";
import { A2AError, ErrorCode } from "./errors.js";
import {
  PROTOCOL_VERSION,
  SIGNATURE_ALGORITHM,
  type A2AMessage,
  type AgentCard,
  type Challenge,
  type ChallengeRequest,
  type ChallengeVerification,
  type SessionGrant,
} from "./types.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const CONTENT_TYPE_PATTERN =
  /^[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*(?:\s*;.*)?$/i;
const MESSAGE_FIELDS = new Set([
  "protocol",
  "id",
  "kind",
  "sender",
  "recipient",
  "createdAt",
  "ttlMs",
  "sequence",
  "contentType",
  "payload",
  "conversationId",
  "correlationId",
  "causationId",
  "idempotencyKey",
  "requiredScopes",
  "trace",
  "extensions",
  "security",
]);
const BUILT_IN_KINDS = new Set([
  "request",
  "response",
  "command",
  "event",
  "ack",
  "error",
  "state-delta",
  "state-snapshot",
]);
const KNOWN_TRANSPORTS = new Set(["http", "https", "in-memory"]);
const CAPABILITY_FIELDS = new Set([
  "name",
  "description",
  "messageKinds",
  "requiredScopes",
  "inputSchema",
  "outputSchema",
]);

function fail(message: string): never {
  throw new A2AError(ErrorCode.InvalidMessage, message, { status: 400 });
}

function assertRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  name: string,
  allowed: ReadonlySet<string>,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    fail(`${name} contains unsupported fields: ${unexpected.join(", ")}`);
  }
}

function assertString(
  value: unknown,
  name: string,
  maxLength = 1024,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength
  ) {
    fail(`${name} must be a non-empty string up to ${maxLength} characters`);
  }
}

function assertIdentifier(value: unknown, name: string): asserts value is string {
  assertString(value, name, 255);
  if (!ID_PATTERN.test(value)) {
    fail(`${name} contains unsupported characters`);
  }
}

function assertStringArray(
  value: unknown,
  name: string,
  maximum = 100,
): asserts value is string[] {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some(
      (item) =>
        typeof item !== "string" || item.length === 0 || item.length > 255,
    )
  ) {
    fail(`${name} must be an array of at most ${maximum} strings`);
  }
}

function assertMessageKind(value: unknown, name: string): asserts value is string {
  assertIdentifier(value, name);
  if (!BUILT_IN_KINDS.has(value) && !value.startsWith("x-")) {
    fail(`${name} must be a built-in kind or begin with x-`);
  }
}

function assertJson(value: unknown, name: string): void {
  if (!isJsonValue(value)) {
    fail(`${name} must be valid JSON`);
  }
}

function validateCapability(value: unknown, name: string): void {
  assertRecord(value, name);
  assertOnlyKeys(value, name, CAPABILITY_FIELDS);
  assertString(value.name, `${name}.name`, 255);
  if (value.description !== undefined) {
    assertString(value.description, `${name}.description`, 1024);
  }
  if (!Array.isArray(value.messageKinds) || value.messageKinds.length === 0) {
    fail(`${name}.messageKinds must be a non-empty array`);
  }
  if (value.messageKinds.length > 50) {
    fail(`${name}.messageKinds must contain at most 50 kinds`);
  }
  for (const kind of value.messageKinds) {
    assertMessageKind(kind, `${name}.messageKinds[]`);
  }
  assertStringArray(value.requiredScopes, `${name}.requiredScopes`);
  if (value.inputSchema !== undefined) {
    assertJson(value.inputSchema, `${name}.inputSchema`);
  }
  if (value.outputSchema !== undefined) {
    assertJson(value.outputSchema, `${name}.outputSchema`);
  }
}

function validateTrace(value: unknown): void {
  assertRecord(value, "trace");
  assertOnlyKeys(
    value,
    "trace",
    new Set(["traceId", "spanId", "traceFlags", "traceState"]),
  );
  assertString(value.traceId, "trace.traceId", 64);
  assertString(value.spanId, "trace.spanId", 32);
  if (value.traceFlags !== undefined) {
    assertString(value.traceFlags, "trace.traceFlags", 8);
  }
  if (value.traceState !== undefined) {
    assertString(value.traceState, "trace.traceState", 512);
  }
}

function validateExtensions(value: unknown): void {
  assertRecord(value, "extensions");
  for (const [key, extension] of Object.entries(value)) {
    if (!key.startsWith("x-") || key.length > 128) {
      fail("Extension keys must begin with x- and be at most 128 characters");
    }
    assertJson(extension, `Extension ${key}`);
  }
}

export interface MessageValidationOptions {
  maxTtlMs?: number;
  maxMessageBytes?: number;
}

function validateMessageBody(
  value: Record<string, unknown>,
  options: MessageValidationOptions,
): void {
  assertString(value.createdAt, "createdAt", 64);
  const createdAt = Date.parse(value.createdAt);
  if (!Number.isFinite(createdAt)) {
    fail("createdAt must be an ISO-8601 timestamp");
  }

  const maxTtlMs = options.maxTtlMs ?? 300_000;
  if (
    !Number.isSafeInteger(value.ttlMs) ||
    (value.ttlMs as number) <= 0 ||
    (value.ttlMs as number) > maxTtlMs
  ) {
    fail(`ttlMs must be an integer from 1 to ${maxTtlMs}`);
  }
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 0) {
    fail("sequence must be a non-negative safe integer");
  }

  assertString(value.contentType, "contentType", 255);
  if (!CONTENT_TYPE_PATTERN.test(value.contentType)) {
    fail("contentType is invalid");
  }
  assertJson(value.payload, "payload");

  for (const field of [
    "conversationId",
    "correlationId",
    "causationId",
    "idempotencyKey",
  ] as const) {
    if (value[field] !== undefined) {
      assertIdentifier(value[field], field);
    }
  }

  if (value.requiredScopes !== undefined) {
    assertStringArray(value.requiredScopes, "requiredScopes");
    if (new Set(value.requiredScopes).size !== value.requiredScopes.length) {
      fail("requiredScopes cannot contain duplicates");
    }
  }
  if (value.trace !== undefined) {
    validateTrace(value.trace);
  }
  if (value.extensions !== undefined) {
    validateExtensions(value.extensions);
  }

  assertRecord(value.security, "security");
  assertOnlyKeys(
    value.security,
    "security",
    new Set(["keyId", "algorithm", "payloadDigest", "signature"]),
  );
  assertIdentifier(value.security.keyId, "security.keyId");
  if (value.security.algorithm !== SIGNATURE_ALGORITHM) {
    fail(`security.algorithm must be ${SIGNATURE_ALGORITHM}`);
  }
  for (const field of ["payloadDigest", "signature"] as const) {
    assertString(value.security[field], `security.${field}`, 1024);
    if (!BASE64URL_PATTERN.test(value.security[field])) {
      fail(`security.${field} must be unpadded base64url`);
    }
  }

  const maxMessageBytes = options.maxMessageBytes ?? 1_048_576;
  if (Buffer.byteLength(canonicalJson(value), "utf8") > maxMessageBytes) {
    throw new A2AError(
      ErrorCode.PayloadTooLarge,
      `Message exceeds the ${maxMessageBytes} byte limit`,
      { status: 413 },
    );
  }
}

export function assertValidMessage(
  value: unknown,
  options: MessageValidationOptions = {},
): asserts value is A2AMessage {
  assertRecord(value, "message");
  assertOnlyKeys(value, "message", MESSAGE_FIELDS);
  if (value.protocol !== PROTOCOL_VERSION) {
    throw new A2AError(
      ErrorCode.UnsupportedVersion,
      `Protocol version must be ${PROTOCOL_VERSION}`,
      { status: 400 },
    );
  }
  assertIdentifier(value.id, "id");
  assertMessageKind(value.kind, "kind");
  assertIdentifier(value.sender, "sender");
  if (value.recipient !== "*") {
    assertIdentifier(value.recipient, "recipient");
  }
  validateMessageBody(value, options);
}

export function assertChallengeRequest(
  value: unknown,
): asserts value is ChallengeRequest {
  assertRecord(value, "challenge request");
  assertOnlyKeys(
    value,
    "challenge request",
    new Set(["agentId", "keyId", "requestedScopes"]),
  );
  assertIdentifier(value.agentId, "agentId");
  assertIdentifier(value.keyId, "keyId");
  assertStringArray(value.requestedScopes, "requestedScopes");
}

export function assertChallengeVerification(
  value: unknown,
): asserts value is ChallengeVerification {
  assertRecord(value, "challenge verification");
  assertOnlyKeys(
    value,
    "challenge verification",
    new Set(["challengeId", "signature"]),
  );
  assertIdentifier(value.challengeId, "challengeId");
  assertString(value.signature, "signature", 1024);
  if (!BASE64URL_PATTERN.test(value.signature)) {
    fail("signature must be unpadded base64url");
  }
}

export function assertAgentCard(value: unknown): asserts value is AgentCard {
  assertRecord(value, "agent card");
  assertIdentifier(value.agentId, "agentCard.agentId");
  assertString(value.name, "agentCard.name", 255);
  assertString(value.endpoint, "agentCard.endpoint", 2048);
  assertStringArray(value.protocolVersions, "agentCard.protocolVersions", 20);
  assertStringArray(value.transports, "agentCard.transports", 20);
  if (value.transports.length === 0) {
    fail("agentCard.transports must declare at least one transport");
  }
  if (value.transports.some((item) => !KNOWN_TRANSPORTS.has(item))) {
    fail("agentCard.transports supports only http, https, and in-memory");
  }
  assertStringArray(value.contentTypes, "agentCard.contentTypes", 100);

  assertRecord(value.authentication, "agentCard.authentication");
  if (
    value.authentication.scheme !== "A2A-Challenge" ||
    value.authentication.proofAlgorithm !== SIGNATURE_ALGORITHM ||
    value.authentication.sessionTokenLocation !== "Authorization"
  ) {
    fail("Agent Card authentication metadata is unsupported");
  }

  if (!Array.isArray(value.publicKeys) || value.publicKeys.length === 0) {
    fail("Agent Card must contain at least one public key");
  }
  for (const item of value.publicKeys) {
    assertRecord(item, "agentCard.publicKeys[]");
    assertIdentifier(item.keyId, "agentCard.publicKeys[].keyId");
    assertString(item.publicKeyPem, "agentCard.publicKeys[].publicKeyPem", 8192);
    if (
      item.algorithm !== SIGNATURE_ALGORITHM ||
      !["active", "retiring", "revoked"].includes(item.status as string)
    ) {
      fail("Agent Card contains unsupported key metadata");
    }
  }

  if (!Array.isArray(value.capabilities)) {
    fail("agentCard.capabilities must be an array");
  }
  if (value.capabilities.length > 200) {
    fail("agentCard.capabilities must contain at most 200 entries");
  }
  value.capabilities.forEach((capability, index) => {
    validateCapability(capability, `agentCard.capabilities[${index}]`);
  });
  assertRecord(value.limits, "agentCard.limits");
  if (
    !Number.isSafeInteger(value.limits.maxMessageBytes) ||
    (value.limits.maxMessageBytes as number) <= 0 ||
    !Number.isSafeInteger(value.limits.maxTtlMs) ||
    (value.limits.maxTtlMs as number) <= 0
  ) {
    fail("Agent Card limits must be positive integers");
  }
  if (value.extensions !== undefined) {
    validateExtensions(value.extensions);
  }
}

export function assertChallenge(value: unknown): asserts value is Challenge {
  assertRecord(value, "challenge");
  assertIdentifier(value.challengeId, "challenge.challengeId");
  assertString(value.challenge, "challenge.challenge", 1024);
  assertIdentifier(value.agentId, "challenge.agentId");
  assertIdentifier(value.audience, "challenge.audience");
  assertIdentifier(value.keyId, "challenge.keyId");
  assertIdentifier(value.serverKeyId, "challenge.serverKeyId");
  assertStringArray(value.requestedScopes, "challenge.requestedScopes");
  assertString(value.expiresAt, "challenge.expiresAt", 64);
  if (!Number.isFinite(Date.parse(value.expiresAt))) {
    fail("challenge.expiresAt must be an ISO-8601 timestamp");
  }
  assertString(value.serverSignature, "challenge.serverSignature", 1024);
  if (
    !BASE64URL_PATTERN.test(value.challenge) ||
    !BASE64URL_PATTERN.test(value.serverSignature)
  ) {
    fail("Challenge values must be unpadded base64url");
  }
}

export function assertSessionGrant(
  value: unknown,
): asserts value is SessionGrant {
  assertRecord(value, "session grant");
  assertString(value.token, "sessionGrant.token", 2048);
  if (value.tokenType !== "Bearer") {
    fail("sessionGrant.tokenType must be Bearer");
  }
  assertIdentifier(value.agentId, "sessionGrant.agentId");
  assertStringArray(value.scopes, "sessionGrant.scopes");
  assertString(value.expiresAt, "sessionGrant.expiresAt", 64);
  if (!Number.isFinite(Date.parse(value.expiresAt))) {
    fail("sessionGrant.expiresAt must be an ISO-8601 timestamp");
  }
}
