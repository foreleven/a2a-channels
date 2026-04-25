import { inject, injectable } from "inversify";
import type {
  AgentConfigSnapshot,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";

import { ConnectionManager } from "./connection-manager.js";
import { RuntimeOwnershipState } from "./ownership-state.js";
import {
  RuntimeOwnershipGate,
  type OwnershipGate,
  type OwnershipLease,
} from "./ownership-gate.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";
import { RuntimeOpenClawConfigProjection } from "./runtime-openclaw-config-projection.js";
import type { RuntimeConnectionStatus } from "./runtime-connection-status.js";

type AgentConfig = AgentConfigSnapshot;
type ChannelBinding = ChannelBindingSnapshot;

/** Options that prevent duplicate restarts while an agent-triggered assignment is in progress. */
interface ApplyAgentUpsertOptions {
  skipRestartBindingIds?: string[];
}

/** Applies runtime assignment commands to local ownership and connections. */
@injectable()
export class RuntimeAssignmentService {
  private readonly leases = new Map<string, OwnershipLease>();

  /** Receives ownership, state, connection, and projection collaborators from the container. */
  constructor(
    @inject(RuntimeAgentRegistry)
    private readonly agentRegistry: RuntimeAgentRegistry,
    @inject(RuntimeOpenClawConfigProjection)
    private readonly openClawConfigProjection: RuntimeOpenClawConfigProjection,
    @inject(RuntimeOwnershipState)
    private readonly ownershipState: RuntimeOwnershipState,
    @inject(RuntimeOwnershipGate)
    private readonly ownershipGate: OwnershipGate,
    @inject(ConnectionManager)
    private readonly connectionManager: ConnectionManager,
  ) {}

  /** Acquires ownership for a binding, updates its agent if needed, and reconciles connection state. */
  async assignBinding(
    binding: ChannelBinding,
    agent: AgentConfig,
  ): Promise<void> {
    if (!(await this.acquireBindingLease(binding.id))) {
      return;
    }

    const previousAgent = this.agentRegistry.getAgent(agent.id);
    const agentChanged =
      !previousAgent ||
      previousAgent.url !== agent.url ||
      previousAgent.protocol !== agent.protocol;

    if (agentChanged) {
      await this.applyAgentUpsert(agent, {
        skipRestartBindingIds: [binding.id],
      });
    }

    await this.applyBindingUpsert(binding, { forceRestart: agentChanged });
  }

  /** Releases local ownership, stops the connection, and removes the binding from projections. */
  async releaseBinding(bindingId: string): Promise<void> {
    if (!this.ownershipState.getOwnedBinding(bindingId)) {
      await this.releaseBindingLease(bindingId);
      return;
    }

    this.ownershipState.clearReconnect(bindingId);
    await this.connectionManager.stopConnection(bindingId);
    await this.releaseBindingLease(bindingId);

    if (!this.ownershipState.releaseBinding(bindingId)) {
      return;
    }

    this.openClawConfigProjection.rebuild();
  }

  /** Stores an agent snapshot and restarts owned bindings that route through it. */
  async applyAgentUpsert(
    agent: AgentConfig,
    options: ApplyAgentUpsertOptions = {},
  ): Promise<void> {
    await this.agentRegistry.upsertAgent(agent);
    this.openClawConfigProjection.rebuild();

    const affectedBindings = this.listBindings().filter(
      (binding) =>
        binding.agentId === agent.id &&
        !options.skipRestartBindingIds?.includes(binding.id),
    );

    for (const binding of affectedBindings) {
      await this.applyBindingUpsert(binding, { forceRestart: true });
    }
  }

  /** Lists owned bindings in creation order for stable projection and API output. */
  listBindings(): ChannelBinding[] {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** Lists owned bindings that should currently be represented as active channel config. */
  listEnabledBindings(): ChannelBinding[] {
    return this.listBindings().filter((binding) => binding.enabled);
  }

  /** Lists binding ids currently owned by this runtime node. */
  listOwnedBindingIds(): string[] {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding.id);
  }

  /** Returns cloned connection status snapshots for all owned bindings. */
  listConnectionStatuses(): RuntimeConnectionStatus[] {
    return this.ownershipState.listConnectionStatuses();
  }

  /** Cancels pending reconnect timers before relay shutdown or ownership cleanup. */
  clearReconnectsForOwnedBindings(): void {
    for (const bindingId of this.listOwnedBindingIds()) {
      this.ownershipState.clearReconnect(bindingId);
    }
  }

  /** Applies connection callbacks to ownership state and schedules retries when needed. */
  handleOwnedConnectionStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    options: {
      agentUrl?: string;
      error?: unknown;
      restartConnection: (binding: ChannelBinding) => Promise<void>;
    },
  ): void {
    if (!this.ownershipState.getOwnedBinding(bindingId)) {
      return;
    }

    switch (status) {
      case "connecting":
        this.ownershipState.markConnecting(bindingId, options.agentUrl);
        break;
      case "connected":
        this.ownershipState.markConnected(bindingId, options.agentUrl);
        break;
      case "disconnected": {
        const decision = this.ownershipState.markDisconnected(
          bindingId,
          options.agentUrl,
        );
        this.scheduleReconnect(
          bindingId,
          decision.delayMs,
          options.restartConnection,
        );
        break;
      }
      case "error": {
        const decision = this.ownershipState.markError(
          bindingId,
          options.error ?? new Error("Unknown connection error"),
          options.agentUrl,
        );
        this.scheduleReconnect(
          bindingId,
          decision.delayMs,
          options.restartConnection,
        );
        break;
      }
      case "idle":
        this.ownershipState.markIdle(bindingId);
        break;
    }
  }

  /** Updates owned binding state, rebuilds projected config, and starts/stops as required. */
  private async applyBindingUpsert(
    binding: ChannelBinding,
    options: { forceRestart?: boolean } = {},
  ): Promise<void> {
    const ownershipUpdate = this.ownershipState.upsertBinding(binding, {
      forceRestart: options.forceRestart ?? false,
      hasActiveConnection: this.connectionManager.hasConnection(binding.id),
    });

    this.openClawConfigProjection.rebuild();

    if (ownershipUpdate.shouldStop) {
      this.ownershipState.clearReconnect(binding.id);
      await this.connectionManager.stopConnection(binding.id);
      return;
    }

    if (!ownershipUpdate.shouldRestart) {
      return;
    }

    this.ownershipState.clearReconnect(binding.id);
    await this.connectionManager.restartConnection(binding);
  }

  /** Acquires or renews the distributed/local lease before this node mutates binding state. */
  private async acquireBindingLease(bindingId: string): Promise<boolean> {
    const existingLease = this.leases.get(bindingId);
    if (existingLease) {
      const renewed = await this.ownershipGate.renew(existingLease);
      if (renewed) {
        return true;
      }

      this.leases.delete(bindingId);
      if (this.ownershipState.getOwnedBinding(bindingId)) {
        await this.releaseBinding(bindingId);
      }
      return false;
    }

    if (this.ownershipState.getOwnedBinding(bindingId)) {
      return true;
    }

    const lease = await this.ownershipGate.acquire(bindingId);
    if (!lease) {
      return false;
    }

    this.leases.set(bindingId, lease);
    return true;
  }

  /** Releases the stored ownership lease and logs release failures without masking cleanup. */
  private async releaseBindingLease(bindingId: string): Promise<void> {
    const lease = this.leases.get(bindingId);
    if (!lease) {
      return;
    }

    this.leases.delete(bindingId);
    try {
      await this.ownershipGate.release(lease);
    } catch (error) {
      console.error(
        `[runtime] failed to release ownership lease for binding ${bindingId}:`,
        error,
      );
    }
  }

  /** Registers a delayed restart that rechecks latest ownership and enabled state before firing. */
  private scheduleReconnect(
    bindingId: string,
    delayMs: number,
    restartConnection: (binding: ChannelBinding) => Promise<void>,
  ): void {
    this.ownershipState.scheduleReconnect(bindingId, delayMs, async () => {
      const latestOwnedBinding = this.ownershipState.getOwnedBinding(bindingId);
      if (!latestOwnedBinding) {
        return;
      }

      const latestBinding = latestOwnedBinding.binding;
      if (!latestBinding.enabled) {
        return;
      }

      await restartConnection(latestBinding);
    });
  }

}
