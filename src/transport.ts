import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { A2AError, ErrorCode, asA2AError } from "./errors.js";
import type { A2ANode } from "./node.js";
import type {
  A2AMessage,
  AgentCard,
  Challenge,
  ChallengeRequest,
  ChallengeVerification,
  ClientTransport,
  DeliveryBundle,
  JsonValue,
  SessionGrant,
} from "./types.js";
import {
  assertChallengeRequest,
  assertChallengeVerification,
} from "./validation.js";

const JSON_CONTENT_TYPE = "application/json";

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": `${JSON_CONTENT_TYPE}; charset=utf-8`,
    "content-length": String(encoded.byteLength),
    "cache-control": "no-store",
    "a2a-version": "1.0",
    ...extraHeaders,
  });
  response.end(encoded);
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const contentType = request.headers["content-type"] ?? "";
  if (!contentType.toLowerCase().startsWith(JSON_CONTENT_TYPE)) {
    throw new A2AError(
      ErrorCode.InvalidMessage,
      "Content-Type must be application/json",
      { status: 415 },
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) {
      throw new A2AError(
        ErrorCode.PayloadTooLarge,
        `Request body exceeds ${maxBytes} bytes`,
        { status: 413 },
      );
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error) {
    throw new A2AError(ErrorCode.InvalidMessage, "Request body is not JSON", {
      status: 400,
      cause: error,
    });
  }
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new A2AError(
      ErrorCode.AuthenticationRequired,
      "Authorization: Bearer <token> is required",
      { status: 401 },
    );
  }
  return authorization.slice(7);
}

export interface HttpServerOptions {
  maxRequestBytes?: number;
  requestTimeoutMs?: number;
}

export function createA2AHttpServer(
  node: A2ANode,
  options: HttpServerOptions = {},
): Server {
  // The raw request body is bounded by the same limit the node advertises in
  // its Agent Card, so a peer that respects `limits.maxMessageBytes` is never
  // rejected below what it was promised. An explicit `maxRequestBytes` may
  // still tighten this to match a gateway limit.
  const maxRequestBytes = options.maxRequestBytes ?? node.maxMessageBytes;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://a2a.local");
      if (
        request.method === "GET" &&
        url.pathname === "/.well-known/a2a-agent.json"
      ) {
        writeJson(response, 200, node.getAgentCard(), {
          "cache-control": "public, max-age=300",
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/a2a/v1/auth/challenge"
      ) {
        const body = await readJson(request, maxRequestBytes);
        assertChallengeRequest(body);
        writeJson(response, 200, node.issueChallenge(body));
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/a2a/v1/auth/verify"
      ) {
        const body = await readJson(request, maxRequestBytes);
        assertChallengeVerification(body);
        writeJson(response, 200, node.verifyChallenge(body));
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/a2a/v1/messages"
      ) {
        const body = await readJson(request, maxRequestBytes);
        const result = await node.receive(body, bearerToken(request));
        writeJson(response, 200, result);
        return;
      }

      throw new A2AError(ErrorCode.HandlerNotFound, "Route not found", {
        status: 404,
      });
    } catch (error) {
      const protocolError = asA2AError(error);
      writeJson(response, protocolError.status, {
        error: protocolError.toPayload(),
      });
    }
  });
  server.requestTimeout = options.requestTimeoutMs ?? 30_000;
  server.headersTimeout = Math.min(server.requestTimeout, 20_000);
  return server;
}

export interface HttpTransportOptions {
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof globalThis.fetch;
}

export class HttpTransport implements ClientTransport {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(
    private readonly baseUrl: string,
    options: HttpTransportOptions = {},
  ) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 2_097_152;
  }

  discover(signal?: AbortSignal): Promise<AgentCard> {
    return this.call<AgentCard>(
      "/.well-known/a2a-agent.json",
      { method: "GET" },
      signal,
    );
  }

  requestChallenge(
    request: ChallengeRequest,
    signal?: AbortSignal,
  ): Promise<Challenge> {
    return this.call<Challenge>(
      "/a2a/v1/auth/challenge",
      {
        method: "POST",
        body: JSON.stringify(request),
      },
      signal,
    );
  }

  verifyChallenge(
    verification: ChallengeVerification,
    signal?: AbortSignal,
  ): Promise<SessionGrant> {
    return this.call<SessionGrant>(
      "/a2a/v1/auth/verify",
      {
        method: "POST",
        body: JSON.stringify(verification),
      },
      signal,
    );
  }

  send(
    message: A2AMessage,
    bearerToken: string,
    signal?: AbortSignal,
  ): Promise<DeliveryBundle> {
    return this.call<DeliveryBundle>(
      "/a2a/v1/messages",
      {
        method: "POST",
        headers: { authorization: `Bearer ${bearerToken}` },
        body: JSON.stringify(message),
      },
      signal,
    );
  }

  private async call<T>(
    path: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController();
    // The request is bounded by two independent conditions: the configured
    // request timeout and the caller's signal. They are not interchangeable:
    // a timeout is a retriable transport failure, whereas a caller abort is
    // a deliberate cancellation and must surface as the signal's reason.
    const cancelFromCaller = (): void => {
      controller.abort(signal?.reason);
    };
    if (signal?.aborted) {
      controller.abort(signal.reason);
    } else {
      signal?.addEventListener("abort", cancelFromCaller, { once: true });
    }
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImplementation(
        new URL(path, this.baseUrl),
        {
          ...init,
          headers: {
            accept: JSON_CONTENT_TYPE,
            ...(init.body ? { "content-type": JSON_CONTENT_TYPE } : {}),
            ...init.headers,
          },
          signal: controller.signal,
        },
      );
      const declaredLength = Number(response.headers.get("content-length"));
      if (
        Number.isFinite(declaredLength) &&
        declaredLength > this.maxResponseBytes
      ) {
        throw new A2AError(
          ErrorCode.PayloadTooLarge,
          "A2A response exceeds the configured limit",
          { status: 502 },
        );
      }
      const text = await response.text();
      if (Buffer.byteLength(text) > this.maxResponseBytes) {
        throw new A2AError(
          ErrorCode.PayloadTooLarge,
          "A2A response exceeds the configured limit",
          { status: 502 },
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(text) as unknown;
      } catch (error) {
        throw new A2AError(
          ErrorCode.TransportFailed,
          "A2A endpoint returned invalid JSON",
          { status: 502, retriable: true, cause: error },
        );
      }
      if (!response.ok) {
        const payload = body as {
          error?: {
            code?: string;
            message?: string;
            retriable?: boolean;
            details?: JsonValue;
          };
        };
        throw new A2AError(
          payload.error?.code ?? ErrorCode.TransportFailed,
          payload.error?.message ?? `A2A endpoint returned ${response.status}`,
          {
            status: response.status,
            retriable:
              payload.error?.retriable ??
              (response.status === 429 || response.status >= 500),
            ...(payload.error?.details !== undefined
              ? { details: payload.error.details }
              : {}),
          },
        );
      }
      return body as T;
    } catch (error) {
      if (signal?.aborted) {
        // A caller cancellation is not a transport failure: surfacing it as a
        // retriable error would make the client retry work the caller just
        // cancelled, and would re-run handler side effects.
        throw signal.reason;
      }
      if (error instanceof A2AError) {
        throw error;
      }
      throw new A2AError(
        ErrorCode.TransportFailed,
        error instanceof Error ? error.message : "A2A request failed",
        { status: 503, retriable: true, cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancelFromCaller);
    }
  }
}

export class InMemoryTransport implements ClientTransport {
  constructor(private readonly node: A2ANode) {}

  async discover(signal?: AbortSignal): Promise<AgentCard> {
    if (signal?.aborted) {
      throw signal.reason;
    }
    return structuredClone(this.node.getAgentCard());
  }

  async requestChallenge(
    request: ChallengeRequest,
    signal?: AbortSignal,
  ): Promise<Challenge> {
    if (signal?.aborted) {
      throw signal.reason;
    }
    const input: unknown = structuredClone(request);
    assertChallengeRequest(input);
    return structuredClone(this.node.issueChallenge(input));
  }

  async verifyChallenge(
    verification: ChallengeVerification,
    signal?: AbortSignal,
  ): Promise<SessionGrant> {
    if (signal?.aborted) {
      throw signal.reason;
    }
    const input: unknown = structuredClone(verification);
    assertChallengeVerification(input);
    return structuredClone(this.node.verifyChallenge(input));
  }

  async send(
    message: A2AMessage,
    bearerToken: string,
    signal?: AbortSignal,
  ): Promise<DeliveryBundle> {
    // Fail before the handler runs, so a cancelled request cannot cause a
    // side effect the caller will never observe.
    if (signal?.aborted) {
      throw signal.reason;
    }
    return structuredClone(
      await this.node.receive(structuredClone(message), bearerToken),
    );
  }
}
