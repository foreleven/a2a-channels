import type {
  ChannelAccountRunner,
  ChannelBindingRef,
  ChannelProvider,
} from '@a2a-channels/core';
import type { OpenClawPluginHost, GatewayRuntimeEnv } from '@a2a-channels/openclaw-compat';

function makeRuntimeEnv(channelType: string, accountId: string): GatewayRuntimeEnv {
  return {
    log:   (...args: unknown[]) => console.log(`[${channelType}:${accountId}]`, ...args),
    error: (...args: unknown[]) => console.error(`[${channelType}:${accountId}]`, ...args),
    exit:  (code: number) => process.exit(code),
  };
}

class LarkAccountRunner implements ChannelAccountRunner {
  constructor(
    private readonly binding: ChannelBindingRef,
    private readonly host: OpenClawPluginHost,
  ) {}

  /**
   * The runtime is set once at startup via registerLarkPlugin / host.setRuntime().
   * Per-runner injection is a no-op; the interface method is kept for
   * compatibility with MonitorManager which calls it before each account run.
   */
  injectRuntime(_runtime: unknown): void {}

  async run(signal: AbortSignal): Promise<void> {
    const { accountId, channelType } = this.binding;
    console.log(`[lark-provider] starting account runner for ${channelType}:${accountId}`);
    await this.host.startChannelAccount(
      channelType,
      accountId,
      makeRuntimeEnv(channelType, accountId),
      signal,
    );
  }
}

export class LarkChannelProvider implements ChannelProvider {
  readonly channelType = 'lark';
  readonly aliases: readonly string[] = ['feishu'];

  constructor(private readonly host: OpenClawPluginHost) {}

  supports(channelType: string): boolean {
    return this.channelType === channelType || this.aliases.includes(channelType);
  }

  createAccountRunner(binding: ChannelBindingRef): ChannelAccountRunner {
    return new LarkAccountRunner(binding, this.host);
  }
}
