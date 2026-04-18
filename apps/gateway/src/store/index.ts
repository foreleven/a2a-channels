/**
 * SQLite-backed store for channel bindings and agent configurations.
 *
 * Delegates to @a2a-channels/store-sqlite, which provides ChannelStore and
 * AgentStore implementations backed by a local SQLite file.
 *
 * The database file path is controlled by the DB_PATH environment variable
 * (defaults to `./a2a-channels.db` next to the process working directory).
 *
 * The exported function signatures are identical to the previous in-memory
 * implementation so that the HTTP handlers in index.ts need no changes.
 */

import { join } from "node:path";
import type { ChannelBinding, AgentConfig } from "@a2a-channels/core";
import { createSQLiteStores } from "@a2a-channels/store-sqlite";

// ---------------------------------------------------------------------------
// Open the database
// ---------------------------------------------------------------------------

const DB_PATH =
  process.env["DB_PATH"] ?? join(process.cwd(), "db/a2a-channels.db");

const { channels: channelStore, agents: agentStore } =
  createSQLiteStores(DB_PATH);

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
// Seed defaults on first launch
// ---------------------------------------------------------------------------

const DEFAULT_ECHO_AGENT_URL =
  process.env["ECHO_AGENT_URL"] ?? "http://localhost:3001";

// Seed echo agent if the agents table is empty.
if (agentStore.list().length === 0) {
  agentStore.create({
    name: "Echo Agent",
    url: DEFAULT_ECHO_AGENT_URL,
    description: "Built-in echo agent – mirrors every message back",
  });
}

// Seed a Feishu bootstrap binding from environment variables (once).
const bootstrapAppId = process.env["FEISHU_APP_ID"];
const bootstrapAppSecret = process.env["FEISHU_APP_SECRET"];

if (bootstrapAppId && bootstrapAppSecret) {
  const existing = channelStore
    .list()
    .find(
      (b) =>
        b.channelType === "feishu" &&
        b.accountId === (process.env["FEISHU_ACCOUNT_ID"] ?? "default"),
    );
  if (!existing) {
    channelStore.create({
      name: "Bootstrap Feishu Bot",
      channelType: "feishu",
      accountId: process.env["FEISHU_ACCOUNT_ID"] ?? "default",
      channelConfig: {
        appId: bootstrapAppId,
        appSecret: bootstrapAppSecret,
        verificationToken:
          process.env["FEISHU_VERIFICATION_TOKEN"] || undefined,
        encryptKey: process.env["FEISHU_ENCRYPT_KEY"] || undefined,
        allowFrom: ["*"],
      },
      agentUrl: DEFAULT_ECHO_AGENT_URL,
      enabled: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Channel bindings – flat exports (used by HTTP handlers)
// ---------------------------------------------------------------------------

export function listChannelBindings(): ChannelBinding[] {
  return channelStore.list();
}

export function getChannelBinding(id: string): ChannelBinding | undefined {
  return channelStore.get(id);
}

export function createChannelBinding(
  data: Omit<ChannelBinding, "id" | "createdAt">,
): ChannelBinding {
  return channelStore.create(data);
}

export function updateChannelBinding(
  id: string,
  data: Partial<Omit<ChannelBinding, "id" | "createdAt">>,
): ChannelBinding | undefined {
  return channelStore.update(id, data);
}

export function deleteChannelBinding(id: string): boolean {
  return channelStore.delete(id);
}

// ---------------------------------------------------------------------------
// Agent configs – flat exports (used by HTTP handlers)
// ---------------------------------------------------------------------------

export function listAgentConfigs(): AgentConfig[] {
  return agentStore.list();
}

export function getAgentConfig(id: string): AgentConfig | undefined {
  return agentStore.get(id);
}

export function createAgentConfig(
  data: Omit<AgentConfig, "id" | "createdAt">,
): AgentConfig {
  return agentStore.create(data);
}

export function updateAgentConfig(
  id: string,
  data: Partial<Omit<AgentConfig, "id" | "createdAt">>,
): AgentConfig | undefined {
  return agentStore.update(id, data);
}

export function deleteAgentConfig(id: string): boolean {
  return agentStore.delete(id);
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
  const all = channelStore.list();
  const exact = all.find((b) => b.accountId === target && b.enabled);
  if (exact) return exact.agentUrl;
  const any = all.find((b) => b.enabled);
  if (any) return any.agentUrl;
  return DEFAULT_ECHO_AGENT_URL;
}

/**
 * Build an OpenClawConfig-compatible object from all enabled Feishu bindings.
 * Called by OpenClawPluginHost and the plugin runtime to obtain fresh config.
 */
export function buildOpenClawConfig(): Record<string, unknown> {
  const feishuAccounts: Record<string, unknown> = {};
  let defaultFeishuConfig: Record<string, unknown> | null = null;

  for (const binding of channelStore.list()) {
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
      feishu_doc: {},
    },
    agents: {},
  };
}
