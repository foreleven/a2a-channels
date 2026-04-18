/**
 * Gateway store – Prisma-backed persistence with an in-memory cache for
 * hot-path reads (agent URL resolution and OpenClaw config building).
 *
 * Async CRUD helpers are used directly by HTTP route handlers.
 * The synchronous `getAgentUrlForAccount` and `buildOpenClawConfig` helpers
 * read from the in-memory cache and are used by the plugin runtime and host.
 *
 * Call `initStore()` once at startup to populate the cache from the database.
 * Each mutating operation keeps the cache in sync so no periodic refresh
 * is required.
 */

import type { ChannelBinding, AgentConfig } from "@a2a-channels/core";
import { PrismaClient } from "../generated/prisma/index.js";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { join } from "node:path";

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
// Prisma client instance
// ---------------------------------------------------------------------------

const DB_PATH =
  process.env["DB_PATH"] ?? join(process.cwd(), "db/a2a-channels.db");

const adapter = new PrismaBetterSqlite3({ url: `file:${DB_PATH}` });

export const prisma = new PrismaClient({ adapter });

// ---------------------------------------------------------------------------
// In-memory cache (populated from DB, kept in sync after mutations)
// ---------------------------------------------------------------------------

let channelCache: ChannelBinding[] = [];

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function mapBinding(
  b: Awaited<ReturnType<typeof prisma.channelBinding.findUniqueOrThrow>>,
): ChannelBinding {
  return {
    id: b.id,
    name: b.name,
    channelType: b.channelType,
    accountId: b.accountId,
    channelConfig: JSON.parse(b.channelConfig) as Record<string, unknown>,
    agentUrl: b.agentUrl,
    enabled: b.enabled,
    createdAt: b.createdAt.toISOString(),
  };
}

function mapAgent(
  a: Awaited<ReturnType<typeof prisma.agent.findUniqueOrThrow>>,
): AgentConfig {
  return {
    id: a.id,
    name: a.name,
    url: a.url,
    description: a.description ?? undefined,
    createdAt: a.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Store initialisation (call once at startup)
// ---------------------------------------------------------------------------

export async function initStore(): Promise<void> {
  const bindings = await prisma.channelBinding.findMany({
    orderBy: { createdAt: "asc" },
  });
  channelCache = bindings.map(mapBinding);
}

// ---------------------------------------------------------------------------
// Channel bindings
// ---------------------------------------------------------------------------

export async function listChannelBindings(): Promise<ChannelBinding[]> {
  const rows = await prisma.channelBinding.findMany({
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapBinding);
}

export async function getChannelBinding(
  id: string,
): Promise<ChannelBinding | null> {
  const row = await prisma.channelBinding.findUnique({ where: { id } });
  return row ? mapBinding(row) : null;
}

export async function createChannelBinding(
  data: Omit<ChannelBinding, "id" | "createdAt">,
): Promise<ChannelBinding> {
  const row = await prisma.channelBinding.create({
    data: {
      name: data.name,
      channelType: data.channelType,
      accountId: data.accountId,
      channelConfig: JSON.stringify(data.channelConfig),
      agentUrl: data.agentUrl,
      enabled: data.enabled,
    },
  });
  const binding = mapBinding(row);
  channelCache = [...channelCache, binding];
  return binding;
}

export async function updateChannelBinding(
  id: string,
  data: Partial<Omit<ChannelBinding, "id" | "createdAt">>,
): Promise<ChannelBinding | null> {
  const existing = await prisma.channelBinding.findUnique({ where: { id } });
  if (!existing) return null;

  const row = await prisma.channelBinding.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.channelType !== undefined && { channelType: data.channelType }),
      ...(data.accountId !== undefined && { accountId: data.accountId }),
      ...(data.channelConfig !== undefined && {
        channelConfig: JSON.stringify(data.channelConfig),
      }),
      ...(data.agentUrl !== undefined && { agentUrl: data.agentUrl }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
    },
  });
  const binding = mapBinding(row);
  channelCache = channelCache.map((b) => (b.id === id ? binding : b));
  return binding;
}

export async function deleteChannelBinding(id: string): Promise<boolean> {
  try {
    await prisma.channelBinding.delete({ where: { id } });
    channelCache = channelCache.filter((b) => b.id !== id);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Agent configs
// ---------------------------------------------------------------------------

export async function listAgentConfigs(): Promise<AgentConfig[]> {
  const rows = await prisma.agent.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(mapAgent);
}

export async function getAgentConfig(id: string): Promise<AgentConfig | null> {
  const row = await prisma.agent.findUnique({ where: { id } });
  return row ? mapAgent(row) : null;
}

export async function createAgentConfig(
  data: Omit<AgentConfig, "id" | "createdAt">,
): Promise<AgentConfig> {
  const row = await prisma.agent.create({
    data: {
      name: data.name,
      url: data.url,
      description: data.description ?? null,
    },
  });
  return mapAgent(row);
}

export async function updateAgentConfig(
  id: string,
  data: Partial<Omit<AgentConfig, "id" | "createdAt">>,
): Promise<AgentConfig | null> {
  const existing = await prisma.agent.findUnique({ where: { id } });
  if (!existing) return null;

  const row = await prisma.agent.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.url !== undefined && { url: data.url }),
      ...(data.description !== undefined && {
        description: data.description ?? null,
      }),
    },
  });
  return mapAgent(row);
}

export async function deleteAgentConfig(id: string): Promise<boolean> {
  try {
    await prisma.agent.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Routing helpers (synchronous – read from in-memory cache)
// ---------------------------------------------------------------------------

/**
 * Resolve the agent URL for the given channel account.
 * Priority: exact accountId match → first enabled binding → env default.
 */
export function getAgentUrlForAccount(
  accountId: string | undefined,
  defaultUrl: string,
): string {
  const target = accountId ?? "default";
  const exact = channelCache.find((b) => b.accountId === target && b.enabled);
  if (exact) return exact.agentUrl;
  const any = channelCache.find((b) => b.enabled);
  if (any) return any.agentUrl;
  return defaultUrl;
}

/**
 * Build an OpenClawConfig-compatible object from all enabled Feishu bindings.
 * Called by OpenClawPluginHost and the plugin runtime to obtain fresh config.
 */
export function buildOpenClawConfig(): Record<string, unknown> {
  const feishuAccounts: Record<string, unknown> = {};
  let defaultFeishuConfig: Record<string, unknown> | null = null;

  for (const binding of channelCache) {
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

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

/**
 * Seed default data into a freshly opened store.
 * - Adds the echo agent if the agents table is empty.
 * - Bootstraps a Feishu binding from environment variables (once).
 */
export async function seedDefaults(defaultEchoAgentUrl: string): Promise<void> {
  const agentCount = await prisma.agent.count();
  if (agentCount === 0) {
    await prisma.agent.create({
      data: {
        name: "Echo Agent",
        url: defaultEchoAgentUrl,
        description: "Built-in echo agent – mirrors every message back",
      },
    });
  }

  const bootstrapAppId = process.env["FEISHU_APP_ID"];
  const bootstrapAppSecret = process.env["FEISHU_APP_SECRET"];

  if (bootstrapAppId && bootstrapAppSecret) {
    const accountId = process.env["FEISHU_ACCOUNT_ID"] ?? "default";
    const existing = await prisma.channelBinding.findFirst({
      where: { channelType: "feishu", accountId },
    });
    if (!existing) {
      await prisma.channelBinding.create({
        data: {
          name: "Bootstrap Feishu Bot",
          channelType: "feishu",
          accountId,
          channelConfig: JSON.stringify({
            appId: bootstrapAppId,
            appSecret: bootstrapAppSecret,
            verificationToken:
              process.env["FEISHU_VERIFICATION_TOKEN"] || undefined,
            encryptKey: process.env["FEISHU_ENCRYPT_KEY"] || undefined,
            allowFrom: ["*"],
          }),
          agentUrl: defaultEchoAgentUrl,
          enabled: true,
        },
      });
    }
  }
}


