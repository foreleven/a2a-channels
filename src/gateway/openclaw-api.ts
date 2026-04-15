/**
 * Minimal OpenClawPluginApi implementation.
 *
 * Loads the @larksuite/openclaw-lark plugin by calling its `register`
 * function (as referenced in https://github.com/foreleven/openclaw-lark/blob/main/index.ts#L110).
 *
 * We only implement the methods actually invoked by the Feishu plugin.
 * All other registration methods are safe no-ops.
 */

import { buildPluginRuntime } from './plugin-runtime.js';
import { buildOpenClawConfig } from '../store/index.js';

// ---------------------------------------------------------------------------
// Minimal logger
// ---------------------------------------------------------------------------

const logger = {
  debug: (msg: string, meta?: unknown) => console.debug('[plugin]', msg, meta ?? ''),
  info: (msg: string, meta?: unknown) => console.info('[plugin]', msg, meta ?? ''),
  warn: (msg: string, meta?: unknown) => console.warn('[plugin]', msg, meta ?? ''),
  error: (msg: string, meta?: unknown) => console.error('[plugin]', msg, meta ?? ''),
};

// ---------------------------------------------------------------------------
// API builder
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildOpenClawPluginApi(): any {
  const hookHandlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const registeredChannels: unknown[] = [];
  const registeredTools: unknown[] = [];

  const runtime = buildPluginRuntime();

  return {
    // Identity fields
    id: 'a2a-channels-gateway',
    name: 'A2A Channels Gateway',
    version: '0.1.0',
    description: 'A2A-backed OpenClaw channel plugin runtime',
    source: 'local',
    registrationMode: 'eager',

    // Config – always returns the latest in-memory config
    get config() {
      return buildOpenClawConfig();
    },
    pluginConfig: {},

    // Runtime – the A2A-backed PluginRuntime
    runtime,

    // Logger
    logger,

    // Registration methods
    registerChannel: (registration: unknown) => {
      registeredChannels.push(registration);
      logger.info('registerChannel called', { count: registeredChannels.length });
    },
    registerTool: (tool: unknown) => {
      registeredTools.push(tool);
    },
    registerHook: (_events: unknown, _handler: unknown) => {},
    registerHttpRoute: (_params: unknown) => {},
    registerGatewayMethod: (_method: unknown, _handler: unknown) => {},
    registerCli: (_registrar: unknown) => {},
    registerReload: (_registration: unknown) => {},
    registerNodeHostCommand: (_command: unknown) => {},
    registerSecurityAuditCollector: (_collector: unknown) => {},
    registerService: (_service: unknown) => {},
    registerCliBackend: (_backend: unknown) => {},
    registerTextTransforms: (_transforms: unknown) => {},
    registerConfigMigration: (_migrate: unknown) => {},
    registerAutoEnableProbe: (_probe: unknown) => {},
    registerProvider: (_provider: unknown) => {},
    registerSpeechProvider: (_provider: unknown) => {},
    registerRealtimeTranscriptionProvider: (_provider: unknown) => {},
    registerRealtimeVoiceProvider: (_provider: unknown) => {},
    registerMediaUnderstandingProvider: (_provider: unknown) => {},
    registerImageGenerationProvider: (_provider: unknown) => {},
    registerVideoGenerationProvider: (_provider: unknown) => {},
    registerMusicGenerationProvider: (_provider: unknown) => {},
    registerWebFetchProvider: (_provider: unknown) => {},
    registerWebSearchProvider: (_provider: unknown) => {},
    registerInteractiveHandler: (_registration: unknown) => {},
    onConversationBindingResolved: (_handler: unknown) => {},
    registerCommand: (_command: unknown) => {},
    registerContextEngine: (_id: unknown, _factory: unknown) => {},
    registerCompactionProvider: (_provider: unknown) => {},
    registerAgentHarness: (_harness: unknown) => {},
    registerMemoryCapability: (_capability: unknown) => {},
    registerMemoryPromptSection: (_builder: unknown) => {},
    registerMemoryPromptSupplement: (_builder: unknown) => {},
    registerMemoryCorpusSupplement: (_supplement: unknown) => {},
    registerMemoryFlushPlan: (_resolver: unknown) => {},
    registerMemoryRuntime: (_runtime: unknown) => {},
    registerMemoryEmbeddingProvider: (_adapter: unknown) => {},

    resolvePath: (input: string) => input,

    /** Lifecycle hook registration */
    on: (hookName: string, handler: (...args: unknown[]) => unknown) => {
      const existing = hookHandlers.get(hookName) ?? [];
      existing.push(handler);
      hookHandlers.set(hookName, existing);
      logger.debug('hook registered', { hookName });
    },
  };
}
