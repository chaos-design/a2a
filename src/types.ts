import type { KeyObject } from "node:crypto";

export const PROTOCOL_VERSION = "1.0" as const;
export const SIGNATURE_ALGORITHM = "Ed25519" as const;
export const ENCRYPTION_ALGORITHM = "X25519-HKDF-SHA256+A256GCM" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MessageKind =
  | "request"
  | "response"
  | "command"
  | "event"
  | "ack"
  | "error"
  | "state-delta"
  | "state-snapshot"
  | `x-${string}`;

export interface TraceContext {
  traceId: string;
  spanId: string;
  traceFlags?: string;
  traceState?: string;
}

export interface MessageSecurity {
  keyId: string;
  algorithm: typeof SIGNATURE_ALGORITHM;
  payloadDigest: string;
  signature: string;
}

export interface A2AMessage<T = JsonValue> {
  protocol: typeof PROTOCOL_VERSION;
  id: string;
  kind: MessageKind;
  sender: string;
  recipient: string;
  createdAt: string;
  ttlMs: number;
  sequence: number;
  contentType: string;
  payload: T;
  conversationId?: string;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  requiredScopes?: string[];
  trace?: TraceContext;
  extensions?: Record<`x-${string}`, JsonValue>;
  security: MessageSecurity;
}

export type UnsignedMessage<T = JsonValue> = Omit<
  A2AMessage<T>,
  "security"
>;

export interface MessageInput<T = JsonValue> {
  kind: MessageKind;
  recipient: string;
  payload: T;
  contentType?: string;
  ttlMs?: number;
  sequence?: number;
  conversationId?: string;
  correlationId?: string;
  causationId?: string;
  idempotencyKey?: string;
  requiredScopes?: string[];
  trace?: TraceContext;
  extensions?: Record<`x-${string}`, JsonValue>;
}

export interface SigningIdentity {
  agentId: string;
  keyId: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export interface EncryptionIdentity {
  keyId: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export interface PublicKeyDescriptor {
  keyId: string;
  algorithm: typeof SIGNATURE_ALGORITHM;
  publicKeyPem: string;
  status: "active" | "retiring" | "revoked";
}

export interface CapabilityDescriptor {
  name: string;
  description?: string;
  messageKinds: MessageKind[];
  requiredScopes: string[];
  inputSchema?: JsonValue;
  outputSchema?: JsonValue;
}

export interface AgentCard {
  agentId: string;
  name: string;
  description?: string;
  protocolVersions: string[];
  endpoint: string;
  transports: Array<"https" | "http" | "in-memory">;
  contentTypes: string[];
  authentication: {
    scheme: "A2A-Challenge";
    proofAlgorithm: typeof SIGNATURE_ALGORITHM;
    sessionTokenLocation: "Authorization";
  };
  publicKeys: PublicKeyDescriptor[];
  capabilities: CapabilityDescriptor[];
  limits: {
    maxMessageBytes: number;
    maxTtlMs: number;
  };
  extensions?: Record<`x-${string}`, JsonValue>;
}

export interface ChallengeRequest {
  agentId: string;
  keyId: string;
  requestedScopes: string[];
}

export interface Challenge {
  challengeId: string;
  challenge: string;
  agentId: string;
  audience: string;
  keyId: string;
  serverKeyId: string;
  requestedScopes: string[];
  expiresAt: string;
  serverSignature: string;
}

export interface ChallengeVerification {
  challengeId: string;
  signature: string;
}

export interface SessionGrant {
  token: string;
  tokenType: "Bearer";
  agentId: string;
  scopes: string[];
  expiresAt: string;
}

export interface SessionPrincipal {
  agentId: string;
  keyId: string;
  scopes: ReadonlySet<string>;
  expiresAt: number;
}

export type AckStatus = "accepted" | "completed" | "rejected" | "duplicate";

export type AckPayload = {
  messageId: string;
  status: AckStatus;
  code?: string;
  detail?: string;
};

export type ErrorPayload = {
  code: string;
  message: string;
  retriable: boolean;
  details?: JsonValue;
};

export interface HandlerResult<T = JsonValue> {
  payload: T;
  kind?: MessageKind;
  contentType?: string;
  extensions?: Record<`x-${string}`, JsonValue>;
}

export interface HandlerContext {
  principal: SessionPrincipal;
  message: A2AMessage;
  receivedAt: string;
}

export type MessageHandler = (
  context: HandlerContext,
) => Promise<HandlerResult | void> | HandlerResult | void;

export interface DeliveryBundle {
  ack: A2AMessage<AckPayload>;
  messages: A2AMessage[];
}

export interface ClientTransport {
  discover(): Promise<AgentCard>;
  requestChallenge(request: ChallengeRequest): Promise<Challenge>;
  verifyChallenge(
    verification: ChallengeVerification,
  ): Promise<SessionGrant>;
  send(message: A2AMessage, bearerToken: string): Promise<DeliveryBundle>;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
  jitterRatio: number;
}

export interface SendOptions {
  retryPolicy?: Partial<RetryPolicy>;
  signal?: AbortSignal;
}

export interface PeerRegistration {
  agentId: string;
  keyId: string;
  publicKey: KeyObject | string;
  grantedScopes: string[];
  status?: "active" | "revoked";
}

export type EncryptedPayload = {
  encrypted: true;
  algorithm: typeof ENCRYPTION_ALGORITHM;
  recipientKeyId: string;
  ephemeralPublicKey: string;
  iv: string;
  ciphertext: string;
  authTag: string;
};

export type VectorClock = Record<string, number>;

export type StateEntry = {
  key: string;
  value: JsonValue;
  clock: VectorClock;
  updatedAt: string;
  updatedBy: string;
  tombstone?: boolean;
};

export type StateDelta = {
  namespace: string;
  baseClock: VectorClock;
  clock: VectorClock;
  changes: StateEntry[];
};

export type StateSnapshot = {
  namespace: string;
  clock: VectorClock;
  entries: StateEntry[];
};
