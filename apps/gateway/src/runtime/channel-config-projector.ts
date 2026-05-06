import type { ChannelBindingSnapshot } from "@agent-relay/domain";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { channelTypeRegistry } from "./channel-type-registry.js";

type ChannelBinding = ChannelBindingSnapshot;
type OpenClawChannels = NonNullable<OpenClawConfig["channels"]>;

/** Projected OpenClaw channel account config for one binding. */
export interface ProjectedChannelConfig {
  accountId: string;
  channelKey: keyof OpenClawChannels;
  config: Record<string, unknown>;
}

/** Maps gateway channel bindings into OpenClaw channel config fragments. */
export interface ChannelConfigProjector {
  project(binding: ChannelBinding): ProjectedChannelConfig | null;
}

/** Projects gateway bindings into plugin-owned OpenClaw channel sections. */
export class GenericChannelConfigProjector implements ChannelConfigProjector {
  /** Returns an OpenClaw account config for enabled channel bindings. */
  project(binding: ChannelBinding): ProjectedChannelConfig | null {
    if (!binding.enabled) {
      return null;
    }

    return {
      accountId: binding.accountId,
      channelKey: channelTypeRegistry.canonicalize(
        binding.channelType,
      ) as keyof OpenClawChannels,
      config: this.buildAccountConfig(binding),
    };
  }

  /** Adds gateway-owned metadata while preserving plugin-owned account fields. */
  private buildAccountConfig(binding: ChannelBinding): Record<string, unknown> {
    return {
      ...binding.channelConfig,
      bindingId: binding.id,
      enabled: true,
    };
  }
}
