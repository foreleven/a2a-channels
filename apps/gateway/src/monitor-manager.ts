/**
 * MonitorManager – lifecycle manager for channel account runners.
 *
 * Owns per-account monitor handles (AbortController + running Promise)
 * and drives start/stop/restart across all registered ChannelProviders.
 *
 * Subscribes to runtime events so message traffic can be observed and
 * persisted (e.g. written to a database table) without coupling the
 * runtime itself to any store implementation.
 *
 * Adding a new channel type requires only registering its OpenClaw plugin
 * in apps/gateway/src/register-plugins.ts.
 */

import type { ChannelBinding, ChannelProvider } from "@a2a-channels/core";
import type {
  MessageInboundEvent,
  MessageOutboundEvent,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";

interface MonitorHandle {
  abortController: AbortController;
  binding: ChannelBinding;
  promise: Promise<void>;
}

export class MonitorManager {
  private readonly monitors = new Map<string, MonitorHandle>();

  constructor(
    private readonly providers: readonly ChannelProvider[],
    private readonly listBindings: () => ChannelBinding[] | Promise<ChannelBinding[]>,
    runtime?: OpenClawPluginRuntime,
  ) {
    if (runtime) {
      runtime.on("message:inbound", (event: MessageInboundEvent) => {
        console.log(
          `[monitor] message:inbound channel=${event.channelType ?? "-"} accountId=${event.accountId ?? "-"} agent=${event.agentUrl} text=${JSON.stringify(event.userMessage)}`,
        );
      });
      runtime.on("message:outbound", (event: MessageOutboundEvent) => {
        console.log(
          `[monitor] message:outbound channel=${event.channelType ?? "-"} accountId=${event.accountId ?? "-"} agent=${event.agentUrl} text=${JSON.stringify(event.replyText)}`,
        );
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveProvider(channelType: string): ChannelProvider | undefined {
    return this.providers.find((p) => p.supports(channelType));
  }

  private async startMonitor(binding: ChannelBinding): Promise<void> {
    const provider = this.resolveProvider(binding.channelType);
    if (!provider) {
      console.warn(
        `[monitor] no provider for "${binding.channelType}"; skipping binding ${binding.id}`,
      );
      return;
    }

    const existing = this.monitors.get(binding.id);
    if (existing) {
      console.log(`[monitor] stopping existing monitor for binding ${binding.id}`);
      existing.abortController.abort();
      await existing.promise.catch(() => {});
      this.monitors.delete(binding.id);
    }

    const abortController = new AbortController();
    const runner = provider.createAccountRunner(binding);

    console.log(
      `[monitor] starting binding ${binding.id} for ${binding.channelType}:${binding.accountId}`,
    );
    const promise = runner.run(abortController.signal).catch((err: unknown) => {
      if ((err as { name?: string })?.name !== "AbortError") {
        console.error(`[monitor] binding ${binding.id} error:`, String(err));
      }
    });

    this.monitors.set(binding.id, { abortController, binding, promise });
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
    const activeIds = new Set(bindings.map((b) => b.id));

    for (const [bindingId, handle] of this.monitors.entries()) {
      if (!activeIds.has(bindingId)) {
        console.log(`[monitor] stopping removed binding: ${bindingId}`);
        handle.abortController.abort();
        await handle.promise.catch(() => {});
        this.monitors.delete(bindingId);
      }
    }

    for (const binding of bindings) {
      if (!this.monitors.has(binding.id)) {
        await this.startMonitor(binding);
      }
    }
  }

  /** Restart the monitor for a single binding after create/update. */
  async restartMonitor(binding: ChannelBinding): Promise<void> {
    if (!binding.enabled) {
      await this.stopMonitor(binding.id);
      return;
    }
    await this.startMonitor(binding);
  }

  /** Stop one binding monitor if it is running. */
  async stopMonitor(bindingId: string): Promise<void> {
    const handle = this.monitors.get(bindingId);
    if (!handle) return;

    console.log(`[monitor] stopping binding: ${bindingId}`);
    handle.abortController.abort();
    await handle.promise.catch(() => {});
    this.monitors.delete(bindingId);
  }

  /** Gracefully stop all active monitors. */
  async stopAllMonitors(): Promise<void> {
    for (const bindingId of Array.from(this.monitors.keys())) {
      await this.stopMonitor(bindingId);
    }
  }
}
