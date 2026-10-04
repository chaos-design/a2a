import { canonicalJson, cloneJson, isJsonValue } from "./canonical-json.js";
import { A2AError, ErrorCode } from "./errors.js";
import type { A2ANode } from "./node.js";
import type {
  JsonValue,
  StateDelta,
  StateEntry,
  StateSnapshot,
  VectorClock,
} from "./types.js";

export type ClockRelation = "before" | "after" | "equal" | "concurrent";

function assertClock(value: unknown, name: string): asserts value is VectorClock {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new A2AError(ErrorCode.InvalidMessage, `${name} must be an object`, {
      status: 400,
    });
  }
  for (const [agentId, counter] of Object.entries(value)) {
    if (
      agentId.length === 0 ||
      !Number.isSafeInteger(counter) ||
      (counter as number) < 0
    ) {
      throw new A2AError(
        ErrorCode.InvalidMessage,
        `${name} contains an invalid vector-clock component`,
        { status: 400 },
      );
    }
  }
}

function assertEntry(value: unknown): asserts value is StateEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new A2AError(
      ErrorCode.InvalidMessage,
      "State entry must be an object",
      { status: 400 },
    );
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.key !== "string" || entry.key.length === 0) {
    throw new A2AError(
      ErrorCode.InvalidMessage,
      "State entry key must be a non-empty string",
      { status: 400 },
    );
  }
  if (!isJsonValue(entry.value)) {
    throw new A2AError(
      ErrorCode.InvalidMessage,
      "State entry value must be JSON",
      { status: 400 },
    );
  }
  assertClock(entry.clock, "State entry clock");
  if (
    typeof entry.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(entry.updatedAt)) ||
    typeof entry.updatedBy !== "string" ||
    entry.updatedBy.length === 0 ||
    (entry.tombstone !== undefined && typeof entry.tombstone !== "boolean")
  ) {
    throw new A2AError(
      ErrorCode.InvalidMessage,
      "State entry metadata is invalid",
      { status: 400 },
    );
  }
}

function assertSyncDocument(
  value: unknown,
  expectedType: "delta" | "snapshot",
): asserts value is StateDelta | StateSnapshot {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new A2AError(
      ErrorCode.InvalidMessage,
      `State ${expectedType} must be an object`,
      { status: 400 },
    );
  }
  const document = value as Record<string, unknown>;
  if (
    typeof document.namespace !== "string" ||
    document.namespace.length === 0
  ) {
    throw new A2AError(
      ErrorCode.InvalidMessage,
      "State namespace must be a non-empty string",
      { status: 400 },
    );
  }
  assertClock(document.clock, "State clock");
  if (expectedType === "delta") {
    assertClock(document.baseClock, "State base clock");
  }
  if (!Array.isArray(expectedType === "delta" ? document.changes : document.entries)) {
    throw new A2AError(
      ErrorCode.InvalidMessage,
      `State ${expectedType} entries must be an array`,
      { status: 400 },
    );
  }
  const entries =
    expectedType === "delta" ? document.changes : document.entries;
  for (const entry of entries as unknown[]) {
    assertEntry(entry);
  }
}

export function compareVectorClocks(
  left: VectorClock,
  right: VectorClock,
): ClockRelation {
  let leftGreater = false;
  let rightGreater = false;
  const agents = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const agentId of agents) {
    const leftValue = left[agentId] ?? 0;
    const rightValue = right[agentId] ?? 0;
    leftGreater ||= leftValue > rightValue;
    rightGreater ||= rightValue > leftValue;
  }
  if (leftGreater && rightGreater) {
    return "concurrent";
  }
  if (leftGreater) {
    return "after";
  }
  if (rightGreater) {
    return "before";
  }
  return "equal";
}

export function mergeVectorClocks(
  left: VectorClock,
  right: VectorClock,
): VectorClock {
  const merged: VectorClock = {};
  for (const agentId of new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])) {
    merged[agentId] = Math.max(left[agentId] ?? 0, right[agentId] ?? 0);
  }
  return merged;
}

function selectConcurrentEntry(
  local: StateEntry,
  incoming: StateEntry,
): StateEntry {
  if (incoming.updatedAt !== local.updatedAt) {
    return incoming.updatedAt > local.updatedAt ? incoming : local;
  }
  if (incoming.updatedBy !== local.updatedBy) {
    return incoming.updatedBy > local.updatedBy ? incoming : local;
  }
  return canonicalJson(incoming) > canonicalJson(local) ? incoming : local;
}

export class ReplicatedState {
  private clock: VectorClock = {};
  private readonly entries = new Map<string, StateEntry>();

  constructor(
    readonly agentId: string,
    readonly namespace: string,
    initial?: StateSnapshot,
  ) {
    if (initial) {
      this.applySnapshot(initial);
    }
  }

  get(key: string): JsonValue | undefined {
    const entry = this.entries.get(key);
    return entry && !entry.tombstone ? cloneJson(entry.value) : undefined;
  }

  has(key: string): boolean {
    const entry = this.entries.get(key);
    return entry !== undefined && !entry.tombstone;
  }

  set(key: string, value: JsonValue, now = new Date()): StateEntry {
    if (key.length === 0 || !isJsonValue(value)) {
      throw new A2AError(
        ErrorCode.InvalidMessage,
        "State key and value must be valid",
        { status: 400 },
      );
    }
    this.tick();
    const entry: StateEntry = {
      key,
      value: cloneJson(value),
      clock: { ...this.clock },
      updatedAt: now.toISOString(),
      updatedBy: this.agentId,
    };
    this.entries.set(key, entry);
    return cloneJson(entry);
  }

  delete(key: string, now = new Date()): StateEntry {
    this.tick();
    const entry: StateEntry = {
      key,
      value: null,
      clock: { ...this.clock },
      updatedAt: now.toISOString(),
      updatedBy: this.agentId,
      tombstone: true,
    };
    this.entries.set(key, entry);
    return cloneJson(entry);
  }

  createDelta(since: VectorClock = {}): StateDelta {
    assertClock(since, "Delta cursor");
    const changes = [...this.entries.values()]
      .filter(
        (entry) => compareVectorClocks(entry.clock, since) !== "before" &&
          compareVectorClocks(entry.clock, since) !== "equal",
      )
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((entry) => cloneJson(entry));
    return {
      namespace: this.namespace,
      baseClock: { ...since },
      clock: { ...this.clock },
      changes,
    };
  }

  snapshot(): StateSnapshot {
    return {
      namespace: this.namespace,
      clock: { ...this.clock },
      entries: [...this.entries.values()]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((entry) => cloneJson(entry)),
    };
  }

  applyDelta(delta: StateDelta): number {
    assertSyncDocument(delta, "delta");
    this.assertNamespace(delta.namespace);
    const applied = this.mergeEntries(delta.changes);
    this.clock = mergeVectorClocks(this.clock, delta.clock);
    return applied;
  }

  applySnapshot(snapshot: StateSnapshot): number {
    assertSyncDocument(snapshot, "snapshot");
    this.assertNamespace(snapshot.namespace);
    const applied = this.mergeEntries(snapshot.entries);
    this.clock = mergeVectorClocks(this.clock, snapshot.clock);
    return applied;
  }

  private mergeEntries(incomingEntries: StateEntry[]): number {
    let applied = 0;
    for (const rawEntry of incomingEntries) {
      const incoming = cloneJson(rawEntry);
      const local = this.entries.get(incoming.key);
      if (!local) {
        this.entries.set(incoming.key, incoming);
        applied += 1;
        continue;
      }

      const relation = compareVectorClocks(incoming.clock, local.clock);
      if (
        relation === "after" ||
        (relation === "concurrent" &&
          selectConcurrentEntry(local, incoming) === incoming)
      ) {
        this.entries.set(incoming.key, incoming);
        applied += 1;
      }
    }
    return applied;
  }

  private tick(): void {
    this.clock[this.agentId] = (this.clock[this.agentId] ?? 0) + 1;
  }

  private assertNamespace(namespace: string): void {
    if (namespace !== this.namespace) {
      throw new A2AError(
        ErrorCode.Conflict,
        `State namespace ${namespace} does not match ${this.namespace}`,
        { status: 409 },
      );
    }
  }
}

/**
 * Result payload returned by the `state-delta` handler.
 *
 * `delta` is a well-formed `StateDelta` describing everything the receiver is
 * missing, so it can be forwarded to `applyDelta` unchanged. `applied` is
 * reported separately rather than merged into the delta, which would otherwise
 * produce an object that only satisfies `StateDelta` by accident of the
 * permissive wire validator.
 */
export type StateSyncResult = {
  namespace: string;
  clock: VectorClock;
  applied: number;
  delta?: StateDelta;
};

export function registerStateSyncHandlers(
  node: A2ANode,
  state: ReplicatedState,
  requiredScope = "state:sync",
): () => void {
  const removeDelta = node.registerHandler(
    "state-delta",
    ({ message }) => {
      const delta = message.payload as unknown as StateDelta;
      const applied = state.applyDelta(delta);
      return {
        kind: "state-delta",
        payload: {
          namespace: state.namespace,
          clock: state.snapshot().clock,
          applied,
          delta: state.createDelta(delta.clock),
        } satisfies StateSyncResult,
      };
    },
    { requiredScopes: [requiredScope] },
  );
  const removeSnapshot = node.registerHandler(
    "state-snapshot",
    ({ message }) => {
      const applied = state.applySnapshot(
        message.payload as unknown as StateSnapshot,
      );
      return {
        payload: {
          namespace: state.namespace,
          clock: state.snapshot().clock,
          applied,
        } satisfies StateSyncResult,
      };
    },
    { requiredScopes: [requiredScope] },
  );
  return () => {
    removeDelta();
    removeSnapshot();
  };
}
