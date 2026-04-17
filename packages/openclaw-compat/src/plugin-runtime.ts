/**
 * OpenClaw-compatible runtime surface for community channel plugins.
 *
 * Only the subset used by @larksuite/openclaw-lark is implemented.
 * Reply dispatch is intercepted and forwarded to the configured agent
 * via the injected AgentTransport, keeping this package free of any
 * direct dependency on a specific protocol SDK or store implementation.
 */

import crypto from "node:crypto";

import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import * as channelRuntimeSdk from "openclaw/plugin-sdk/channel-runtime";
import * as commandDetection from "openclaw/plugin-sdk/command-detection";
import * as markdownTableRuntime from "openclaw/plugin-sdk/markdown-table-runtime";
import * as replyDispatchRuntime from "openclaw/plugin-sdk/reply-dispatch-runtime";
import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import * as routingSdk from "openclaw/plugin-sdk/routing";
import * as textRuntimeSdk from "openclaw/plugin-sdk/text-runtime";

import type { AgentTransport } from "@a2a-channels/core";

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
// Runtime builder
// ---------------------------------------------------------------------------

export function buildOpenClawPluginRuntime(
  options: PluginRuntimeOptions,
): Record<string, unknown> {
  const { transport, getAgentUrl, getConfig } = options;

  async function dispatch(
    ctx: Record<string, unknown>,
  ): Promise<{ text: string } | null> {
    const userMessage =
      (ctx["BodyForAgent"] as string | undefined) ??
      (ctx["Body"] as string | undefined) ??
      (ctx["RawBody"] as string | undefined) ??
      "";

    if (!userMessage.trim()) return null;

    const agentUrl = getAgentUrl(ctx["AccountId"] as string | undefined);
    return transport.send(agentUrl, {
      userMessage,
      contextId: ctx["SessionKey"] as string | undefined,
      accountId: ctx["AccountId"] as string | undefined,
    });
  }

  return {
    version: "1.0.0",

    // ---- Config ----
    config: {
      loadConfig: () => getConfig(),
      writeConfigFile: async () => {},
    },

    // ---- Agent (stubs – this gateway doesn't run embedded agents) ----
    agent: {
      defaults: { model: "gpt-4o", provider: "openai" },
      resolveAgentDir: () => "/tmp/a2a-channels",
      resolveAgentWorkspaceDir: () => "/tmp/a2a-channels",
      resolveAgentIdentity: () => ({ agentId: "main", name: "main" }),
      resolveThinkingDefault: () => "off",
      runEmbeddedAgent: async () => ({ text: "", sessionKey: "" }),
      runEmbeddedPiAgent: async () => ({ text: "", sessionKey: "" }),
      resolveAgentTimeoutMs: () => 30_000,
      ensureAgentWorkspace: async () => {},
      session: {
        resolveStorePath: () => "/tmp/a2a-sessions",
        loadSessionStore: async () => ({ messages: [] }),
        saveSessionStore: async () => {},
        resolveSessionFilePath: () => "/tmp/a2a-sessions/session.json",
      },
    },

    // ---- System ----
    system: {
      enqueueSystemEvent: (msg: string, meta?: unknown) => {
        console.log("[system]", msg, meta ?? "");
      },
      requestHeartbeatNow: async () => {},
      runHeartbeatOnce: async () => ({ ok: true }),
      runCommandWithTimeout: async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
      formatNativeDependencyHint: (h: { name: string }) => h.name,
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
        resolveMarkdownTableMode: markdownTableRuntime.resolveMarkdownTableMode,
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
          const response = await dispatch(params.ctx);
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
          const response = await dispatch(params.ctx);
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
  };
}
