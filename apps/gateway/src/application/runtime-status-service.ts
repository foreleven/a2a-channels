import { inject, injectable } from "inversify";

import type { RuntimeConnectionStatus } from "../runtime/connection/index.js";
import { GatewayConfigService } from "../bootstrap/config.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import {
  RuntimeOwnershipGate,
  type OwnershipGate,
} from "../runtime/ownership-gate.js";
import { RuntimeAssignmentService } from "../runtime/runtime-assignment-service.js";
import { ChannelBindingService } from "./channel-binding-service.js";

export interface RuntimeNodeStatusSnapshot {
  nodeId: string;
  displayName: string;
  mode: string;
  lastKnownAddress: string;
  registeredAt: string;
  updatedAt: string;
  isCurrent: boolean;
}

export type RuntimeChannelOwnership =
  | "local"
  | "cluster-lease"
  | "unassigned"
  | "disabled";

export interface RuntimeChannelStatusSnapshot {
  bindingId: string;
  mode: "local" | "cluster";
  ownership: RuntimeChannelOwnership;
  status: RuntimeConnectionStatus["status"] | "unknown";
  ownerNodeId?: string;
  ownerDisplayName?: string;
  error?: string;
  updatedAt?: string;
  leaseHeld: boolean;
}

export interface RuntimeStatusSnapshot {
  mode: "local" | "cluster";
  currentNodeId: string;
  nodes: RuntimeNodeStatusSnapshot[];
  channels: RuntimeChannelStatusSnapshot[];
  generatedAt: string;
}

/**
 * Read model for admin runtime status.
 *
 * The service depends on narrow runtime ownership/query boundaries instead of
 * routing status reads through RelayRuntime. In cluster mode, this node only
 * knows local connection details; Redis lease presence distinguishes bindings
 * owned elsewhere from bindings that are currently unassigned.
 */
@injectable()
export class RuntimeStatusService {
  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(ChannelBindingService)
    private readonly channels: ChannelBindingService,
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(RuntimeOwnershipGate)
    private readonly ownershipGate: OwnershipGate,
    @inject(RuntimeNodeStateRepository)
    private readonly nodes: RuntimeNodeStateRepository,
  ) {}

  async getStatus(): Promise<RuntimeStatusSnapshot> {
    const [bindings, nodes] = await Promise.all([
      this.channels.list(),
      this.nodes.list(),
    ]);
    const localStatuses = new Map(
      this.assignments
        .listConnectionStatuses()
        .map((status) => [status.bindingId, status]),
    );
    const localOwnedIds = new Set(this.assignments.listOwnedBindingIds());
    const mode = this.config.clusterMode ? "cluster" : "local";

    return {
      mode,
      currentNodeId: this.config.nodeId,
      nodes: nodes.map((node) => ({
        nodeId: node.nodeId,
        displayName: node.displayName,
        mode: node.mode,
        lastKnownAddress: node.lastKnownAddress,
        registeredAt: node.registeredAt.toISOString(),
        updatedAt: node.updatedAt.toISOString(),
        isCurrent: node.nodeId === this.config.nodeId,
      })),
      channels: await Promise.all(
        bindings.map(async (binding) => {
          const localStatus = localStatuses.get(binding.id);
          const locallyOwned = localOwnedIds.has(binding.id);
          const leaseHeld = await this.ownershipGate.isHeld(binding.id);

          if (!binding.enabled) {
            return {
              bindingId: binding.id,
              mode,
              ownership: "disabled",
              status: localStatus?.status ?? "idle",
              updatedAt: localStatus?.updatedAt,
              leaseHeld,
            };
          }

          if (locallyOwned && localStatus) {
            return {
              bindingId: binding.id,
              mode,
              ownership: "local",
              status: localStatus.status,
              ownerNodeId: this.config.nodeId,
              ownerDisplayName: this.config.nodeDisplayName,
              error: localStatus.error,
              updatedAt: localStatus.updatedAt,
              leaseHeld,
            };
          }

          if (this.config.clusterMode && leaseHeld) {
            return {
              bindingId: binding.id,
              mode,
              ownership: "cluster-lease",
              status: "unknown",
              leaseHeld,
            };
          }

          return {
            bindingId: binding.id,
            mode,
            ownership: "unassigned",
            status: "idle",
            leaseHeld,
          };
        }),
      ),
      generatedAt: new Date().toISOString(),
    };
  }
}
