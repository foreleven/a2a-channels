/**
 * OpenClaw-compatible plugin host facade.
 *
 * Exposes only the registration surface that community channel plugins
 * (e.g. @larksuite/openclaw-lark) actually use, while the gateway stays in
 * full control of the account lifecycle.
 *
 * This class is intentionally channel-agnostic.  Channel-specific bootstrap
 * (plugin loading) lives in each channel's own registration module under
 * apps/gateway/src/register-plugins.ts.
 *
 * Typical gateway startup:
 *   const host = new OpenClawPluginHost(() => store.buildOpenClawConfig());
 *   registerLarkPlugin(host);        // channel-specific
 *   host.setRuntime(buildRuntime()); // shared runtime injected once
 */

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Minimal logger interface shared between the host and registered plugins. */
interface HostLogger {
  debug: (msg: string, meta?: unknown) => void;
  info:  (msg: string, meta?: unknown) => void;
  warn:  (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}

/**
 * Runtime environment passed to a channel plugin when starting an account.
 * Mirrors the env object a real OpenClaw host normally provides.
 */
export interface GatewayRuntimeEnv {
  log:   (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  exit:  (code: number) => void;
}

interface ChannelGatewayController {
  startAccount?: (ctx: {
    cfg:         Record<string, unknown>;
    accountId:   string;
    runtime:     GatewayRuntimeEnv;
    abortSignal: AbortSignal;
    setStatus:   (status: Record<string, unknown>) => void;
    log?:        HostLogger;
  }) => Promise<void>;
  stopAccount?: (ctx: {
    cfg:       Record<string, unknown>;
    accountId: string;
    runtime:   GatewayRuntimeEnv;
    log?:      HostLogger;
  }) => Promise<void>;
}

interface RegisteredChannelPlugin {
  id:       string;
  meta?:    { aliases?: string[] };
  gateway?: ChannelGatewayController;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

const logger: HostLogger = {
  debug: (msg, meta) => console.debug('[openclaw-host]', msg, meta ?? ''),
  info:  (msg, meta) => console.info( '[openclaw-host]', msg, meta ?? ''),
  warn:  (msg, meta) => console.warn( '[openclaw-host]', msg, meta ?? ''),
  error: (msg, meta) => console.error('[openclaw-host]', msg, meta ?? ''),
};

// ---------------------------------------------------------------------------
// OpenClawPluginHost
// ---------------------------------------------------------------------------

export class OpenClawPluginHost {
  private runtime: unknown = null;

  private readonly channels     = new Map<string, RegisteredChannelPlugin>();
  private readonly hookHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();

  /**
   * @param getConfig  Callback that returns the current OpenClaw-compatible
   *   channel config.  Injected by the gateway so this package has no
   *   dependency on the store implementation.
   */
  constructor(private readonly getConfig: () => Record<string, unknown>) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Returns true if a channel plugin with the given id or alias has been
   * registered.  Used by OpenClawChannelProvider.supports() to determine
   * which channel types this host can handle.
   */
  hasChannel(channelType: string): boolean {
    return this.resolveChannel(channelType) !== undefined;
  }

  /**
   * Set the shared plugin runtime.
   */
  setRuntime(runtime: unknown): void {
    this.runtime = runtime;
  }

  /**
   * Register a community plugin.  The loader receives the host's plugin API
   * object and is expected to call the plugin's own register() function:
   *
   *   host.registerPlugin((api) => larkPlugin.register(api));
   */
  registerPlugin(loader: (api: unknown) => void): void {
    loader(this.buildPluginApi());
  }

  /**
   * Start the gateway account for a registered channel type.
   * Called by channel runners once they have a live AbortSignal.
   */
  async startChannelAccount(
    channelType: string,
    accountId:   string,
    runtimeEnv:  GatewayRuntimeEnv,
    abortSignal: AbortSignal,
  ): Promise<void> {
    const channel = this.resolveChannel(channelType);
    if (!channel?.gateway?.startAccount) {
      throw new Error(
        `No registered channel gateway for "${channelType}". ` +
        `Did you forget to call the channel's register function before starting accounts?`,
      );
    }

    await channel.gateway.startAccount({
      cfg:       this.getConfig(),
      accountId,
      runtime:   runtimeEnv,
      abortSignal,
      setStatus: (status) => logger.info(`status [${channel.id}:${accountId}]`, status),
      log:       logger,
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private resolveChannel(channelType: string): RegisteredChannelPlugin | undefined {
    const exact = this.channels.get(channelType);
    if (exact) return exact;
    for (const channel of this.channels.values()) {
      if (channel.meta?.aliases?.includes(channelType)) return channel;
    }
    return undefined;
  }

  /**
   * Build the plugin API object passed to community plugins on registration.
   *
   * Only the surface that @larksuite/openclaw-lark actually calls is
   * implemented.  Everything else is a deliberate no-op stub — stubs exist
   * to satisfy the plugin's registration phase without throwing.
   */
  private buildPluginApi(): unknown {
    const host = this;

    return {
      // ---- Identity -------------------------------------------------------
      id:               'a2a-channels-gateway',
      name:             'A2A Channels Gateway',
      version:          '0.1.0',
      description:      'A2A-backed OpenClaw channel plugin host',
      source:           'local',
      registrationMode: 'eager',

      // ---- Live getters ---------------------------------------------------
      get config()  { return host.getConfig(); },
      get runtime() { return host.runtime; },
      pluginConfig: {},

      logger,

      // ---- Implemented registration hooks ---------------------------------

      /** Called by channel plugins to register their gateway controller. */
      registerChannel: (
        registration: { plugin?: RegisteredChannelPlugin } | RegisteredChannelPlugin,
      ) => {
        const channel = (
          typeof registration === 'object' &&
          registration !== null &&
          'plugin' in registration
            ? registration.plugin
            : registration
        ) as RegisteredChannelPlugin | undefined;

        if (!channel?.id) {
          throw new Error('registerChannel: plugin object must have a non-empty id');
        }
        host.channels.set(channel.id, channel);
        logger.info('channel registered', { id: channel.id, aliases: channel.meta?.aliases ?? [] });
      },

      /** Subscribe to host lifecycle events. */
      on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
        const existing = host.hookHandlers.get(hookName) ?? [];
        existing.push(handler);
        host.hookHandlers.set(hookName, existing);
      },

      resolvePath: (input: string) => input,

      // ---- No-op stubs for unused registration surface --------------------
      // Allow plugin register() calls to complete without throwing when
      // the gateway doesn't implement the corresponding capability.
      registerTool:                          () => {},
      registerHook:                          () => {},
      registerHttpRoute:                     () => {},
      registerGatewayMethod:                 () => {},
      registerCli:                           () => {},
      registerReload:                        () => {},
      registerNodeHostCommand:               () => {},
      registerSecurityAuditCollector:        () => {},
      registerService:                       () => {},
      registerCliBackend:                    () => {},
      registerTextTransforms:                () => {},
      registerConfigMigration:               () => {},
      registerAutoEnableProbe:               () => {},
      registerProvider:                      () => {},
      registerSpeechProvider:                () => {},
      registerRealtimeTranscriptionProvider: () => {},
      registerRealtimeVoiceProvider:         () => {},
      registerMediaUnderstandingProvider:    () => {},
      registerImageGenerationProvider:       () => {},
      registerVideoGenerationProvider:       () => {},
      registerMusicGenerationProvider:       () => {},
      registerWebFetchProvider:              () => {},
      registerWebSearchProvider:             () => {},
      registerInteractiveHandler:            () => {},
      onConversationBindingResolved:         () => {},
      registerCommand:                       () => {},
      registerContextEngine:                 () => {},
      registerCompactionProvider:            () => {},
      registerAgentHarness:                  () => {},
      registerMemoryCapability:              () => {},
      registerMemoryPromptSection:           () => {},
      registerMemoryPromptSupplement:        () => {},
      registerMemoryCorpusSupplement:        () => {},
      registerMemoryFlushPlan:               () => {},
      registerMemoryRuntime:                 () => {},
      registerMemoryEmbeddingProvider:       () => {},
    };
  }
}
