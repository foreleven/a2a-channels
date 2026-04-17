/**
 * Generic OpenClaw-compatible channel provider.
 *
 * Wraps an OpenClawPluginHost and bridges the gateway's ChannelProvider
 * interface to the host's startChannelAccount() lifecycle method.
 *
 * Any OpenClaw channel plugin registered with the host is automatically
 * supported – no per-channel package is required.
 */

import type {
  ChannelAccountRunner,
  ChannelBindingRef,
  ChannelProvider,
} from '@a2a-channels/core';
import type { GatewayRuntimeEnv } from './plugin-host.js';
import { OpenClawPluginHost } from './plugin-host.js';

function makeRuntimeEnv(channelType: string, accountId: string): GatewayRuntimeEnv {
  return {
    log:   (...args: unknown[]) => console.log(`[${channelType}:${accountId}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${channelType}:${accountId}]`, ...args),
    exit:  (code: number) => process.exit(code),
  };
}

class OpenClawAccountRunner implements ChannelAccountRunner {
  constructor(
    private readonly binding: ChannelBindingRef,
    private readonly host: OpenClawPluginHost,
  ) {}

  async run(signal: AbortSignal): Promise<void> {
    const { accountId, channelType } = this.binding;
    console.log(`[openclaw-provider] starting account runner for ${channelType}:${accountId}`);
    await this.host.startChannelAccount(
      channelType,
      accountId,
      makeRuntimeEnv(channelType, accountId),
      signal,
    );
  }
}

/**
 * A single generic provider that supports every channel plugin registered
 * with the given OpenClawPluginHost.  Register this in the gateway instead
 * of a per-channel ChannelProvider implementation.
 */
export class OpenClawChannelProvider implements ChannelProvider {
  readonly channelType = 'openclaw';

  constructor(private readonly host: OpenClawPluginHost) {}

  supports(channelType: string): boolean {
    return this.host.hasChannel(channelType);
  }

  createAccountRunner(binding: ChannelBindingRef): ChannelAccountRunner {
    return new OpenClawAccountRunner(binding, this.host);
  }
}
