import { inject, injectable } from "inversify";
import type {
  AgentConfigSnapshot,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";

import {
  ConnectionManager,
  type ConnectionLifecycleEvent,
} from "./connection/index.js";
import { RuntimeOwnershipState } from "./ownership-state.js";
import {
  RuntimeOwnershipGate,
  type OwnershipGate,
  type OwnershipLease,
} from "./ownership-gate.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";
import { RuntimeOpenClawConfigProjection } from "./runtime-openclaw-config-projection.js";
import type { RuntimeConnectionStatus } from "./connection/index.js";

type AgentConfig = AgentConfigSnapshot;
type ChannelBinding = ChannelBindingSnapshot;

/** Suppresses restarts already covered by the current assignment command. */
interface ApplyAgentUpsertOptions {
  skipRestartBindingId?: string;
}

/**
 * Applies locally owned assignment commands.
 *
 * This service is the write boundary for this node's runtime ownership. It
 * acquires leases, updates owned binding/agent state, rebuilds OpenClaw config
 * projections, starts or stops channel connections, and reacts to connection
 * lifecycle edges by updating status and scheduling reconnects.
 */
@injectable()
export class RuntimeAssignmentService {
  private readonly leases = new Map<string, OwnershipLease>();

  /** Subscribes connection lifecycle facts into the local ownership model. */
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
  ) {
    this.connectionManager.onConnectionStatus((event) =>
      this.handleConnectionStatus(event),
    );
  }

  /** Claims a binding for this node, ensures its agent client exists, and reconciles the connection. */
  async assignBinding(
    binding: ChannelBinding,
    agent: AgentConfig,
  ): Promise<void> {
    if (!(await this.acquireBindingLease(binding.id))) {
      return;
    }

    const agentChanged = this.hasAgentConfigChanged(agent);

    if (agentChanged) {
      await this.applyAgentUpsert(agent, {
        skipRestartBindingId: binding.id,
      });
    }

    await this.applyBindingUpsert(binding, agentChanged);
  }

  /** Drops local ownership and removes every local side effect for the binding. */
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

  /** Stores an agent snapshot and restarts owned bindings whose target changed. */
  async applyAgentUpsert(
    agent: AgentConfig,
    options: ApplyAgentUpsertOptions = {},
  ): Promise<void> {
    await this.agentRegistry.upsertAgent(agent);
    this.openClawConfigProjection.rebuild();

    const affectedBindings = this.listBindings().filter(
      (binding) =>
        binding.agentId === agent.id &&
        binding.id !== options.skipRestartBindingId,
    );

    for (const binding of affectedBindings) {
      await this.applyBindingUpsert(binding, true);
    }
  }

  /** Lists locally owned binding snapshots in stable creation order. */
  listBindings(): ChannelBinding[] {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** Lists locally owned bindings that should appear in OpenClaw runtime config. */
  listEnabledBindings(): ChannelBinding[] {
    return this.listBindings().filter((binding) => binding.enabled);
  }

  /** Lists binding ids currently leased or retained by this runtime node. */
  listOwnedBindingIds(): string[] {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding.id);
  }

  /** Returns connection status snapshots for locally owned bindings. */
  listConnectionStatuses(): RuntimeConnectionStatus[] {
    return this.ownershipState.listConnectionStatuses();
  }

  /** Cancels reconnect timers before shutdown drains active connections. */
  clearReconnectsForOwnedBindings(): void {
    for (const bindingId of this.listOwnedBindingIds()) {
      this.ownershipState.clearReconnect(bindingId);
    }
  }

  /** Converts connection lifecycle facts into status state and reconnect work. */
  private handleConnectionStatus({
    binding,
    status,
    error,
  }: ConnectionLifecycleEvent): void {
    if (!this.ownershipState.getOwnedBinding(binding.id)) {
      return;
    }

    switch (status) {
      case "connecting":
        this.ownershipState.markConnecting(binding.id);
        break;
      case "connected":
        this.ownershipState.markConnected(binding.id);
        break;
      case "disconnected": {
        const decision = this.ownershipState.markDisconnected(binding.id);
        this.scheduleReconnect(binding.id, decision.delayMs);
        break;
      }
      case "error": {
        const decision = this.ownershipState.markError(
          binding.id,
          error ?? new Error("Unknown connection error"),
        );
        this.scheduleReconnect(binding.id, decision.delayMs);
        break;
      }
      case "idle":
        this.ownershipState.markIdle(binding.id);
        break;
    }
  }

  /** Applies one binding snapshot and executes the resulting connection action. */
  private async applyBindingUpsert(
    binding: ChannelBinding,
    forceRestart = false,
  ): Promise<void> {
    const ownershipUpdate = this.ownershipState.upsertBinding(binding, {
      forceRestart,
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

  /** Reports whether storing this agent changes connection routing. */
  private hasAgentConfigChanged(agent: AgentConfig): boolean {
    const previousAgent = this.agentRegistry.getAgent(agent.id);
    return (
      !previousAgent ||
      previousAgent.protocol !== agent.protocol ||
      JSON.stringify(previousAgent.config) !== JSON.stringify(agent.config)
    );
  }

  /** Acquires or renews the ownership lease before mutating local runtime state. */
  private async acquireBindingLease(bindingId: string): Promise<boolean> {
    const existingLease = this.leases.get(bindingId);
    if (existingLease) {
      const renewed = await this.ownershipGate.renew(existingLease);
      if (renewed) {
        return true;
      }

      this.leases.delete(bindingId);
      if (this.ownershipState.getOwnedBinding(bindingId)) {
        await this.dropBindingAfterLeaseLoss(bindingId);
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

  /** Releases the stored lease without masking local cleanup failures. */
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

  /** Cleans local state after a lease renewal proves this node no longer owns the binding. */
  private async dropBindingAfterLeaseLoss(bindingId: string): Promise<void> {
    this.ownershipState.clearReconnect(bindingId);
    await this.connectionManager.stopConnection(bindingId);

    if (this.ownershipState.releaseBinding(bindingId)) {
      this.openClawConfigProjection.rebuild();
    }
  }

  /** Schedules a reconnect that revalidates ownership and enabled state before restarting. */
  private scheduleReconnect(bindingId: string, delayMs: number): void {
    this.ownershipState.scheduleReconnect(bindingId, delayMs, async () => {
      const latestOwnedBinding = this.ownershipState.getOwnedBinding(bindingId);
      if (!latestOwnedBinding) {
        return;
      }

      const latestBinding = latestOwnedBinding.binding;
      if (!latestBinding.enabled) {
        return;
      }

      await this.connectionManager.restartConnection(latestBinding);
    });
  }
}
