/**
 * A2A Channels Gateway – main HTTP server.
 *
 * Composition root: wires together the DDD infrastructure
 * (state repositories, outbox-backed application services) and starts the Hono
 * HTTP server.
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

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";

import { buildGatewayConfig } from "./bootstrap/config.js";
import { buildGatewayContainer } from "./bootstrap/container.js";
import { buildHttpApp } from "./http/app.js";
import { AgentService } from "./application/agent-service.js";
import { ChannelBindingService } from "./application/channel-binding-service.js";
import { DomainEventBus } from "./infra/domain-event-bus.js";
import { OutboxWorker } from "./infra/outbox-worker.js";
import { buildRuntimeBootstrap } from "./runtime/bootstrap.js";
import { RelayRuntime } from "./runtime/relay-runtime.js";
import { initStore, seedDefaults } from "./services/initialization.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const gatewayConfig = buildGatewayConfig();
const { port: PORT, corsOrigin: CORS_ORIGIN } = gatewayConfig;

// ---------------------------------------------------------------------------
// Infrastructure wiring
// ---------------------------------------------------------------------------

const container = buildGatewayContainer(gatewayConfig);
const eventBus = container.get(DomainEventBus);
const outboxWorker = container.get(OutboxWorker);
const bindingRepo = container.get<ChannelBindingRepository>(
  ChannelBindingRepository,
);
const agentRepo = container.get<AgentConfigRepository>(AgentConfigRepository);
const channelBindingService = container.get(ChannelBindingService);
const agentService = container.get(AgentService);

await initStore();

await seedDefaults({
  agentService,
  bindingService: channelBindingService,
  agentRepo,
  bindingRepo,
});

outboxWorker.start();

// ---------------------------------------------------------------------------
// Runtime bootstrap
// ---------------------------------------------------------------------------

// RelayRuntime manages only local owned bindings; bootstrap selects the
// single-instance or cluster scheduler boundary around it.
const relay = await RelayRuntime.load();
await relay.bootstrap();
const clusterMode = process.env["CLUSTER_MODE"] === "true";
const bootstrap = buildRuntimeBootstrap({
  clusterMode,
  redisUrl: process.env["REDIS_URL"],
  relay,
  eventBus,
});
bootstrap.scheduler.start();

const app = buildHttpApp(container, {
  corsOrigin: CORS_ORIGIN,
  runtime: relay,
  webDir: WEB_DIR,
});

// ── Server startup ───────────────────────────────────────────────────────────

console.log(`🚀 A2A Channels Gateway starting on http://localhost:${PORT}`);

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`✅ Gateway listening on http://localhost:${PORT}`);
  console.log(`   Web UI: http://localhost:${PORT}/`);
  console.log(`   API:    http://localhost:${PORT}/api/channels`);
});

process.on("SIGINT", async () => {
  console.log("\n[gateway] shutting down…");
  await bootstrap.scheduler.stop();
  await outboxWorker.stop();
  await relay.shutdown();
  server.close();
  process.exit(0);
});

export default app;
