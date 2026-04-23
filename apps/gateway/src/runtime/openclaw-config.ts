import { injectable } from "inversify";
import type {
  AgentConfigSnapshot,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

type AgentConfig = AgentConfigSnapshot;
type ChannelBinding = ChannelBindingSnapshot;

interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  allowFrom?: string[];
}

type FeishuConfig = NonNullable<OpenClawConfig["channels"]>["feishu"];

@injectable()
export class OpenClawConfigBuilder {
  build(bindings: ChannelBinding[]): OpenClawConfig {
    const feishuBindings = bindings.filter(
      (binding) => binding.enabled && binding.channelType === "feishu",
    );

    const feishuAccounts: Record<string, FeishuConfig> = {};
    let defaultFeishuConfig: FeishuConfig | null = null;

    for (const binding of feishuBindings) {
      const accountConfig = this.buildFeishuAccountConfig(binding);
      if (!accountConfig) {
        continue;
      }

      if (binding.accountId === "default") {
        defaultFeishuConfig = accountConfig;
      } else {
        feishuAccounts[binding.accountId] = accountConfig;
      }
    }

    return {
      channels: {
        feishu: {
          ...(defaultFeishuConfig ?? {}),
          ...(Object.keys(feishuAccounts).length > 0
            ? { accounts: feishuAccounts }
            : {}),
        },
        feishu_doc: {},
      },
      agents: {},
    } as OpenClawConfig;
  }

  private buildFeishuAccountConfig(
    binding: ChannelBinding,
  ): FeishuConfig | null {
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
