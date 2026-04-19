/**
 * A2A Channels Gateway – main HTTP server.
 *
 * Composition root: wires together the DDD / event-sourcing infrastructure
 * (EventStore, repositories, projections, DomainEventBus, application
 * services) and starts the Hono HTTP server.
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

import { DomainEventBus } from "./domain/event-bus.js";
import { ChannelBindingService } from "./domain/channel-binding-service.js";
import type { UpdateChannelBindingData } from "./domain/channel-binding-service.js";
import { AgentService } from "./domain/agent-service.js";
import type { UpdateAgentData } from "./domain/agent-service.js";
import { DuplicateEnabledBindingError } from "./services/channel-bindings.js";
import { PrismaEventStore } from "./infra/prisma-event-store.js";
import { EventSourcedChannelBindingRepository } from "./infra/channel-binding-repo.js";
import { EventSourcedAgentConfigRepository } from "./infra/agent-config-repo.js";
import { ChannelBindingProjection } from "./projections/channel-binding-projection.js";
import { AgentConfigProjection } from "./projections/agent-config-projection.js";
import { RelayRuntime } from "./runtime/relay-runtime.js";
import { initStore, seedDefaults } from "./store/index.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const PORT = Number(process.env["PORT"] ?? 7890);

// ---------------------------------------------------------------------------
// Infrastructure wiring
// ---------------------------------------------------------------------------

await initStore();
await seedDefaults();

const eventBus = new DomainEventBus();
const eventStore = new PrismaEventStore();

const bindingRepo = new EventSourcedChannelBindingRepository(eventStore, eventBus);
const agentRepo = new EventSourcedAgentConfigRepository(eventStore, eventBus);

const bindingProjection = new ChannelBindingProjection(eventBus, eventStore);
const agentProjection = new AgentConfigProjection(eventBus, eventStore);

// Replay any missed events (projection catch-up), then register live handlers.
await bindingProjection.catchUp();
await agentProjection.catchUp();
bindingProjection.register();
agentProjection.register();

// Application services
const channelBindingService = new ChannelBindingService(bindingRepo);
const agentService = new AgentService(agentRepo);

// RelayRuntime subscribes to the event bus to react to binding/agent changes.
const relay = await RelayRuntime.load(eventBus);
await relay.bootstrap();

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

function channelMutationErrorResponse(c: Context, err: unknown) {
  if (err instanceof DuplicateEnabledBindingError) {
    return c.json({ error: err.message }, 409);
  }
  throw err;
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
app.get("/api/channels", async (c) => c.json(await channelBindingService.list()));

app.get("/api/channels/:id", async (c) => {
  const binding = await channelBindingService.getById(c.req.param("id"));
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
  try {
    const binding = await channelBindingService.create({
      name: String(body["name"]),
      channelType: (body["channelType"] as string | undefined) ?? "feishu",
      channelConfig: body["channelConfig"] as Record<string, unknown>,
      accountId: (body["accountId"] as string | undefined) ?? "default",
      agentUrl: String(body["agentUrl"]),
      enabled: (body["enabled"] as boolean | undefined) ?? true,
    });
    return c.json(binding, 201);
  } catch (err) {
    return channelMutationErrorResponse(c, err);
  }
});

app.patch("/api/channels/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  try {
    const updated = await channelBindingService.update(id, body as UpdateChannelBindingData);
    if (!updated) return c.json({ error: `Channel ${id} not found` }, 404);
    return c.json(updated);
  } catch (err) {
    return channelMutationErrorResponse(c, err);
  }
});

app.delete("/api/channels/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = await channelBindingService.delete(id);
  if (!deleted) return c.json({ error: `Channel ${id} not found` }, 404);
  return c.json({ deleted: true });
});

// ── Agent configs ─────────────────────────────────────────────────────────────
app.get("/api/agents", async (c) => c.json(await agentService.list()));

app.get("/api/agents/:id", async (c) => {
  const agent = await agentService.getById(c.req.param("id"));
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
  const agent = await agentService.register({
    name: String(body["name"]),
    url: String(body["url"]),
    protocol: (body["protocol"] as string | undefined) ?? "a2a",
    description: body["description"] as string | undefined,
  });
  return c.json(agent, 201);
});

app.patch("/api/agents/:id", async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const updated = await agentService.update(id, body as UpdateAgentData);
  if (!updated) return c.json({ error: `Agent ${id} not found` }, 404);
  return c.json(updated);
});

app.delete("/api/agents/:id", async (c) => {
  const id = c.req.param("id");
  const deleted = await agentService.delete(id);
  if (!deleted) return c.json({ error: `Agent ${id} not found` }, 404);
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
