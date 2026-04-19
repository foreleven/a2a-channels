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

import type { ChannelReplyEvent } from "../plugin-runtime.js";

type PluginRuntimeChannel = PluginRuntime["channel"];

/**
 * Build the `channel` surface of a `PluginRuntime`.
 *
 * Real text/chunk/routing/mention helpers are wired to the actual openclaw
 * SDK implementations. The reply dispatch methods are intercepted and turned
 * into explicit channel reply events handled by the injected runtime owner.
 */
export function buildChannelCompat(
  handleChannelReplyEvent: (
    event: ChannelReplyEvent,
  ) => Promise<
    Awaited<
      ReturnType<PluginRuntime["channel"]["reply"]["dispatchReplyFromConfig"]>
    >
  >,
): PluginRuntimeChannel {
  return {
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

    reply: {
      dispatchReplyFromConfig: async (
        params: Parameters<
          PluginRuntimeChannel["reply"]["dispatchReplyFromConfig"]
        >[0],
      ) => {
        return handleChannelReplyEvent({
          type: "channel.reply.dispatch",
          ctx: params.ctx,
          cfg: params.cfg,
          dispatcher: params.dispatcher,
          replyOptions: params.replyOptions,
        });
      },

      dispatchReplyWithBufferedBlockDispatcher: async (
        params: Parameters<
          PluginRuntimeChannel["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
        >[0],
      ) => {
        return handleChannelReplyEvent({
          type: "channel.reply.buffered.dispatch",
          ctx: params.ctx,
          dispatcherOptions: params.dispatcherOptions,
        });
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
          params.dispatcher.markComplete();
          try {
            await params.dispatcher.waitForIdle();
          } finally {
            await params.onSettled?.();
          }
        }
      },
    },

    routing: {
      buildAgentSessionKey: routingSdk.buildAgentSessionKey,
      resolveAgentRoute: routingSdk.resolveAgentRoute,
    },

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
