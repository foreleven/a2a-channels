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

import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";

import { buildGatewayConfig } from "./bootstrap/config.js";
import { buildGatewayContainer } from "./bootstrap/container.js";
import { startGateway } from "./bootstrap/start-gateway.js";
import { buildHttpApp } from "./http/app.js";
import { AgentService } from "./application/agent-service.js";
import { ChannelBindingService } from "./application/channel-binding-service.js";
import { OutboxWorker } from "./infra/outbox-worker.js";
import { RuntimeBootstrapper } from "./runtime/runtime-bootstrapper.js";
import { RuntimeClusterStateReader } from "./runtime/runtime-cluster-state-reader.js";
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
const outboxWorker = container.get(OutboxWorker);
const bindingRepo = container.get<ChannelBindingRepository>(
  ChannelBindingRepository,
);
const agentRepo = container.get<AgentConfigRepository>(AgentConfigRepository);
const channelBindingService = container.get(ChannelBindingService);
const agentService = container.get(AgentService);
const runtimeBootstrapper = container.get(RuntimeBootstrapper);
const runtimeStateReader = container.get(RuntimeClusterStateReader);

await initStore();

await seedDefaults({
  agentService,
  bindingService: channelBindingService,
  agentRepo,
  bindingRepo,
});
const app = buildHttpApp(container, {
  corsOrigin: CORS_ORIGIN,
  runtime: runtimeStateReader,
  webDir: WEB_DIR,
});
const gateway = startGateway({
  app,
  port: PORT,
  outboxWorker,
  runtimeBootstrapper,
});

process.on("SIGINT", async () => {
  console.log("\n[gateway] shutting down…");
  await gateway.shutdown();
  process.exit(0);
});

export default app;
