import { createPublicKey, randomBytes, randomUUID } from "node:crypto";
import {
  signServerChallenge,
  verifyChallengeSignature,
} from "./crypto.js";
import { A2AError, ErrorCode } from "./errors.js";
import type {
  Challenge,
  ChallengeRequest,
  ChallengeVerification,
  PeerRegistration,
  SessionGrant,
  SessionPrincipal,
  SigningIdentity,
} from "./types.js";

interface PeerRecord {
  agentId: string;
  keyId: string;
  publicKey: ReturnType<typeof createPublicKey>;
  grantedScopes: Set<string>;
  status: "active" | "revoked";
}

export class PeerRegistry {
  private readonly peers = new Map<string, PeerRecord>();

  register(registration: PeerRegistration): void {
    const publicKey =
      typeof registration.publicKey === "string"
        ? createPublicKey(registration.publicKey)
        : registration.publicKey;
    if (publicKey.asymmetricKeyType !== "ed25519") {
      throw new A2AError(
        ErrorCode.UnknownKey,
        "Peer signing keys must use Ed25519",
        { status: 400 },
      );
    }

    this.peers.set(this.key(registration.agentId, registration.keyId), {
      agentId: registration.agentId,
      keyId: registration.keyId,
      publicKey,
      grantedScopes: new Set(registration.grantedScopes),
      status: registration.status ?? "active",
    });
  }

  revoke(agentId: string, keyId: string): void {
    const peer = this.get(agentId, keyId);
    peer.status = "revoked";
  }

  resolve(agentId: string, keyId: string): PeerRecord {
    const peer = this.get(agentId, keyId);
    if (peer.status !== "active") {
      throw new A2AError(ErrorCode.UnknownKey, "Peer key is revoked", {
        status: 401,
      });
    }
    return peer;
  }

  private get(agentId: string, keyId: string): PeerRecord {
    const peer = this.peers.get(this.key(agentId, keyId));
    if (!peer) {
      throw new A2AError(ErrorCode.UnknownKey, "Peer key is not registered", {
        status: 401,
      });
    }
    return peer;
  }

  private key(agentId: string, keyId: string): string {
    return `${agentId}\u0000${keyId}`;
  }
}

interface StoredChallenge {
  challenge: Challenge;
  expiresAt: number;
}

interface StoredSession {
  principal: SessionPrincipal;
}

export interface SessionManagerOptions {
  challengeTtlMs?: number;
  sessionTtlMs?: number;
  maxPendingChallenges?: number;
  maxSessions?: number;
  now?: () => number;
}

export class SessionManager {
  private readonly challenges = new Map<string, StoredChallenge>();
  private readonly sessions = new Map<string, StoredSession>();
  private readonly challengeTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly maxPendingChallenges: number;
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(
    private readonly identity: SigningIdentity,
    private readonly peers: PeerRegistry,
    options: SessionManagerOptions = {},
  ) {
    this.challengeTtlMs = options.challengeTtlMs ?? 30_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 15 * 60_000;
    this.maxPendingChallenges = options.maxPendingChallenges ?? 10_000;
    this.maxSessions = options.maxSessions ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  issueChallenge(request: ChallengeRequest): Challenge {
    const peer = this.peers.resolve(request.agentId, request.keyId);
    this.cleanup();
    if (this.challenges.size >= this.maxPendingChallenges) {
      throw new A2AError(
        ErrorCode.RateLimited,
        "Too many pending authentication challenges",
        { status: 429, retriable: true },
      );
    }

    const requestedScopes = [...new Set(request.requestedScopes)].sort();
    const expiresAt = this.now() + this.challengeTtlMs;
    const unsignedChallenge: Omit<Challenge, "serverSignature"> = {
      challengeId: randomUUID(),
      challenge: randomBytes(32).toString("base64url"),
      agentId: peer.agentId,
      audience: this.identity.agentId,
      keyId: peer.keyId,
      serverKeyId: this.identity.keyId,
      requestedScopes,
      expiresAt: new Date(expiresAt).toISOString(),
    };
    const challenge = signServerChallenge(unsignedChallenge, this.identity);
    this.challenges.set(challenge.challengeId, { challenge, expiresAt });
    return challenge;
  }

  verifyChallenge(verification: ChallengeVerification): SessionGrant {
    const stored = this.challenges.get(verification.challengeId);
    this.challenges.delete(verification.challengeId);
    if (!stored || stored.expiresAt <= this.now()) {
      throw new A2AError(
        ErrorCode.AuthenticationFailed,
        "Authentication challenge is missing, expired, or already used",
        { status: 401 },
      );
    }

    const peer = this.peers.resolve(
      stored.challenge.agentId,
      stored.challenge.keyId,
    );
    let valid = false;
    try {
      valid = verifyChallengeSignature(
        stored.challenge,
        verification.signature,
        peer.publicKey,
      );
    } catch {
      valid = false;
    }
    if (!valid) {
      throw new A2AError(
        ErrorCode.AuthenticationFailed,
        "Challenge signature is invalid",
        { status: 401 },
      );
    }

    this.cleanup();
    if (this.sessions.size >= this.maxSessions) {
      throw new A2AError(
        ErrorCode.RateLimited,
        "Too many active sessions",
        { status: 429, retriable: true },
      );
    }

    const expiresAt = this.now() + this.sessionTtlMs;
    const scopes = stored.challenge.requestedScopes.filter(
      (scope) =>
        peer.grantedScopes.has(scope) || peer.grantedScopes.has("*"),
    );
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, {
      principal: {
        agentId: peer.agentId,
        keyId: peer.keyId,
        scopes: new Set(scopes),
        expiresAt,
      },
    });
    return {
      token,
      tokenType: "Bearer",
      agentId: peer.agentId,
      scopes,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  authenticate(token: string): SessionPrincipal {
    const session = this.sessions.get(token);
    if (!session || session.principal.expiresAt <= this.now()) {
      if (session) {
        this.sessions.delete(token);
      }
      throw new A2AError(
        ErrorCode.AuthenticationRequired,
        "A valid A2A bearer token is required",
        { status: 401 },
      );
    }

    this.peers.resolve(session.principal.agentId, session.principal.keyId);
    return session.principal;
  }

  revokeToken(token: string): void {
    this.sessions.delete(token);
  }

  private cleanup(): void {
    const now = this.now();
    for (const [id, item] of this.challenges) {
      if (item.expiresAt <= now) {
        this.challenges.delete(id);
      }
    }
    for (const [token, item] of this.sessions) {
      if (item.principal.expiresAt <= now) {
        this.sessions.delete(token);
      }
    }
  }
}

export function requireScopes(
  principal: SessionPrincipal,
  requiredScopes: Iterable<string>,
): void {
  const missing = [...new Set(requiredScopes)].filter(
    (scope) => !principal.scopes.has(scope) && !principal.scopes.has("*"),
  );
  if (missing.length > 0) {
    throw new A2AError(
      ErrorCode.AuthorizationDenied,
      "The authenticated agent lacks required scopes",
      {
        status: 403,
        details: { missingScopes: missing },
      },
    );
  }
}
