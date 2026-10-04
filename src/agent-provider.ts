import {
  createHash,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
} from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { Server } from "node:http";
import { parse } from "dotenv";
import { A2AError, ErrorCode } from "./errors.js";
import { generateSigningIdentity } from "./crypto.js";
import {
  A2ANode,
  type A2ANodeOptions,
} from "./node.js";
import { PeerRegistry } from "./auth.js";
import {
  createA2AHttpServer,
  type HttpServerOptions,
} from "./transport.js";
import type {
  AgentCard,
  CapabilityDescriptor,
  SigningIdentity,
} from "./types.js";

const DEFAULT_ENDPOINT = "http://127.0.0.1:4310";

export interface AgentProviderConfig {
  envPath: string;
  envLoaded: boolean;
  agentId: string;
  agentName: string;
  agentDescription?: string;
  endpoint: string;
  listenHost: string;
  listenPort: number;
  transports: AgentCard["transports"];
  contentTypes: string[];
  maxMessageBytes: number;
  maxTtlMs: number;
  allowedClockSkewMs: number;
  challengeTtlMs: number;
  sessionTtlMs: number;
}

export interface AgentProviderOptions {
  /**
   * A .env file or an existing directory containing .env.
   * Resolution order: this value, A2A_ENV_PATH, then process.cwd()/.env.
   */
  envPath?: string;
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  requireEnvFile?: boolean;
  identity?: SigningIdentity;
}

export interface AgentProviderNodeOptions {
  peers?: PeerRegistry;
  identity?: SigningIdentity;
  capabilities?: CapabilityDescriptor[];
  extensions?: AgentCard["extensions"];
}

export interface AgentProviderListenOptions extends HttpServerOptions {
  host?: string;
  port?: number;
}

export class AgentProvider {
  readonly identity: SigningIdentity;

  private readonly resolvedConfig: AgentProviderConfig;
  private readonly values: NodeJS.ProcessEnv;

  constructor(options: AgentProviderOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    const environment = options.environment ?? process.env;
    const configuredPath = options.envPath ?? environment.A2A_ENV_PATH;
    const initialPath = configuredPath
      ? resolvePath(cwd, configuredPath)
      : resolve(cwd, ".env");
    const envPath =
      existsSync(initialPath) && statSync(initialPath).isDirectory()
        ? resolve(initialPath, ".env")
        : initialPath;
    const explicitPath = configuredPath !== undefined;
    const requireEnvFile = options.requireEnvFile ?? explicitPath;

    let fileValues: NodeJS.ProcessEnv = {};
    if (existsSync(envPath)) {
      try {
        fileValues = parse(readFileSync(envPath));
      } catch (error) {
        throw configurationError(`Unable to read ${envPath}`, error);
      }
    } else if (requireEnvFile) {
      throw configurationError(`Environment file does not exist: ${envPath}`);
    }

    const environmentValues = Object.fromEntries(
      Object.entries(environment).filter((entry) => entry[1] !== undefined),
    );
    // Runtime environment takes precedence without mutating process.env.
    this.values = { ...fileValues, ...environmentValues };
    this.resolvedConfig = readConfig(this.values, envPath, existsSync(envPath));
    this.identity =
      options.identity ?? readIdentity(this.values, this.resolvedConfig);
  }

  getConfig(): AgentProviderConfig {
    return structuredClone(this.resolvedConfig);
  }

  createNode(options: AgentProviderNodeOptions = {}): A2ANode {
    const config = this.resolvedConfig;
    const nodeOptions: A2ANodeOptions = {
      identity: options.identity ?? this.identity,
      peers: options.peers ?? new PeerRegistry(),
      name: config.agentName,
      endpoint: config.endpoint,
      transports: [...config.transports],
      contentTypes: [...config.contentTypes],
      maxMessageBytes: config.maxMessageBytes,
      maxTtlMs: config.maxTtlMs,
      allowedClockSkewMs: config.allowedClockSkewMs,
      session: {
        challengeTtlMs: config.challengeTtlMs,
        sessionTtlMs: config.sessionTtlMs,
      },
    };
    if (config.agentDescription !== undefined) {
      nodeOptions.description = config.agentDescription;
    }
    if (options.capabilities !== undefined) {
      nodeOptions.capabilities = options.capabilities;
    }
    if (options.extensions !== undefined) {
      nodeOptions.extensions = options.extensions;
    }
    return new A2ANode(nodeOptions);
  }

  createHttpServer(
    node: A2ANode,
    options: HttpServerOptions = {},
  ): Server {
    return createA2AHttpServer(node, options);
  }

  async listen(
    node: A2ANode,
    options: AgentProviderListenOptions = {},
  ): Promise<Server> {
    const server = this.createHttpServer(node, options);
    const host = options.host ?? this.resolvedConfig.listenHost;
    const port = options.port ?? this.resolvedConfig.listenPort;
    await new Promise<void>((resolvePromise, reject) => {
      const handleError = (error: Error): void => {
        reject(error);
      };
      server.once("error", handleError);
      server.listen(port, host, () => {
        server.removeListener("error", handleError);
        resolvePromise();
      });
    });
    return server;
  }
}

function resolvePath(cwd: string, path: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function readConfig(
  values: NodeJS.ProcessEnv,
  envPath: string,
  envLoaded: boolean,
): AgentProviderConfig {
  const endpoint = values.A2A_ENDPOINT?.trim() || DEFAULT_ENDPOINT;
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch (error) {
    throw configurationError("A2A_ENDPOINT must be a valid URL", error);
  }
  if (!["http:", "https:", "memory:"].includes(parsedEndpoint.protocol)) {
    throw configurationError(
      "A2A_ENDPOINT must use http, https, or memory",
    );
  }

  const defaultTransport: AgentCard["transports"][number] =
    parsedEndpoint.protocol === "https:"
      ? "https"
      : parsedEndpoint.protocol === "memory:"
        ? "in-memory"
        : "http";
  const transports = readList(values.A2A_TRANSPORTS, [defaultTransport]);
  if (
    transports.some(
      (transport) =>
        !["http", "https", "in-memory"].includes(transport),
    )
  ) {
    throw configurationError(
      "A2A_TRANSPORTS supports only http, https, and in-memory",
    );
  }

  const config: AgentProviderConfig = {
    envPath,
    envLoaded,
    agentId: values.A2A_AGENT_ID?.trim() || "agent://local",
    agentName: values.A2A_AGENT_NAME?.trim() || "Local A2A Agent",
    endpoint,
    listenHost:
      values.A2A_LISTEN_HOST?.trim() ||
      (parsedEndpoint.protocol === "memory:"
        ? "127.0.0.1"
        : parsedEndpoint.hostname),
    listenPort: readInteger(
      values,
      "A2A_LISTEN_PORT",
      parsedEndpoint.port
        ? Number(parsedEndpoint.port)
        : parsedEndpoint.protocol === "https:"
          ? 443
          : 4310,
      0,
      65_535,
    ),
    transports: transports as AgentCard["transports"],
    contentTypes: readList(values.A2A_CONTENT_TYPES, ["application/json"]),
    maxMessageBytes: readInteger(
      values,
      "A2A_MAX_MESSAGE_BYTES",
      1_048_576,
      1,
    ),
    maxTtlMs: readInteger(values, "A2A_MAX_TTL_MS", 300_000, 1),
    allowedClockSkewMs: readInteger(
      values,
      "A2A_ALLOWED_CLOCK_SKEW_MS",
      30_000,
      0,
    ),
    challengeTtlMs: readInteger(
      values,
      "A2A_CHALLENGE_TTL_MS",
      30_000,
      1,
    ),
    sessionTtlMs: readInteger(
      values,
      "A2A_SESSION_TTL_MS",
      900_000,
      1,
    ),
  };
  if (values.A2A_AGENT_DESCRIPTION?.trim()) {
    config.agentDescription = values.A2A_AGENT_DESCRIPTION.trim();
  }
  return config;
}

function readIdentity(
  values: NodeJS.ProcessEnv,
  config: AgentProviderConfig,
): SigningIdentity {
  const inlinePem = values.A2A_SIGNING_PRIVATE_KEY?.replaceAll("\\n", "\n");
  const keyFile = values.A2A_SIGNING_PRIVATE_KEY_FILE?.trim();
  if (inlinePem && keyFile) {
    throw configurationError(
      "Set only one of A2A_SIGNING_PRIVATE_KEY and A2A_SIGNING_PRIVATE_KEY_FILE",
    );
  }

  let privateKey: KeyObject | undefined;
  if (inlinePem) {
    try {
      privateKey = createPrivateKey(inlinePem);
    } catch (error) {
      throw configurationError(
        "A2A_SIGNING_PRIVATE_KEY is not a valid private key",
        error,
      );
    }
  } else if (keyFile) {
    const path = resolvePath(dirname(config.envPath), keyFile);
    try {
      privateKey = createPrivateKey(readFileSync(path));
    } catch (error) {
      throw configurationError(
        `Unable to load A2A_SIGNING_PRIVATE_KEY_FILE: ${path}`,
        error,
      );
    }
  }

  if (!privateKey) {
    return generateSigningIdentity(
      config.agentId,
      values.A2A_SIGNING_KEY_ID?.trim() || undefined,
    );
  }
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw configurationError("The configured signing key must use Ed25519");
  }
  const publicKey = createPublicKey(privateKey);
  const keyId =
    values.A2A_SIGNING_KEY_ID?.trim() || deriveKeyId(publicKey);
  return {
    agentId: config.agentId,
    keyId,
    publicKey,
    privateKey,
  };
}

function deriveKeyId(publicKey: KeyObject): string {
  const bytes = publicKey.export({ type: "spki", format: "der" });
  const fingerprint = createHash("sha256")
    .update(bytes)
    .digest("base64url")
    .slice(0, 22);
  return `sig-${fingerprint}`;
}

function readList(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) {
    return [...fallback];
  }
  const items = [...new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
  if (items.length === 0) {
    throw configurationError("Comma-separated configuration cannot be empty");
  }
  return items;
}

function readInteger(
  values: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = values[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw configurationError(
      `${key} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value;
}

function configurationError(message: string, cause?: unknown): A2AError {
  return new A2AError(ErrorCode.ConfigurationError, message, {
    status: 500,
    ...(cause !== undefined ? { cause } : {}),
  });
}
