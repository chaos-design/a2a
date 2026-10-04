import assert from "node:assert/strict";
import test from "node:test";
import {
  A2AClient,
  A2ANode,
  InMemoryTransport,
  PeerRegistry,
  ReplicatedState,
  compareVectorClocks,
  generateSigningIdentity,
  mergeVectorClocks,
  registerStateSyncHandlers,
  type StateDelta,
  type StateSyncResult,
} from "../src/index.js";

test("vector clocks distinguish causal and concurrent updates", () => {
  assert.equal(compareVectorClocks({ a: 1 }, { a: 2 }), "before");
  assert.equal(compareVectorClocks({ a: 2 }, { a: 1 }), "after");
  assert.equal(compareVectorClocks({ a: 1 }, { a: 1 }), "equal");
  assert.equal(
    compareVectorClocks({ a: 2, b: 0 }, { a: 1, b: 1 }),
    "concurrent",
  );
  assert.deepEqual(
    mergeVectorClocks({ a: 2, b: 1 }, { a: 1, c: 3 }),
    { a: 2, b: 1, c: 3 },
  );
});

test("concurrent state changes converge deterministically", () => {
  const alpha = new ReplicatedState("agent://alpha", "workflow");
  const beta = new ReplicatedState("agent://beta", "workflow");
  const timestamp = new Date("2026-09-07T10:00:00.000Z");
  alpha.set("status", "from-alpha", timestamp);
  beta.set("status", "from-beta", timestamp);

  const alphaDelta = alpha.createDelta();
  const betaDelta = beta.createDelta();
  alpha.applyDelta(betaDelta);
  beta.applyDelta(alphaDelta);

  assert.equal(alpha.get("status"), "from-beta");
  assert.equal(beta.get("status"), "from-beta");
  assert.deepEqual(alpha.snapshot(), beta.snapshot());
});

test("the state-delta reply carries a reusable delta beside its counters", async () => {
  const serverIdentity = generateSigningIdentity("agent://coordinator");
  const clientIdentity = generateSigningIdentity("agent://worker");
  const peers = new PeerRegistry();
  peers.register({
    agentId: clientIdentity.agentId,
    keyId: clientIdentity.keyId,
    publicKey: clientIdentity.publicKey,
    grantedScopes: ["state:sync"],
  });
  const node = new A2ANode({
    identity: serverIdentity,
    peers,
    name: "Coordinator",
    endpoint: "http://127.0.0.1:4310",
  });
  const state = new ReplicatedState("agent://coordinator", "workflow");
  registerStateSyncHandlers(node, state);
  state.set("step", 1);

  const client = new A2AClient({
    identity: clientIdentity,
    transport: new InMemoryTransport(node),
    requestedScopes: ["state:sync"],
  });
  const delivery = await client.send({
    kind: "state-delta",
    recipient: serverIdentity.agentId,
    payload: { namespace: "workflow", baseClock: {}, clock: {}, changes: [] },
  });

  const result = delivery.messages[0]?.payload as StateSyncResult;
  assert.equal(result.namespace, "workflow");
  assert.equal(result.applied, 0);
  assert.equal(typeof result.clock["agent://coordinator"], "number");

  // The nested delta must be a self-contained StateDelta that can be applied
  // directly, rather than the whole reply being shaped like one by accident.
  const delta = result.delta as StateDelta;
  assert.equal(delta.namespace, "workflow");
  assert.deepEqual(Object.keys(delta).sort(), [
    "baseClock",
    "changes",
    "clock",
    "namespace",
  ]);

  const receiver = new ReplicatedState("agent://worker", "workflow");
  receiver.applyDelta(delta);
  assert.equal(receiver.get("step"), 1);
});

test("causally newer updates and tombstones propagate as deltas", () => {
  const alpha = new ReplicatedState("agent://alpha", "workflow");
  const beta = new ReplicatedState("agent://beta", "workflow");
  alpha.set("step", 1);
  beta.applyDelta(alpha.createDelta());
  const betaCursor = beta.snapshot().clock;

  alpha.set("step", 2);
  alpha.set("temporary", true);
  alpha.delete("temporary");
  const delta = alpha.createDelta(betaCursor);
  assert.equal(delta.changes.length, 2);
  beta.applyDelta(delta);

  assert.equal(beta.get("step"), 2);
  assert.equal(beta.has("temporary"), false);
  assert.deepEqual(beta.snapshot().clock, alpha.snapshot().clock);
});
