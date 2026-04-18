import crypto from "node:crypto";

import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import * as channelRuntimeSdk from "openclaw/plugin-sdk/channel-runtime";
import * as commandDetection from "openclaw/plugin-sdk/command-detection";
import * as markdownTableRuntime from "openclaw/plugin-sdk/markdown-table-runtime";
import * as replyDispatchRuntime from "openclaw/plugin-sdk/reply-dispatch-runtime";
import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import * as routingSdk from "openclaw/plugin-sdk/routing";
import * as textRuntimeSdk from "openclaw/plugin-sdk/text-runtime";

import type { PluginRuntime } from "openclaw/plugin-sdk";

type PluginRuntimeChannel = PluginRuntime["channel"];

/**
 * Build the `channel` surface of a `PluginRuntime`.
 *
 * Real text/chunk/routing/mention helpers are wired to the actual openclaw
 * SDK implementations.  The reply dispatch methods are intercepted so that
 * messages are forwarded to the bound A2A / ACP agent.
 *
 * @param dispatch  The function that forwards an inbound context to the agent
 *   and returns its reply, or `null` when the message should be ignored.
 */
export function buildChannelCompat(
  dispatch: (ctx: Record<string, unknown>) => Promise<{ text: string } | null>,
): PluginRuntimeChannel {
  return {
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
        console.log(
          `[runtime] dispatchReplyFromConfig`,
          params.ctx,
          params.cfg,
          params.dispatcher,
          params.replyOptions,
        );
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
      dispatchReplyWithBufferedBlockDispatcher: async (
        params: Parameters<
          PluginRuntimeChannel["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
        >[0],
      ) => {
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
      formatAgentEnvelope: (
        params: Parameters<
          PluginRuntimeChannel["reply"]["formatAgentEnvelope"]
        >[0],
      ) => {
        return channelInbound.formatInboundEnvelope({
          channel: params.channel,
          from: params.from ?? "",
          body: params.body,
          timestamp: params.timestamp,
          envelope: params.envelope,
        });
      },
      formatInboundEnvelope: channelInbound.formatInboundEnvelope,
      resolveEnvelopeFormatOptions: channelInbound.resolveEnvelopeFormatOptions,
      resolveEffectiveMessagesConfig: (
        ...params: Parameters<
          PluginRuntimeChannel["reply"]["resolveEffectiveMessagesConfig"]
        >
      ) => {
        const [cfg, agentId, opts] = params;
        return {
          messagePrefix: "occ",
          responsePrefix: "occ",
        };
      },
      resolveHumanDelayConfig: () => undefined,
      withReplyDispatcher: async <T>(
        params: Parameters<
          PluginRuntimeChannel["reply"]["withReplyDispatcher"]
        >[0],
      ): Promise<T> => {
        try {
          return (await params.run()) as T;
        } finally {
          // Ensure dispatcher reservations are always released on every exit path.
          params.dispatcher.markComplete();
          try {
            await params.dispatcher.waitForIdle();
          } finally {
            await params.onSettled?.();
          }
        }
      },
    },

    // -- Routing --
    routing: {
      buildAgentSessionKey: routingSdk.buildAgentSessionKey,
      resolveAgentRoute: routingSdk.resolveAgentRoute,
    },

    // -- Stubs --
    pairing: {
      buildPairingReply: (
        params: Parameters<
          PluginRuntimeChannel["pairing"]["buildPairingReply"]
        >[0],
      ) => {
        const { channel, idLine, code } = params;
        const approveCommand = `openclaw pairing approve ${channel} ${code}`;
        return [
          "OpenClaw: access not configured.",
          "",
          idLine,
          "Pairing code:",
          "```",
          code,
          "```",
          "",
          "Ask the bot owner to approve with:",
          `openclaw pairing approve ${channel} ${code}`,
          "```",
          approveCommand,
          "```",
        ].join("\n");
      },
      readAllowFromStore: async () => [],
      upsertPairingRequest: async (
        params: Parameters<
          PluginRuntimeChannel["pairing"]["upsertPairingRequest"]
        >[0],
      ) => {
        // TODO: implement pairing request storage and expiration logic
        return {
          code: "",
          created: true,
        };
      },
    },
    media: {
      fetchRemoteMedia: async (
        params: Parameters<
          PluginRuntimeChannel["media"]["fetchRemoteMedia"]
        >[0],
      ) => {
        return {
          buffer: Buffer.from(""),
        };
      },
      saveMediaBuffer: async (
        ...params: Parameters<PluginRuntimeChannel["media"]["saveMediaBuffer"]>
      ) => {
        const [buffer, contentType, subdir, maxBytes, originalFilename] =
          params;
        return {
          id: "",
          path: "",
          size: 0,
          contentType: contentType,
        };
      },
    },
    activity: {
      record: channelRuntimeSdk.recordChannelActivity ?? (() => {}),
      get: (params: Parameters<PluginRuntimeChannel["activity"]["get"]>[0]) => {
        return {
          inboundAt: 0,
          outboundAt: 0,
        };
      },
    },
    session: {
      resolveStorePath: () => "/tmp/a2a-sessions",
      readSessionUpdatedAt: (
        params: Parameters<
          PluginRuntimeChannel["session"]["readSessionUpdatedAt"]
        >[0],
      ) => 0,
      recordSessionMetaFromInbound: async () => {
        return null;
      },
      recordInboundSession: async () => {},
      updateLastRoute: async () => {
        throw new Error("Not implemented");
      },
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
      resolveGroupPolicy: () => ({ allowed: true, allowlistEnabled: true }),
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
    outbound: { loadAdapter: async () => undefined },
    threadBindings: {
      setIdleTimeoutBySessionKey: () => [],
      setMaxAgeBySessionKey: () => [],
    },
    runtimeContexts: {
      register: (_p: unknown) => ({ dispose: () => {} }),
      get: () => undefined,
      watch: () => () => {},
    },
  };
}
