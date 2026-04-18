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
  /** URL of the A2A / ACP agent server that handles messages for this account. */
  agentUrl: string;
  enabled: boolean;
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  url: string;
  /** Transport protocol this agent speaks. Defaults to "a2a". */
  protocol: string;
  description?: string;
  createdAt: string;
}
