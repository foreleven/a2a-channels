/**
 * Integration tests for the gateway store.
 *
 * Each test group resets the database via `resetDB()` so tests remain
 * independent.  The test runner must set DB_PATH before this module
 * loads (done via the `test` npm script in package.json).
 */

import { describe, test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  prisma,
  initStore,
  listChannelBindings,
  getChannelBinding,
  createChannelBinding,
  updateChannelBinding,
  deleteChannelBinding,
  listAgentConfigs,
  getAgentConfig,
  createAgentConfig,
  updateAgentConfig,
  deleteAgentConfig,
  DuplicateEnabledBindingError,
  getAgentUrlForBinding,
  getAgentUrlForChannelAccount,
  getAgentProtocolForUrl,
  buildOpenClawConfig,
  seedDefaults,
} from "./index.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const GATEWAY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Push the Prisma schema to the test DB (creates tables if absent). */
function pushSchema(): void {
  execSync(
    "node_modules/.bin/prisma db push --schema=prisma/schema.prisma",
    { cwd: GATEWAY_ROOT, stdio: "pipe" },
  );
}

/** Delete all rows from the `channel_bindings` and `agents` tables and refresh the in-memory cache. */
async function resetDB(): Promise<void> {
  await prisma.channelBinding.deleteMany();
  await prisma.agent.deleteMany();
  await initStore();
}

const FEISHU_BINDING_DATA = {
  name: "Test Feishu Bot",
  channelType: "feishu",
  accountId: "test-account",
  channelConfig: { appId: "cli_abc", appSecret: "secret123" },
  agentUrl: "http://localhost:3001",
  enabled: true,
} as const;

const AGENT_DATA = {
  name: "Test Agent",
  url: "http://localhost:3001",
  protocol: "a2a",
  description: "A test agent",
} as const;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

before(() => {
  pushSchema();
});

// ---------------------------------------------------------------------------
// ChannelBinding CRUD
// ---------------------------------------------------------------------------

describe("ChannelBinding CRUD", () => {
  beforeEach(resetDB);

  test("create stores all fields and returns a mapped binding", async () => {
    const binding = await createChannelBinding(FEISHU_BINDING_DATA);

    assert.ok(binding.id, "id should be non-empty");
    assert.equal(binding.name, FEISHU_BINDING_DATA.name);
    assert.equal(binding.channelType, FEISHU_BINDING_DATA.channelType);
    assert.equal(binding.accountId, FEISHU_BINDING_DATA.accountId);
    assert.deepEqual(binding.channelConfig, FEISHU_BINDING_DATA.channelConfig);
    assert.equal(binding.agentUrl, FEISHU_BINDING_DATA.agentUrl);
    assert.equal(binding.enabled, true);
    assert.ok(binding.createdAt, "createdAt should be set");
  });

  test("list returns empty array when no bindings exist", async () => {
    const list = await listChannelBindings();
    assert.deepEqual(list, []);
  });

  test("list returns all bindings ordered by createdAt asc", async () => {
    const b1 = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "First",
    });
    const b2 = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "account-2",
      name: "Second",
    });

    const list = await listChannelBindings();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, b1.id);
    assert.equal(list[1]?.id, b2.id);
  });

  test("get returns null for an unknown id", async () => {
    const result = await getChannelBinding("nonexistent-id");
    assert.equal(result, null);
  });

  test("get returns the binding for a known id", async () => {
    const created = await createChannelBinding(FEISHU_BINDING_DATA);
    const fetched = await getChannelBinding(created.id);

    assert.ok(fetched);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.name, created.name);
  });

  test("update returns null for an unknown id", async () => {
    const result = await updateChannelBinding("nonexistent-id", {
      name: "New Name",
    });
    assert.equal(result, null);
  });

  test("update patches only the provided fields", async () => {
    const created = await createChannelBinding(FEISHU_BINDING_DATA);
    const updated = await updateChannelBinding(created.id, {
      name: "Updated Name",
      enabled: false,
    });

    assert.ok(updated);
    assert.equal(updated.id, created.id);
    assert.equal(updated.name, "Updated Name");
    assert.equal(updated.enabled, false);
    // Unchanged fields should remain
    assert.equal(updated.channelType, FEISHU_BINDING_DATA.channelType);
    assert.equal(updated.agentUrl, FEISHU_BINDING_DATA.agentUrl);
  });

  test("update persists changes to the database", async () => {
    const created = await createChannelBinding(FEISHU_BINDING_DATA);
    await updateChannelBinding(created.id, { name: "DB Persisted" });
    const fetched = await getChannelBinding(created.id);

    assert.ok(fetched);
    assert.equal(fetched.name, "DB Persisted");
  });

  test("delete returns false for an unknown id", async () => {
    const result = await deleteChannelBinding("nonexistent-id");
    assert.equal(result, false);
  });

  test("delete removes the binding and returns true", async () => {
    const created = await createChannelBinding(FEISHU_BINDING_DATA);
    const deleted = await deleteChannelBinding(created.id);

    assert.equal(deleted, true);
    const fetched = await getChannelBinding(created.id);
    assert.equal(fetched, null);
  });

  test("create immediately reflects in the in-memory cache", async () => {
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "cache-test",
      agentUrl: "http://cache-agent:4000",
    });

    const url = getAgentUrlForBinding(binding.id, "http://default");
    assert.equal(url, binding.agentUrl);
  });

  test("update immediately reflects in the in-memory cache", async () => {
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "cache-update",
      agentUrl: "http://old-agent:4000",
    });
    await updateChannelBinding(binding.id, {
      agentUrl: "http://new-agent:4000",
    });

    const url = getAgentUrlForBinding(binding.id, "http://default");
    assert.equal(url, "http://new-agent:4000");
  });

  test("delete immediately reflects in the in-memory cache", async () => {
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "cache-delete",
      agentUrl: "http://to-delete:4000",
    });
    await deleteChannelBinding(binding.id);

    const url = getAgentUrlForBinding(binding.id, "http://fallback");
    assert.equal(url, "http://fallback");
  });
  test("rejects creating a second enabled binding for the same channel/account", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);

    await assert.rejects(
      createChannelBinding({
        ...FEISHU_BINDING_DATA,
        name: "Duplicate",
        agentUrl: "http://duplicate-agent:4000",
      }),
      DuplicateEnabledBindingError,
    );
  });

  test("allows a disabled duplicate binding for the same channel/account", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);

    const duplicate = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "Disabled Duplicate",
      enabled: false,
    });

    assert.equal(duplicate.enabled, false);
  });

  test("rejects enabling a disabled duplicate binding", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);
    const duplicate = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "Disabled Duplicate",
      enabled: false,
    });

    await assert.rejects(
      updateChannelBinding(duplicate.id, { enabled: true }),
      DuplicateEnabledBindingError,
    );
  });

  test("rejects updating a binding into another enabled channel/account pair", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);
    const other = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "other-account",
    });

    await assert.rejects(
      updateChannelBinding(other.id, { accountId: FEISHU_BINDING_DATA.accountId }),
      DuplicateEnabledBindingError,
    );
  });

  test("allows the same accountId to be enabled for different channel types", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);
    const slack = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "Slack Bot",
      channelType: "slack",
      channelConfig: { token: "xoxb" },
    });

    assert.equal(slack.channelType, "slack");
  });
});
// ---------------------------------------------------------------------------

describe("Agent CRUD", () => {
  beforeEach(resetDB);

  test("create stores all fields and returns a mapped agent", async () => {
    const agent = await createAgentConfig(AGENT_DATA);

    assert.ok(agent.id, "id should be non-empty");
    assert.equal(agent.name, AGENT_DATA.name);
    assert.equal(agent.url, AGENT_DATA.url);
    assert.equal(agent.protocol, AGENT_DATA.protocol);
    assert.equal(agent.description, AGENT_DATA.description);
    assert.ok(agent.createdAt, "createdAt should be set");
  });

  test("create defaults protocol to 'a2a' when not provided", async () => {
    const agent = await createAgentConfig({
      name: "No Protocol",
      url: "http://no-proto:3000",
    });
    assert.equal(agent.protocol, "a2a");
  });

  test("create handles undefined description", async () => {
    const agent = await createAgentConfig({
      name: "No Desc",
      url: "http://no-desc:3000",
    });
    assert.equal(agent.description, undefined);
  });

  test("list returns empty array when no agents exist", async () => {
    const list = await listAgentConfigs();
    assert.deepEqual(list, []);
  });

  test("list returns all agents ordered by createdAt asc", async () => {
    const a1 = await createAgentConfig({ ...AGENT_DATA, name: "First" });
    const a2 = await createAgentConfig({
      ...AGENT_DATA,
      url: "http://second:3002",
      name: "Second",
    });

    const list = await listAgentConfigs();
    assert.equal(list.length, 2);
    assert.equal(list[0]?.id, a1.id);
    assert.equal(list[1]?.id, a2.id);
  });

  test("get returns null for an unknown id", async () => {
    const result = await getAgentConfig("nonexistent-id");
    assert.equal(result, null);
  });

  test("get returns the agent for a known id", async () => {
    const created = await createAgentConfig(AGENT_DATA);
    const fetched = await getAgentConfig(created.id);

    assert.ok(fetched);
    assert.equal(fetched.id, created.id);
    assert.equal(fetched.name, created.name);
  });

  test("update returns null for an unknown id", async () => {
    const result = await updateAgentConfig("nonexistent-id", {
      name: "New Name",
    });
    assert.equal(result, null);
  });

  test("update patches only the provided fields", async () => {
    const created = await createAgentConfig(AGENT_DATA);
    const updated = await updateAgentConfig(created.id, {
      name: "Updated Agent",
      protocol: "acp",
    });

    assert.ok(updated);
    assert.equal(updated.name, "Updated Agent");
    assert.equal(updated.protocol, "acp");
    // Unchanged
    assert.equal(updated.url, AGENT_DATA.url);
  });

  test("update persists changes to the database", async () => {
    const created = await createAgentConfig(AGENT_DATA);
    await updateAgentConfig(created.id, { name: "DB Persisted Agent" });
    const fetched = await getAgentConfig(created.id);

    assert.ok(fetched);
    assert.equal(fetched.name, "DB Persisted Agent");
  });

  test("update handles URL change in the in-memory cache", async () => {
    const created = await createAgentConfig({
      ...AGENT_DATA,
      url: "http://old-url:3001",
      protocol: "acp",
    });

    // Old URL is in cache
    assert.equal(getAgentProtocolForUrl("http://old-url:3001"), "acp");

    await updateAgentConfig(created.id, { url: "http://new-url:3001" });

    // Old URL should no longer be in cache
    assert.equal(getAgentProtocolForUrl("http://old-url:3001"), "a2a");
    // New URL should be in cache
    assert.equal(getAgentProtocolForUrl("http://new-url:3001"), "acp");
  });

  test("delete returns false for an unknown id", async () => {
    const result = await deleteAgentConfig("nonexistent-id");
    assert.equal(result, false);
  });

  test("delete removes the agent and returns true", async () => {
    const created = await createAgentConfig(AGENT_DATA);
    const deleted = await deleteAgentConfig(created.id);

    assert.equal(deleted, true);
    const fetched = await getAgentConfig(created.id);
    assert.equal(fetched, null);
  });

  test("delete removes the agent URL from the in-memory cache", async () => {
    const created = await createAgentConfig({
      ...AGENT_DATA,
      protocol: "acp",
    });
    assert.equal(getAgentProtocolForUrl(created.url), "acp");

    await deleteAgentConfig(created.id);
    assert.equal(getAgentProtocolForUrl(created.url), "a2a");
  });
});

// ---------------------------------------------------------------------------
// Agent URL routing
// ---------------------------------------------------------------------------

describe("agent URL routing", () => {
  beforeEach(resetDB);

  const DEFAULT_URL = "http://default-agent:3001";

  test("getAgentUrlForBinding returns the default URL when the binding is missing", () => {
    const url = getAgentUrlForBinding("missing-binding", DEFAULT_URL);
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForBinding returns the matching enabled binding URL", async () => {
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      agentUrl: "http://binding-agent:4000",
    });

    const url = getAgentUrlForBinding(binding.id, DEFAULT_URL);
    assert.equal(url, "http://binding-agent:4000");
  });

  test("getAgentUrlForBinding skips disabled bindings", async () => {
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      agentUrl: "http://disabled-agent:4000",
      enabled: false,
    });

    const url = getAgentUrlForBinding(binding.id, DEFAULT_URL);
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForChannelAccount returns the matching channel/account URL", async () => {
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "exact-match",
      agentUrl: "http://exact-agent:4000",
    });

    const url = getAgentUrlForChannelAccount(
      "feishu",
      "exact-match",
      DEFAULT_URL,
    );
    assert.equal(url, "http://exact-agent:4000");
  });

  test("getAgentUrlForChannelAccount does not fall back to another account", async () => {
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "other-account",
      agentUrl: "http://other-agent:4000",
    });

    const url = getAgentUrlForChannelAccount(
      "feishu",
      "no-match-account",
      DEFAULT_URL,
    );
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForChannelAccount skips disabled bindings", async () => {
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "disabled-account",
      agentUrl: "http://disabled-agent:4000",
      enabled: false,
    });

    const url = getAgentUrlForChannelAccount(
      "feishu",
      "disabled-account",
      DEFAULT_URL,
    );
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForChannelAccount treats undefined channel/account as feishu/default", async () => {
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "default",
      agentUrl: "http://default-binding-agent:4000",
    });

    const url = getAgentUrlForChannelAccount(undefined, undefined, DEFAULT_URL);
    assert.equal(url, "http://default-binding-agent:4000");
  });

  test("getAgentUrlForChannelAccount distinguishes identical accountIds across channel types", async () => {
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "shared",
      agentUrl: "http://feishu-agent:4000",
    });
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "Slack Bot",
      channelType: "slack",
      accountId: "shared",
      channelConfig: { token: "xoxb" },
      agentUrl: "http://slack-agent:4000",
    });

    assert.equal(
      getAgentUrlForChannelAccount("feishu", "shared", DEFAULT_URL),
      "http://feishu-agent:4000",
    );
    assert.equal(
      getAgentUrlForChannelAccount("slack", "shared", DEFAULT_URL),
      "http://slack-agent:4000",
    );
  });
});

// ---------------------------------------------------------------------------
// getAgentProtocolForUrl
// ---------------------------------------------------------------------------

describe("getAgentProtocolForUrl", () => {
  beforeEach(resetDB);

  test("returns 'a2a' when the agent URL is not in the cache", () => {
    const protocol = getAgentProtocolForUrl("http://unknown:3001");
    assert.equal(protocol, "a2a");
  });

  test("returns the stored protocol for a cached agent", async () => {
    await createAgentConfig({
      name: "ACP Agent",
      url: "http://acp-agent:3001",
      protocol: "acp",
    });

    const protocol = getAgentProtocolForUrl("http://acp-agent:3001");
    assert.equal(protocol, "acp");
  });

  test("returns 'a2a' after the agent is deleted", async () => {
    const agent = await createAgentConfig({
      name: "Temp Agent",
      url: "http://temp:3001",
      protocol: "acp",
    });
    await deleteAgentConfig(agent.id);

    const protocol = getAgentProtocolForUrl("http://temp:3001");
    assert.equal(protocol, "a2a");
  });
});

// ---------------------------------------------------------------------------
// buildOpenClawConfig
// ---------------------------------------------------------------------------

describe("buildOpenClawConfig", () => {
  beforeEach(resetDB);

  test("returns an empty feishu config when there are no bindings", () => {
    const config = buildOpenClawConfig();

    assert.deepEqual(config.channels, {
      feishu: {},
      feishu_doc: {},
    });
    assert.deepEqual(config.agents, {});
  });

  test("returns feishu config for a 'default' account binding", async () => {
    const binding = await createChannelBinding({
      name: "Default Feishu",
      channelType: "feishu",
      accountId: "default",
      channelConfig: {
        appId: "cli_def",
        appSecret: "sec_def",
        verificationToken: "token123",
        encryptKey: "enc456",
        allowFrom: ["*"],
      },
      agentUrl: "http://localhost:3001",
      enabled: true,
    });

    const config = buildOpenClawConfig();
    const feishu = config.channels as Record<string, unknown>;
    const feishuConfig = feishu["feishu"] as Record<string, unknown>;

    assert.equal(feishuConfig["bindingId"], binding.id);
    assert.equal(feishuConfig["agentUrl"], "http://localhost:3001");
    assert.equal(feishuConfig["appId"], "cli_def");
    assert.equal(feishuConfig["appSecret"], "sec_def");
    assert.equal(feishuConfig["verificationToken"], "token123");
    assert.equal(feishuConfig["encryptKey"], "enc456");
    assert.equal(feishuConfig["enabled"], true);
    assert.deepEqual(feishuConfig["allowFrom"], ["*"]);
    assert.ok(!("accounts" in feishuConfig), "default account should not create accounts block");
  });

  test("returns feishu config with an accounts block for non-default bindings", async () => {
    const binding = await createChannelBinding({
      name: "Account A",
      channelType: "feishu",
      accountId: "account-a",
      channelConfig: { appId: "cli_a", appSecret: "sec_a" },
      agentUrl: "http://localhost:3001",
      enabled: true,
    });

    const config = buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;
    const accounts = feishu["accounts"] as Record<string, unknown>;

    assert.ok(accounts);
    assert.ok("account-a" in accounts);
    const accountCfg = accounts["account-a"] as Record<string, unknown>;
    assert.equal(accountCfg["bindingId"], binding.id);
    assert.equal(accountCfg["agentUrl"], "http://localhost:3001");
    assert.equal(accountCfg["appId"], "cli_a");
  });

  test("skips disabled feishu bindings", async () => {
    await createChannelBinding({
      name: "Disabled Bot",
      channelType: "feishu",
      accountId: "disabled",
      channelConfig: { appId: "cli_dis", appSecret: "sec_dis" },
      agentUrl: "http://localhost:3001",
      enabled: false,
    });

    const config = buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;

    assert.ok(
      !("appId" in feishu) && !("accounts" in feishu),
      "disabled binding should not appear in config",
    );
  });

  test("skips non-feishu channel bindings", async () => {
    await createChannelBinding({
      name: "Slack Bot",
      channelType: "slack",
      accountId: "default",
      channelConfig: { token: "xoxb-slack" },
      agentUrl: "http://localhost:3001",
      enabled: true,
    });

    const config = buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;

    assert.ok(
      !("appId" in feishu),
      "slack binding should not appear in feishu config",
    );
  });

  test("uses '*' as default allowFrom when not specified in channelConfig", async () => {
    await createChannelBinding({
      name: "No AllowFrom",
      channelType: "feishu",
      accountId: "no-allow",
      channelConfig: { appId: "cli_naf", appSecret: "sec_naf" },
      agentUrl: "http://localhost:3001",
      enabled: true,
    });

    const config = buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;
    const accounts = feishu["accounts"] as Record<string, unknown>;
    const accountCfg = accounts["no-allow"] as Record<string, unknown>;

    assert.deepEqual(accountCfg["allowFrom"], ["*"]);
  });
});

// ---------------------------------------------------------------------------
// seedDefaults
// ---------------------------------------------------------------------------

describe("seedDefaults", () => {
  beforeEach(resetDB);

  const ECHO_URL = "http://localhost:3001";

  test("creates the echo agent when the agents table is empty", async () => {
    await seedDefaults(ECHO_URL);

    const agents = await listAgentConfigs();
    assert.equal(agents.length, 1);
    const agent = agents[0]!;
    assert.equal(agent.url, ECHO_URL);
    assert.equal(agent.protocol, "a2a");
  });

  test("does not duplicate the echo agent on repeated calls", async () => {
    await seedDefaults(ECHO_URL);
    await seedDefaults(ECHO_URL);

    const agents = await listAgentConfigs();
    assert.equal(agents.length, 1);
  });

  test("does not create echo agent when agents already exist", async () => {
    await createAgentConfig({
      name: "Existing Agent",
      url: "http://existing:4000",
      protocol: "a2a",
    });

    await seedDefaults(ECHO_URL);

    const agents = await listAgentConfigs();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.url, "http://existing:4000");
  });

  test("adds echo agent URL to the in-memory protocol cache", async () => {
    await seedDefaults(ECHO_URL);
    const protocol = getAgentProtocolForUrl(ECHO_URL);
    assert.equal(protocol, "a2a");
  });

  test("creates a feishu binding from FEISHU_APP_ID / FEISHU_APP_SECRET env vars", async () => {
    process.env["FEISHU_APP_ID"] = "cli_seed_app";
    process.env["FEISHU_APP_SECRET"] = "seed_secret";
    process.env["FEISHU_ACCOUNT_ID"] = "seed-account";

    try {
      await seedDefaults(ECHO_URL);

      const bindings = await listChannelBindings();
      const feishuBinding = bindings.find(
        (b) => b.channelType === "feishu" && b.accountId === "seed-account",
      );

      assert.ok(feishuBinding, "feishu binding should be created from env vars");
      const cfg = feishuBinding.channelConfig as Record<string, unknown>;
      assert.equal(cfg["appId"], "cli_seed_app");
      assert.equal(cfg["appSecret"], "seed_secret");
    } finally {
      delete process.env["FEISHU_APP_ID"];
      delete process.env["FEISHU_APP_SECRET"];
      delete process.env["FEISHU_ACCOUNT_ID"];
    }
  });

  test("does not duplicate the feishu binding on repeated seedDefaults calls", async () => {
    process.env["FEISHU_APP_ID"] = "cli_dup";
    process.env["FEISHU_APP_SECRET"] = "dup_secret";
    process.env["FEISHU_ACCOUNT_ID"] = "dup-account";

    try {
      await seedDefaults(ECHO_URL);
      await seedDefaults(ECHO_URL);

      const bindings = await listChannelBindings();
      const feishuBindings = bindings.filter(
        (b) => b.channelType === "feishu" && b.accountId === "dup-account",
      );
      assert.equal(feishuBindings.length, 1);
    } finally {
      delete process.env["FEISHU_APP_ID"];
      delete process.env["FEISHU_APP_SECRET"];
      delete process.env["FEISHU_ACCOUNT_ID"];
    }
  });

  test("uses 'default' as accountId when FEISHU_ACCOUNT_ID is not set", async () => {
    process.env["FEISHU_APP_ID"] = "cli_noaccountid";
    process.env["FEISHU_APP_SECRET"] = "sec_noaccountid";
    delete process.env["FEISHU_ACCOUNT_ID"];

    try {
      await seedDefaults(ECHO_URL);

      const bindings = await listChannelBindings();
      const feishuBinding = bindings.find(
        (b) => b.channelType === "feishu" && b.accountId === "default",
      );
      assert.ok(feishuBinding, "accountId should default to 'default'");
    } finally {
      delete process.env["FEISHU_APP_ID"];
      delete process.env["FEISHU_APP_SECRET"];
    }
  });
});

// ---------------------------------------------------------------------------
// initStore
// ---------------------------------------------------------------------------

describe("initStore", () => {
  beforeEach(resetDB);

  test("populates the channel cache from the database", async () => {
    // Insert a binding directly via prisma, bypass store functions
    await prisma.channelBinding.create({
      data: {
        name: "Direct Insert",
        channelType: "feishu",
        accountId: "direct",
        channelConfig: JSON.stringify({ appId: "x", appSecret: "y" }),
        agentUrl: "http://direct:4000",
        enabled: true,
      },
    });

    // Re-init to pick up the direct insert
    await initStore();

    const bindings = await listChannelBindings();
    const binding = bindings.find((b) => b.accountId === "direct");
    assert.ok(binding);

    const url = getAgentUrlForBinding(binding.id, "http://fallback");
    assert.equal(url, "http://direct:4000");
  });

  test("populates the agent protocol cache from the database", async () => {
    // Insert directly via prisma
    await prisma.agent.create({
      data: {
        name: "Direct Agent",
        url: "http://direct-agent:4000",
        protocol: "acp",
      },
    });

    await initStore();

    const protocol = getAgentProtocolForUrl("http://direct-agent:4000");
    assert.equal(protocol, "acp");
  });
});
