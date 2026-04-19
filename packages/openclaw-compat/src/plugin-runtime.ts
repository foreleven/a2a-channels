/**
 * OpenClaw-compatible runtime surface for community channel plugins.
 *
 * Only the subset used by @larksuite/openclaw-lark is implemented.
 * Reply dispatch is intercepted and forwarded to the configured agent
 * via the injected AgentTransport, keeping this package free of any
 * direct dependency on a specific protocol SDK or store implementation.
 */

import { EventEmitter } from "node:events";

import type { AgentClientHandle } from "@a2a-channels/core";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";

import { buildAgentCompat } from "./compatibilities/agent.js";
import { buildChannelCompat } from "./compatibilities/channel.js";
import {
  buildImageGenerationCompat,
  buildVideoGenerationCompat,
} from "./compatibilities/generation.js";
import {
  buildMediaCompat,
  buildMediaUnderstandingCompat,
  buildTtsCompat,
} from "./compatibilities/media.js";
import { buildSystemCompat } from "./compatibilities/system.js";
import { buildTasksCompat } from "./compatibilities/tasks.js";

export type ConfigProvider = PluginRuntime["config"];

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface PluginRuntimeOptions {
  config: ConfigProvider;
  /**
   * Resolve the pre-initialized agent client for the given agent URL.
   * Injected by the gateway so this package stays protocol-agnostic.
   */
  getAgentClient: (
    agentUrl: string,
  ) => AgentClientHandle | Promise<AgentClientHandle>;

  /**
   * Resolve the agent URL for the given channel account.
   * Injected by the gateway so this package has no store dependency.
   */
  getAgentUrl: (
    channelType: string | undefined,
    accountId: string | undefined,
  ) => string | Promise<string>;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Emitted when an inbound message from the channel is about to be forwarded to the agent. */
export interface MessageInboundEvent {
  channelType: string | undefined;
  accountId: string | undefined;
  sessionKey: string | undefined;
  userMessage: string;
  agentUrl: string;
}

/** Emitted when the agent reply has been received and is about to be sent back to the channel. */
export interface MessageOutboundEvent {
  channelType: string | undefined;
  accountId: string | undefined;
  sessionKey: string | undefined;
  replyText: string;
  agentUrl: string;
}

export interface RuntimeEventMap {
  "message:inbound": (event: MessageInboundEvent) => void;
  "message:outbound": (event: MessageOutboundEvent) => void;
}

// ---------------------------------------------------------------------------
// OpenClawPluginRuntime class
// ---------------------------------------------------------------------------

/**
 * Class-based OpenClaw plugin runtime that emits lifecycle events so that
 * external observers (e.g. MonitorManager) can record message traffic.
 *
 * Use `runtime.asPluginRuntime()` when passing it to `OpenClawPluginHost`.
 */
export class OpenClawPluginRuntime extends EventEmitter {
  private readonly getAgentClient: (
    agentUrl: string,
  ) => AgentClientHandle | Promise<AgentClientHandle>;
  private readonly getAgentUrl: (
    channelType: string | undefined,
    accountId: string | undefined,
  ) => string | Promise<string>;

  constructor(private readonly options: PluginRuntimeOptions) {
    super();
    this.getAgentClient = options.getAgentClient;
    this.getAgentUrl = options.getAgentUrl;
  }

  // -------------------------------------------------------------------------
  // Typed event emitter overloads
  // -------------------------------------------------------------------------

  override on<K extends keyof RuntimeEventMap>(
    event: K,
    listener: RuntimeEventMap[K],
  ): this;
  override on(event: string | symbol, listener: (...args: any[]) => void): this;
  override on(
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): this {
    return super.on(event, listener);
  }

  override off<K extends keyof RuntimeEventMap>(
    event: K,
    listener: RuntimeEventMap[K],
  ): this;
  override off(
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): this;
  override off(
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): this {
    return super.off(event, listener);
  }

  override emit<K extends keyof RuntimeEventMap>(
    event: K,
    ...args: Parameters<RuntimeEventMap[K]>
  ): boolean;
  override emit(event: string | symbol, ...args: any[]): boolean;
  override emit(event: string | symbol, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }

  // -------------------------------------------------------------------------
  // Internal dispatch
  // -------------------------------------------------------------------------

  private async dispatch(
    ctx: Record<string, unknown>,
  ): Promise<{ text: string } | null> {
    const userMessage =
      (ctx["BodyForAgent"] as string | undefined) ??
      (ctx["Body"] as string | undefined) ??
      (ctx["RawBody"] as string | undefined) ??
      "";

    if (!userMessage.trim()) return null;

    const channelType =
      (ctx["ChannelType"] as string | undefined) ??
      (ctx["Channel"] as string | undefined) ??
      (ctx["Provider"] as string | undefined);
    const accountId = ctx["AccountId"] as string | undefined;
    const sessionKey = ctx["SessionKey"] as string | undefined;
    const agentUrl = await this.getAgentUrl(channelType, accountId);
    const agentClient = await this.getAgentClient(agentUrl);

    this.emit("message:inbound", {
      channelType,
      accountId,
      sessionKey,
      userMessage,
      agentUrl,
    });

    const result = await agentClient.send({
      userMessage,
      contextId: sessionKey,
      accountId,
    });

    if (result) {
      this.emit("message:outbound", {
        channelType,
        accountId,
        sessionKey,
        replyText: result.text,
        agentUrl,
      });
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // PluginRuntime shape
  // -------------------------------------------------------------------------

  /**
   * Returns a `PluginRuntime` facade backed by this instance for use with
   * `OpenClawPluginHost`. The returned object matches the expected interface
   * even though TypeScript cannot verify it statically.
   */
  asPluginRuntime(): PluginRuntime {
    return this._buildPluginRuntime();
  }

  getConfig(): OpenClawConfig {
    return this.options.config.loadConfig();
  }

  private _buildPluginRuntime(): PluginRuntime {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return {
      version: "1.0.0",
      config: this.options.config,
      agent: buildAgentCompat(),
      system: buildSystemCompat(),
      media: buildMediaCompat(),
      tts: buildTtsCompat(),
      mediaUnderstanding: buildMediaUnderstandingCompat(),
      imageGeneration: buildImageGenerationCompat(),
      videoGeneration: buildVideoGenerationCompat(),
      musicGeneration: {
        generate: async () =>
          ({
            tracks: [],
            provider: "",
            model: "",
            attempts: [],
            ignoredOverrides: [],
          }) as Awaited<
            ReturnType<PluginRuntime["musicGeneration"]["generate"]>
          >,
        listProviders: () => [],
      },
      webSearch: {
        listProviders: () => [],
        search: async () => ({ provider: "", result: {} }),
      },
      stt: {
        transcribeAudioFile: async () => ({ text: undefined }),
      },
      events: {
        onAgentEvent: () => () => {},
        onSessionTranscriptUpdate: () => () => {},
      },
      logging: {
        shouldLogVerbose: () => false,
        getChildLogger: () => ({
          info: () => {},
          warn: () => {},
          error: () => {},
        }),
      },
      state: {
        resolveStateDir: () => "/tmp/a2a-channels",
      },
      modelAuth: {
        getApiKeyForModel: async () => ({
          source: "stub",
          mode: "api-key" as const,
        }),
        getRuntimeAuthForModel: async () => ({
          source: "stub",
          mode: "api-key" as const,
        }),
        resolveApiKeyForProvider: async () => ({
          source: "stub",
          mode: "api-key" as const,
        }),
      },
      tasks: buildTasksCompat(),
      taskFlow: buildTasksCompat().flow,
      subagent: {
        run: async () => ({ runId: "" }),
        waitForRun: async () => ({ status: "ok" as const }),
        getSessionMessages: async () => ({ messages: [] }),
        getSession: async () => ({ messages: [] }),
        deleteSession: async () => {},
      },
      channel: buildChannelCompat((ctx) => self.dispatch(ctx)),
    } as PluginRuntime;
  }
}
