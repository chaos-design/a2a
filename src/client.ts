import { createPublicKey, type KeyObject } from "node:crypto";
import {
  createSignedMessage,
  signChallenge,
  verifyMessageSignature,
  verifyServerChallengeSignature,
} from "./crypto.js";
import { A2AError, ErrorCode } from "./errors.js";
import { PROTOCOL_VERSION } from "./types.js";
import type {
  A2AMessage,
  AckStatus,
  AgentCard,
  ClientTransport,
  DeliveryBundle,
  JsonValue,
  MessageInput,
  RetryPolicy,
  SendOptions,
  SessionGrant,
  SigningIdentity,
} from "./types.js";
import {
  assertAgentCard,
  assertChallenge,
  assertSessionGrant,
  assertValidMessage,
} from "./validation.js";

const ACK_STATUSES = new Set<string>([
  "accepted",
  "completed",
  "rejected",
  "duplicate",
] satisfies AckStatus[]);

const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 4,
  initialDelayMs: 100,
  maxDelayMs: 2_000,
  backoffFactor: 2,
  jitterRatio: 0.2,
};

export interface A2AClientOptions {
  identity: SigningIdentity;
  transport: ClientTransport;
  requestedScopes?: string[];
  expectedAgentId?: string;
  trustedServerKeys?: Record<string, KeyObject | string>;
  retryPolicy?: Partial<RetryPolicy>;
  sessionRefreshMarginMs?: number;
}

export class A2AClient {
  private readonly identity: SigningIdentity;
  private readonly transport: ClientTransport;
  private readonly requestedScopes: string[];
  private readonly expectedAgentId: string | undefined;
  private readonly configuredServerKeys = new Map<string, KeyObject>();
  private readonly retryPolicy: RetryPolicy;
  private readonly sessionRefreshMarginMs: number;
  private readonly sequenceByConversation = new Map<string, number>();

  private card?: AgentCard;
  private grant: SessionGrant | undefined;
  private serverKeys = new Map<string, KeyObject>();

  constructor(options: A2AClientOptions) {
    this.identity = options.identity;
    this.transport = options.transport;
    this.requestedScopes = [...new Set(options.requestedScopes ?? [])];
    this.expectedAgentId = options.expectedAgentId;
    this.retryPolicy = {
      ...DEFAULT_RETRY_POLICY,
      ...options.retryPolicy,
    };
    this.sessionRefreshMarginMs = options.sessionRefreshMarginMs ?? 5_000;

    for (const [keyId, key] of Object.entries(
      options.trustedServerKeys ?? {},
    )) {
      this.configuredServerKeys.set(
        keyId,
        typeof key === "string" ? createPublicKey(key) : key,
      );
    }
  }

  async connect(): Promise<AgentCard> {
    const card = await this.transport.discover();
    assertAgentCard(card);
    if (
      this.expectedAgentId !== undefined &&
      card.agentId !== this.expectedAgentId
    ) {
      throw new A2AError(
        ErrorCode.AuthenticationFailed,
        `Expected agent ${this.expectedAgentId}, received ${card.agentId}`,
        { status: 401 },
      );
    }
    if (!card.protocolVersions.includes(PROTOCOL_VERSION)) {
      throw new A2AError(
        ErrorCode.UnsupportedVersion,
        `Remote agent does not advertise A2A/${PROTOCOL_VERSION}`,
        { status: 400 },
      );
    }

    const discoveredKeys = new Map<string, KeyObject>();
    for (const descriptor of card.publicKeys) {
      if (descriptor.status !== "revoked") {
        discoveredKeys.set(
          descriptor.keyId,
          createPublicKey(descriptor.publicKeyPem),
        );
      }
    }
    this.serverKeys =
      this.configuredServerKeys.size > 0
        ? new Map(this.configuredServerKeys)
        : discoveredKeys;
    if (this.serverKeys.size === 0) {
      throw new A2AError(
        ErrorCode.UnknownKey,
        "Remote agent has no trusted active signing key",
        { status: 401 },
      );
    }
    this.card = card;
    this.grant = await this.authenticate();
    return structuredClone(card);
  }

  async send<T extends JsonValue>(
    input: MessageInput<T>,
    options: SendOptions = {},
  ): Promise<DeliveryBundle> {
    await this.ensureConnected();
    const conversationId = input.conversationId ?? input.idempotencyKey;
    const sequence =
      input.sequence ??
      (conversationId === undefined
        ? 0
        : this.nextSequence(conversationId));
    const signed = createSignedMessage(this.identity, {
      ...input,
      sequence,
    });
    return this.sendSigned(signed, options);
  }

  async sendSigned(
    message: A2AMessage,
    options: SendOptions = {},
  ): Promise<DeliveryBundle> {
    await this.ensureConnected();
    const policy = { ...this.retryPolicy, ...options.retryPolicy };
    this.assertRetryPolicy(policy);

    let lastError: unknown;
    let refreshedSession = false;
    let attempt = 0;
    while (attempt < policy.maxAttempts) {
      if (options.signal?.aborted) {
        throw options.signal.reason;
      }
      attempt += 1;
      try {
        const grant = await this.ensureSession();
        const bundle = await this.transport.send(
          message,
          grant.token,
          options.signal,
        );
        this.verifyDelivery(message, bundle);
        if (bundle.ack.payload.status === "rejected") {
          const errorMessage = bundle.messages.find(
            (candidate) => candidate.kind === "error",
          );
          const payload = errorMessage?.payload as
            | {
                code?: string;
                message?: string;
                retriable?: boolean;
                details?: JsonValue;
              }
            | undefined;
          throw new A2AError(
            payload?.code ?? bundle.ack.payload.code ?? ErrorCode.HandlerFailed,
            payload?.message ??
              bundle.ack.payload.detail ??
              "Remote handler rejected the message",
            {
              status: 422,
              retriable: payload?.retriable ?? false,
              ...(payload?.details !== undefined
                ? { details: payload.details }
                : {}),
            },
          );
        }
        return bundle;
      } catch (error) {
        lastError = error;
        if (
          error instanceof A2AError &&
          error.status === 401 &&
          !refreshedSession
        ) {
          // Re-authentication is not a delivery attempt, so it must not
          // consume the retry budget. The protocol guarantees exactly one
          // refresh; a second 401 falls through and is surfaced.
          this.grant = undefined;
          this.grant = await this.authenticate();
          refreshedSession = true;
          attempt -= 1;
          continue;
        }
        if (
          attempt >= policy.maxAttempts ||
          !(error instanceof A2AError) ||
          error.status === 422 ||
          !error.retriable
        ) {
          throw error;
        }
        await this.delay(this.retryDelay(attempt, policy), options.signal);
      }
    }
    throw lastError;
  }

  private async ensureConnected(): Promise<void> {
    if (!this.card) {
      await this.connect();
    }
  }

  private async ensureSession(): Promise<SessionGrant> {
    if (
      !this.grant ||
      Date.parse(this.grant.expiresAt) - this.sessionRefreshMarginMs <=
        Date.now()
    ) {
      this.grant = await this.authenticate();
    }
    return this.grant;
  }

  private async authenticate(): Promise<SessionGrant> {
    const challenge = await this.transport.requestChallenge({
      agentId: this.identity.agentId,
      keyId: this.identity.keyId,
      requestedScopes: this.requestedScopes,
    });
    assertChallenge(challenge);
    const expectedScopes = [...this.requestedScopes].sort();
    if (
      challenge.agentId !== this.identity.agentId ||
      challenge.keyId !== this.identity.keyId ||
      (this.card && challenge.audience !== this.card.agentId) ||
      JSON.stringify(challenge.requestedScopes) !==
        JSON.stringify(expectedScopes) ||
      Date.parse(challenge.expiresAt) <= Date.now()
    ) {
      throw new A2AError(
        ErrorCode.AuthenticationFailed,
        "Remote endpoint returned a mismatched challenge",
        { status: 401 },
      );
    }
    const serverKey = this.serverKeys.get(challenge.serverKeyId);
    let serverSignatureValid = false;
    try {
      serverSignatureValid =
        serverKey !== undefined &&
        verifyServerChallengeSignature(challenge, serverKey);
    } catch {
      serverSignatureValid = false;
    }
    if (!serverSignatureValid) {
      throw new A2AError(
        ErrorCode.AuthenticationFailed,
        "Remote challenge signature is invalid",
        { status: 401 },
      );
    }

    const grant = await this.transport.verifyChallenge({
      challengeId: challenge.challengeId,
      signature: signChallenge(challenge, this.identity),
    });
    assertSessionGrant(grant);
    if (
      grant.tokenType !== "Bearer" ||
      typeof grant.token !== "string" ||
      grant.token.length === 0 ||
      grant.agentId !== this.identity.agentId ||
      !Array.isArray(grant.scopes) ||
      grant.scopes.some((scope) => !this.requestedScopes.includes(scope)) ||
      Date.parse(grant.expiresAt) <= Date.now()
    ) {
      throw new A2AError(
        ErrorCode.AuthenticationFailed,
        "Remote endpoint returned an invalid session grant",
        { status: 401 },
      );
    }
    return grant;
  }

  private verifyDelivery(
    sent: A2AMessage,
    bundle: DeliveryBundle,
  ): void {
    this.assertDeliveryShape(bundle);
    const allMessages: A2AMessage[] = [bundle.ack, ...bundle.messages];
    for (const message of allMessages) {
      const limits = this.card
        ? {
            maxMessageBytes: this.card.limits.maxMessageBytes,
            maxTtlMs: this.card.limits.maxTtlMs,
          }
        : {};
      assertValidMessage(message, limits);
      if (
        message.sender !== this.card?.agentId ||
        message.recipient !== this.identity.agentId ||
        message.correlationId !== sent.id
      ) {
        throw new A2AError(
          ErrorCode.AuthenticationFailed,
          "Remote response identity or correlation is invalid",
          { status: 502 },
        );
      }
      const key = this.serverKeys.get(message.security.keyId);
      if (!key || !verifyMessageSignature(message, key)) {
        throw new A2AError(
          ErrorCode.InvalidSignature,
          "Remote response signature verification failed",
          { status: 502 },
        );
      }
    }
    if (
      bundle.ack.kind !== "ack" ||
      bundle.ack.payload.messageId !== sent.id
    ) {
      throw new A2AError(
        ErrorCode.InvalidMessage,
        "Delivery acknowledgement does not match the sent message",
        { status: 502 },
      );
    }
  }

  /**
   * `DeliveryBundle` is untrusted remote input. The acknowledgement payload
   * is read as a typed object by both `verifyDelivery` and the retry loop, so
   * a malformed envelope must fail with a protocol error instead of a
   * `TypeError` from property access on `null`.
   */
  private assertDeliveryShape(bundle: DeliveryBundle): void {
    const invalid = new A2AError(
      ErrorCode.InvalidMessage,
      "Delivery bundle is malformed",
      { status: 502 },
    );
    if (
      bundle === null ||
      typeof bundle !== "object" ||
      !Array.isArray(bundle.messages)
    ) {
      throw invalid;
    }
    const payload = bundle.ack?.payload;
    if (
      payload === null ||
      typeof payload !== "object" ||
      typeof payload.messageId !== "string" ||
      typeof payload.status !== "string" ||
      !ACK_STATUSES.has(payload.status)
    ) {
      throw invalid;
    }
  }

  private nextSequence(conversationId: string): number {
    const next = (this.sequenceByConversation.get(conversationId) ?? -1) + 1;
    this.sequenceByConversation.set(conversationId, next);
    return next;
  }

  private retryDelay(attempt: number, policy: RetryPolicy): number {
    const base = Math.min(
      policy.maxDelayMs,
      policy.initialDelayMs * policy.backoffFactor ** (attempt - 1),
    );
    const jitter = base * policy.jitterRatio * (Math.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }

  private async delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const complete = (): void => {
        if (signal) {
          signal.removeEventListener("abort", abort);
        }
        resolve();
      };
      const timer = setTimeout(complete, milliseconds);
      const abort = (): void => {
        clearTimeout(timer);
        reject(signal?.reason);
      };
      if (signal) {
        signal.addEventListener("abort", abort, { once: true });
      }
    });
  }

  private assertRetryPolicy(policy: RetryPolicy): void {
    if (
      !Number.isInteger(policy.maxAttempts) ||
      policy.maxAttempts < 1 ||
      policy.initialDelayMs < 0 ||
      policy.maxDelayMs < policy.initialDelayMs ||
      policy.backoffFactor < 1 ||
      policy.jitterRatio < 0 ||
      policy.jitterRatio > 1
    ) {
      throw new A2AError(
        ErrorCode.InvalidMessage,
        "Retry policy is invalid",
        { status: 400 },
      );
    }
  }
}
