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

import { prisma } from "./prisma.js";
import { AgentService, ReferencedAgentError } from "../application/agent-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import { DuplicateEnabledBindingError } from "../application/errors.js";
import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { DomainEventBus } from "../infra/domain-event-bus.js";
import { OutboxWorker } from "../infra/outbox-worker.js";
import { LocalScheduler } from "../runtime/local-scheduler.js";
import { initStore, seedDefaults } from "../services/initialization.js";
import { buildOpenClawConfig } from "../services/openclaw-config.js";
import {
  getAgentUrlForBinding,
  getAgentUrlForChannelAccount,
  getAgentProtocolForUrl,
} from "../services/routing.js";
import { createRuntimeOwnershipState } from "../runtime/ownership-state.js";
import { createReconnectPolicy } from "../runtime/reconnect-policy.js";

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

/** Delete all rows from the gateway state, outbox, and legacy event tables. */
async function resetDB(): Promise<void> {
  await prisma.outboxEvent.deleteMany();
  await prisma.channelBinding.deleteMany();
  await prisma.agent.deleteMany();
  await initStore();
}

const FEISHU_BINDING_DATA = {
  name: "Test Feishu Bot",
  channelType: "feishu",
  accountId: "test-account",
  channelConfig: { appId: "cli_abc", appSecret: "secret123" },
  agentId: "test-agent-id",
  enabled: true,
} as const;

const AGENT_DATA = {
  name: "Test Agent",
  url: "http://localhost:3001",
  protocol: "a2a",
  description: "A test agent",
} as const;

async function createTestAgent(url: string = AGENT_DATA.url) {
  return createAgentConfig({
    ...AGENT_DATA,
    url,
    name: `Agent ${url}`,
  });
}

function makeInfra() {
  const bindingRepo = new ChannelBindingStateRepository();
  const agentRepo = new AgentConfigStateRepository();
  return {
    bindingService: new ChannelBindingService(bindingRepo),
    agentService: new AgentService(agentRepo, bindingRepo),
    bindingRepo,
    agentRepo,
  };
}

async function listChannelBindings() {
  return makeInfra().bindingService.list();
}

async function getChannelBinding(id: string) {
  return makeInfra().bindingService.getById(id);
}

async function createChannelBinding(
  data: Parameters<ChannelBindingService["create"]>[0],
) {
  return makeInfra().bindingService.create(data);
}

async function updateChannelBinding(
  id: string,
  data: Parameters<ChannelBindingService["update"]>[1],
) {
  return makeInfra().bindingService.update(id, data);
}

async function deleteChannelBinding(id: string) {
  return makeInfra().bindingService.delete(id);
}

async function listAgentConfigs() {
  return makeInfra().agentService.list();
}

async function getAgentConfig(id: string) {
  return makeInfra().agentService.getById(id);
}

async function createAgentConfig(data: Parameters<AgentService["register"]>[0]) {
  return makeInfra().agentService.register(data);
}

async function updateAgentConfig(
  id: string,
  data: Parameters<AgentService["update"]>[1],
) {
  return makeInfra().agentService.update(id, data);
}

async function deleteAgentConfig(id: string) {
  return makeInfra().agentService.delete(id);
}

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
    assert.equal(binding.agentId, FEISHU_BINDING_DATA.agentId);
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
    assert.equal(updated.agentId, FEISHU_BINDING_DATA.agentId);
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

  test("create immediately reflects in DB-backed routing", async () => {
    const agent = await createTestAgent("http://routing-agent:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "routing-test",
      agentId: agent.id,
    });

    const url = await getAgentUrlForBinding(binding.id, "http://default");
    assert.equal(url, agent.url);
  });

  test("update immediately reflects in DB-backed routing", async () => {
    const oldAgent = await createTestAgent("http://old-agent:4000");
    const newAgent = await createTestAgent("http://new-agent:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "routing-update",
      agentId: oldAgent.id,
    });
    await updateChannelBinding(binding.id, {
      agentId: newAgent.id,
    });

    const url = await getAgentUrlForBinding(binding.id, "http://default");
    assert.equal(url, newAgent.url);
  });

  test("delete immediately reflects in DB-backed routing", async () => {
    const agent = await createTestAgent("http://to-delete:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "routing-delete",
      agentId: agent.id,
    });
    await deleteChannelBinding(binding.id);

    const url = await getAgentUrlForBinding(binding.id, "http://fallback");
    assert.equal(url, "http://fallback");
  });
  test("rejects creating a second enabled binding for the same channel/account", async () => {
    await createChannelBinding(FEISHU_BINDING_DATA);

    await assert.rejects(
      createChannelBinding({
        ...FEISHU_BINDING_DATA,
        name: "Duplicate",
        agentId: "http://duplicate-agent:4000",
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

describe("RuntimeOwnershipState", () => {
  test("detaching a binding removes its runtime status entry", async () => {
    const state = createRuntimeOwnershipState();
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    state.attachBinding(binding);
    state.markConnecting("binding-1", "http://agent-1");
    state.markConnected("binding-1", "http://agent-1");
    state.detachBinding("binding-1");

    assert.deepEqual(state.listConnectionStatuses(), []);
  });

  test("error state schedules the next reconnect attempt", async () => {
    const state = createRuntimeOwnershipState({
      reconnectPolicy: createReconnectPolicy({
        baseDelayMs: 1000,
        maxDelayMs: 8000,
      }),
    });
    const binding = {
      id: "binding-1",
      name: "Binding One",
      channelType: "feishu",
      accountId: "default",
      channelConfig: { appId: "cli_1", appSecret: "sec_1" },
      agentId: "agent-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    state.attachBinding(binding);
    const retry = state.markError("binding-1", new Error("socket closed"));

    assert.equal(retry.attempt, 1);
    assert.equal(retry.delayMs, 1000);
    assert.equal(state.getOwnedBinding("binding-1")?.status.status, "error");
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

  test("update handles URL change in DB-backed protocol lookup", async () => {
    const created = await createAgentConfig({
      ...AGENT_DATA,
      url: "http://old-url:3001",
      protocol: "acp",
    });

    assert.equal(await getAgentProtocolForUrl("http://old-url:3001"), "acp");

    await updateAgentConfig(created.id, { url: "http://new-url:3001" });

    assert.equal(await getAgentProtocolForUrl("http://old-url:3001"), "a2a");
    assert.equal(await getAgentProtocolForUrl("http://new-url:3001"), "acp");
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

  test("delete removes the agent from DB-backed protocol lookup", async () => {
    const created = await createAgentConfig({
      ...AGENT_DATA,
      protocol: "acp",
    });
    assert.equal(await getAgentProtocolForUrl(created.url), "acp");

    await deleteAgentConfig(created.id);
    assert.equal(await getAgentProtocolForUrl(created.url), "a2a");
  });
});

// ---------------------------------------------------------------------------
// Agent routing
// ---------------------------------------------------------------------------

describe("agent routing", () => {
  beforeEach(resetDB);

  const DEFAULT_URL = "http://default-agent:3001";

  test("getAgentUrlForBinding returns the default URL when the binding is missing", async () => {
    const url = await getAgentUrlForBinding("missing-binding", DEFAULT_URL);
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForBinding returns the matching enabled binding URL", async () => {
    const agent = await createTestAgent("http://binding-agent:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      agentId: agent.id,
    });

    const url = await getAgentUrlForBinding(binding.id, DEFAULT_URL);
    assert.equal(url, agent.url);
  });

  test("getAgentUrlForBinding skips disabled bindings", async () => {
    const agent = await createTestAgent("http://disabled-agent:4000");
    const binding = await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      agentId: agent.id,
      enabled: false,
    });

    const url = await getAgentUrlForBinding(binding.id, DEFAULT_URL);
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForChannelAccount returns the matching channel/account URL", async () => {
    const agent = await createTestAgent("http://exact-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "exact-match",
      agentId: agent.id,
    });

    const url = await getAgentUrlForChannelAccount(
      "feishu",
      "exact-match",
      DEFAULT_URL,
    );
    assert.equal(url, agent.url);
  });

  test("getAgentUrlForChannelAccount does not fall back to another account", async () => {
    const agent = await createTestAgent("http://other-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "other-account",
      agentId: agent.id,
    });

    const url = await getAgentUrlForChannelAccount(
      "feishu",
      "no-match-account",
      DEFAULT_URL,
    );
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForChannelAccount skips disabled bindings", async () => {
    const agent = await createTestAgent("http://disabled-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "disabled-account",
      agentId: agent.id,
      enabled: false,
    });

    const url = await getAgentUrlForChannelAccount(
      "feishu",
      "disabled-account",
      DEFAULT_URL,
    );
    assert.equal(url, DEFAULT_URL);
  });

  test("getAgentUrlForChannelAccount treats undefined channel/account as feishu/default", async () => {
    const agent = await createTestAgent("http://default-binding-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "default",
      agentId: agent.id,
    });

    const url = await getAgentUrlForChannelAccount(undefined, undefined, DEFAULT_URL);
    assert.equal(url, agent.url);
  });

  test("getAgentUrlForChannelAccount distinguishes identical accountIds across channel types", async () => {
    const feishuAgent = await createTestAgent("http://feishu-agent:4000");
    const slackAgent = await createTestAgent("http://slack-agent:4000");
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      accountId: "shared",
      agentId: feishuAgent.id,
    });
    await createChannelBinding({
      ...FEISHU_BINDING_DATA,
      name: "Slack Bot",
      channelType: "slack",
      accountId: "shared",
      channelConfig: { token: "xoxb" },
      agentId: slackAgent.id,
    });

    assert.equal(
      await getAgentUrlForChannelAccount("feishu", "shared", DEFAULT_URL),
      feishuAgent.url,
    );
    assert.equal(
      await getAgentUrlForChannelAccount("slack", "shared", DEFAULT_URL),
      slackAgent.url,
    );
  });
});

// ---------------------------------------------------------------------------
// getAgentProtocolForUrl
// ---------------------------------------------------------------------------

describe("getAgentProtocolForUrl", () => {
  beforeEach(resetDB);

  test("returns 'a2a' when the agent is not in the database", async () => {
    const protocol = await getAgentProtocolForUrl("http://unknown:3001");
    assert.equal(protocol, "a2a");
  });

  test("returns the stored protocol for an agent", async () => {
    await createAgentConfig({
      name: "ACP Agent",
      url: "http://acp-agent:3001",
      protocol: "acp",
    });

    const protocol = await getAgentProtocolForUrl("http://acp-agent:3001");
    assert.equal(protocol, "acp");
  });

  test("returns 'a2a' after the agent is deleted", async () => {
    const agent = await createAgentConfig({
      name: "Temp Agent",
      url: "http://temp:3001",
      protocol: "acp",
    });
    await deleteAgentConfig(agent.id);

    const protocol = await getAgentProtocolForUrl("http://temp:3001");
    assert.equal(protocol, "a2a");
  });
});

// ---------------------------------------------------------------------------
// buildOpenClawConfig
// ---------------------------------------------------------------------------

describe("buildOpenClawConfig", () => {
  beforeEach(resetDB);

  test("returns an empty feishu config when there are no bindings", async () => {
    const config = await buildOpenClawConfig();

    assert.deepEqual(config.channels, {
      feishu: {},
      feishu_doc: {},
    });
    assert.deepEqual(config.agents, {});
  });

  test("returns feishu config for a 'default' account binding", async () => {
    const agent = await createTestAgent("http://localhost:3001");
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
      agentId: agent.id,
      enabled: true,
    });

    const config = await buildOpenClawConfig();
    const feishu = config.channels as Record<string, unknown>;
    const feishuConfig = feishu["feishu"] as Record<string, unknown>;

    assert.equal(feishuConfig["bindingId"], binding.id);
    assert.equal(feishuConfig["agentUrl"], agent.url);
    assert.equal(feishuConfig["appId"], "cli_def");
    assert.equal(feishuConfig["appSecret"], "sec_def");
    assert.equal(feishuConfig["verificationToken"], "token123");
    assert.equal(feishuConfig["encryptKey"], "enc456");
    assert.equal(feishuConfig["enabled"], true);
    assert.deepEqual(feishuConfig["allowFrom"], ["*"]);
    assert.ok(!("accounts" in feishuConfig), "default account should not create accounts block");
  });

  test("returns feishu config with an accounts block for non-default bindings", async () => {
    const agent = await createTestAgent("http://localhost:3001");
    const binding = await createChannelBinding({
      name: "Account A",
      channelType: "feishu",
      accountId: "account-a",
      channelConfig: { appId: "cli_a", appSecret: "sec_a" },
      agentId: agent.id,
      enabled: true,
    });

    const config = await buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;
    const accounts = feishu["accounts"] as Record<string, unknown>;

    assert.ok(accounts);
    assert.ok("account-a" in accounts);
    const accountCfg = accounts["account-a"] as Record<string, unknown>;
    assert.equal(accountCfg["bindingId"], binding.id);
    assert.equal(accountCfg["agentUrl"], agent.url);
    assert.equal(accountCfg["appId"], "cli_a");
  });

  test("skips disabled feishu bindings", async () => {
    const agent = await createTestAgent();
    await createChannelBinding({
      name: "Disabled Bot",
      channelType: "feishu",
      accountId: "disabled",
      channelConfig: { appId: "cli_dis", appSecret: "sec_dis" },
      agentId: agent.id,
      enabled: false,
    });

    const config = await buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;

    assert.ok(
      !("appId" in feishu) && !("accounts" in feishu),
      "disabled binding should not appear in config",
    );
  });

  test("skips non-feishu channel bindings", async () => {
    const agent = await createTestAgent();
    await createChannelBinding({
      name: "Slack Bot",
      channelType: "slack",
      accountId: "default",
      channelConfig: { token: "xoxb-slack" },
      agentId: agent.id,
      enabled: true,
    });

    const config = await buildOpenClawConfig();
    const feishu = (config.channels as Record<string, unknown>)[
      "feishu"
    ] as Record<string, unknown>;

    assert.ok(
      !("appId" in feishu),
      "slack binding should not appear in feishu config",
    );
  });

  test("uses '*' as default allowFrom when not specified in channelConfig", async () => {
    const agent = await createTestAgent();
    await createChannelBinding({
      name: "No AllowFrom",
      channelType: "feishu",
      accountId: "no-allow",
      channelConfig: { appId: "cli_naf", appSecret: "sec_naf" },
      agentId: agent.id,
      enabled: true,
    });

    const config = await buildOpenClawConfig();
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
    await seedDefaults();

    const agents = await listAgentConfigs();
    assert.equal(agents.length, 1);
    const agent = agents[0]!;
    assert.equal(agent.url, ECHO_URL);
    assert.equal(agent.protocol, "a2a");
  });

  test("does not duplicate the echo agent on repeated calls", async () => {
    await seedDefaults();
    await seedDefaults();

    const agents = await listAgentConfigs();
    assert.equal(agents.length, 1);
  });

  test("does not create echo agent when agents already exist", async () => {
    await createAgentConfig({
      name: "Existing Agent",
      url: "http://existing:4000",
      protocol: "a2a",
    });

    await seedDefaults();

    const agents = await listAgentConfigs();
    assert.equal(agents.length, 1);
    assert.equal(agents[0]?.url, "http://existing:4000");
  });

  test("seeded echo agent is available to protocol lookup", async () => {
    await seedDefaults();
    const protocol = await getAgentProtocolForUrl(ECHO_URL);
    assert.equal(protocol, "a2a");
  });

  test("creates a feishu binding from FEISHU_APP_ID / FEISHU_APP_SECRET env vars", async () => {
    process.env["FEISHU_APP_ID"] = "cli_seed_app";
    process.env["FEISHU_APP_SECRET"] = "seed_secret";
    process.env["FEISHU_ACCOUNT_ID"] = "seed-account";

    try {
      await seedDefaults();

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
      await seedDefaults();
      await seedDefaults();

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
      await seedDefaults();

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

  test("direct channel rows are available through DB-backed routing", async () => {
    const agent = await prisma.agent.create({
      data: {
        name: "Direct Binding Agent",
        url: "http://direct:4000",
        protocol: "a2a",
      },
    });

    await prisma.channelBinding.create({
      data: {
        name: "Direct Insert",
        channelType: "feishu",
        accountId: "direct",
        channelConfig: JSON.stringify({ appId: "x", appSecret: "y" }),
        agentId: agent.id,
        enabled: true,
      },
    });

    const bindings = await listChannelBindings();
    const binding = bindings.find((b) => b.accountId === "direct");
    assert.ok(binding);

    const url = await getAgentUrlForBinding(binding.id, "http://fallback");
    assert.equal(url, "http://direct:4000");
  });

  test("direct agent rows are available through DB-backed protocol lookup", async () => {
    // Insert directly via prisma
    await prisma.agent.create({
      data: {
        name: "Direct Agent",
        url: "http://direct-agent:4000",
        protocol: "acp",
      },
    });

    const protocol = await getAgentProtocolForUrl("http://direct-agent:4000");
    assert.equal(protocol, "acp");
  });
});

// ---------------------------------------------------------------------------
// DDD state persistence – aggregates + application services + outbox
// ---------------------------------------------------------------------------

describe("LocalScheduler", () => {
  test("start and stop do not accumulate duplicate event listeners", async () => {
    const bus = new DomainEventBus();
    const calls: string[] = [];
    const runtime = {
      async refreshBinding() {
        calls.push("refresh");
      },
      async detachBinding() {
        calls.push("detach");
      },
      listBindings() {
        return [];
      },
    } as const;

    const scheduler = new LocalScheduler(
      runtime as unknown as import("../runtime/relay-runtime.js").RelayRuntime,
      bus,
      { debounceMs: 0, reconcileIntervalMs: 60_000 },
    );

    scheduler.start();
    await scheduler.stop();
    scheduler.start();

    bus.publish({
      eventType: "AgentDeleted.v1",
      agentId: "agent-1",
      occurredAt: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    await scheduler.stop();

    assert.ok(calls.length <= 1, "scheduler should not reconcile twice for one event after restart");
  });
});
describe("OutboxWorker", () => {
  beforeEach(resetDB);

  test("publishes pending outbox events and marks them processed", async () => {
    const { bindingService } = makeInfra();
    const binding = await bindingService.create({
      name: "Worker Feishu Bot",
      channelType: "feishu",
      accountId: "worker-test",
      channelConfig: { appId: "cli_worker", appSecret: "sec_worker" },
      agentId: "http://worker-agent:3001",
      enabled: true,
    });

    const bus = new DomainEventBus();
    const received: unknown[] = [];
    bus.on("ChannelBindingCreated.v1", (event) => received.push(event));

    await new OutboxWorker(bus).drain();

    assert.equal(received.length, 1);
    assert.equal(
      (received[0] as { bindingId?: string }).bindingId,
      binding.id,
    );

    const row = await prisma.outboxEvent.findFirst({
      where: { aggregateId: binding.id },
    });
    assert.ok(row?.processedAt);
  });
});

describe("ChannelBinding aggregate + ChannelBindingService", () => {
  beforeEach(resetDB);

  test("create persists binding and returns snapshot", async () => {
    const { bindingService } = makeInfra();
    const binding = await bindingService.create({
      name: "ES Feishu Bot",
      channelType: "feishu",
      accountId: "es-test",
      channelConfig: { appId: "cli_es", appSecret: "sec_es" },
      agentId: "http://es-agent:3001",
      enabled: true,
    });

    assert.ok(binding.id, "id should be set");
    assert.equal(binding.name, "ES Feishu Bot");
    assert.equal(binding.channelType, "feishu");
    assert.equal(binding.accountId, "es-test");
    assert.equal(binding.enabled, true);
  });

  test("create writes a ChannelBindingCreated event to the outbox", async () => {
    const { bindingService } = makeInfra();
    const binding = await bindingService.create({
      name: "Outbox Feishu Bot",
      channelType: "feishu",
      accountId: "outbox-test",
      channelConfig: { appId: "cli_outbox", appSecret: "sec_outbox" },
      agentId: "http://outbox-agent:3001",
      enabled: true,
    });

    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: binding.id },
      orderBy: { occurredAt: "asc" },
    });
    assert.equal(events.length, 1);
    assert.equal(events[0]?.eventType, "ChannelBindingCreated.v1");
  });

  test("create persists current binding state", async () => {
    const { bindingService } = makeInfra();
    const binding = await bindingService.create({
      name: "State Feishu Bot",
      channelType: "feishu",
      accountId: "state-test",
      channelConfig: { appId: "cli_state", appSecret: "sec_state" },
      agentId: "http://state-agent:3001",
      enabled: true,
    });

    const row = await prisma.channelBinding.findUnique({ where: { id: binding.id } });
    assert.ok(row);
    assert.equal(row.name, "State Feishu Bot");
    assert.equal(row.channelType, "feishu");
  });

  test("update persists changes through state repository", async () => {
    const { bindingService } = makeInfra();
    const created = await bindingService.create({
      name: "Before Update",
      channelType: "feishu",
      accountId: "update-test",
      channelConfig: { appId: "cli_upd", appSecret: "sec_upd" },
      agentId: "http://upd-agent:3001",
      enabled: true,
    });

    const updated = await bindingService.update(created.id, {
      name: "After Update",
      enabled: false,
    });

    assert.ok(updated);
    assert.equal(updated.name, "After Update");
    assert.equal(updated.enabled, false);
    assert.equal(updated.channelType, "feishu");
  });

  test("update writes create and update events to the outbox", async () => {
    const { bindingService } = makeInfra();
    const created = await bindingService.create({
      name: "Two Events",
      channelType: "feishu",
      accountId: "two-events",
      channelConfig: { appId: "cli_2e", appSecret: "sec_2e" },
      agentId: "http://2e-agent:3001",
      enabled: true,
    });

    await bindingService.update(created.id, { name: "Updated" });

    const events = await prisma.outboxEvent.findMany({
      where: { aggregateId: created.id },
      orderBy: { occurredAt: "asc" },
    });
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventType, "ChannelBindingCreated.v1");
    assert.equal(events[1]?.eventType, "ChannelBindingUpdated.v1");
  });

  test("delete marks binding as deleted and removes state row", async () => {
    const { bindingService, bindingRepo } = makeInfra();
    const created = await bindingService.create({
      name: "To Delete",
      channelType: "feishu",
      accountId: "delete-test",
      channelConfig: { appId: "cli_del", appSecret: "sec_del" },
      agentId: "http://del-agent:3001",
      enabled: true,
    });

    const deleted = await bindingService.delete(created.id);
    assert.equal(deleted, true);

    const found = await bindingRepo.findById(created.id);
    assert.equal(found, null, "deleted binding should not be findable");
  });

  test("rejects creating a second enabled binding for the same channel/account", async () => {
    const { bindingService } = makeInfra();
    await bindingService.create({
      name: "First",
      channelType: "feishu",
      accountId: "dup-test",
      channelConfig: { appId: "cli_d1", appSecret: "sec_d1" },
      agentId: "http://d1:3001",
      enabled: true,
    });

    await assert.rejects(
      bindingService.create({
        name: "Duplicate",
        channelType: "feishu",
        accountId: "dup-test",
        channelConfig: { appId: "cli_d2", appSecret: "sec_d2" },
        agentId: "http://d2:3001",
        enabled: true,
      }),
      DuplicateEnabledBindingError,
    );
  });

  test("state table remains the source of truth on cold start", async () => {
    const { bindingService, bindingRepo } = makeInfra();
    const created = await bindingService.create({
      name: "Cold Start Binding",
      channelType: "feishu",
      accountId: "cold-start",
      channelConfig: { appId: "cli_cs", appSecret: "sec_cs" },
      agentId: "http://cs-agent:3001",
      enabled: true,
    });

    const found = await bindingRepo.findById(created.id);
    assert.ok(found, "binding should load from the current state row");
    assert.equal(found.name, "Cold Start Binding");
  });
});

describe("AgentConfig aggregate + AgentService", () => {
  beforeEach(resetDB);

  test("register persists agent and returns snapshot", async () => {
    const { agentService } = makeInfra();
    const agent = await agentService.register({
      name: "ES Agent",
      url: "http://es-agent:4000",
      protocol: "a2a",
    });

    assert.ok(agent.id);
    assert.equal(agent.name, "ES Agent");
    assert.equal(agent.protocol, "a2a");
  });

  test("register does not write a runtime outbox event", async () => {
    const { agentService } = makeInfra();

    await agentService.register({
      name: "Bus Agent",
      url: "http://bus-agent:4000",
    });

    const events = await prisma.outboxEvent.findMany();
    assert.equal(events.length, 0);
  });

  test("update patches agent fields", async () => {
    const { agentService } = makeInfra();
    const created = await agentService.register({
      name: "Before",
      url: "http://before:4000",
      protocol: "a2a",
    });

    const updated = await agentService.update(created.id, {
      name: "After",
      protocol: "acp",
    });

    assert.ok(updated);
    assert.equal(updated.name, "After");
    assert.equal(updated.protocol, "acp");
    assert.equal(updated.url, "http://before:4000");
  });

  test("delete removes an unreferenced agent", async () => {
    const { agentService, agentRepo } = makeInfra();
    const agent = await agentService.register({
      name: "Disposable",
      url: "http://disposable:4000",
    });

    const deleted = await agentService.delete(agent.id);
    assert.equal(deleted, true);

    const found = await agentRepo.findById(agent.id);
    assert.equal(found, null);
  });

  test("delete rejects when channel bindings reference the agent", async () => {
    const { agentService, bindingService } = makeInfra();
    const agent = await agentService.register({
      name: "Referenced",
      url: "http://referenced:4000",
    });
    const binding = await bindingService.create({
      name: "References Agent",
      channelType: "feishu",
      accountId: "references-agent",
      channelConfig: { appId: "cli_ref", appSecret: "sec_ref" },
      agentId: agent.id,
      enabled: true,
    });

    await assert.rejects(
      agentService.delete(agent.id),
      (err: unknown) =>
        err instanceof ReferencedAgentError &&
        err.agentId === agent.id &&
        err.bindingIds.includes(binding.id),
    );
  });
});
