import { inject, injectable } from "inversify";
import type {
  ChannelBinding,
  RuntimeConnectionStatus,
} from "@a2a-channels/core";

import { RuntimeBindingStateService } from "./runtime-binding-state-service.js";
import { RuntimeSnapshotPublisher } from "./runtime-snapshot-publisher.js";

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
