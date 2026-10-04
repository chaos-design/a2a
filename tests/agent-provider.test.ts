import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AgentProvider,
  A2AError,
  ErrorCode,
  PeerRegistry,
  exportPrivateKeyPem,
  exportPublicKeyPem,
  generateSigningIdentity,
} from "../src/index.js";

function temporaryDirectory(): string {
  return mkdtempSync(join(tmpdir(), "a2a-provider-"));
}

test("AgentProvider loads .env from the current directory by default", () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(
      join(directory, ".env"),
      [
        "A2A_AGENT_ID=agent://configured",
        "A2A_AGENT_NAME=Configured Agent",
        "A2A_ENDPOINT=http://127.0.0.1:5400",
        "A2A_MAX_TTL_MS=45000",
      ].join("\n"),
    );

    const provider = new AgentProvider({
      cwd: directory,
      environment: {},
    });
    const config = provider.getConfig();
    const node = provider.createNode({ peers: new PeerRegistry() });

    assert.equal(config.envPath, join(directory, ".env"));
    assert.equal(config.envLoaded, true);
    assert.equal(config.agentId, "agent://configured");
    assert.equal(config.listenPort, 5400);
    assert.equal(config.maxTtlMs, 45_000);
    assert.equal(node.getAgentCard().endpoint, "http://127.0.0.1:5400");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("AgentProvider supports a dynamic config path and runtime overrides", () => {
  const directory = temporaryDirectory();
  try {
    const configDirectory = join(directory, "config");
    mkdirSync(configDirectory);
    writeFileSync(
      join(configDirectory, ".env"),
      [
        "A2A_AGENT_ID=agent://file",
        "A2A_AGENT_NAME=File Agent",
        "A2A_ENDPOINT=http://127.0.0.1:5500",
      ].join("\n"),
    );

    const provider = new AgentProvider({
      cwd: directory,
      envPath: "config",
      environment: {
        A2A_AGENT_NAME: "Runtime Agent",
        A2A_LISTEN_PORT: "5600",
      },
    });
    const config = provider.getConfig();

    assert.equal(config.envPath, join(configDirectory, ".env"));
    assert.equal(config.agentId, "agent://file");
    assert.equal(config.agentName, "Runtime Agent");
    assert.equal(config.endpoint, "http://127.0.0.1:5500");
    assert.equal(config.listenPort, 5600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("A2A_ENV_PATH can select the config file", () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(
      join(directory, "worker.env"),
      "A2A_AGENT_ID=agent://worker-from-env-path\n",
    );
    const provider = new AgentProvider({
      cwd: directory,
      environment: { A2A_ENV_PATH: "worker.env" },
    });

    assert.equal(provider.getConfig().agentId, "agent://worker-from-env-path");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("relative signing key paths resolve from the .env directory", () => {
  const directory = temporaryDirectory();
  try {
    const sourceIdentity = generateSigningIdentity("agent://key-source");
    mkdirSync(join(directory, "secrets"));
    writeFileSync(
      join(directory, "secrets", "signing.pem"),
      exportPrivateKeyPem(sourceIdentity.privateKey),
      { mode: 0o600 },
    );
    writeFileSync(
      join(directory, ".env"),
      [
        "A2A_AGENT_ID=agent://stable",
        "A2A_SIGNING_KEY_ID=stable-key",
        "A2A_SIGNING_PRIVATE_KEY_FILE=secrets/signing.pem",
      ].join("\n"),
    );

    const provider = new AgentProvider({
      cwd: directory,
      environment: {},
    });

    assert.equal(provider.identity.keyId, "stable-key");
    assert.equal(
      exportPublicKeyPem(provider.identity.publicKey),
      exportPublicKeyPem(sourceIdentity.publicKey),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an explicitly configured missing .env fails fast", () => {
  const directory = temporaryDirectory();
  try {
    assert.throws(
      () =>
        new AgentProvider({
          cwd: directory,
          envPath: "missing.env",
          environment: {},
        }),
      (error: unknown) =>
        error instanceof A2AError &&
        error.code === ErrorCode.ConfigurationError,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("AgentProvider listens on the configured address", async () => {
  const directory = temporaryDirectory();
  try {
    writeFileSync(
      join(directory, ".env"),
      [
        "A2A_ENDPOINT=http://127.0.0.1:4310",
        "A2A_LISTEN_HOST=127.0.0.1",
        "A2A_LISTEN_PORT=0",
      ].join("\n"),
    );
    const provider = new AgentProvider({
      cwd: directory,
      environment: {},
    });
    const server = await provider.listen(provider.createNode());
    try {
      const address = server.address();
      assert(address && typeof address === "object");
      assert.equal(address.address, "127.0.0.1");
      assert(address.port > 0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
