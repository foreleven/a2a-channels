/**
 * Channel provider contracts used by the gateway monitor lifecycle manager.
 */

export interface ChannelBindingRef {
  accountId: string;
  channelType: string;
}

export interface ChannelAccountRunner {
  /**
   * Push the shared plugin runtime into the channel SDK.
   * Called once before run() for each new runner instance.
   */
  injectRuntime(runtime: unknown): void;

  /**
   * Open the channel connection and keep it alive until signal fires.
   * Resolves when the connection ends normally or after abort.
   */
  run(signal: AbortSignal): Promise<void>;
}

export interface ChannelProvider {
  readonly channelType: string;
  readonly aliases?: readonly string[];

  /**
   * Returns true when this provider handles the given channelType,
   * including aliases (e.g. 'feishu' for the Lark provider).
   */
  supports(channelType: string): boolean;

  createAccountRunner(binding: ChannelBindingRef): ChannelAccountRunner;
}
