import type { LocalRuntimeSnapshot } from "./runtime-node-state.js";

export const NodeRuntimeStateStoreToken = Symbol.for(
  "runtime.NodeRuntimeStateStore",
);

export interface NodeRuntimeStateStore {
  publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void>;
}
