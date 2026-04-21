import type { NodeRuntimeStateStore } from "./node-runtime-state-store.js";
import type { LocalRuntimeSnapshot } from "./runtime-node-state.js";

export class LocalNodeRuntimeStateStore implements NodeRuntimeStateStore {
  private readonly snapshots: LocalRuntimeSnapshot[] = [];

  async publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void> {
    this.snapshots.unshift(cloneSnapshot(snapshot));
  }

  listNodeSnapshots(): LocalRuntimeSnapshot[] {
    return this.snapshots.map(cloneSnapshot);
  }
}

function cloneSnapshot(snapshot: LocalRuntimeSnapshot): LocalRuntimeSnapshot {
  return {
    ...snapshot,
    bindingStatuses: snapshot.bindingStatuses.map((status) => ({ ...status })),
  };
}
