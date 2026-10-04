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
  type AckPayload,
  type AgentCard,
  type Challenge,
  type ChallengeRequest,
  type ChallengeVerification,
  type ClientTransport,
  type DeliveryBundle,
  type SessionGrant,
  type SigningIdentity,
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

test("a single 401 does not consume the retry budget", async () => {
  const { clientIdentity, node } = createFixture();
  node.registerHandler("request", () => ({ payload: { ok: true } }));
  const inner = new InMemoryTransport(node);
  let unauthorized = true;
  const transport = new Single401Transport(inner, () => {
    if (!unauthorized) {
      return false;
    }
    unauthorized = false;
    return true;
  });
  const client = new A2AClient({
    identity: clientIdentity,
    transport,
    requestedScopes: ["tasks:execute"],
    retryPolicy: { maxAttempts: 1, initialDelayMs: 1, jitterRatio: 0 },
  });

  const delivery = await client.send({
    kind: "request",
    recipient: node.identity.agentId,
    payload: { task: "single-attempt" },
  });

  assert.equal(delivery.ack.payload.status, "completed");
  assert.equal(transport.sendCount, 2);
});

test("a persistent 401 surfaces after a single re-authentication", async () => {
  const { clientIdentity, node } = createFixture();
  node.registerHandler("request", () => ({ payload: { ok: true } }));
  const inner = new InMemoryTransport(node);
  const transport = new Single401Transport(inner, () => true);
  const client = new A2AClient({
    identity: clientIdentity,
    transport,
    requestedScopes: ["tasks:execute"],
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1, jitterRatio: 0 },
  });

  await assert.rejects(
    () =>
      client.send({
        kind: "request",
        recipient: node.identity.agentId,
        payload: { task: "always-401" },
      }),
    (error: unknown) => error instanceof A2AError && error.status === 401,
  );
  assert.equal(transport.sendCount, 2);
});

test("a malformed acknowledgement yields a protocol error, not a TypeError", async () => {
  const { clientIdentity, node, serverIdentity } = createFixture();
  node.registerHandler("request", () => ({ payload: { ok: true } }));
  const inner = new InMemoryTransport(node);
  const client = new A2AClient({
    identity: clientIdentity,
    transport: new HostileAckTransport(inner, serverIdentity),
    requestedScopes: ["tasks:execute"],
  });

  await assert.rejects(
    () =>
      client.send({
        kind: "request",
        recipient: serverIdentity.agentId,
        payload: { task: "hostile-ack" },
      }),
    (error: unknown) =>
      error instanceof A2AError &&
      error.code === ErrorCode.InvalidMessage &&
      !(error instanceof TypeError),
  );
});

test("delivery and conversation caches stay within their configured bounds", async () => {
  const { clientIdentity, node } = createFixture();
  node.registerHandler("request", () => ({ payload: { ok: true } }));
  const bounded = new A2ANode({
    identity: node.identity,
    peers: node.peers,
    name: "Coordinator",
    endpoint: "http://127.0.0.1:4310",
    maxProcessedMessages: 4,
    maxTrackedConversations: 4,
  });
  bounded.registerHandler("request", () => ({ payload: { ok: true } }), {
    requiredScopes: ["tasks:execute"],
  });
  const client = new A2AClient({
    identity: clientIdentity,
    transport: new InMemoryTransport(bounded),
    requestedScopes: ["tasks:execute"],
  });

  for (let index = 0; index < 50; index += 1) {
    await client.send({
      kind: "request",
      recipient: bounded.identity.agentId,
      conversationId: `conversation-${index}`,
      payload: { index },
    });
  }

  const internals = bounded as unknown as {
    processed: Map<string, unknown>;
    sequenceByConversation: Map<string, number>;
  };
  assert.equal(internals.processed.size, 4);
  assert.equal(internals.sequenceByConversation.size, 4);
});

test("the in-memory transport applies the same wire validation as HTTP", async () => {
  const { node } = createFixture();
  const transport = new InMemoryTransport(node);

  for (const malformed of [
    null,
    { agentId: "agent://worker", keyId: "key" },
    { agentId: "agent://worker", keyId: "key", requestedScopes: "tasks" },
    { requestedScopes: [] },
  ]) {
    await assert.rejects(
      () => transport.requestChallenge(malformed as ChallengeRequest),
      (error: unknown) =>
        error instanceof A2AError &&
        error.code === ErrorCode.InvalidMessage &&
        !(error instanceof TypeError),
      `expected a protocol error for ${JSON.stringify(malformed)}`,
    );
  }

  for (const malformed of [
    { challengeId: 12_345 },
    { challengeId: "challenge-1", signature: "not base64url!" },
  ]) {
    await assert.rejects(
      () => transport.verifyChallenge(malformed as ChallengeVerification),
      (error: unknown) =>
        error instanceof A2AError &&
        error.code === ErrorCode.InvalidMessage &&
        !(error instanceof TypeError),
      `expected a protocol error for ${JSON.stringify(malformed)}`,
    );
  }
});

test("aborting a send cancels the in-flight request instead of waiting it out", async () => {
  const { clientIdentity, node, serverIdentity } = createFixture();
  let deliveries = 0;
  // Held open rather than slept on, so the handler cannot finish early and no
  // timer is left behind after the test.
  let releaseHandler = (): void => undefined;
  const handlerGate = new Promise<void>((resolveGate) => {
    releaseHandler = resolveGate;
  });
  node.registerHandler(
    "request",
    async () => {
      deliveries += 1;
      await handlerGate;
      return { payload: { ok: true } };
    },
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
      transport: new HttpTransport(`http://127.0.0.1:${address.port}`, {
        // Long enough that a request which ignored cancellation would hang
        // well past the assertions below.
        requestTimeoutMs: 30_000,
      }),
      requestedScopes: ["tasks:execute"],
      expectedAgentId: serverIdentity.agentId,
      trustedServerKeys: {
        [serverIdentity.keyId]: serverIdentity.publicKey,
      },
      retryPolicy: { maxAttempts: 4, initialDelayMs: 1, jitterRatio: 0 },
    });

    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = client.send(
      {
        kind: "request",
        recipient: serverIdentity.agentId,
        payload: { task: "slow" },
      },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error("caller cancelled")), 150);

    await assert.rejects(
      () => pending,
      (error: unknown) => {
        // A caller cancellation is not a transport failure, so it must not be
        // reported as a retriable A2AError.
        assert.ok(
          !(error instanceof A2AError),
          `expected the abort reason, received ${String(error)}`,
        );
        assert.equal((error as Error).message, "caller cancelled");
        return true;
      },
    );

    assert.ok(
      Date.now() - startedAt < 5_000,
      "send must not wait out the request timeout after an abort",
    );
    // The retry budget must not be spent on work the caller cancelled.
    assert.equal(deliveries, 1);
  } finally {
    releaseHandler();
    await new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("the in-memory transport refuses a pre-aborted send before the handler runs", async () => {
  const { clientIdentity, node } = createFixture();
  let invocations = 0;
  node.registerHandler("request", () => {
    invocations += 1;
    return { payload: { ok: true } };
  });
  const transport = new InMemoryTransport(node);
  const client = new A2AClient({
    identity: clientIdentity,
    transport,
    requestedScopes: ["tasks:execute"],
  });
  await client.connect();

  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));

  await assert.rejects(
    () =>
      client.send(
        { kind: "request", recipient: node.identity.agentId, payload: {} },
        { signal: controller.signal },
      ),
    (error: unknown) => (error as Error).message === "caller cancelled",
  );
  assert.equal(invocations, 0);
});

test("a retriable transport failure still consumes the retry budget", async () => {
  const { clientIdentity, node } = createFixture();
  node.registerHandler("request", () => ({ payload: { ok: true } }));
  const inner = new InMemoryTransport(node);
  let attempts = 0;
  const transport = new FailingTransport(inner, () => {
    attempts += 1;
    return true;
  });
  const client = new A2AClient({
    identity: clientIdentity,
    transport,
    requestedScopes: ["tasks:execute"],
    retryPolicy: { maxAttempts: 3, initialDelayMs: 1, jitterRatio: 0 },
  });

  // Guards the distinction the abort fix relies on: a retriable transport
  // failure must keep being retried rather than being swallowed as a cancel.
  await assert.rejects(
    () =>
      client.send({
        kind: "request",
        recipient: node.identity.agentId,
        payload: {},
      }),
    (error: unknown) => error instanceof A2AError && error.retriable,
  );
  assert.equal(attempts, 3);
});

class FailingTransport implements ClientTransport {
  constructor(
    private readonly inner: ClientTransport,
    private readonly shouldFail: () => boolean,
  ) {}

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
    if (this.shouldFail()) {
      throw new A2AError(
        ErrorCode.TransportFailed,
        "Simulated timeout",
        { status: 503, retriable: true },
      );
    }
    return this.inner.send(message, bearerToken);
  }
}

class Single401Transport implements ClientTransport {
  sendCount = 0;

  constructor(
    private readonly inner: ClientTransport,
    private readonly shouldReject: () => boolean,
  ) {}

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
    if (this.shouldReject()) {
      throw new A2AError(
        ErrorCode.AuthenticationRequired,
        "Simulated expired session",
        { status: 401 },
      );
    }
    return this.inner.send(message, bearerToken);
  }
}

class HostileAckTransport implements ClientTransport {
  constructor(
    private readonly inner: ClientTransport,
    private readonly serverIdentity: SigningIdentity,
  ) {}

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
    await this.inner.send(message, bearerToken);
    // Re-signs a null payload with the trusted server key, so the signature
    // check passes and only the acknowledgement shape is invalid.
    return {
      ack: createSignedMessage(this.serverIdentity, {
        kind: "ack",
        recipient: message.sender,
        payload: null as unknown as AckPayload,
        correlationId: message.id,
        conversationId: "hostile",
      }),
      messages: [],
    };
  }
}

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
