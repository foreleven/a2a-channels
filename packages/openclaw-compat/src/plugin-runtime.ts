/**
 * OpenClaw-compatible runtime surface for community channel plugins.
 *
 * Only the subset used by @larksuite/openclaw-lark is implemented.
 * Channel reply events are constructed here and emitted as runtime inbound
 * messages so live connections can decide whether they own the message.
 */

import { EventEmitter } from "node:events";

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

type ChannelReplyDispatchParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]
>[0];
type ChannelReplyBufferedDispatchParams = Parameters<
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
export type ChannelReplyDispatchResult = Awaited<
  ReturnType<PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]>
>;

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface PluginRuntimeOptions {
  config: ConfigProvider;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

export interface MessageInboundEvent {
  channelType: string | undefined;
  accountId: string | undefined;
  sessionKey: string | undefined;
  userMessage: string;
  replyEvent: ChannelReplyEvent;
}

export interface MessageOutboundEvent {
  channelType: string | undefined;
  accountId: string | undefined;
  sessionKey: string | undefined;
  replyText: string;
  agentUrl: string;
}

export interface ChannelReplyDispatchEvent {
  type: "channel.reply.dispatch";
  ctx: ChannelReplyDispatchParams["ctx"];
  cfg: ChannelReplyDispatchParams["cfg"];
  dispatcher: ChannelReplyDispatchParams["dispatcher"];
  replyOptions?: ChannelReplyDispatchParams["replyOptions"];
}

export interface ChannelReplyBufferedDispatchEvent {
  type: "channel.reply.buffered.dispatch";
  ctx: ChannelReplyBufferedDispatchParams["ctx"];
  dispatcherOptions: ChannelReplyBufferedDispatchParams["dispatcherOptions"];
}

export type ChannelReplyEvent =
  | ChannelReplyDispatchEvent
  | ChannelReplyBufferedDispatchEvent;

export interface RuntimeEventMap {
  "message:inbound": (
    event: MessageInboundEvent,
  ) =>
    | ChannelReplyDispatchResult
    | undefined
    | Promise<ChannelReplyDispatchResult | undefined>;
  "message:outbound": (event: MessageOutboundEvent) => void;
}

// ---------------------------------------------------------------------------
// OpenClawPluginRuntime class
// ---------------------------------------------------------------------------

/**
 * Class-based OpenClaw plugin runtime that emits lifecycle events and inbound
 * channel messages.
 */
export class OpenClawPluginRuntime extends EventEmitter {
  constructor(private readonly options: PluginRuntimeOptions) {
    super();
  }

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

  async handleChannelReplyEvent(
    event: ChannelReplyEvent,
  ): Promise<ChannelReplyDispatchResult> {
    const message = this.buildMessageInboundEvent(event);
    for (const listener of this.listeners("message:inbound")) {
      const result = await (
        listener as RuntimeEventMap["message:inbound"]
      )(message);
      if (result !== undefined) {
        return result;
      }
    }

    throw new Error(
      `No active connection found for channelType=${message.channelType} accountId=${message.accountId}`,
    );
  }

  asPluginRuntime(): PluginRuntime {
    return this._buildPluginRuntime();
  }

  getConfig(): OpenClawConfig {
    return this.options.config.loadConfig();
  }

  private _buildPluginRuntime(): PluginRuntime {
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
      channel: buildChannelCompat((event) => this.handleChannelReplyEvent(event)),
    } as PluginRuntime;
  }

  private buildMessageInboundEvent(event: ChannelReplyEvent): MessageInboundEvent {
    const ctx = event.ctx as Record<string, unknown>;
    const userMessage =
      (ctx["BodyForAgent"] as string | undefined) ??
      (ctx["Body"] as string | undefined) ??
      (ctx["RawBody"] as string | undefined) ??
      "";
    const channelType =
      (ctx["ChannelType"] as string | undefined) ??
      (ctx["Channel"] as string | undefined) ??
      (ctx["Provider"] as string | undefined);
    const accountId = ctx["AccountId"] as string | undefined;
    const sessionKey = ctx["SessionKey"] as string | undefined;

    return {
      accountId,
      channelType,
      replyEvent: event,
      sessionKey,
      userMessage,
    };
  }
}
