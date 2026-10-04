import {
  A2AClient,
  AgentProvider,
  HttpTransport,
  PeerRegistry,
  generateSigningIdentity,
} from "../src/index.js";

const environment = { ...process.env };
if (process.env.A2A_DEMO_PORT) {
  environment.A2A_LISTEN_PORT = process.env.A2A_DEMO_PORT;
  environment.A2A_ENDPOINT ??=
    `http://127.0.0.1:${process.env.A2A_DEMO_PORT}`;
}
const provider = new AgentProvider({ environment });
const config = provider.getConfig();
const coordinatorIdentity = provider.identity;
const workerIdentity = generateSigningIdentity("agent://worker");

const peers = new PeerRegistry();
peers.register({
  agentId: workerIdentity.agentId,
  keyId: workerIdentity.keyId,
  publicKey: workerIdentity.publicKey,
  grantedScopes: ["tasks:execute"],
});

const coordinator = provider.createNode({
  peers,
  capabilities: [
    {
      name: "summarize",
      description: "Produces a compact summary of supplied text.",
      messageKinds: ["request"],
      requiredScopes: ["tasks:execute"],
    },
  ],
});

coordinator.registerHandler(
  "request",
  ({ message }) => {
    const payload = message.payload as { text: string };
    return {
      payload: {
        summary: payload.text.split(/\s+/).slice(0, 8).join(" "),
        processedBy: coordinator.identity.agentId,
      },
    };
  },
  { requiredScopes: ["tasks:execute"] },
);

const server = await provider.listen(coordinator);

try {
  const worker = new A2AClient({
    identity: workerIdentity,
    transport: new HttpTransport(config.endpoint),
    requestedScopes: ["tasks:execute"],
    expectedAgentId: coordinator.identity.agentId,
    trustedServerKeys: {
      [coordinatorIdentity.keyId]: coordinatorIdentity.publicKey,
    },
  });

  const card = await worker.connect();
  const delivery = await worker.send({
    kind: "request",
    recipient: card.agentId,
    conversationId: "demo-conversation",
    idempotencyKey: "demo-request-1",
    payload: {
      text: "A2A messages are authenticated, authorized, signed, and retried safely.",
    },
  });

  console.log(
    JSON.stringify(
      {
        remoteAgent: card.agentId,
        acknowledgement: delivery.ack.payload,
        response: delivery.messages[0]?.payload,
      },
      null,
      2,
    ),
  );
} finally {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
