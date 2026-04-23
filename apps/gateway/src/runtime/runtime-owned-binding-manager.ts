import { inject, injectable } from "inversify";
import type {
  ChannelBinding,
  RuntimeConnectionStatus,
} from "@a2a-channels/core";

import { RuntimeBindingStateService } from "./runtime-binding-state-service.js";
import { RuntimeSnapshotPublisher } from "./runtime-snapshot-publisher.js";

/**
 * Thin façade for mutations on bindings currently owned by this node.
 *
 * This layer exists to keep RelayRuntime from depending directly on the
 * lower-level ownership state service plus snapshot publication details.
 */
export interface RuntimeOwnedBindingHooks {
  hasActiveConnection: (bindingId: string) => boolean;
  onBindingsChanged: () => void;
  restartConnection: (binding: ChannelBinding) => Promise<void>;
  stopConnection: (bindingId: string) => Promise<void>;
}

@injectable()
export class RuntimeOwnedBindingManager {
  constructor(
    @inject(RuntimeBindingStateService)
    private readonly bindingStateService: RuntimeBindingStateService,
    @inject(RuntimeSnapshotPublisher)
    private readonly snapshotPublisher: RuntimeSnapshotPublisher,
  ) {}

  async applyBindingUpsert(
    binding: ChannelBinding,
    hooks: RuntimeOwnedBindingHooks,
    options: { forceRestart?: boolean } = {},
  ): Promise<void> {
    // Snapshot publication is derived behavior of ownership changes; callers
    // should not need to remember to publish separately.
    await this.bindingStateService.applyBindingUpsert(binding, {
      forceRestart: options.forceRestart,
      hasActiveConnection: hooks.hasActiveConnection,
      onBindingsChanged: hooks.onBindingsChanged,
      publishSnapshot: async () => {
        await this.snapshotPublisher.publishNodeSnapshot();
      },
      restartConnection: hooks.restartConnection,
      stopConnection: hooks.stopConnection,
    });
  }

  async applyBindingDelete(
    bindingId: string,
    hooks: Omit<RuntimeOwnedBindingHooks, "hasActiveConnection" | "restartConnection">,
  ): Promise<boolean> {
    return await this.bindingStateService.applyBindingDelete(bindingId, {
      onBindingsChanged: hooks.onBindingsChanged,
      publishSnapshot: async () => {
        await this.snapshotPublisher.publishNodeSnapshot();
      },
      stopConnection: hooks.stopConnection,
    });
  }

  listBindings(): ChannelBinding[] {
    return this.bindingStateService.listBindings();
  }

  listEnabledBindings(): ChannelBinding[] {
    return this.bindingStateService.listEnabledBindings();
  }

  listOwnedBindingIds(): string[] {
    return this.bindingStateService.listOwnedBindingIds();
  }

  listConnectionStatuses(): RuntimeConnectionStatus[] {
    return this.bindingStateService.listConnectionStatuses();
  }

  clearReconnectsForOwnedBindings(): void {
    this.bindingStateService.clearReconnectsForOwnedBindings();
  }

  handleOwnedConnectionStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    options: {
      agentUrl?: string;
      error?: unknown;
      restartConnection: (binding: ChannelBinding) => Promise<void>;
    },
  ): void {
    // Connection callbacks are hot paths, so snapshot publication is delegated
    // in the background instead of being awaited here.
    this.bindingStateService.handleOwnedConnectionStatus(bindingId, status, {
      agentUrl: options.agentUrl,
      error: options.error,
      publishSnapshotInBackground: () => {
        this.snapshotPublisher.publishNodeSnapshotInBackground();
      },
      restartConnection: options.restartConnection,
    });
  }
}
