import { injectable } from "inversify";
import type { AgentConfig, ChannelBinding } from "@a2a-channels/core";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

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
  build(
    bindings: ChannelBinding[],
    agentsById: ReadonlyMap<string, AgentConfig>,
  ): OpenClawConfig {
    const feishuBindings = bindings.filter(
      (binding) => binding.enabled && binding.channelType === "feishu",
    );

    const feishuAccounts: Record<string, FeishuConfig> = {};
    let defaultFeishuConfig: FeishuConfig | null = null;

    for (const binding of feishuBindings) {
      const accountConfig = this.buildFeishuAccountConfig(binding, agentsById);
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
    agentsById: ReadonlyMap<string, AgentConfig>,
  ): FeishuConfig | null {
    const agentUrl = agentsById.get(binding.agentId)?.url;
    if (!agentUrl) {
      return null;
    }

    const cfg = binding.channelConfig as unknown as FeishuChannelConfig;
    return {
      bindingId: binding.id,
      agentUrl,
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
