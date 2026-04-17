/**
 * In-memory store for channel bindings and agent configurations.
 *
 * Implements ChannelStore and AgentStore from @a2a-channels/core.
 * All state lives in RAM and is reset when the gateway restarts.
 *
 * For persistence, replace this module with an adapter backed by
 * SQLite, Redis, or any other storage system while keeping the same
 * exported function signatures.
 */

import crypto from "node:crypto";
import type { ChannelBinding, AgentConfig } from "@a2a-channels/core";

// ---------------------------------------------------------------------------
// Lark / Feishu channel config shape (gateway-internal)
// ---------------------------------------------------------------------------

interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  allowFrom?: string[];
}

// ---------------------------------------------------------------------------
// In-memory collections
// ---------------------------------------------------------------------------

const channelBindings = new Map<string, ChannelBinding>();
const agentConfigs = new Map<string, AgentConfig>();

const DEFAULT_ECHO_AGENT_URL =
  process.env["ECHO_AGENT_URL"] ?? "http://localhost:3001";

// Seed a default echo agent so the UI shows something on first launch
agentConfigs.set("echo", {
  id: "echo",
  name: "Echo Agent",
  url: DEFAULT_ECHO_AGENT_URL,
  description: "Built-in echo agent – mirrors every message back",
  createdAt: new Date().toISOString(),
});

// Optional bootstrap binding from environment variables
const bootstrapAppId = process.env["FEISHU_APP_ID"];
const bootstrapAppSecret = process.env["FEISHU_APP_SECRET"];
if (bootstrapAppId && bootstrapAppSecret) {
  const bootstrapBinding: ChannelBinding = {
    id: "bootstrap-feishu",
    name: "Bootstrap Feishu Bot",
    channelType: "feishu",
    accountId: process.env["FEISHU_ACCOUNT_ID"] ?? "default",
    channelConfig: {
      appId: bootstrapAppId,
      appSecret: bootstrapAppSecret,
      verificationToken: process.env["FEISHU_VERIFICATION_TOKEN"] || undefined,
      encryptKey: process.env["FEISHU_ENCRYPT_KEY"] || undefined,
      allowFrom: ["*"],
    },
    agentUrl: DEFAULT_ECHO_AGENT_URL,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  channelBindings.set(bootstrapBinding.id, bootstrapBinding);
}

// ---------------------------------------------------------------------------
// Channel bindings – flat exports (used by HTTP handlers)
// ---------------------------------------------------------------------------

export function listChannelBindings(): ChannelBinding[] {
  return Array.from(channelBindings.values());
}

export function getChannelBinding(id: string): ChannelBinding | undefined {
  return channelBindings.get(id);
}

export function createChannelBinding(
  data: Omit<ChannelBinding, "id" | "createdAt">,
): ChannelBinding {
  const binding: ChannelBinding = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  channelBindings.set(binding.id, binding);
  return binding;
}

export function updateChannelBinding(
  id: string,
  data: Partial<Omit<ChannelBinding, "id" | "createdAt">>,
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

// ---------------------------------------------------------------------------
// Agent configs – flat exports (used by HTTP handlers)
// ---------------------------------------------------------------------------

export function listAgentConfigs(): AgentConfig[] {
  return Array.from(agentConfigs.values());
}

export function getAgentConfig(id: string): AgentConfig | undefined {
  return agentConfigs.get(id);
}

export function createAgentConfig(
  data: Omit<AgentConfig, "id" | "createdAt">,
): AgentConfig {
  const agent: AgentConfig = {
    ...data,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  agentConfigs.set(agent.id, agent);
  return agent;
}

export function updateAgentConfig(
  id: string,
  data: Partial<Omit<AgentConfig, "id" | "createdAt">>,
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
// Routing helpers – injected into the openclaw-compat runtime
// ---------------------------------------------------------------------------

/**
 * Resolve the agent URL for the given channel account.
 * Priority: exact accountId match → first enabled binding → env default.
 */
export function getAgentUrlForAccount(accountId: string | undefined): string {
  const target = accountId ?? "default";
  for (const b of channelBindings.values()) {
    if (b.accountId === target && b.enabled) return b.agentUrl;
  }
  for (const b of channelBindings.values()) {
    if (b.enabled) return b.agentUrl;
  }
  return DEFAULT_ECHO_AGENT_URL;
}

/**
 * Build an OpenClawConfig-compatible object from all enabled Feishu bindings.
 * Called by OpenClawPluginHost and the plugin runtime to obtain fresh config.
 */
export function buildOpenClawConfig(): Record<string, unknown> {
  const feishuAccounts: Record<string, unknown> = {};
  let defaultFeishuConfig: Record<string, unknown> | null = null;

  for (const binding of channelBindings.values()) {
    if (!binding.enabled || binding.channelType !== "feishu") continue;

    const cfg = binding.channelConfig as unknown as FeishuChannelConfig;
    const accountConfig = {
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

  return {
    channels: {
      feishu: {
        ...(defaultFeishuConfig ?? {}),
        ...(Object.keys(feishuAccounts).length > 0
          ? { accounts: feishuAccounts }
          : {}),
      },
      // Feishu Docs (云文档) is not configured in this gateway.
      // Providing an empty object prevents the Lark plugin from logging a
      // "No accounts configured" warning during startup.
      feishu_doc: {},
    },
    agents: {},
  };
}
