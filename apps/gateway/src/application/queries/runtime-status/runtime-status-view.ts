import type { RuntimeConnectionStatus } from "../../../runtime/runtime-connection-status.js";
import type { LocalRuntimeSnapshot } from "../../../runtime/runtime-node-state.js";

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
