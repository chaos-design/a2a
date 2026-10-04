import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import { canonicalJson } from "./canonical-json.js";
import { A2AError, ErrorCode } from "./errors.js";
import {
  ENCRYPTION_ALGORITHM,
  PROTOCOL_VERSION,
  SIGNATURE_ALGORITHM,
  type A2AMessage,
  type Challenge,
  type EncryptedPayload,
  type EncryptionIdentity,
  type JsonValue,
  type MessageInput,
  type SigningIdentity,
  type UnsignedMessage,
} from "./types.js";

function encode(value: string | Uint8Array): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("base64url");
}

function signingMaterial<T>(message: UnsignedMessage<T>, keyId: string): object {
  return {
    ...message,
    security: {
      keyId,
      algorithm: SIGNATURE_ALGORITHM,
      payloadDigest: digest(message.payload),
    },
  };
}

export function generateSigningIdentity(
  agentId: string,
  keyId = `sig-${randomUUID()}`,
): SigningIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { agentId, keyId, publicKey, privateKey };
}

export function generateEncryptionIdentity(
  keyId = `enc-${randomUUID()}`,
): EncryptionIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return { keyId, publicKey, privateKey };
}

export function exportPublicKeyPem(publicKey: KeyObject): string {
  return publicKey.export({ type: "spki", format: "pem" }).toString();
}

export function exportPrivateKeyPem(privateKey: KeyObject): string {
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

export function createUnsignedMessage<T>(
  identity: Pick<SigningIdentity, "agentId">,
  input: MessageInput<T>,
): UnsignedMessage<T> {
  const message: UnsignedMessage<T> = {
    protocol: PROTOCOL_VERSION,
    id: randomUUID(),
    kind: input.kind,
    sender: identity.agentId,
    recipient: input.recipient,
    createdAt: new Date().toISOString(),
    ttlMs: input.ttlMs ?? 30_000,
    sequence: input.sequence ?? 0,
    contentType: input.contentType ?? "application/json",
    payload: input.payload,
  };

  if (input.conversationId !== undefined) {
    message.conversationId = input.conversationId;
  }
  if (input.correlationId !== undefined) {
    message.correlationId = input.correlationId;
  }
  if (input.causationId !== undefined) {
    message.causationId = input.causationId;
  }
  if (input.idempotencyKey !== undefined) {
    message.idempotencyKey = input.idempotencyKey;
  }
  if (input.requiredScopes !== undefined) {
    message.requiredScopes = [...input.requiredScopes];
  }
  if (input.trace !== undefined) {
    message.trace = { ...input.trace };
  }
  if (input.extensions !== undefined) {
    message.extensions = { ...input.extensions };
  }
  return message;
}

export function signMessage<T>(
  message: UnsignedMessage<T>,
  identity: SigningIdentity,
): A2AMessage<T> {
  if (message.sender !== identity.agentId) {
    throw new A2AError(
      ErrorCode.InvalidMessage,
      "The signing identity does not match message.sender",
      { status: 400 },
    );
  }

  const material = signingMaterial(message, identity.keyId);
  const signature = sign(
    null,
    encode(canonicalJson(material)),
    identity.privateKey,
  ).toString("base64url");

  return {
    ...message,
    security: {
      ...(material as { security: Omit<A2AMessage["security"], "signature"> })
        .security,
      signature,
    },
  };
}

export function createSignedMessage<T>(
  identity: SigningIdentity,
  input: MessageInput<T>,
): A2AMessage<T> {
  return signMessage(createUnsignedMessage(identity, input), identity);
}

export function verifyMessageSignature(
  message: A2AMessage,
  publicKey: KeyObject,
): boolean {
  const { security, ...unsigned } = message;
  const expectedDigest = digest(message.payload);
  const actualDigest = decodeBase64Url(security.payloadDigest);
  const expectedDigestBytes = decodeBase64Url(expectedDigest);

  if (
    actualDigest.length !== expectedDigestBytes.length ||
    !timingSafeEqual(actualDigest, expectedDigestBytes)
  ) {
    return false;
  }

  const material = signingMaterial(unsigned, security.keyId);
  return verify(
    null,
    encode(canonicalJson(material)),
    publicKey,
    decodeBase64Url(security.signature),
  );
}

export function challengeProofMaterial(challenge: Challenge): string {
  return canonicalJson({
    protocol: PROTOCOL_VERSION,
    purpose: "session-authentication",
    challengeId: challenge.challengeId,
    challenge: challenge.challenge,
    agentId: challenge.agentId,
    audience: challenge.audience,
    keyId: challenge.keyId,
    serverKeyId: challenge.serverKeyId,
    requestedScopes: challenge.requestedScopes,
    expiresAt: challenge.expiresAt,
  });
}

export function signServerChallenge(
  challenge: Omit<Challenge, "serverSignature">,
  identity: SigningIdentity,
): Challenge {
  if (
    challenge.audience !== identity.agentId ||
    challenge.serverKeyId !== identity.keyId
  ) {
    throw new A2AError(
      ErrorCode.AuthenticationFailed,
      "Challenge audience does not match the server signing identity",
      { status: 500 },
    );
  }
  return {
    ...challenge,
    serverSignature: sign(
      null,
      encode(canonicalJson({
        protocol: PROTOCOL_VERSION,
        purpose: "session-authentication",
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        agentId: challenge.agentId,
        audience: challenge.audience,
        keyId: challenge.keyId,
        serverKeyId: challenge.serverKeyId,
        requestedScopes: challenge.requestedScopes,
        expiresAt: challenge.expiresAt,
      })),
      identity.privateKey,
    ).toString("base64url"),
  };
}

export function verifyServerChallengeSignature(
  challenge: Challenge,
  publicKey: KeyObject,
): boolean {
  return verify(
    null,
    encode(challengeProofMaterial(challenge)),
    publicKey,
    decodeBase64Url(challenge.serverSignature),
  );
}

export function signChallenge(
  challenge: Challenge,
  identity: SigningIdentity,
): string {
  if (
    challenge.agentId !== identity.agentId ||
    challenge.keyId !== identity.keyId
  ) {
    throw new A2AError(
      ErrorCode.AuthenticationFailed,
      "Challenge identity does not match the signing identity",
      { status: 401 },
    );
  }
  return sign(
    null,
    encode(challengeProofMaterial(challenge)),
    identity.privateKey,
  ).toString("base64url");
}

export function verifyChallengeSignature(
  challenge: Challenge,
  signature: string,
  publicKey: KeyObject,
): boolean {
  return verify(
    null,
    encode(challengeProofMaterial(challenge)),
    publicKey,
    decodeBase64Url(signature),
  );
}

function deriveEncryptionKey(
  privateKey: KeyObject,
  publicKey: KeyObject,
  recipientKeyId: string,
): Buffer {
  const sharedSecret = diffieHellman({ privateKey, publicKey });
  return Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from("A2A/1.0 payload encryption"),
      Buffer.from(recipientKeyId),
      32,
    ),
  );
}

export function encryptJson(
  payload: JsonValue,
  recipientPublicKey: KeyObject,
  recipientKeyId: string,
  associatedData = "",
): EncryptedPayload {
  const ephemeral = generateKeyPairSync("x25519");
  const key = deriveEncryptionKey(
    ephemeral.privateKey,
    recipientPublicKey,
    recipientKeyId,
  );
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([
    cipher.update(canonicalJson(payload), "utf8"),
    cipher.final(),
  ]);

  return {
    encrypted: true,
    algorithm: ENCRYPTION_ALGORITHM,
    recipientKeyId,
    ephemeralPublicKey: ephemeral.publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64url"),
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
  };
}

export function decryptJson(
  payload: EncryptedPayload,
  recipient: EncryptionIdentity,
  associatedData = "",
): JsonValue {
  if (
    payload.algorithm !== ENCRYPTION_ALGORITHM ||
    payload.recipientKeyId !== recipient.keyId
  ) {
    throw new A2AError(
      ErrorCode.AuthenticationFailed,
      "Encrypted payload metadata does not match the recipient",
      { status: 400 },
    );
  }

  try {
    const ephemeralPublicKey = createPublicKey({
      key: decodeBase64Url(payload.ephemeralPublicKey),
      type: "spki",
      format: "der",
    });
    const key = deriveEncryptionKey(
      recipient.privateKey,
      ephemeralPublicKey,
      recipient.keyId,
    );
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      decodeBase64Url(payload.iv),
    );
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(decodeBase64Url(payload.authTag));
    const plaintext = Buffer.concat([
      decipher.update(decodeBase64Url(payload.ciphertext)),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as JsonValue;
  } catch (error) {
    throw new A2AError(
      ErrorCode.AuthenticationFailed,
      "Encrypted payload authentication failed",
      { status: 400, cause: error },
    );
  }
}
