import type { ChannelBinding } from "@/lib/api";

export const CHANNEL_OPTIONS = [
  { value: "feishu", label: "Feishu / Lark", supportsQr: true },
  { value: "discord", label: "Discord", supportsQr: false },
  { value: "slack", label: "Slack", supportsQr: false },
  { value: "telegram", label: "Telegram", supportsQr: false },
  { value: "whatsapp", label: "WhatsApp", supportsQr: false },
  { value: "wechat", label: "WeChat / Weixin", supportsQr: true },
  { value: "qqbot", label: "QQ Bot", supportsQr: false },
] as const;

export const CHANNEL_CONFIG_TEMPLATES: Record<string, Record<string, unknown>> = {
  feishu: {
    appId: "",
    appSecret: "",
    verificationToken: "",
    encryptKey: "",
    allowFrom: ["*"],
  },
  discord: {
    botToken: "",
    allowFrom: ["*"],
  },
  slack: {
    botToken: "",
    appToken: "",
    signingSecret: "",
    allowFrom: ["*"],
  },
  telegram: {
    botToken: "",
    allowFrom: ["*"],
  },
  whatsapp: {
    allowFrom: ["*"],
  },
  wechat: {},
  qqbot: {
    appId: "",
    token: "",
    secret: "",
    allowFrom: ["*"],
  },
};

export const CHANNEL_CONFIG_FIELDS: Record<
  string,
  Array<{ key: string; label: string; secret?: boolean }>
> = {
  feishu: [
    { key: "appId", label: "App ID" },
    { key: "appSecret", label: "App Secret", secret: true },
    { key: "verificationToken", label: "Verification Token", secret: true },
    { key: "encryptKey", label: "Encrypt Key", secret: true },
    { key: "allowFrom", label: "Allow From" },
  ],
  discord: [
    { key: "botToken", label: "Bot Token", secret: true },
    { key: "allowFrom", label: "Allow From" },
  ],
  slack: [
    { key: "botToken", label: "Bot Token", secret: true },
    { key: "appToken", label: "App Token", secret: true },
    { key: "signingSecret", label: "Signing Secret", secret: true },
    { key: "allowFrom", label: "Allow From" },
  ],
  telegram: [
    { key: "botToken", label: "Bot Token", secret: true },
    { key: "allowFrom", label: "Allow From" },
  ],
  whatsapp: [{ key: "allowFrom", label: "Allow From" }],
  qqbot: [
    { key: "appId", label: "App ID" },
    { key: "token", label: "Token", secret: true },
    { key: "secret", label: "Secret", secret: true },
    { key: "allowFrom", label: "Allow From" },
  ],
};

export interface FormState {
  name: string;
  channelType: string;
  accountId: string;
  agentId: string;
  enabled: boolean;
  channelConfigJson: string;
}

export const EMPTY_FORM: FormState = {
  name: "",
  channelType: "feishu",
  accountId: "default",
  agentId: "",
  enabled: true,
  channelConfigJson: stringifyConfig(CHANNEL_CONFIG_TEMPLATES["feishu"]),
};

export class ChannelFormMapper {
  toPayload(form: FormState): Omit<ChannelBinding, "id" | "createdAt"> {
    return {
      name: form.name,
      channelType: form.channelType,
      accountId: form.accountId,
      agentId: form.agentId,
      enabled: form.enabled,
      channelConfig: this.parseConfig(form.channelConfigJson),
    };
  }

  fromBinding(binding: ChannelBinding): FormState {
    return {
      name: binding.name,
      channelType: binding.channelType,
      accountId: binding.accountId,
      agentId: binding.agentId,
      enabled: binding.enabled,
      channelConfigJson: stringifyConfig(binding.channelConfig),
    };
  }

  private parseConfig(rawConfig: string): Record<string, unknown> {
    const parsed = JSON.parse(rawConfig || "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Channel config must be a JSON object.");
    }
    return parsed as Record<string, unknown>;
  }
}

export function channelLabel(channelType: string): string {
  return (
    CHANNEL_OPTIONS.find((channel) => channel.value === channelType)?.label ??
    channelType
  );
}

export function supportsQrLogin(channelType: string): boolean {
  return CHANNEL_OPTIONS.some(
    (channel) => channel.value === channelType && channel.supportsQr,
  );
}

export function stringifyConfig(config: Record<string, unknown> | undefined): string {
  return JSON.stringify(config ?? {}, null, 2);
}

export function summarizeConfig(config: Record<string, unknown>): string {
  const keys = Object.keys(config).filter((key) => config[key] !== "");
  if (keys.length === 0) {
    return "{}";
  }
  return keys.slice(0, 3).join(", ") + (keys.length > 3 ? "..." : "");
}
