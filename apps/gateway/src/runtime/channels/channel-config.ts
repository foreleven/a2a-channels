import type { OpenClawConfig } from "openclaw/plugin-sdk";

type OpenClawChannels = NonNullable<OpenClawConfig["channels"]>;

export type RuntimeChannelKey = keyof OpenClawChannels;

/** Channel-specific runtime config rules that sit outside the generic projector. */
export interface RuntimeChannelConfigSchema {
  readonly channelKey: RuntimeChannelKey;
  project(config: Record<string, unknown>): Record<string, unknown>;
}

