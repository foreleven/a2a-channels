/**
 * Gateway store – repository-pattern facade over a {@link StoreProvider}.
 *
 * Call `createGatewayStore(provider)` at the composition root (index.ts) to
 * obtain the flat helper functions used by HTTP handlers and the monitor
 * manager.  The `provider` can be any {@link StoreProvider} implementation
 * (SQLite, Postgres, in-memory, …) – the gateway code is oblivious to the
 * backing database.
 *
 * Seed logic (default echo agent, bootstrap Feishu binding) now lives in
 * `seedDefaults()`, which is called once during gateway startup.
 */

import type { ChannelBinding, AgentConfig, StoreProvider } from "@a2a-channels/core";

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
// Factory
// ---------------------------------------------------------------------------

export interface GatewayStore {
  // Channel bindings
  listChannelBindings(): ChannelBinding[];
  getChannelBinding(id: string): ChannelBinding | undefined;
  createChannelBinding(
    data: Omit<ChannelBinding, "id" | "createdAt">,
  ): ChannelBinding;
  updateChannelBinding(
    id: string,
    data: Partial<Omit<ChannelBinding, "id" | "createdAt">>,
  ): ChannelBinding | undefined;
  deleteChannelBinding(id: string): boolean;

  // Agent configs
  listAgentConfigs(): AgentConfig[];
  getAgentConfig(id: string): AgentConfig | undefined;
  createAgentConfig(data: Omit<AgentConfig, "id" | "createdAt">): AgentConfig;
  updateAgentConfig(
    id: string,
    data: Partial<Omit<AgentConfig, "id" | "createdAt">>,
  ): AgentConfig | undefined;
  deleteAgentConfig(id: string): boolean;

  // Routing helpers injected into the openclaw-compat runtime
  getAgentUrlForAccount(accountId: string | undefined): string;
  buildOpenClawConfig(): Record<string, unknown>;
}

/**
 * Create the gateway store from any {@link StoreProvider}.
 *
 * @param provider  - A concrete store provider (e.g. `SQLiteStoreProvider`).
 * @param defaultEchoAgentUrl - Fallback agent URL when no binding matches.
 */
export function createGatewayStore(
  provider: StoreProvider,
  defaultEchoAgentUrl: string,
): GatewayStore {
  const { channels: channelRepo, agents: agentRepo } = provider;

  return {
    // ── Channel bindings ──────────────────────────────────────────────────
    listChannelBindings(): ChannelBinding[] {
      return channelRepo.list();
    },

    getChannelBinding(id: string): ChannelBinding | undefined {
      return channelRepo.get(id);
    },

    createChannelBinding(
      data: Omit<ChannelBinding, "id" | "createdAt">,
    ): ChannelBinding {
      return channelRepo.create(data);
    },

    updateChannelBinding(
      id: string,
      data: Partial<Omit<ChannelBinding, "id" | "createdAt">>,
    ): ChannelBinding | undefined {
      return channelRepo.update(id, data);
    },

    deleteChannelBinding(id: string): boolean {
      return channelRepo.delete(id);
    },

    // ── Agent configs ─────────────────────────────────────────────────────
    listAgentConfigs(): AgentConfig[] {
      return agentRepo.list();
    },

    getAgentConfig(id: string): AgentConfig | undefined {
      return agentRepo.get(id);
    },

    createAgentConfig(
      data: Omit<AgentConfig, "id" | "createdAt">,
    ): AgentConfig {
      return agentRepo.create(data);
    },

    updateAgentConfig(
      id: string,
      data: Partial<Omit<AgentConfig, "id" | "createdAt">>,
    ): AgentConfig | undefined {
      return agentRepo.update(id, data);
    },

    deleteAgentConfig(id: string): boolean {
      return agentRepo.delete(id);
    },

    // ── Routing helpers ───────────────────────────────────────────────────

    /**
     * Resolve the agent URL for the given channel account.
     * Priority: exact accountId match → first enabled binding → env default.
     */
    getAgentUrlForAccount(accountId: string | undefined): string {
      const target = accountId ?? "default";
      const all = channelRepo.list();
      const exact = all.find((b) => b.accountId === target && b.enabled);
      if (exact) return exact.agentUrl;
      const any = all.find((b) => b.enabled);
      if (any) return any.agentUrl;
      return defaultEchoAgentUrl;
    },

    /**
     * Build an OpenClawConfig-compatible object from all enabled Feishu bindings.
     * Called by OpenClawPluginHost and the plugin runtime to obtain fresh config.
     */
    buildOpenClawConfig(): Record<string, unknown> {
      const feishuAccounts: Record<string, unknown> = {};
      let defaultFeishuConfig: Record<string, unknown> | null = null;

      for (const binding of channelRepo.list()) {
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
    },
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
export function seedDefaults(
  provider: StoreProvider,
  defaultEchoAgentUrl: string,
): void {
  const { channels: channelRepo, agents: agentRepo } = provider;

  if (agentRepo.list().length === 0) {
    agentRepo.create({
      name: "Echo Agent",
      url: defaultEchoAgentUrl,
      description: "Built-in echo agent – mirrors every message back",
    });
  }

  const bootstrapAppId = process.env["FEISHU_APP_ID"];
  const bootstrapAppSecret = process.env["FEISHU_APP_SECRET"];

  if (bootstrapAppId && bootstrapAppSecret) {
    const accountId = process.env["FEISHU_ACCOUNT_ID"] ?? "default";
    const existing = channelRepo
      .list()
      .find(
        (b) => b.channelType === "feishu" && b.accountId === accountId,
      );
    if (!existing) {
      channelRepo.create({
        name: "Bootstrap Feishu Bot",
        channelType: "feishu",
        accountId,
        channelConfig: {
          appId: bootstrapAppId,
          appSecret: bootstrapAppSecret,
          verificationToken:
            process.env["FEISHU_VERIFICATION_TOKEN"] || undefined,
          encryptKey: process.env["FEISHU_ENCRYPT_KEY"] || undefined,
          allowFrom: ["*"],
        },
        agentUrl: defaultEchoAgentUrl,
        enabled: true,
      });
    }
  }
}

