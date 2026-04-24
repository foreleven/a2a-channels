import type { LocalRuntimeSnapshot } from "./runtime-node-state.js";

export const NodeRuntimeSnapshotWriter = Symbol.for(
  "runtime.NodeRuntimeSnapshotWriter",
);
export const NodeRuntimeSnapshotReader = Symbol.for(
  "runtime.NodeRuntimeSnapshotReader",
);

export interface NodeRuntimeSnapshotWriter {
  publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void>;
}

export interface NodeRuntimeSnapshotReader {
  listNodeSnapshots(): LocalRuntimeSnapshot[] | Promise<LocalRuntimeSnapshot[]>;
}
