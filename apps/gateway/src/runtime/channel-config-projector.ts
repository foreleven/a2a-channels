import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

type ChannelBinding = ChannelBindingSnapshot;
type OpenClawChannels = NonNullable<OpenClawConfig["channels"]>;
type FeishuConfig = OpenClawChannels["feishu"];

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

/** Feishu channel credentials stored on a channel binding. */
interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  allowFrom?: string[];
}

/** Projects Feishu/Lark bindings into the OpenClaw feishu channel shape. */
export class FeishuChannelConfigProjector implements ChannelConfigProjector {
  /** Returns an OpenClaw account config for enabled Feishu bindings. */
  project(binding: ChannelBinding): ProjectedChannelConfig | null {
    if (!binding.enabled || binding.channelType !== "feishu") {
      return null;
    }

    return {
      accountId: binding.accountId,
      channelKey: "feishu",
      config: this.buildAccountConfig(binding) as Record<string, unknown>,
    };
  }

  /** Maps one gateway binding snapshot into one OpenClaw Feishu account config. */
  private buildAccountConfig(binding: ChannelBinding): FeishuConfig {
    const cfg = binding.channelConfig as unknown as FeishuChannelConfig;
    return {
      bindingId: binding.id,
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      encryptKey: cfg.encryptKey,
      verificationToken: cfg.verificationToken,
      enabled: true,
      allowFrom: cfg.allowFrom ?? ["*"],
      replyMode: "static",
      dmPolicy: "open",
      groupPolicy: "open",
    };
  }
}
