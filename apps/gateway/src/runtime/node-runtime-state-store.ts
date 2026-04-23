import type { RuntimeConnectionStatus } from "@a2a-channels/core";

import type { LocalRuntimeSnapshot } from "./runtime-node-state.js";

export const NodeRuntimeStateStore = Symbol.for(
  "runtime.NodeRuntimeStateStore",
);

export interface RuntimeNodeListItem {
  nodeId: string;
  displayName: string;
  mode: LocalRuntimeSnapshot["mode"];
  schedulerRole: LocalRuntimeSnapshot["schedulerRole"];
  lastKnownAddress: string;
  lifecycle: LocalRuntimeSnapshot["lifecycle"];
  lastHeartbeatAt: string | null;
  lastError: string | null;
  bindingCount: number;
  updatedAt: string;
}

export interface RuntimeConnectionListItem {
  bindingId: string;
  bindingName: string;
  channelType: string;
  accountId: string;
  agentId: string;
  agentUrl?: string;
  ownerNodeId: string | null;
  status: RuntimeConnectionStatus["status"];
  updatedAt: string | null;
}

export interface NodeRuntimeStateStore {
  publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void>;
  listNodeSnapshots?():
    | LocalRuntimeSnapshot[]
    | Promise<LocalRuntimeSnapshot[]>;
}
