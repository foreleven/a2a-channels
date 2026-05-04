/**
 * OpenClaw-compatible plugin host facade.
 *
 * Exposes only the registration surface that community channel plugins
 * (e.g. @openclaw/feishu) actually use, while the gateway stays in
 * full control of the account lifecycle.
 *
 * This class is intentionally channel-agnostic.  Channel-specific bootstrap
 * (plugin loading) lives in each channel's own registration module under
 * apps/gateway/src/register-plugins.ts.
 *
 * Typical gateway startup:
 *   const host = new OpenClawPluginHost(() => configProjection.getConfig());
 *   registerLarkPlugin(host);        // channel-specific
 *   host.setRuntime(buildRuntime()); // shared runtime injected once
 */

import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  OpenClawPluginApi,
  PluginRuntime,
} from "openclaw/plugin-sdk";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import type { ChannelLogSink } from "openclaw/plugin-sdk/channel-runtime";
import type { OpenClawPluginRuntime } from "./plugin-runtime";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Runtime environment passed to a channel plugin when starting an account.
 * Mirrors the env object a real OpenClaw host normally provides.
 *
 * This is intentionally kept internal — external callers should use
 * {@link OpenClawPluginHost.startChannelAccount} which creates this
 * automatically for the given channel/account pair.
 */
interface GatewayRuntimeEnv {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit: (code: number) => void;
}

export interface ChannelBindingStatusUpdate extends ChannelAccountSnapshot {
  running?: boolean;
  connected?: boolean;
}

export interface StartChannelBindingCallbacks {
  onStatus?: (status: ChannelBindingStatusUpdate) => void;
}

export interface ChannelQrLoginStartParams {
  accountId?: string;
  force?: boolean;
  verbose?: boolean;
}

export interface ChannelQrLoginStartResult {
  qrDataUrl?: string;
  message: string;
  sessionKey?: string;
}

export interface ChannelQrLoginWaitParams {
  accountId?: string;
  sessionKey?: string;
  timeoutMs?: number;
}

export interface ChannelQrLoginWaitResult {
  connected: boolean;
  message: string;
  accountId?: string;
  channelConfig?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger: ChannelLogSink = {
  debug: (msg) => console.debug("[openclaw-host]", msg),
  info: (msg) => console.info("[openclaw-host]", msg),
  warn: (msg) => console.warn("[openclaw-host]", msg),
  error: (msg) => console.error("[openclaw-host]", msg),
};

// ---------------------------------------------------------------------------
// OpenClawPluginHost
// ---------------------------------------------------------------------------

/** Hosts OpenClaw channel plugins and controls channel account lifecycles. */
export class OpenClawPluginHost {
  private readonly channels = new Map<string, ChannelPlugin>();
  private readonly channelAliases = new Map<string, string>();
  private readonly hookHandlers = new Map<
    string,
    Array<(...args: any[]) => unknown>
  >();

  /**
   * @param getConfig  Callback that returns the current OpenClaw-compatible
   *   channel config.  Injected by the gateway so this package has no
   *   dependency on the store implementation.
   */
  constructor(private readonly runtime: OpenClawPluginRuntime) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Returns true if a channel plugin with the given id or alias has been
   * registered. Used by the gateway runtime before starting channel bindings.
   */
  hasChannel(channelType: string): boolean {
    return this.resolveChannel(channelType) !== undefined;
  }

  /**
   * Register a community plugin.  The loader receives the host's plugin API
   * object and is expected to call the plugin's own register() function:
   *
   *   host.registerPlugin((api) => larkPlugin.register(api));
   */
  registerPlugin(loader: (api: OpenClawPluginApi) => void): void {
    loader(this.buildPluginApi());
  }

  /** Register a gateway-owned channel id alias that points at a plugin id. */
  registerChannelAlias(alias: string, targetChannelId: string): void {
    this.channelAliases.set(alias, targetChannelId);
  }

  /**
   * Start the gateway account for a registered channel type.
   *
   * This is the entry point called by the connection manager when assignment
   * grants a channel binding to the local node. It:
   *   1. Resolves the registered channel plugin for `channelType`.
   *   2. Creates a scoped logging environment for the account.
   *   3. Delegates to the plugin's `gateway.startAccount()` hook.
   *
   * The returned Promise settles when the account connection ends
   * (normally or via the `abortSignal`).
   */
  async startChannelBinding(
    binding: ChannelBindingSnapshot,
    abortSignal: AbortSignal,
    callbacks: StartChannelBindingCallbacks = {},
  ): Promise<void> {
    const { id: bindingId, channelType, accountId } = binding;
    const channel = this.resolveChannel(channelType);
    if (!channel?.gateway?.startAccount) {
      throw new Error(
        `No registered channel gateway for "${channelType}". ` +
          `Did you forget to call the channel's register function before starting accounts?`,
      );
    }

    const runtimeEnv: GatewayRuntimeEnv = {
      log: (...args: unknown[]) =>
        console.log(`[${channelType}:${accountId}:${bindingId}]`, ...args),
      error: (...args: unknown[]) =>
        console.error(`[${channelType}:${accountId}:${bindingId}]`, ...args),
      exit: (code: number) => process.exit(code),
    };

    const emitStatus = (status: ChannelBindingStatusUpdate): void => {
      callbacks.onStatus?.(status);
      logger.info(
        `account[${channel.id}:${accountId}:${bindingId}] status=${JSON.stringify(status)}`,
      );
    };

    const startPromise = channel.gateway.startAccount({
      cfg: this.runtime.getConfig(),
      accountId,
      account: binding.channelConfig,
      runtime: runtimeEnv,
      abortSignal,
      getStatus: (): ChannelAccountSnapshot => {
        return { accountId };
      },
      setStatus: (status) => emitStatus(status),
      log: logger,
    });

    await startPromise;
  }

  async startChannelQrLogin(
    channelType: string,
    params: ChannelQrLoginStartParams = {},
  ): Promise<ChannelQrLoginStartResult> {
    const channel = this.resolveChannel(channelType);
    const start = channel?.gateway?.loginWithQrStart;
    if (!start) {
      throw new Error(`Channel QR login is not supported for ${channelType}`);
    }

    return await start.bind(channel.gateway)(params);
  }

  async waitForChannelQrLogin(
    channelType: string,
    params: ChannelQrLoginWaitParams,
  ): Promise<ChannelQrLoginWaitResult> {
    const channel = this.resolveChannel(channelType);
    const wait = channel?.gateway?.loginWithQrWait;
    if (!wait) {
      throw new Error(`Channel QR login is not supported for ${channelType}`);
    }

    return await wait.bind(channel.gateway)(params);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveChannel(channelType: string): ChannelPlugin | undefined {
    const exact = this.channels.get(channelType);
    if (exact) return exact;
    const aliasTarget = this.channelAliases.get(channelType);
    if (aliasTarget) {
      const aliased = this.channels.get(aliasTarget);
      if (aliased) return aliased;
    }
    for (const channel of this.channels.values()) {
      if (channel.meta?.aliases?.includes(channelType)) return channel;
    }
    return undefined;
  }

  /**
   * Build the plugin API object passed to community plugins on registration.
   *
   * Only the surface that OpenClaw channel plugins actually call is
   * implemented.  Everything else is a deliberate no-op stub — stubs exist
   * to satisfy the plugin's registration phase without throwing.
   */
  private buildPluginApi(): OpenClawPluginApi {
    const host = this;
    const config = host.runtime.getConfig();

    const on: OpenClawPluginApi["on"] = (event, handler) => {
      const existing = host.hookHandlers.get(event) ?? [];
      existing.push(handler);
      host.hookHandlers.set(event, existing);
    };
    const runtime = host.runtime.asPluginRuntime();

    return {
      // ---- Identity -------------------------------------------------------
      id: "a2a-channels-gateway",
      name: "A2A Channels Gateway",
      version: "0.1.0",
      description: "A2A-backed OpenClaw channel plugin host",
      source: "local",
      registrationMode: "setup-runtime",

      // ---- Live getters ---------------------------------------------------
      get config() {
        return config;
      },
      get runtime() {
        return runtime;
      },
      pluginConfig: {},

      logger,

      // ---- Implemented registration hooks ---------------------------------

      /** Called by channel plugins to register their gateway controller. */
      registerChannel: (
        registration: Parameters<OpenClawPluginApi["registerChannel"]>[0],
      ) => {
        const channel =
          typeof registration === "object" &&
          registration !== null &&
          "plugin" in registration
            ? registration.plugin
            : registration;

        if (!channel?.id) {
          throw new Error(
            "registerChannel: plugin object must have a non-empty id",
          );
        }
        host.channels.set(channel.id, channel);
        logger.info(
          `channel registered: id=[${channel.id}] alias=[${channel.meta.aliases}]`,
        );
      },

      /** Subscribe to host lifecycle events. */
      on: on,

      resolvePath: (input: string) => input,

      // ---- No-op stubs for unused registration surface --------------------
      // Allow plugin register() calls to complete without throwing when
      // the gateway doesn't implement the corresponding capability.
      registerTool: () => {},
      registerHook: () => {},
      registerHttpRoute: () => {},
      registerGatewayMethod: () => {},
      registerCli: () => {},
      registerReload: () => {},
      registerNodeHostCommand: () => {},
      registerSecurityAuditCollector: () => {},
      registerService: () => {},
      registerCliBackend: () => {},
      registerTextTransforms: () => {},
      registerConfigMigration: () => {},
      registerAutoEnableProbe: () => {},
      registerProvider: () => {},
      registerSpeechProvider: () => {},
      registerRealtimeTranscriptionProvider: () => {},
      registerRealtimeVoiceProvider: () => {},
      registerMediaUnderstandingProvider: () => {},
      registerImageGenerationProvider: () => {},
      registerVideoGenerationProvider: () => {},
      registerMusicGenerationProvider: () => {},
      registerWebFetchProvider: () => {},
      registerWebSearchProvider: () => {},
      registerInteractiveHandler: () => {},
      onConversationBindingResolved: () => {},
      registerCommand: () => {},
      registerContextEngine: () => {},
      registerCompactionProvider: () => {},
      registerAgentHarness: () => {},
      registerMemoryCapability: () => {},
      registerMemoryPromptSection: () => {},
      registerMemoryPromptSupplement: () => {},
      registerMemoryCorpusSupplement: () => {},
      registerMemoryFlushPlan: () => {},
      registerMemoryRuntime: () => {},
      registerMemoryEmbeddingProvider: () => {},
    } as unknown as OpenClawPluginApi;
  }
}
