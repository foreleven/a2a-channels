/**
 * A minimal PluginRuntime implementation for the a2a-channels gateway.
 *
 * Only the surface actually called by @larksuite/openclaw-lark is implemented;
 * everything else is a safe no-op stub.  The two critical dispatch functions
 * (dispatchReplyFromConfig and dispatchReplyWithBufferedBlockDispatcher) call
 * an A2A agent instead of the real OpenClaw LLM pipeline.
 */

import crypto from 'node:crypto';
import { A2AClient } from '@a2a-js/sdk/client';

// Import real helpers from the openclaw SDK that we can reuse
// @ts-expect-error – type declarations don't include all exported symbols
import * as replyRuntime from 'openclaw/plugin-sdk/reply-runtime';
// @ts-expect-error
import * as channelInbound from 'openclaw/plugin-sdk/channel-inbound';
// @ts-expect-error
import * as channelRuntimeSdk from 'openclaw/plugin-sdk/channel-runtime';
// @ts-expect-error
import * as markdownTableRuntime from 'openclaw/plugin-sdk/markdown-table-runtime';
// @ts-expect-error
import * as textRuntimeSdk from 'openclaw/plugin-sdk/text-runtime';
// @ts-expect-error
import * as commandDetection from 'openclaw/plugin-sdk/command-detection';
// @ts-expect-error
import * as routingSdk from 'openclaw/plugin-sdk/routing';
// @ts-expect-error
import * as replyDispatchRuntime from 'openclaw/plugin-sdk/reply-dispatch-runtime';

import { getAgentUrlForAccount, buildOpenClawConfig } from '../store/index.js';

// ---------------------------------------------------------------------------
// A2A helpers
// ---------------------------------------------------------------------------

/** Extract plain text from an A2A Message result */
function extractTextFromA2AResult(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;

  // JSON-RPC success envelope: { jsonrpc, id, result: { ... } }
  if ('jsonrpc' in r && 'result' in r) {
    return extractTextFromA2AResult(r['result']);
  }

  // Message result: { kind: 'message', parts: [...] }
  if (r['kind'] === 'message') {
    const parts = Array.isArray(r['parts']) ? r['parts'] : [];
    return parts
      .filter((p: unknown) => typeof p === 'object' && p !== null && (p as Record<string, unknown>)['kind'] === 'text')
      .map((p: unknown) => ((p as Record<string, unknown>)['text'] as string) ?? '')
      .join('\n')
      .trim();
  }

  // Task result: { kind: 'task', artifacts: [{ parts: [...] }] }
  if (r['kind'] === 'task') {
    const artifacts = Array.isArray(r['artifacts']) ? r['artifacts'] : [];
    const texts: string[] = [];
    for (const artifact of artifacts as Array<Record<string, unknown>>) {
      const parts = Array.isArray(artifact['parts']) ? artifact['parts'] : [];
      for (const p of parts as Array<Record<string, unknown>>) {
        if (p['kind'] === 'text' && typeof p['text'] === 'string') {
          texts.push(p['text']);
        }
      }
    }
    return texts.join('\n').trim();
  }

  return '';
}

/**
 * Send a message to an A2A agent and return the response text.
 * Falls back to an error string when the agent is unavailable.
 */
async function callA2AAgent(
  agentUrl: string,
  userMessage: string,
  contextId?: string,
): Promise<string> {
  try {
    // Build a minimal inline AgentCard pointing at the target URL
    const agentCard = {
      name: 'A2A Agent',
      description: 'A2A agent',
      url: agentUrl,
      protocolVersion: '0.3.0',
      version: '1.0.0',
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    };

    const client = new A2AClient(agentCard as never);
    const result = await client.sendMessage({
      message: {
        kind: 'message',
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{ kind: 'text', text: userMessage }],
        ...(contextId ? { contextId } : {}),
      },
    });
    return extractTextFromA2AResult(result) || '(no response from agent)';
  } catch (err) {
    console.error('[a2a] failed to reach agent at', agentUrl, ':', String(err));
    return `(agent unavailable: ${String(err)})`;
  }
}

// ---------------------------------------------------------------------------
// Runtime builder
// ---------------------------------------------------------------------------

/**
 * Build the PluginRuntime object injected into the openclaw-lark plugin.
 *
 * The runtime is accessed via `LarkClient.runtime` inside the plugin.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildPluginRuntime(): any {
  return {
    version: '1.0.0',

    // ---- Config ----
    config: {
      loadConfig: () => buildOpenClawConfig(),
      writeConfigFile: async () => {},
    },

    // ---- Agent ----
    agent: {
      defaults: { model: 'gpt-4o', provider: 'openai' },
      resolveAgentDir: () => '/tmp/a2a-channels',
      resolveAgentWorkspaceDir: () => '/tmp/a2a-channels',
      resolveAgentIdentity: () => ({ agentId: 'main', name: 'main' }),
      resolveThinkingDefault: () => 'off',
      runEmbeddedAgent: async () => ({ text: '', sessionKey: '' }),
      runEmbeddedPiAgent: async () => ({ text: '', sessionKey: '' }),
      resolveAgentTimeoutMs: () => 30_000,
      ensureAgentWorkspace: async () => {},
      session: {
        resolveStorePath: () => '/tmp/a2a-sessions',
        loadSessionStore: async () => ({ messages: [] }),
        saveSessionStore: async () => {},
        resolveSessionFilePath: () => '/tmp/a2a-sessions/session.json',
      },
    },

    // ---- System ----
    system: {
      enqueueSystemEvent: (msg: string, meta?: unknown) => {
        console.log('[system]', msg, meta ?? '');
      },
      requestHeartbeatNow: async () => {},
      runHeartbeatOnce: async () => ({ ok: true }),
      runCommandWithTimeout: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      formatNativeDependencyHint: (h: { name: string }) => h.name,
    },

    // ---- Media / TTS / etc. (stubs) ----
    media: {
      loadWebMedia: async () => null,
      detectMime: () => 'application/octet-stream',
      mediaKindFromMime: () => 'file',
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
      describeImageFile: async () => '',
      describeImageFileWithModel: async () => '',
      describeVideoFile: async () => '',
      transcribeAudioFile: async () => '',
    },
    imageGeneration: {
      generate: async () => ({ url: '' }),
      listProviders: () => [],
    },
    videoGeneration: {
      generate: async () => ({ url: '' }),
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
      flows: {
        get: async () => null,
        list: async () => [],
      },
    },

    // ---- Channel ----
    channel: {
      // -- Text helpers (real implementations from openclaw SDK) --
      text: {
        chunkByNewline: (text: string, limit?: number) => {
          if (!limit) return text.split('\n');
          const chunks: string[] = [];
          let current = '';
          for (const line of text.split('\n')) {
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
        chunkMarkdownText: replyRuntime.chunkMarkdownText ?? replyRuntime.chunkMarkdownTextWithMode,
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
         *
         * Instead of running an LLM agent we forward the message to the A2A agent
         * configured for this channel account, then deliver the reply text via the
         * dispatcher (which in turn sends it back to the Feishu user).
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
          const ctx = params.ctx;
          const userMessage =
            (ctx['BodyForAgent'] as string | undefined) ??
            (ctx['Body'] as string | undefined) ??
            (ctx['RawBody'] as string | undefined) ??
            '';

          const sessionKey = ctx['SessionKey'] as string | undefined;
          const accountId = ctx['AccountId'] as string | undefined;

          if (!userMessage.trim()) {
            params.dispatcher.markComplete();
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          }

          const agentUrl = getAgentUrlForAccount(accountId);
          const responseText = await callA2AAgent(agentUrl, userMessage, sessionKey);

          params.dispatcher.sendFinalReply({ text: responseText });
          await params.dispatcher.waitForIdle();
          params.dispatcher.markComplete();

          return { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } };
        },

        /**
         * BUFFERED DISPATCH: used by openclaw-lark for comment/drive replies.
         * Delivers through the caller-supplied dispatcherOptions.deliver callback.
         */
        dispatchReplyWithBufferedBlockDispatcher: async (params: {
          ctx: Record<string, unknown>;
          cfg: unknown;
          dispatcherOptions: {
            deliver: (payload: { text: string }, info: { kind: string }) => Promise<void>;
            onSkip?: (payload: unknown, info: unknown) => void;
            onError?: (err: unknown, info: unknown) => void;
          };
          replyOptions?: unknown;
        }) => {
          const ctx = params.ctx;
          const userMessage =
            (ctx['BodyForAgent'] as string | undefined) ??
            (ctx['Body'] as string | undefined) ??
            (ctx['RawBody'] as string | undefined) ??
            '';

          const sessionKey = ctx['SessionKey'] as string | undefined;
          const accountId = ctx['AccountId'] as string | undefined;

          if (!userMessage.trim()) {
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          }

          const agentUrl = getAgentUrlForAccount(accountId);
          try {
            const responseText = await callA2AAgent(agentUrl, userMessage, sessionKey);
            await params.dispatcherOptions.deliver({ text: responseText }, { kind: 'final' });
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } };
          } catch (err) {
            params.dispatcherOptions.onError?.(err, { kind: 'final' });
            return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
          }
        },

        // Real helper from openclaw SDK
        createReplyDispatcherWithTyping: replyRuntime.createReplyDispatcherWithTyping,
        // Real helper to build FinalizedMsgContext
        finalizeInboundContext: replyDispatchRuntime.finalizeInboundContext,
        // Envelope formatting
        formatAgentEnvelope: channelInbound.formatInboundEnvelope,
        formatInboundEnvelope: channelInbound.formatInboundEnvelope,
        resolveEnvelopeFormatOptions: channelInbound.resolveEnvelopeFormatOptions,
        // Stubs for less-used helpers
        resolveEffectiveMessagesConfig: (cfg: unknown) => (cfg as Record<string, unknown>)?.['messages'] ?? {},
        resolveHumanDelayConfig: () => undefined,
        dispatchReplyFromConfig: undefined as never, // will be overridden below
        withReplyDispatcher: async (_d: unknown, fn: (d: unknown) => Promise<unknown>) => fn(_d),
      },

      // -- Routing --
      routing: {
        buildAgentSessionKey: routingSdk.buildAgentSessionKey,
        resolveAgentRoute: routingSdk.resolveAgentRoute,
      },

      // -- Pairing (stubs) --
      pairing: {
        buildPairingReply: () => ({ text: 'Pairing not supported in A2A gateway.' }),
        readAllowFromStore: async () => undefined,
        upsertPairingRequest: async () => {},
      },

      // -- Media --
      media: {
        fetchRemoteMedia: async () => Buffer.alloc(0),
        saveMediaBuffer: async (_buffer: unknown, _name: string) => `/tmp/${crypto.randomUUID()}`,
      },

      // -- Activity --
      activity: {
        record: channelRuntimeSdk.recordChannelActivity ?? (() => {}),
        get: () => null,
      },

      // -- Session --
      session: {
        resolveStorePath: () => '/tmp/a2a-sessions',
        readSessionUpdatedAt: async () => null,
        recordSessionMetaFromInbound: async () => {},
        recordInboundSession: async () => {},
        updateLastRoute: async () => {},
      },

      // -- Mentions --
      mentions: {
        buildMentionRegexes: channelInbound.buildMentionRegexes,
        matchesMentionPatterns: channelInbound.matchesMentionPatterns,
        matchesMentionWithExplicit: channelInbound.matchesMentionWithExplicit,
        implicitMentionKindWhen: channelInbound.implicitMentionKindWhen,
        resolveInboundMentionDecision: channelInbound.resolveInboundMentionDecision,
      },

      // -- Reactions (stubs) --
      reactions: {
        shouldAckReaction: () => false,
        removeAckReactionAfterReply: async () => {},
      },

      // -- Groups --
      groups: {
        resolveGroupPolicy: () => undefined,
        resolveRequireMention: () => undefined,
      },

      // -- Debounce --
      debounce: {
        createInboundDebouncer: replyRuntime.createInboundDebouncer,
        resolveInboundDebounceMs: replyRuntime.resolveInboundDebounceMs,
      },

      // -- Commands --
      commands: {
        resolveCommandAuthorizedFromAuthorizers: () => true,
        isControlCommandMessage: commandDetection.isControlCommandMessage,
        shouldComputeCommandAuthorized: commandDetection.shouldComputeCommandAuthorized,
        shouldHandleTextCommands: () => true,
      },

      // -- Outbound adapter loader (stub) --
      outbound: {
        loadAdapter: async () => null,
      },

      // -- Thread bindings (stubs) --
      threadBindings: {
        setIdleTimeoutBySessionKey: () => [],
        setMaxAgeBySessionKey: () => [],
      },

      // -- Runtime contexts (stubs) --
      runtimeContexts: {
        register: (_params: unknown) => ({ dispose: () => {} }),
        get: () => undefined,
        watch: () => () => {},
      },
    },
  };
}
