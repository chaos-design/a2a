import assert from "node:assert/strict";
import test from "node:test";
import {
  A2AClient,
  A2AError,
  A2ANode,
  ErrorCode,
  HttpTransport,
  InMemoryTransport,
  PeerRegistry,
  createA2AHttpServer,
  createSignedMessage,
  generateSigningIdentity,
  signChallenge,
  type A2AMessage,
  type AgentCard,
  type Challenge,
  type ChallengeRequest,
  type ChallengeVerification,
  type ClientTransport,
  type DeliveryBundle,
  type SessionGrant,
} from "../src/index.js";

function createFixture(grantedScopes = ["tasks:execute"]) {
  const serverIdentity = generateSigningIdentity("agent://coordinator");
  const clientIdentity = generateSigningIdentity("agent://worker");
  const peers = new PeerRegistry();
  peers.register({
    agentId: clientIdentity.agentId,
    keyId: clientIdentity.keyId,
    publicKey: clientIdentity.publicKey,
    grantedScopes,
  });
  const node = new A2ANode({
    identity: serverIdentity,
    peers,
    name: "Coordinator",
    endpoint: "http://127.0.0.1:4310",
    capabilities: [
      {
        name: "execute-task",
        messageKinds: ["request"],
        requiredScopes: ["tasks:execute"],
      },
    ],
  });
  return { serverIdentity, clientIdentity, node };
}

test("authenticated request produces signed acknowledgement and response", async () => {
  const { clientIdentity, node } = createFixture();
  let invocationCount = 0;
  node.registerHandler(
    "request",
    ({ message }) => {
      invocationCount += 1;
      return {
        payload: {
          acceptedTask: (message.payload as { task: string }).task,
        },
      };
    },
    { requiredScopes: ["tasks:execute"] },
  );
  const client = new A2AClient({
    identity: clientIdentity,
    transport: new InMemoryTransport(node),
    requestedScopes: ["tasks:execute"],
    expectedAgentId: node.identity.agentId,
  });

  const delivery = await client.send({
    kind: "request",
    recipient: node.identity.agentId,
    payload: { task: "compile-report" },
    conversationId: "conversation-1",
  });

  assert.equal(delivery.ack.payload.status, "completed");
  assert.deepEqual(delivery.messages[0]?.payload, {
    acceptedTask: "compile-report",
  });
  assert.equal(invocationCount, 1);
});

test("lost responses are retried without repeating handler side effects", async () => {
  const { clientIdentity, node } = createFixture();
  let invocationCount = 0;
  node.registerHandler(
    "command",
    () => {
      invocationCount += 1;
    },
    { requiredScopes: ["tasks:execute"] },
  );
  const flaky = new LoseFirstResponseTransport(new InMemoryTransport(node));
  const client = new A2AClient({
    identity: clientIdentity,
    transport: flaky,
    requestedScopes: ["tasks:execute"],
    retryPolicy: { initialDelayMs: 1, maxDelayMs: 2, jitterRatio: 0 },
  });

  const delivery = await client.send({
    kind: "command",
    recipient: node.identity.agentId,
    payload: { action: "charge-account" },
    idempotencyKey: "billing-2026-09-07",
  });

  assert.equal(delivery.ack.payload.status, "duplicate");
  assert.equal(invocationCount, 1);
  assert.equal(flaky.sendCount, 2);
});

test("authorization is enforced before handler invocation", async () => {
  const { clientIdentity, node } = createFixture([]);
  let invoked = false;
  node.registerHandler(
    "request",
    () => {
      invoked = true;
    },
    { requiredScopes: ["tasks:execute"] },
  );
  const client = new A2AClient({
    identity: clientIdentity,
    transport: new InMemoryTransport(node),
    requestedScopes: ["tasks:execute"],
  });

  await assert.rejects(
    () =>
      client.send({
        kind: "request",
        recipient: node.identity.agentId,
        payload: { task: "forbidden" },
      }),
    (error: unknown) =>
      error instanceof A2AError &&
      error.code === ErrorCode.AuthorizationDenied,
  );
  assert.equal(invoked, false);
});

test("challenge proof is single-use", () => {
  const { clientIdentity, node } = createFixture();
  const challenge = node.issueChallenge({
    agentId: clientIdentity.agentId,
    keyId: clientIdentity.keyId,
    requestedScopes: ["tasks:execute"],
  });
  const verification = {
    challengeId: challenge.challengeId,
    signature: signChallenge(challenge, clientIdentity),
  };

  assert.equal(
    node.verifyChallenge(verification).scopes.includes("tasks:execute"),
    true,
  );
  assert.throws(
    () => node.verifyChallenge(verification),
    (error: unknown) =>
      error instanceof A2AError &&
      error.code === ErrorCode.AuthenticationFailed,
  );
});

test("client rejects a challenge not authenticated by the server", async () => {
  const { clientIdentity, node, serverIdentity } = createFixture();
  const transport = new TamperedChallengeTransport(
    new InMemoryTransport(node),
  );
  const client = new A2AClient({
    identity: clientIdentity,
    transport,
    requestedScopes: ["tasks:execute"],
    expectedAgentId: serverIdentity.agentId,
    trustedServerKeys: {
      [serverIdentity.keyId]: serverIdentity.publicKey,
    },
  });

  await assert.rejects(
    () => client.connect(),
    (error: unknown) =>
      error instanceof A2AError &&
      error.code === ErrorCode.AuthenticationFailed,
  );
});

test("tampered signed messages are rejected", async () => {
  const { clientIdentity, node } = createFixture();
  node.registerHandler("request", () => undefined, {
    requiredScopes: ["tasks:execute"],
  });
  const challenge = node.issueChallenge({
    agentId: clientIdentity.agentId,
    keyId: clientIdentity.keyId,
    requestedScopes: ["tasks:execute"],
  });
  const grant = node.verifyChallenge({
    challengeId: challenge.challengeId,
    signature: signChallenge(challenge, clientIdentity),
  });
  const signed = createSignedMessage(clientIdentity, {
    kind: "request",
    recipient: node.identity.agentId,
    payload: { approved: false },
  });
  const tampered: A2AMessage = {
    ...signed,
    payload: { approved: true },
  };

  await assert.rejects(
    () => node.receive(tampered, grant.token),
    (error: unknown) =>
      error instanceof A2AError &&
      error.code === ErrorCode.InvalidSignature,
  );
});

test("HTTP binding completes discovery, authentication, and delivery", async () => {
  const { clientIdentity, node, serverIdentity } = createFixture();
  node.registerHandler(
    "request",
    () => ({ payload: { transport: "http" } }),
    { requiredScopes: ["tasks:execute"] },
  );
  const server = createA2AHttpServer(node);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert(address && typeof address === "object");
    const client = new A2AClient({
      identity: clientIdentity,
      transport: new HttpTransport(`http://127.0.0.1:${address.port}`),
      requestedScopes: ["tasks:execute"],
      expectedAgentId: serverIdentity.agentId,
      trustedServerKeys: {
        [serverIdentity.keyId]: serverIdentity.publicKey,
      },
    });
    const delivery = await client.send({
      kind: "request",
      recipient: serverIdentity.agentId,
      payload: { check: "round-trip" },
    });

    assert.equal(delivery.ack.payload.status, "completed");
    assert.deepEqual(delivery.messages[0]?.payload, { transport: "http" });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

class LoseFirstResponseTransport implements ClientTransport {
  sendCount = 0;

  constructor(private readonly inner: ClientTransport) {}

  discover(): Promise<AgentCard> {
    return this.inner.discover();
  }

  requestChallenge(request: ChallengeRequest): Promise<Challenge> {
    return this.inner.requestChallenge(request);
  }

  verifyChallenge(
    verification: ChallengeVerification,
  ): Promise<SessionGrant> {
    return this.inner.verifyChallenge(verification);
  }

  async send(
    message: A2AMessage,
    bearerToken: string,
  ): Promise<DeliveryBundle> {
    this.sendCount += 1;
    const delivery = await this.inner.send(message, bearerToken);
    if (this.sendCount === 1) {
      throw new A2AError(
        ErrorCode.TransportFailed,
        "Simulated response loss",
        { status: 503, retriable: true },
      );
    }
    return delivery;
  }
}

class TamperedChallengeTransport implements ClientTransport {
  constructor(private readonly inner: ClientTransport) {}

  discover(): Promise<AgentCard> {
    return this.inner.discover();
  }

  async requestChallenge(request: ChallengeRequest): Promise<Challenge> {
    const challenge = await this.inner.requestChallenge(request);
    return { ...challenge, challenge: `${challenge.challenge}tampered` };
  }

  verifyChallenge(
    verification: ChallengeVerification,
  ): Promise<SessionGrant> {
    return this.inner.verifyChallenge(verification);
  }

  send(
    message: A2AMessage,
    bearerToken: string,
  ): Promise<DeliveryBundle> {
    return this.inner.send(message, bearerToken);
  }
}
