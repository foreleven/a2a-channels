/**
 * Core domain types shared across all a2a-channels packages.
 * No runtime dependencies – import freely from any layer.
 */

/** Identifies a channel integration; open-ended for future channel packages. */
export type ChannelType = string;

export interface ChannelBinding {
  id: string;
  name: string;
  channelType: ChannelType;
  /** Channel-specific credentials; shape depends on channelType. */
  channelConfig: Record<string, unknown>;
  /** Account identifier used for config scoping and agent routing. */
  accountId: string;
  /** Agent config identifier used to resolve the target A2A / ACP server. */
  agentId: string;
  enabled: boolean;
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  url: string;
  /** Transport protocol this agent speaks. Defaults to "a2a". */
  protocol?: string;
  description?: string;
  createdAt: string;
}

export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface RuntimeConnectionStatus {
  bindingId: string;
  status: ConnectionStatus;
  agentUrl?: string;
  error?: string;
  updatedAt: string;
}

export interface OpenClawFeishuAccountConfig {
  bindingId?: string;
  agentUrl?: string;
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  encryptKey?: string;
  enabled?: boolean;
  allowFrom?: string[];
  replyMode?: string;
  dmPolicy?: string;
  groupPolicy?: string;
  accounts?: Record<string, OpenClawFeishuAccountConfig>;
}

export interface OpenClawConfig extends Record<string, unknown> {
  channels: {
    feishu: OpenClawFeishuAccountConfig;
    feishu_doc: Record<string, unknown>;
    [channelType: string]: unknown;
  };
  agents: Record<string, unknown>;
}
