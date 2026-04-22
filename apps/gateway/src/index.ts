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

import { buildGatewayContainer } from "./bootstrap/container.js";
import { GatewayServer } from "./bootstrap/gateway-server.js";
import { InitializationService } from "./services/initialization.js";

// ---------------------------------------------------------------------------
// Infrastructure wiring
// ---------------------------------------------------------------------------

const container = buildGatewayContainer();

const initializationService = container.get(InitializationService);
await initializationService.initStore();
await initializationService.seedDefaults();

const server = container.get(GatewayServer);
server.start();

process.on("SIGINT", async () => {
  console.log("\n[gateway] shutting down…");
  await server.shutdown();
  process.exit(0);
});

export default server;
