import {
  PeerRegistry,
  SessionManager,
  requireScopes,
  type SessionManagerOptions,
} from "./auth.js";
import {
  createSignedMessage,
  exportPublicKeyPem,
  verifyMessageSignature,
} from "./crypto.js";
import { A2AError, ErrorCode, asA2AError } from "./errors.js";
import type {
  A2AMessage,
  AckPayload,
  AgentCard,
  CapabilityDescriptor,
  Challenge,
  ChallengeRequest,
  ChallengeVerification,
  DeliveryBundle,
  ErrorPayload,
  HandlerResult,
  JsonValue,
  MessageHandler,
  MessageKind,
  SessionGrant,
  SigningIdentity,
} from "./types.js";
import { assertValidMessage } from "./validation.js";
import { PROTOCOL_VERSION } from "./types.js";

interface HandlerRegistration {
  handler: MessageHandler;
  requiredScopes: string[];
}

interface CachedDelivery {
  bundle: DeliveryBundle;
  expiresAt: number;
}

export interface A2ANodeOptions {
  identity: SigningIdentity;
  peers: PeerRegistry;
  name: string;
  endpoint: string;
  description?: string;
  capabilities?: CapabilityDescriptor[];
  transports?: AgentCard["transports"];
  contentTypes?: string[];
  maxMessageBytes?: number;
  maxTtlMs?: number;
  allowedClockSkewMs?: number;
  /** Upper bound on cached delivery bundles retained for deduplication. */
  maxProcessedMessages?: number;
  /** Upper bound on conversations tracked for per-conversation sequencing. */
  maxTrackedConversations?: number;
  extensions?: AgentCard["extensions"];
  session?: SessionManagerOptions;
  now?: () => number;
}

export interface RegisterHandlerOptions {
  requiredScopes?: string[];
}

export class A2ANode {
  readonly identity: SigningIdentity;
  readonly peers: PeerRegistry;
  readonly sessions: SessionManager;

  private readonly handlers = new Map<MessageKind, HandlerRegistration>();
  private readonly processed = new Map<string, CachedDelivery>();
  private readonly sequenceByConversation = new Map<string, number>();
  private readonly now: () => number;
  private readonly maxMessageBytes: number;
  private readonly maxTtlMs: number;
  private readonly allowedClockSkewMs: number;
  private readonly maxProcessedMessages: number;
  private readonly maxTrackedConversations: number;
  private readonly card: AgentCard;

  constructor(options: A2ANodeOptions) {
    this.identity = options.identity;
    this.peers = options.peers;
    this.now = options.now ?? Date.now;
    this.maxMessageBytes = options.maxMessageBytes ?? 1_048_576;
    this.maxTtlMs = options.maxTtlMs ?? 300_000;
    this.allowedClockSkewMs = options.allowedClockSkewMs ?? 30_000;
    this.maxProcessedMessages = options.maxProcessedMessages ?? 10_000;
    this.maxTrackedConversations = options.maxTrackedConversations ?? 10_000;
    this.sessions = new SessionManager(
      this.identity,
      this.peers,
      options.session,
    );

    this.card = {
      agentId: this.identity.agentId,
      name: options.name,
      protocolVersions: [PROTOCOL_VERSION],
      endpoint: options.endpoint,
      transports: options.transports ?? [
        options.endpoint.startsWith("https:") ? "https" : "http",
      ],
      contentTypes: options.contentTypes ?? ["application/json"],
      authentication: {
        scheme: "A2A-Challenge",
        proofAlgorithm: "Ed25519",
        sessionTokenLocation: "Authorization",
      },
      publicKeys: [
        {
          keyId: this.identity.keyId,
          algorithm: "Ed25519",
          publicKeyPem: exportPublicKeyPem(this.identity.publicKey),
          status: "active",
        },
      ],
      capabilities: options.capabilities ?? [],
      limits: {
        maxMessageBytes: this.maxMessageBytes,
        maxTtlMs: this.maxTtlMs,
      },
    };
    if (options.description !== undefined) {
      this.card.description = options.description;
    }
    if (options.extensions !== undefined) {
      this.card.extensions = options.extensions;
    }
  }

  getAgentCard(): AgentCard {
    return structuredClone(this.card);
  }

  registerHandler(
    kind: MessageKind,
    handler: MessageHandler,
    options: RegisterHandlerOptions = {},
  ): () => void {
    if (this.handlers.has(kind)) {
      throw new A2AError(
        ErrorCode.Conflict,
        `A handler is already registered for ${kind}`,
        { status: 409 },
      );
    }
    this.handlers.set(kind, {
      handler,
      requiredScopes: [...new Set(options.requiredScopes ?? [])],
    });
    return () => {
      this.handlers.delete(kind);
    };
  }

  issueChallenge(request: ChallengeRequest): Challenge {
    return this.sessions.issueChallenge(request);
  }

  verifyChallenge(verification: ChallengeVerification): SessionGrant {
    return this.sessions.verifyChallenge(verification);
  }

  async receive(
    rawMessage: unknown,
    bearerToken: string,
  ): Promise<DeliveryBundle> {
    this.cleanupProcessed();
    assertValidMessage(rawMessage, {
      maxMessageBytes: this.maxMessageBytes,
      maxTtlMs: this.maxTtlMs,
    });
    const message = rawMessage;
    const principal = this.sessions.authenticate(bearerToken);

    if (
      principal.agentId !== message.sender ||
      principal.keyId !== message.security.keyId
    ) {
      throw new A2AError(
        ErrorCode.AuthenticationFailed,
        "Session identity does not match the signed message",
        { status: 401 },
      );
    }

    const peer = this.peers.resolve(message.sender, message.security.keyId);
    if (!verifyMessageSignature(message, peer.publicKey)) {
      throw new A2AError(
        ErrorCode.InvalidSignature,
        "Message signature verification failed",
        { status: 401 },
      );
    }
    if (
      message.recipient !== this.identity.agentId &&
      message.recipient !== "*"
    ) {
      throw new A2AError(
        ErrorCode.RecipientMismatch,
        "Message recipient does not match this agent",
        { status: 400 },
      );
    }

    const cacheKey = `${message.sender}\u0000${message.id}`;
    const cached = this.processed.get(cacheKey);
    if (cached) {
      return {
        ack: this.createAck(message, "duplicate"),
        messages: cached.bundle.messages,
      };
    }
    this.assertFresh(message);

    const registration = this.handlers.get(message.kind);
    if (!registration) {
      throw new A2AError(
        ErrorCode.HandlerNotFound,
        `No handler is registered for ${message.kind}`,
        { status: 404 },
      );
    }
    requireScopes(principal, [
      ...registration.requiredScopes,
      ...(message.requiredScopes ?? []),
    ]);

    let bundle: DeliveryBundle;
    try {
      const result = await registration.handler({
        principal,
        message,
        receivedAt: new Date(this.now()).toISOString(),
      });
      const messages = result
        ? [this.createHandlerResponse(message, result)]
        : [];
      bundle = {
        ack: this.createAck(message, "completed"),
        messages,
      };
    } catch (error) {
      const protocolError = asA2AError(error);
      bundle = {
        ack: this.createAck(
          message,
          "rejected",
          protocolError.code,
          protocolError.message,
        ),
        messages: [this.createErrorResponse(message, protocolError.toPayload())],
      };
    }

    const expiresAt =
      Date.parse(message.createdAt) + message.ttlMs + this.allowedClockSkewMs;
    this.rememberDelivery(cacheKey, { bundle, expiresAt });
    return bundle;
  }

  /**
   * Stores a delivery bundle and evicts the oldest entries once the cache
   * exceeds `maxProcessedMessages`. Entries already carry an expiry derived
   * from the message TTL, so this bound only limits peak retention under
   * sustained load; it never extends a message's deduplication window.
   */
  private rememberDelivery(key: string, delivery: CachedDelivery): void {
    this.processed.set(key, delivery);
    while (this.processed.size > this.maxProcessedMessages) {
      const oldest = this.processed.keys().next();
      if (oldest.done) {
        return;
      }
      this.processed.delete(oldest.value);
    }
  }

  private assertFresh(message: A2AMessage): void {
    const now = this.now();
    const createdAt = Date.parse(message.createdAt);
    if (createdAt - this.allowedClockSkewMs > now) {
      throw new A2AError(
        ErrorCode.InvalidMessage,
        "Message creation time is too far in the future",
        { status: 400 },
      );
    }
    if (createdAt + message.ttlMs + this.allowedClockSkewMs <= now) {
      throw new A2AError(ErrorCode.MessageExpired, "Message has expired", {
        status: 408,
      });
    }
  }

  private createAck(
    message: A2AMessage,
    status: AckPayload["status"],
    code?: string,
    detail?: string,
  ): A2AMessage<AckPayload> {
    const payload: AckPayload = { messageId: message.id, status };
    if (code !== undefined) {
      payload.code = code;
    }
    if (detail !== undefined) {
      payload.detail = detail;
    }
    return createSignedMessage(this.identity, {
      kind: "ack",
      recipient: message.sender,
      payload,
      ttlMs: Math.min(message.ttlMs, this.maxTtlMs),
      sequence: this.nextSequence(message.conversationId ?? message.id),
      conversationId: message.conversationId ?? message.id,
      correlationId: message.id,
      causationId: message.id,
    });
  }

  private createHandlerResponse(
    message: A2AMessage,
    result: HandlerResult,
  ): A2AMessage {
    const input = {
      kind: result.kind ?? ("response" as const),
      recipient: message.sender,
      payload: result.payload as JsonValue,
      contentType: result.contentType ?? "application/json",
      ttlMs: Math.min(message.ttlMs, this.maxTtlMs),
      sequence: this.nextSequence(message.conversationId ?? message.id),
      conversationId: message.conversationId ?? message.id,
      correlationId: message.id,
      causationId: message.id,
      ...(result.extensions ? { extensions: result.extensions } : {}),
    };
    return createSignedMessage(this.identity, input);
  }

  private createErrorResponse(
    message: A2AMessage,
    payload: ErrorPayload,
  ): A2AMessage<ErrorPayload> {
    return createSignedMessage(this.identity, {
      kind: "error",
      recipient: message.sender,
      payload,
      ttlMs: Math.min(message.ttlMs, this.maxTtlMs),
      sequence: this.nextSequence(message.conversationId ?? message.id),
      conversationId: message.conversationId ?? message.id,
      correlationId: message.id,
      causationId: message.id,
    });
  }

  private nextSequence(conversationId: string): number {
    if (
      !this.sequenceByConversation.has(conversationId) &&
      this.sequenceByConversation.size >= this.maxTrackedConversations
    ) {
      const oldest = this.sequenceByConversation.keys().next();
      if (!oldest.done) {
        this.sequenceByConversation.delete(oldest.value);
      }
    }
    const next = (this.sequenceByConversation.get(conversationId) ?? -1) + 1;
    this.sequenceByConversation.set(conversationId, next);
    return next;
  }

  private cleanupProcessed(): void {
    const now = this.now();
    for (const [key, item] of this.processed) {
      if (item.expiresAt <= now) {
        this.processed.delete(key);
      }
    }
  }
}
