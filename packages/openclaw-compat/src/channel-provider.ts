/**
 * Generic OpenClaw-compatible channel provider.
 *
 * Bridges the gateway's {@link ChannelProvider} interface to the
 * {@link OpenClawPluginHost} lifecycle, allowing any registered OpenClaw
 * channel plugin to be managed by the {@link MonitorManager} without
 * per-channel wrappers.
 *
 * ── Message flow overview ──
 *
 *  ChannelBinding (store)
 *    │  MonitorManager reads enabled bindings and asks the provider
 *    │  to create an account runner for each one.
 *    ▼
 *  OpenClawChannelProvider.createAccountRunner(binding)
 *    │  Returns a lightweight runner whose run() delegates to the
 *    │  PluginHost which starts the underlying channel plugin.
 *    ▼
 *  OpenClawPluginHost.startChannelAccount(channelType, accountId, signal)
 *    │  Resolves the registered plugin and calls its
 *    │  gateway.startAccount() hook with config, logging env, etc.
 *    ▼
 *  Channel plugin (e.g. @larksuite/openclaw-lark)
 *    │  Opens a long-lived connection (WebSocket) and listens for
 *    │  inbound messages.  When a message arrives, the plugin calls
 *    │  runtime.channel.reply.dispatchReplyFromConfig().
 *    ▼
 *  OpenClawPluginRuntime.dispatch(ctx)
 *    │  Extracts the user message from the channel context, resolves
 *    │  the bound agent URL + protocol, and delegates to the matching
 *    │  AgentTransport (A2A / ACP) via the TransportRegistry.
 *    ▼
 *  AgentTransport.send(agentUrl, request) → AgentResponse
 *    │  The response text is delivered back through the plugin's reply
 *    │  dispatcher to the channel.
 *    ▼
 *  Channel plugin sends reply to user
 */

import type {
  ChannelAccountRunner,
  ChannelBindingRef,
  ChannelProvider,
} from '@a2a-channels/core';
import type { OpenClawPluginHost } from './plugin-host.js';

/**
 * A single generic provider that supports every channel plugin registered
 * with the given {@link OpenClawPluginHost}.
 *
 * Register one instance of this class in the gateway instead of writing a
 * separate {@link ChannelProvider} per channel type.
 */
export class OpenClawChannelProvider implements ChannelProvider {
  /**
   * This value is not used for routing — the {@link supports} method performs
   * the actual channel-type check by querying the host's plugin registry.
   */
  readonly channelType = 'openclaw-adapter';

  constructor(private readonly host: OpenClawPluginHost) {}

  /** Returns true when the host has a registered plugin for `channelType`. */
  supports(channelType: string): boolean {
    return this.host.hasChannel(channelType);
  }

  /**
   * Create a runner that, when started, opens the channel plugin's long-lived
   * connection for the given account.
   *
   * The runner delegates to {@link OpenClawPluginHost.startChannelAccount},
   * which in turn calls the registered plugin's `gateway.startAccount()` hook.
   */
  createAccountRunner(binding: ChannelBindingRef): ChannelAccountRunner {
    const { accountId, channelType } = binding;
    const host = this.host;

    return {
      async run(signal: AbortSignal): Promise<void> {
        console.log(`[openclaw-provider] starting account runner for ${channelType}:${accountId}`);
        await host.startChannelAccount(channelType, accountId, signal);
      },
    };
  }
}
