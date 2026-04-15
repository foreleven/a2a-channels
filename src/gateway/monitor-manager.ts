/**
 * MonitorManager – generic lifecycle manager for channel adapters.
 *
 * Owns the per-account monitor handles (AbortController + running Promise)
 * and drives start/stop/restart across all registered ChannelAdapters.
 *
 * Adding a new channel requires only:
 *   1. Implementing ChannelAdapter in a new file.
 *   2. Passing the adapter instance to MonitorManager's constructor.
 *   No lifecycle code needs to be duplicated.
 */

import type { ChannelAdapter } from './channel-adapter.js';
import { listChannelBindings } from '../store/index.js';
import { buildPluginRuntime } from './plugin-runtime.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MonitorHandle {
  abortController: AbortController;
  accountId: string;
  promise: Promise<void>;
}

// ---------------------------------------------------------------------------
// MonitorManager
// ---------------------------------------------------------------------------

export class MonitorManager {
  private readonly adapters: ReadonlyMap<string, ChannelAdapter>;
  private readonly monitors = new Map<string, MonitorHandle>();
  private runtimeInstance: ReturnType<typeof buildPluginRuntime> | null = null;

  constructor(adapters: Record<string, ChannelAdapter>) {
    this.adapters = new Map(Object.entries(adapters));
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getRuntime() {
    if (!this.runtimeInstance) {
      this.runtimeInstance = buildPluginRuntime();
    }
    return this.runtimeInstance;
  }

  /** Composite key used inside the monitors map: "<channelType>:<accountId>" */
  private monitorKey(channelType: string, accountId: string): string {
    return `${channelType}:${accountId}`;
  }

  private async startMonitor(channelType: string, accountId: string): Promise<void> {
    const adapter = this.adapters.get(channelType);
    if (!adapter) {
      console.warn(`[monitor] no adapter registered for channelType "${channelType}" – skipping account ${accountId}`);
      return;
    }

    const key = this.monitorKey(channelType, accountId);
    const existing = this.monitors.get(key);
    if (existing) {
      console.log(`[monitor] stopping existing monitor for ${key}`);
      existing.abortController.abort();
      await existing.promise.catch(() => {});
      this.monitors.delete(key);
    }

    const abortController = new AbortController();

    console.log(`[monitor] starting monitor for ${key}`);

    const promise = adapter
      .start(accountId, abortController.signal)
      .catch((err: unknown) => {
        if ((err as { name?: string })?.name !== 'AbortError') {
          console.error(`[monitor] ${key} error:`, String(err));
        }
      });

    // Inject runtime immediately so it is in place before any message arrives.
    adapter.injectRuntime(this.getRuntime());

    this.monitors.set(key, { abortController, accountId, promise });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start (or restart) monitors for all enabled channel bindings.
   * Stops monitors for accounts that are no longer present in the store.
   */
  async syncMonitors(): Promise<void> {
    const bindings = listChannelBindings().filter((b) => b.enabled);

    // Stop monitors for removed / disabled bindings
    const activeKeys = new Set(bindings.map((b) => this.monitorKey(b.channelType, b.accountId)));
    for (const [key, handle] of this.monitors.entries()) {
      if (!activeKeys.has(key)) {
        console.log(`[monitor] stopping monitor for removed binding: ${key}`);
        handle.abortController.abort();
        await handle.promise.catch(() => {});
        this.monitors.delete(key);
      }
    }

    // Start monitors for new bindings
    for (const binding of bindings) {
      const key = this.monitorKey(binding.channelType, binding.accountId);
      if (!this.monitors.has(key)) {
        await this.startMonitor(binding.channelType, binding.accountId);
      }
    }
  }

  /**
   * Restart the monitor for a single account.
   * Called when a binding is created or updated.
   */
  async restartMonitor(channelType: string, accountId: string): Promise<void> {
    await this.startMonitor(channelType, accountId);
  }

  /** Stop all active monitors gracefully. */
  async stopAllMonitors(): Promise<void> {
    for (const [key, handle] of this.monitors.entries()) {
      console.log(`[monitor] stopping monitor: ${key}`);
      handle.abortController.abort();
      await handle.promise.catch(() => {});
      this.monitors.delete(key);
    }
  }
}
