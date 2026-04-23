import { inject, injectable } from "inversify";
import type {
  ChannelBinding,
  RuntimeConnectionStatus,
} from "@a2a-channels/core";

import {
  RuntimeOwnershipState as RuntimeOwnershipStateToken,
  type RuntimeOwnershipState,
} from "./ownership-state.js";
import { RuntimeBindingPolicy } from "./runtime-binding-policy.js";

export interface ApplyRuntimeBindingUpsertHooks {
  forceRestart?: boolean;
  hasActiveConnection: (bindingId: string) => boolean;
  onBindingsChanged: () => void;
  publishSnapshot: () => Promise<void>;
  restartConnection: (binding: ChannelBinding) => Promise<void>;
  stopConnection: (bindingId: string) => Promise<void>;
}

export interface ApplyRuntimeBindingDeleteHooks {
  onBindingsChanged: () => void;
  publishSnapshot: () => Promise<void>;
  stopConnection: (bindingId: string) => Promise<void>;
}

export interface HandleOwnedConnectionStatusHooks {
  agentUrl?: string;
  error?: unknown;
  publishSnapshotInBackground: () => void;
  restartConnection: (binding: ChannelBinding) => Promise<void>;
}

/**
 * Local state machine for bindings already owned by this node.
 *
 * This service coordinates three concerns that need to move together:
 * - ownership state transitions
 * - connection lifecycle side effects
 * - snapshot publication
 *
 * Reconciliation decides which bindings should be owned. Once a binding is
 * owned, this service decides how local state changes in response to updates
 * and connection callbacks.
 */
@injectable()
export class RuntimeBindingStateService {
  constructor(
    @inject(RuntimeOwnershipStateToken)
    private readonly ownershipState: RuntimeOwnershipState,
    @inject(RuntimeBindingPolicy)
    private readonly runtimeBindingPolicy: RuntimeBindingPolicy,
  ) {}

  async applyBindingUpsert(
    binding: ChannelBinding,
    hooks: ApplyRuntimeBindingUpsertHooks,
  ): Promise<void> {
    // The ownership state returns a declarative transition result; this service
    // is responsible for executing the imperative follow-up work.
    const ownershipUpdate = this.ownershipState.upsertBinding(binding, {
      forceRestart: hooks.forceRestart ?? false,
      hasActiveConnection: hooks.hasActiveConnection(binding.id),
      runnable: this.isRunnableBinding(binding),
    });

    hooks.onBindingsChanged();

    if (ownershipUpdate.publishSnapshot) {
      await this.publishSnapshotSafely(
        `binding upsert for ${binding.id}`,
        hooks.publishSnapshot,
      );
    }

    if (ownershipUpdate.shouldStop) {
      this.ownershipState.clearReconnect(binding.id);
      await hooks.stopConnection(binding.id);
      return;
    }

    if (!ownershipUpdate.shouldRestart) {
      return;
    }

    // Clear pending reconnects before a deliberate restart so stale timers
    // cannot resurrect an older connection attempt.
    this.ownershipState.clearReconnect(binding.id);
    await hooks.restartConnection(binding);
  }

  async applyBindingDelete(
    bindingId: string,
    hooks: ApplyRuntimeBindingDeleteHooks,
  ): Promise<boolean> {
    if (!this.ownershipState.releaseBinding(bindingId)) {
      return false;
    }

    hooks.onBindingsChanged();
    await this.publishSnapshotSafely(
      `binding delete for ${bindingId}`,
      hooks.publishSnapshot,
    );
    await hooks.stopConnection(bindingId);
    return true;
  }

  listBindings(): ChannelBinding[] {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  listEnabledBindings(): ChannelBinding[] {
    return this.listBindings().filter(
      (binding) => binding.enabled && this.isRunnableBinding(binding),
    );
  }

  listOwnedBindingIds(): string[] {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding.id);
  }

  listConnectionStatuses(): RuntimeConnectionStatus[] {
    return this.ownershipState.listConnectionStatuses();
  }

  clearReconnectsForOwnedBindings(): void {
    for (const bindingId of this.listOwnedBindingIds()) {
      this.ownershipState.clearReconnect(bindingId);
    }
  }

  handleOwnedConnectionStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    hooks: HandleOwnedConnectionStatusHooks,
  ): void {
    // Ignore late events after ownership has already moved away from this node.
    if (!this.ownershipState.getOwnedBinding(bindingId)) {
      return;
    }

    switch (status) {
      case "connecting":
        this.ownershipState.markConnecting(bindingId, hooks.agentUrl);
        break;
      case "connected":
        this.ownershipState.markConnected(bindingId, hooks.agentUrl);
        break;
      case "disconnected": {
        const decision = this.ownershipState.markDisconnected(
          bindingId,
          hooks.agentUrl,
        );
        this.scheduleReconnect(
          bindingId,
          decision.delayMs,
          hooks.restartConnection,
        );
        break;
      }
      case "error": {
        const decision = this.ownershipState.markError(
          bindingId,
          hooks.error ?? new Error("Unknown connection error"),
          hooks.agentUrl,
        );
        this.scheduleReconnect(
          bindingId,
          decision.delayMs,
          hooks.restartConnection,
        );
        break;
      }
      case "idle":
        this.ownershipState.markIdle(bindingId);
        break;
    }

    hooks.publishSnapshotInBackground();
  }

  private scheduleReconnect(
    bindingId: string,
    delayMs: number,
    restartConnection: (binding: ChannelBinding) => Promise<void>,
  ): void {
    // Re-read the latest owned binding at execution time because config or
    // ownership may have changed while the reconnect timer was waiting.
    this.ownershipState.scheduleReconnect(bindingId, delayMs, async () => {
      const latestOwnedBinding = this.ownershipState.getOwnedBinding(bindingId);
      if (!latestOwnedBinding) {
        return;
      }

      const latestBinding = latestOwnedBinding.binding;
      if (!latestBinding.enabled || !this.isRunnableBinding(latestBinding)) {
        return;
      }

      await restartConnection(latestBinding);
    });
  }

  private isRunnableBinding(binding: ChannelBinding): boolean {
    const runnable = this.runtimeBindingPolicy.isRunnableBinding(binding);

    if (!runnable) {
      console.warn(
        `[gateway] skipping binding ${binding.id} for ${binding.channelType}:${binding.accountId} because it is not runnable under the runtime policy`,
      );
    }

    return runnable;
  }

  private async publishSnapshotSafely(
    reason: string,
    publishSnapshot: () => Promise<void>,
  ): Promise<void> {
    try {
      await publishSnapshot();
    } catch (error) {
      console.error(
        `[runtime] failed to publish node snapshot during ${reason}:`,
        error,
      );
    }
  }
}
