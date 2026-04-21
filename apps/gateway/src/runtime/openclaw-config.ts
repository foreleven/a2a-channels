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

export function buildOpenClawConfigFromBindings(
  bindings: ChannelBinding[],
  agentsById: ReadonlyMap<string, AgentConfig>,
): OpenClawConfig {
  const feishuBindings = bindings.filter(
    (binding) => binding.enabled && binding.channelType === "feishu",
  );

  const feishuAccounts: Record<string, FeishuConfig> = {};
  let defaultFeishuConfig: FeishuConfig | null = null;

  for (const binding of feishuBindings) {
    const agentUrl = agentsById.get(binding.agentId)?.url;
    if (!agentUrl) continue;

    const cfg = binding.channelConfig as unknown as FeishuChannelConfig;
    const accountConfig: FeishuConfig = {
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

    if (binding.accountId === "default") {
      defaultFeishuConfig = accountConfig;
    } else {
      feishuAccounts[binding.accountId] = accountConfig;
    }
  }

  console.log("feishu accounts", defaultFeishuConfig, feishuAccounts);

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
