/**
 * MonitorManager – lifecycle manager for channel account runners.
 *
 * Owns per-account monitor handles (AbortController + running Promise)
 * and drives start/stop/restart across all registered ChannelProviders.
 *
 * Adding a new channel type requires only registering its OpenClaw plugin
 * in apps/gateway/src/register-plugins.ts.
 */

import type { ChannelBinding, ChannelProvider } from "@a2a-channels/core";

interface MonitorHandle {
  abortController: AbortController;
  accountId: string;
  promise: Promise<void>;
}

export class MonitorManager {
  private readonly monitors = new Map<string, MonitorHandle>();

  constructor(
    private readonly providers: readonly ChannelProvider[],
    private readonly listBindings: () => ChannelBinding[] | Promise<ChannelBinding[]>,
  ) {
    // console.log("[monitor] providers=", this.providers);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveProvider(channelType: string): ChannelProvider | undefined {
    return this.providers.find((p) => p.supports(channelType));
  }

  private monitorKey(channelType: string, accountId: string): string {
    return `${channelType}:${accountId}`;
  }

  private async startMonitor(
    channelType: string,
    accountId: string,
  ): Promise<void> {
    const provider = this.resolveProvider(channelType);
    if (!provider) {
      console.warn(
        `[monitor] no provider for "${channelType}"; skipping account ${accountId}`,
      );
      return;
    }

    console.log(`[monitor] starting monitor for ${channelType}:${accountId}`);

    const key = this.monitorKey(channelType, accountId);
    const existing = this.monitors.get(key);
    if (existing) {
      console.log(`[monitor] stopping existing monitor for ${key}`);
      existing.abortController.abort();
      await existing.promise.catch(() => {});
      this.monitors.delete(key);
    }

    const abortController = new AbortController();
    const runner = provider.createAccountRunner({ accountId, channelType });

    console.log(`[monitor] starting monitor for ${key}`);
    const promise = runner.run(abortController.signal).catch((err: unknown) => {
      if ((err as { name?: string })?.name !== "AbortError") {
        console.error(`[monitor] ${key} error:`, String(err));
      }
    });

    this.monitors.set(key, { abortController, accountId, promise });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Sync monitors with the current store state.
   * Stops monitors for removed / disabled bindings; starts monitors for new ones.
   */
  async syncMonitors(): Promise<void> {
    const bindings = (await this.listBindings()).filter((b) => b.enabled);
    console.log(
      `[monitor] syncMonitors: ${bindings.length} enabled binding(s)`,
    );
    const activeKeys = new Set(
      bindings.map((b) => this.monitorKey(b.channelType, b.accountId)),
    );

    for (const [key, handle] of this.monitors.entries()) {
      if (!activeKeys.has(key)) {
        console.log(`[monitor] stopping removed binding: ${key}`);
        handle.abortController.abort();
        await handle.promise.catch(() => {});
        this.monitors.delete(key);
      }
    }

    for (const binding of bindings) {
      const key = this.monitorKey(binding.channelType, binding.accountId);
      if (!this.monitors.has(key)) {
        await this.startMonitor(binding.channelType, binding.accountId);
      }
    }
  }

  /** Restart the monitor for a single account (called on binding create/update). */
  async restartMonitor(channelType: string, accountId: string): Promise<void> {
    await this.startMonitor(channelType, accountId);
  }

  /** Gracefully stop all active monitors. */
  async stopAllMonitors(): Promise<void> {
    for (const [key, handle] of this.monitors.entries()) {
      console.log(`[monitor] stopping: ${key}`);
      handle.abortController.abort();
      await handle.promise.catch(() => {});
      this.monitors.delete(key);
    }
  }
}
