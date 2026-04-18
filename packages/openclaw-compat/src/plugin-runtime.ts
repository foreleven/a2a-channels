/**
 * OpenClaw-compatible runtime surface for community channel plugins.
 *
 * Only the subset used by @larksuite/openclaw-lark is implemented.
 * Reply dispatch is intercepted and forwarded to the configured agent
 * via the injected AgentTransport, keeping this package free of any
 * direct dependency on a specific protocol SDK or store implementation.
 */

import crypto from "node:crypto";
import { EventEmitter } from "node:events";

import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import * as channelRuntimeSdk from "openclaw/plugin-sdk/channel-runtime";
import * as commandDetection from "openclaw/plugin-sdk/command-detection";
import * as markdownTableRuntime from "openclaw/plugin-sdk/markdown-table-runtime";
import * as replyDispatchRuntime from "openclaw/plugin-sdk/reply-dispatch-runtime";
import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import * as routingSdk from "openclaw/plugin-sdk/routing";
import * as textRuntimeSdk from "openclaw/plugin-sdk/text-runtime";

import type { AgentTransport } from "@a2a-channels/core";
import type { PluginRuntime } from "openclaw/plugin-sdk";

// ---------------------------------------------------------------------------
// Runtime options
// ---------------------------------------------------------------------------

export interface PluginRuntimeOptions {
  /** Transport used to forward messages to the configured agent. */
  transport: AgentTransport;

  /**
   * Resolve the agent URL for the given accountId.
   * Injected by the gateway so this package has no store dependency.
   */
  getAgentUrl: (accountId: string | undefined) => string;

  /**
   * Return the current OpenClaw-compatible channel configuration.
   * Injected by the gateway.
   */
  getConfig: () => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Event types
// ---------------------------------------------------------------------------

/** Emitted when an inbound message from the channel is about to be forwarded to the agent. */
export interface MessageInboundEvent {
  accountId: string | undefined;
  sessionKey: string | undefined;
  userMessage: string;
  agentUrl: string;
}

/** Emitted when the agent reply has been received and is about to be sent back to the channel. */
export interface MessageOutboundEvent {
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
 * Cast the instance to `PluginRuntime` when passing it to `OpenClawPluginHost`.
 */
export class OpenClawPluginRuntime extends EventEmitter {
  private readonly transport: AgentTransport;
  private readonly getAgentUrl: (accountId: string | undefined) => string;
  private readonly getConfig: () => Record<string, unknown>;

  constructor(options: PluginRuntimeOptions) {
    super();
    this.transport = options.transport;
    this.getAgentUrl = options.getAgentUrl;
    this.getConfig = options.getConfig;
  }

  // -------------------------------------------------------------------------
  // Typed event emitter overloads
  // -------------------------------------------------------------------------

  override on<K extends keyof RuntimeEventMap>(
    event: K,
    listener: RuntimeEventMap[K],
  ): this;
  override on(
    event: string | symbol,
    listener: (...args: any[]) => void,
  ): this;
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

    const accountId = ctx["AccountId"] as string | undefined;
    const sessionKey = ctx["SessionKey"] as string | undefined;
    const agentUrl = this.getAgentUrl(accountId);

    this.emit("message:inbound", { accountId, sessionKey, userMessage, agentUrl });

    const result = await this.transport.send(agentUrl, {
      userMessage,
      contextId: sessionKey,
      accountId,
    });

    if (result) {
      this.emit("message:outbound", {
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
   * Returns this instance cast as `PluginRuntime` for use with
   * `OpenClawPluginHost`.  The object shape matches the expected interface
   * even though TypeScript cannot verify it statically.
   */
  asPluginRuntime(): PluginRuntime {
    return this._buildPluginRuntime();
  }

  private _buildPluginRuntime(): PluginRuntime {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;

    return {
      version: "1.0.0",

      // ---- Config ----
      config: {
        loadConfig: () => self.getConfig(),
        writeConfigFile: async () => {},
      },

      // ---- Agent (stubs – this gateway doesn't run embedded agents) ----
      agent: {
        defaults: { model: "gpt-5.4", provider: "openai" },
        resolveAgentDir: () => "/tmp/a2a-channels",
        resolveAgentWorkspaceDir: () => "/tmp/a2a-channels",
        resolveAgentIdentity: () => ({ agentId: "main", name: "main" }),
        resolveThinkingDefault: () => "off",
        runEmbeddedAgent: async () => ({ meta: { durationMs: 0 } }),
        runEmbeddedPiAgent: async () => ({ meta: { durationMs: 0 } }),
        resolveAgentTimeoutMs: () => 30_000,
        ensureAgentWorkspace: async () => ({
          dir: "/tmp/a2a-channels",
          created: false,
        }),
        session: {
          resolveStorePath: () => "/tmp/a2a-sessions",
          loadSessionStore: async (_storePath: string) => ({}) as any,
          saveSessionStore: async () => {},
          resolveSessionFilePath: () => "/tmp/a2a-sessions/session.json",
        } as unknown as PluginRuntime["agent"]["session"],
      },

      // ---- System ----
      system: {
        enqueueSystemEvent: (msg: string, meta?: unknown) => {
          console.log("[system]", msg, meta ?? "");
          return false;
        },
        requestHeartbeatNow: async () => {},
        runHeartbeatOnce: async () => ({ status: "ran", durationMs: 0 }),
        runCommandWithTimeout: async () => ({
          code: 0,
          signal: null,
          killed: false,
          termination: "exit",
          stdout: "",
          stderr: "",
          exitCode: 0,
        }),
        formatNativeDependencyHint: (h: { packageName: string }) =>
          h.packageName,
      },

      // ---- Media / TTS / AI stubs ----
      media: {
        loadWebMedia: async () => null,
        detectMime: () => "application/octet-stream",
        mediaKindFromMime: () => "file",
        isVoiceCompatibleAudio: () => false,
        getImageMetadata: async () => null,
        resizeToJpeg: async () => Buffer.alloc(0),
      },
      tts: {
        textToSpeech: async () => null,
        textToSpeechTelephony: async () => null,
        listVoices: async () => [],
      },
      mediaUnderstanding: {
        runFile: async () => null,
        describeImageFile: async () => "",
        describeImageFileWithModel: async () => "",
        describeVideoFile: async () => "",
        transcribeAudioFile: async () => "",
      },
      imageGeneration: {
        generate: async () => ({ url: "" }),
        listProviders: () => [],
      },
      videoGeneration: {
        generate: async () => ({ url: "" }),
        listProviders: () => [],
      },
      tasks: {
        runs: {
          get: async () => null,
          list: async () => [],
          create: async () => ({ id: crypto.randomUUID() }),
          update: async () => null,
          cancel: async () => null,
        },
        flows: { get: async () => null, list: async () => [] },
      },

      // ---- Channel ----
      channel: {
        // -- Text helpers (real implementations from openclaw SDK) --
        text: {
          chunkByNewline: (text: string, limit?: number) => {
            if (!limit) return text.split("\n");
            const chunks: string[] = [];
            let current = "";
            for (const line of text.split("\n")) {
              if (current.length + line.length + 1 > limit && current) {
                chunks.push(current);
                current = line;
              } else {
                current = current ? `${current}\n${line}` : line;
              }
            }
            if (current) chunks.push(current);
            return chunks;
          },
          chunkText: replyRuntime.chunkText,
          chunkTextWithMode: replyRuntime.chunkTextWithMode,
          chunkMarkdownText:
            replyRuntime.chunkMarkdownText ??
            replyRuntime.chunkMarkdownTextWithMode,
          chunkMarkdownTextWithMode: replyRuntime.chunkMarkdownTextWithMode,
          resolveChunkMode: replyRuntime.resolveChunkMode,
          resolveTextChunkLimit: replyRuntime.resolveTextChunkLimit,
          hasControlCommand: commandDetection.hasControlCommand,
          resolveMarkdownTableMode:
            markdownTableRuntime.resolveMarkdownTableMode,
          convertMarkdownTables: textRuntimeSdk.convertMarkdownTables,
        },

        // -- Reply pipeline --
        reply: {
          /**
           * PRIMARY DISPATCH: called by openclaw-lark for every normal inbound message.
           * Forwards to the bound A2A / ACP agent and delivers the reply.
           */
          dispatchReplyFromConfig: async (params: {
            ctx: Record<string, unknown>;
            cfg: unknown;
            dispatcher: {
              sendFinalReply: (payload: { text: string }) => boolean;
              waitForIdle: () => Promise<void>;
              markComplete: () => void;
              getQueuedCounts: () => Record<string, number>;
              getFailedCounts: () => Record<string, number>;
            };
            replyOptions?: unknown;
          }) => {
            const response = await self.dispatch(params.ctx);
            if (!response) {
              params.dispatcher.markComplete();
              return {
                queuedFinal: false,
                counts: { tool: 0, block: 0, final: 0 },
              };
            }
            params.dispatcher.sendFinalReply({ text: response.text });
            await params.dispatcher.waitForIdle();
            params.dispatcher.markComplete();
            return {
              queuedFinal: false,
              counts: { tool: 0, block: 0, final: 1 },
            };
          },

          /**
           * BUFFERED DISPATCH: used by openclaw-lark for comment / drive replies.
           */
          dispatchReplyWithBufferedBlockDispatcher: async (params: {
            ctx: Record<string, unknown>;
            cfg: unknown;
            dispatcherOptions: {
              deliver: (
                payload: { text: string },
                info: { kind: string },
              ) => Promise<void>;
              onSkip?: (payload: unknown, info: unknown) => void;
              onError?: (error: unknown, info: unknown) => void;
            };
            replyOptions?: unknown;
          }) => {
            const response = await self.dispatch(params.ctx);
            if (!response)
              return {
                queuedFinal: false,
                counts: { tool: 0, block: 0, final: 0 },
              };
            try {
              await params.dispatcherOptions.deliver(
                { text: response.text },
                { kind: "final" },
              );
              return {
                queuedFinal: false,
                counts: { tool: 0, block: 0, final: 1 },
              };
            } catch (error) {
              params.dispatcherOptions.onError?.(error, { kind: "final" });
              return {
                queuedFinal: false,
                counts: { tool: 0, block: 0, final: 0 },
              };
            }
          },

          createReplyDispatcherWithTyping:
            replyRuntime.createReplyDispatcherWithTyping,
          finalizeInboundContext: replyDispatchRuntime.finalizeInboundContext,
          formatAgentEnvelope: channelInbound.formatInboundEnvelope,
          formatInboundEnvelope: channelInbound.formatInboundEnvelope,
          resolveEnvelopeFormatOptions:
            channelInbound.resolveEnvelopeFormatOptions,
          resolveEffectiveMessagesConfig: (cfg: unknown) =>
            (cfg as Record<string, unknown>)?.["messages"] ?? {},
          resolveHumanDelayConfig: () => undefined,
          withReplyDispatcher: async (
            d: unknown,
            fn: (x: unknown) => Promise<unknown>,
          ) => fn(d),
        },

        // -- Routing --
        routing: {
          buildAgentSessionKey: routingSdk.buildAgentSessionKey,
          resolveAgentRoute: routingSdk.resolveAgentRoute,
        },

        // -- Stubs --
        pairing: {
          buildPairingReply: () => ({
            text: "Pairing not supported in A2A gateway.",
          }),
          readAllowFromStore: async () => [],
          upsertPairingRequest: async () => {},
        },
        media: {
          fetchRemoteMedia: async () => Buffer.alloc(0),
          saveMediaBuffer: async (_b: unknown, _n: string) =>
            `/tmp/${crypto.randomUUID()}`,
        },
        activity: {
          record: channelRuntimeSdk.recordChannelActivity ?? (() => {}),
          get: () => null,
        },
        session: {
          resolveStorePath: () => "/tmp/a2a-sessions",
          readSessionUpdatedAt: async () => null,
          recordSessionMetaFromInbound: async () => {},
          recordInboundSession: async () => {},
          updateLastRoute: async () => {},
        },
        mentions: {
          buildMentionRegexes: channelInbound.buildMentionRegexes,
          matchesMentionPatterns: channelInbound.matchesMentionPatterns,
          matchesMentionWithExplicit: channelInbound.matchesMentionWithExplicit,
          implicitMentionKindWhen: channelInbound.implicitMentionKindWhen,
          resolveInboundMentionDecision:
            channelInbound.resolveInboundMentionDecision,
        },
        reactions: {
          shouldAckReaction: () => false,
          removeAckReactionAfterReply: async () => {},
        },
        groups: {
          resolveGroupPolicy: () => ({ allowed: true }),
          resolveRequireMention: () => false,
        },
        debounce: {
          createInboundDebouncer: replyRuntime.createInboundDebouncer,
          resolveInboundDebounceMs: replyRuntime.resolveInboundDebounceMs,
        },
        commands: {
          resolveCommandAuthorizedFromAuthorizers: () => true,
          isControlCommandMessage: commandDetection.isControlCommandMessage,
          shouldComputeCommandAuthorized:
            commandDetection.shouldComputeCommandAuthorized,
          shouldHandleTextCommands: () => true,
        },
        outbound: { loadAdapter: async () => null },
        threadBindings: {
          setIdleTimeoutBySessionKey: () => [],
          setMaxAgeBySessionKey: () => [],
        },
        runtimeContexts: {
          register: (_p: unknown) => ({ dispose: () => {} }),
          get: () => undefined,
          watch: () => () => {},
        },
      },
    } as unknown as PluginRuntime;
  }
}
