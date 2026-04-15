/**
 * In-memory store for channel bindings and agent configurations.
 *
 * Channel bindings map a messaging platform (e.g. Feishu) account to an A2A
 * agent server. All state lives in RAM and is reset when the gateway restarts.
 */

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelType = 'feishu' | 'lark';

export interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  allowFrom?: string[];
}

export interface ChannelBinding {
  id: string;
  name: string;
  channelType: ChannelType;
  channelConfig: FeishuChannelConfig;
  /** Resolved accountId used inside the openclaw config (default: 'default') */
  accountId: string;
  /** URL of the A2A agent server to forward messages to */
  agentUrl: string;
  enabled: boolean;
  createdAt: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  url: string;
  description?: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const channelBindings = new Map<string, ChannelBinding>();
const agentConfigs = new Map<string, AgentConfig>();

// Seed a default echo agent so the UI shows something immediately
agentConfigs.set('echo', {
  id: 'echo',
  name: 'Echo Agent',
  url: 'http://localhost:3001',
  description: 'Built-in echo agent – mirrors every message back',
  createdAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// Channel binding CRUD
// ---------------------------------------------------------------------------

export function listChannelBindings(): ChannelBinding[] {
  return Array.from(channelBindings.values());
}

export function getChannelBinding(id: string): ChannelBinding | undefined {
  return channelBindings.get(id);
}

export function createChannelBinding(
  data: Omit<ChannelBinding, 'id' | 'createdAt'>,
): ChannelBinding {
  const id = crypto.randomUUID();
  const binding: ChannelBinding = {
    ...data,
    id,
    createdAt: new Date().toISOString(),
  };
  channelBindings.set(id, binding);
  return binding;
}

export function updateChannelBinding(
  id: string,
  data: Partial<Omit<ChannelBinding, 'id' | 'createdAt'>>,
): ChannelBinding | undefined {
  const existing = channelBindings.get(id);
  if (!existing) return undefined;
  const updated = { ...existing, ...data };
  channelBindings.set(id, updated);
  return updated;
}

export function deleteChannelBinding(id: string): boolean {
  return channelBindings.delete(id);
}

/** Resolve the agent URL for a given feishu accountId (falls back to echo agent). */
export function getAgentUrlForAccount(accountId: string | undefined): string {
  for (const binding of channelBindings.values()) {
    if (binding.accountId === (accountId ?? 'default') && binding.enabled) {
      return binding.agentUrl;
    }
  }
  // Fall back to the first enabled binding or the default echo agent
  for (const binding of channelBindings.values()) {
    if (binding.enabled) return binding.agentUrl;
  }
  return 'http://localhost:3001';
}

// ---------------------------------------------------------------------------
// Agent config CRUD
// ---------------------------------------------------------------------------

export function listAgentConfigs(): AgentConfig[] {
  return Array.from(agentConfigs.values());
}

export function getAgentConfig(id: string): AgentConfig | undefined {
  return agentConfigs.get(id);
}

export function createAgentConfig(
  data: Omit<AgentConfig, 'id' | 'createdAt'>,
): AgentConfig {
  const id = crypto.randomUUID();
  const agent: AgentConfig = {
    ...data,
    id,
    createdAt: new Date().toISOString(),
  };
  agentConfigs.set(id, agent);
  return agent;
}

export function updateAgentConfig(
  id: string,
  data: Partial<Omit<AgentConfig, 'id' | 'createdAt'>>,
): AgentConfig | undefined {
  const existing = agentConfigs.get(id);
  if (!existing) return undefined;
  const updated = { ...existing, ...data };
  agentConfigs.set(id, updated);
  return updated;
}

export function deleteAgentConfig(id: string): boolean {
  return agentConfigs.delete(id);
}

// ---------------------------------------------------------------------------
// OpenClaw config builder
// ---------------------------------------------------------------------------

/**
 * Build an OpenClawConfig-compatible object from all enabled channel bindings.
 * Feishu accounts are placed under `channels.feishu.accounts` keyed by accountId.
 */
export function buildOpenClawConfig(): Record<string, unknown> {
  const feishuAccounts: Record<string, unknown> = {};

  for (const binding of channelBindings.values()) {
    if (!binding.enabled || binding.channelType !== 'feishu') continue;

    const cfg = binding.channelConfig;
    feishuAccounts[binding.accountId] = {
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      encryptKey: cfg.encryptKey,
      verificationToken: cfg.verificationToken,
      enabled: true,
      allowFrom: cfg.allowFrom ?? ['*'],
      // Use static (non-streaming) reply mode for simplicity
      replyMode: 'static',
    };
  }

  // When there is exactly one binding we also expose it at the top level
  // (openclaw-lark's `getLarkAccount` expects either a flat config or accounts map)
  const singleBinding = channelBindings.size === 1
    ? Array.from(channelBindings.values())[0]
    : undefined;

  const topLevelFeishu: Record<string, unknown> =
    singleBinding
      ? {
          appId: singleBinding.channelConfig.appId,
          appSecret: singleBinding.channelConfig.appSecret,
          encryptKey: singleBinding.channelConfig.encryptKey,
          verificationToken: singleBinding.channelConfig.verificationToken,
          enabled: true,
          allowFrom: singleBinding.channelConfig.allowFrom ?? ['*'],
          replyMode: 'static',
        }
      : { accounts: feishuAccounts };

  return {
    channels: {
      feishu: topLevelFeishu,
    },
    agents: {},
  };
}
