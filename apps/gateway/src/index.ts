/**
 * Agent Relay Gateway – main HTTP server.
 *
 * Composition root: wires together infrastructure, application services,
 * runtime orchestration, and the Hono HTTP surface.
 *
 * The entrypoint deliberately does very little work itself:
 * 1. Build the DI container.
 * 2. Resolve the GatewayServer application service.
 * 3. Bootstrap runtime synchronously, then start the HTTP server.
 *
 * Keeping startup orchestration here makes the boot path easy to inspect
 * without spreading process lifecycle code across unrelated modules.
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
import {
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "./infra/logger.js";

// Build the singleton object graph once for the entire process. The container
// is the only place where concrete infrastructure classes are wired to domain
// ports; everything below this entrypoint talks through injected abstractions.

const container = buildGatewayContainer();

// GatewayServer owns process-level lifetime. index.ts should not reach into
// HTTP, scheduler, or runtime collaborators directly.
const server = container.get(GatewayServer);
const logger = container.get<GatewayLoggerPort>(GatewayLogger);
await server.start();

process.on("SIGINT", async () => {
  logger.info("gateway shutting down after SIGINT");
  await server.shutdown();
  process.exit(0);
});

export default server;
