/**
 * ChannelAdapter – contract every channel plugin must satisfy.
 *
 * The MonitorManager owns the account lifecycle (start/stop/restart).
 * Adapters are responsible only for the channel-specific wiring:
 *   • `start`         – open the inbound connection for one account and keep it
 *                       alive until the AbortSignal fires.
 *   • `injectRuntime` – push the shared PluginRuntime into the channel SDK so
 *                       that inbound messages are dispatched through the A2A bridge.
 *
 * To add a new channel (e.g. Slack) create `slack-adapter.ts`, implement
 * this interface, and register the instance with MonitorManager.
 */
export interface ChannelAdapter {
  /** Identifies the channel type, must match `ChannelBinding.channelType`. */
  readonly channelType: string;

  /**
   * Start listening for inbound messages for the given account.
   * Resolves when the connection ends (normally or after abort).
   */
  start(accountId: string, signal: AbortSignal): Promise<void>;

  /**
   * Inject the shared PluginRuntime into the channel SDK.
   * Called immediately after `start()` to ensure the runtime is in place
   * before the first message arrives.
   */
  injectRuntime(runtime: unknown): void;
}
