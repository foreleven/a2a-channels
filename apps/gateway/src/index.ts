/**
 * A2A Channels Gateway – main HTTP server.
 *
 * Composition root: creates the Prisma store, transport, plugin host, and
 * monitor manager, then starts the Hono HTTP server on Node.js.
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

import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";

import { RelayRuntime } from "./runtime/relay-runtime.js";
import {
  DuplicateEnabledBindingError,
  initStore,
  seedDefaults,
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
} from "./store/index.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const PORT = Number(process.env["PORT"] ?? 7890);

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

await initStore();
await seedDefaults();

const relay = await RelayRuntime.load();
await relay.bootstrap();

function channelMutationErrorResponse(c: Context, err: unknown) {
  if (err instanceof DuplicateEnabledBindingError) {
    return c.json({ error: err.message }, 409);
  }
  throw err;
}

function applyRelayMutation(operation: Promise<unknown>, action: string): void {
  operation.catch((err: unknown) =>
    console.error(`[gateway] failed to ${action}:`, err),
  );
}

// ── CORS – allow requests from the Next.js admin UI ──────────────────────────
const CORS_ORIGIN = process.env["CORS_ORIGIN"] ?? "http://localhost:3000";
app.use(
  "/api/*",
  cors({
    origin: CORS_ORIGIN,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

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
app.get("/api/channels", async (c) => c.json(await listChannelBindings()));

app.get("/api/channels/:id", async (c) => {
  const binding = await getChannelBinding(c.req.param("id"));
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
  let binding;
  try {
    binding = await createChannelBinding({
      name: String(body["name"]),
      channelType: (body["channelType"] as string | undefined) ?? "feishu",
      channelConfig: body["channelConfig"] as Record<string, unknown>,
      accountId: (body["accountId"] as string | undefined) ?? "default",
      agentUrl: String(body["agentUrl"]),
      enabled: (body["enabled"] as boolean | undefined) ?? true,
    });
  } catch (err) {
    return channelMutationErrorResponse(c, err);
  }
  applyRelayMutation(relay.applyBindingUpsert(binding), "apply binding create");
  return c.json(binding, 201);
});

app.patch("/api/channels/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await getChannelBinding(id)))
    return c.json({ error: `Channel ${id} not found` }, 404);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  let updated;
  try {
    updated = await updateChannelBinding(id, body);
  } catch (err) {
    return channelMutationErrorResponse(c, err);
  }
  if (!updated) return c.json({ error: "Not found" }, 404);
  applyRelayMutation(relay.applyBindingUpsert(updated), "apply binding update");
  return c.json(updated);
});

app.delete("/api/channels/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await deleteChannelBinding(id)))
    return c.json({ error: `Channel ${id} not found` }, 404);
  applyRelayMutation(relay.applyBindingDelete(id), "apply binding delete");
  return c.json({ deleted: true });
});

// ── Agent configs ─────────────────────────────────────────────────────────────
app.get("/api/agents", async (c) => c.json(await listAgentConfigs()));

app.get("/api/agents/:id", async (c) => {
  const agent = await getAgentConfig(c.req.param("id"));
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
  const agent = await createAgentConfig({
    name: String(body["name"]),
    url: String(body["url"]),
    protocol: (body["protocol"] as string | undefined) ?? "a2a",
    description: body["description"] as string | undefined,
  });
  applyRelayMutation(relay.applyAgentUpsert(agent), "apply agent create");
  return c.json(agent, 201);
});

app.patch("/api/agents/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await getAgentConfig(id)))
    return c.json({ error: `Agent ${id} not found` }, 404);
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const updated = await updateAgentConfig(id, body);
  if (!updated) return c.json({ error: "Not found" }, 404);
  applyRelayMutation(relay.applyAgentUpsert(updated), "apply agent update");
  return c.json(updated);
});

app.delete("/api/agents/:id", async (c) => {
  const id = c.req.param("id");
  if (!(await deleteAgentConfig(id)))
    return c.json({ error: `Agent ${id} not found` }, 404);
  applyRelayMutation(relay.applyAgentDelete(id), "apply agent delete");
  return c.json({ deleted: true });
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

process.on("SIGINT", async () => {
  console.log("\n[gateway] shutting down…");
  await relay.shutdown();
  server.close();
  process.exit(0);
});

export default app;
