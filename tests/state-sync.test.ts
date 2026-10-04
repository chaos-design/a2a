import assert from "node:assert/strict";
import test from "node:test";
import {
  ReplicatedState,
  compareVectorClocks,
  mergeVectorClocks,
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
