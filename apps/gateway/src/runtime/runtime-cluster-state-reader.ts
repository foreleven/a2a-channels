import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";
import { inject, injectable } from "inversify";

import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import type { RuntimeNodeStateRecord } from "../infra/runtime-node-repo.js";
import {
  NodeRuntimeStateStoreToken,
  type NodeRuntimeStateStore,
  type RuntimeConnectionListItem,
  type RuntimeNodeListItem,
} from "./node-runtime-state-store.js";
import type { LocalRuntimeSnapshot } from "./runtime-node-state.js";

interface BindingOwner {
  nodeId: string;
  status: RuntimeConnectionListItem["status"];
  updatedAt: string;
  agentUrl?: string;
}

@injectable()
export class RuntimeClusterStateReader {
  constructor(
    @inject(ChannelBindingRepository)
    private readonly bindingRepository: ChannelBindingRepository,
    @inject(AgentConfigRepository)
    private readonly agentRepository: AgentConfigRepository,
    @inject(RuntimeNodeStateRepository)
    private readonly runtimeNodeRepository: RuntimeNodeStateRepository,
    @inject(NodeRuntimeStateStoreToken)
    private readonly stateStore: NodeRuntimeStateStore,
  ) {}

  async listNodes(): Promise<RuntimeNodeListItem[]> {
    const [records, snapshots] = await Promise.all([
      this.runtimeNodeRepository.list(),
      this.readSnapshots(),
    ]);

    const snapshotsByNodeId = this.buildLatestSnapshotByNodeId(snapshots);
    const items = records.map((record) =>
      this.buildNodeListItem(record, snapshotsByNodeId.get(record.nodeId)),
    );

    const knownNodeIds = new Set(records.map((record) => record.nodeId));
    for (const snapshot of snapshotsByNodeId.values()) {
      if (knownNodeIds.has(snapshot.nodeId)) {
        continue;
      }
      items.push(this.buildNodeListItem(null, snapshot));
    }

    return items;
  }

  async listConnections(): Promise<RuntimeConnectionListItem[]> {
    const [bindings, agents, snapshots] = await Promise.all([
      this.bindingRepository.findAll(),
      this.agentRepository.findAll(),
      this.readSnapshots(),
    ]);
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const latestSnapshotsByNodeId = this.buildLatestSnapshotByNodeId(snapshots);
    const ownerByBindingId = this.buildOwnerByBindingId(
      Array.from(latestSnapshotsByNodeId.values()),
    );

    return bindings.map((binding) => {
      const agent = agentById.get(binding.agentId);
      const owner = ownerByBindingId.get(binding.id);

      return {
        bindingId: binding.id,
        bindingName: binding.name,
        channelType: binding.channelType,
        accountId: binding.accountId,
        agentId: binding.agentId,
        agentUrl: owner?.agentUrl ?? agent?.url,
        ownerNodeId: owner?.nodeId ?? null,
        status: owner?.status ?? "idle",
        updatedAt: owner?.updatedAt ?? null,
      };
    });
  }

  private buildNodeListItem(
    record: RuntimeNodeStateRecord | null,
    snapshot?: LocalRuntimeSnapshot,
  ): RuntimeNodeListItem {
    const updatedAt = snapshot?.updatedAt ?? record?.updatedAt.toISOString();
    if (!updatedAt) {
      throw new Error("Runtime node projection requires a record or snapshot");
    }

    return {
      nodeId: snapshot?.nodeId ?? record?.nodeId ?? "",
      displayName: snapshot?.displayName ?? record?.displayName ?? "",
      mode: snapshot?.mode ?? this.mapRecordMode(record),
      lastKnownAddress: snapshot?.lastKnownAddress ?? record?.lastKnownAddress ?? "",
      lifecycle: snapshot?.lifecycle ?? "stopped",
      bindingCount: snapshot?.bindingStatuses.length ?? 0,
      updatedAt,
    };
  }

  private buildOwnerByBindingId(
    snapshots: LocalRuntimeSnapshot[],
  ): Map<string, BindingOwner> {
    const ownerByBindingId = new Map<string, BindingOwner>();

    for (const snapshot of snapshots) {
      for (const status of snapshot.bindingStatuses) {
        const current = ownerByBindingId.get(status.bindingId);
        if (current && current.updatedAt >= status.updatedAt) {
          continue;
        }

        ownerByBindingId.set(status.bindingId, {
          nodeId: snapshot.nodeId,
          status: status.status,
          updatedAt: status.updatedAt,
          agentUrl: status.agentUrl,
        });
      }
    }

    return ownerByBindingId;
  }

  private buildLatestSnapshotByNodeId(
    snapshots: LocalRuntimeSnapshot[],
  ): Map<string, LocalRuntimeSnapshot> {
    const snapshotsByNodeId = new Map<string, LocalRuntimeSnapshot>();

    for (const snapshot of snapshots) {
      const current = snapshotsByNodeId.get(snapshot.nodeId);
      if (current && current.updatedAt >= snapshot.updatedAt) {
        continue;
      }

      snapshotsByNodeId.set(snapshot.nodeId, snapshot);
    }

    return snapshotsByNodeId;
  }

  private mapRecordMode(
    record: RuntimeNodeStateRecord | null,
  ): RuntimeNodeListItem["mode"] {
    return record?.mode === "cluster" ? "cluster" : "local";
  }

  private async readSnapshots(): Promise<LocalRuntimeSnapshot[]> {
    if (typeof this.stateStore.listNodeSnapshots !== "function") {
      return [];
    }

    const snapshots = await this.stateStore.listNodeSnapshots();
    return snapshots.map(cloneSnapshot);
  }
}

function cloneSnapshot(snapshot: LocalRuntimeSnapshot): LocalRuntimeSnapshot {
  return {
    ...snapshot,
    bindingStatuses: snapshot.bindingStatuses.map((status) => ({ ...status })),
  };
}
