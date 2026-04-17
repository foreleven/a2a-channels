/**
 * A2A Channels Gateway – main HTTP server.
 *
 * Composition root: creates the store, transport, plugin host, and monitor
 * manager, then starts the Hono HTTP server on Node.js.
 *
 * Routes:
 *   GET  /                     → Admin Web UI
 *   GET  /api/channels         → list channel bindings
 *   POST /api/channels         → create channel binding
 *   PATCH /api/channels/:id    → update channel binding
 *   DELETE /api/channels/:id   → delete channel binding
 *   GET  /api/agents           → list agent configs
 *   POST /api/agents           → create agent config
 *   PATCH /api/agents/:id      → update agent config
 *   DELETE /api/agents/:id     → delete agent config
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Hono } from "hono";
import { serve } from "@hono/node-server";

import { A2ATransport } from "@a2a-channels/agent-transport";
import {
  OpenClawChannelProvider,
  OpenClawPluginHost,
  buildOpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";

import { registerAllPlugins } from "./register-plugins.js";

import {
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
  getAgentUrlForAccount,
  buildOpenClawConfig,
} from "./store/index.js";
import { MonitorManager } from "./monitor-manager.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const transport = new A2ATransport();

const runtime = buildOpenClawPluginRuntime({
  transport,
  getAgentUrl: getAgentUrlForAccount,
  getConfig: buildOpenClawConfig,
});

const openclawHost = new OpenClawPluginHost(runtime, buildOpenClawConfig);

registerAllPlugins(openclawHost);

const monitorManager = new MonitorManager([
  new OpenClawChannelProvider(openclawHost),
]);

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const PORT = Number(process.env["PORT"] ?? 7890);

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

// ── Static Web UI ────────────────────────────────────────────────────────────
app.get("/", async (c) => {
  try {
    const html = await readFile(join(WEB_DIR, "index.html"), "utf-8");
    return c.html(html);
  } catch {
    return c.html("<h1>Web UI not found</h1>", 404);
  }
});

// ── Channel bindings ─────────────────────────────────────────────────────────
app.get("/api/channels", (c) => c.json(listChannelBindings()));

app.get("/api/channels/:id", (c) => {
  const binding = getChannelBinding(c.req.param("id"));
  return binding ? c.json(binding) : c.json({ error: "Not found" }, 404);
});

app.post("/api/channels", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body["name"] || !body["channelConfig"] || !body["agentUrl"]) {
    return c.json(
      { error: "Missing required fields: name, channelConfig, agentUrl" },
      400,
    );
  }
  const binding = createChannelBinding({
    name: String(body["name"]),
    channelType: (body["channelType"] as string | undefined) ?? "feishu",
    channelConfig: body["channelConfig"] as Record<string, unknown>,
    accountId: (body["accountId"] as string | undefined) ?? "default",
    agentUrl: String(body["agentUrl"]),
    enabled: (body["enabled"] as boolean | undefined) ?? true,
  });
  if (binding.enabled) {
    monitorManager
      .restartMonitor(binding.channelType, binding.accountId)
      .catch((err: unknown) =>
        console.error("[gateway] failed to start monitor:", err),
      );
  }
  return c.json(binding, 201);
});

app.patch("/api/channels/:id", async (c) => {
  const id = c.req.param("id");
  if (!getChannelBinding(id))
    return c.json({ error: `Channel ${id} not found` }, 404);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const updated = updateChannelBinding(id, body);
  if (!updated) return c.json({ error: "Not found" }, 404);
  monitorManager
    .restartMonitor(updated.channelType, updated.accountId)
    .catch((err: unknown) =>
      console.error("[gateway] failed to restart monitor:", err),
    );
  return c.json(updated);
});

app.delete("/api/channels/:id", (c) => {
  const id = c.req.param("id");
  if (!deleteChannelBinding(id))
    return c.json({ error: `Channel ${id} not found` }, 404);
  monitorManager
    .syncMonitors()
    .catch((err: unknown) =>
      console.error("[gateway] failed to sync monitors:", err),
    );
  return c.json({ deleted: true });
});

// ── Agent configs ─────────────────────────────────────────────────────────────
app.get("/api/agents", (c) => c.json(listAgentConfigs()));

app.get("/api/agents/:id", (c) => {
  const agent = getAgentConfig(c.req.param("id"));
  return agent ? c.json(agent) : c.json({ error: "Not found" }, 404);
});

app.post("/api/agents", async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  if (!body["name"] || !body["url"])
    return c.json({ error: "Missing required fields: name, url" }, 400);
  return c.json(
    createAgentConfig({
      name: String(body["name"]),
      url: String(body["url"]),
      description: body["description"] as string | undefined,
    }),
    201,
  );
});

app.patch("/api/agents/:id", async (c) => {
  const id = c.req.param("id");
  if (!getAgentConfig(id))
    return c.json({ error: `Agent ${id} not found` }, 404);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const updated = updateAgentConfig(id, body);
  return updated ? c.json(updated) : c.json({ error: "Not found" }, 404);
});

app.delete("/api/agents/:id", (c) => {
  const id = c.req.param("id");
  return deleteAgentConfig(id)
    ? c.json({ deleted: true })
    : c.json({ error: `Agent ${id} not found` }, 404);
});

// ---------------------------------------------------------------------------
// Server startup
// ---------------------------------------------------------------------------

console.log(`🚀 A2A Channels Gateway starting on http://localhost:${PORT}`);

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`✅ Gateway listening on http://localhost:${PORT}`);
  console.log(`   Web UI: http://localhost:${PORT}/`);
  console.log(`   API:    http://localhost:${PORT}/api/channels`);
});

monitorManager
  .syncMonitors()
  .catch((err: unknown) =>
    console.error("[gateway] initial monitor sync failed:", err),
  );

process.on("SIGINT", async () => {
  console.log("\n[gateway] shutting down…");
  await monitorManager.stopAllMonitors();
  server.close();
  process.exit(0);
});

export default app;
