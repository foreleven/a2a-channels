# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project-wide implementation constraints

- All new features and functional changes in this project must default to OOP, EventSource, and clean architecture.
- When extending existing code, prefer refactoring toward these constraints instead of adding more procedural or tightly coupled logic.
- Do not use `as unknown as ...` or similar double-cast patterns to bypass TypeScript errors. Fix the underlying types, narrow values with proper type guards, update interfaces, or add typed adapters so the compiler verifies the behavior instead of being silenced.
- When changing Prisma-managed tables or schema, use Prisma migrations as the source of truth. Do not write ad hoc scripts to alter tables or migrate schema state.

## Commands

- Install dependencies: `pnpm install` (the repo declares `pnpm@10.32.0`)
- Start the gateway server: `npm run gateway` or `pnpm gateway` (serves API on port 7890 by default)
- Start the example echo agent: `npm run echo-agent` or `pnpm echo-agent` (port 3001)
- Start the Next.js admin UI: `npm run web` or `pnpm web` (port 3000)
- Start the full local dev stack with ordered gateway readiness: `npm run dev`, `pnpm dev`, or `make dev`
- Type-check the non-web TypeScript project: `npm run typecheck` or `pnpm typecheck`
- Type-check the admin UI: `cd apps/web && npx tsc --noEmit`
- Run the gateway store test: `npm test` or `pnpm test`
- Run the same test directly: `cd apps/gateway && DB_PATH=/tmp/test-a2a-store.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/store/store.test.ts`
- Lint the admin UI: `cd apps/web && npm run lint`
- Build the admin UI: `cd apps/web && npm run build`

There is no repo-wide lint script. The checked-in test script currently covers gateway store and monitor-manager tests.

## High-level architecture

This repository is a Node.js gateway that connects messaging-channel plugins to A2A agent servers.

End-to-end flow:

1. A channel provider such as Feishu/Lark delivers inbound messages over the plugin's WebSocket monitor.
2. `apps/gateway/src/monitor-manager.ts` keeps one long-lived monitor per enabled `ChannelBinding.id`.
3. `packages/openclaw-compat/src/plugin-runtime.ts` implements the minimal OpenClaw plugin runtime surface that channel plugins actually use.
4. Instead of invoking an LLM pipeline, the runtime's reply dispatchers call an A2A server through `@agent-relay/agent-transport` and send the returned text back through the plugin dispatcher.
5. The gateway HTTP API in `apps/gateway/src/index.ts` manages channel bindings and agent configs, and creates/restarts/stops monitors when bindings change.
6. The Next.js admin UI in `apps/web` talks to the gateway `/api/*` endpoints; a legacy static UI may also be served by the gateway at `/`.

## Monorepo layout

- `apps/gateway/`: Hono HTTP server, monitor orchestration, OpenClaw runtime integration, and gateway API.
- `apps/echo-agent/`: standalone minimal A2A-compatible JSON-RPC echo agent for local end-to-end testing.
- `apps/web/`: Next.js 16 admin UI for channel and agent management.
- `packages/domain/`: DDD aggregates, domain events, snapshots, and repository ports.
- `packages/agent-transport/`: agent transport ports plus A2A/ACP client implementations used by the runtime bridge.
- `packages/openclaw-compat/`: OpenClaw plugin host/runtime compatibility layer.
- `packages/event-store/`: event-store port and domain-event publishing primitives.

## Main subsystems

### Gateway server

`apps/gateway/src/index.ts` is the main server. It exposes JSON APIs for:

- channel bindings under `/api/channels`
- agent configs under `/api/agents`

The server owns a single `MonitorManager` instance and uses it to keep channel monitors in sync with store state.

### Channel adapter lifecycle

The monitor lifecycle is intentionally split in layers:

- `packages/domain` defines the desired-state model as channel binding and agent aggregates.
- `apps/gateway/src/runtime/runtime-assignment-service.ts` owns assignment changes for bindings currently granted to this node.
- `apps/gateway/src/runtime/connection-manager.ts` is channel-agnostic connection lifecycle orchestration: start, restart, stop, and route replies through agent transports.
- `packages/openclaw-compat/src/plugin-host.ts` bridges registered OpenClaw channel plugins to gateway runtime connections.

To add a new channel, register its OpenClaw plugin in `apps/gateway/src/register-plugins.ts`. No per-channel package is needed.

### Plugin registration

`apps/gateway/src/register-plugins.ts` is the single place where OpenClaw channel plugins are loaded and registered with the `OpenClawPluginHost`. Adding support for a new channel means adding one `registerXxxPlugin(host)` call here.

### A2A bridge runtime

`packages/openclaw-compat/src/plugin-runtime.ts` is the core integration point. It provides a partial OpenClaw runtime with many stubbed capabilities, but the important behavior is in:

- `dispatchReplyFromConfig`
- `dispatchReplyWithBufferedBlockDispatcher`

Both functions extract inbound text from the channel context, resolve the bound agent URL from the store, call the remote A2A agent, and deliver the returned text as the final reply.

The runtime reuses selected helpers from `openclaw/plugin-sdk/*`, but most nonessential OpenClaw features are stubbed because this repo only needs enough runtime surface for channel-to-A2A forwarding.

### Store and configuration model

The gateway uses a SQLite-backed store by default. Important implications:

- `DB_PATH` controls the database file and defaults to `./agent-relay.db`.
- `npm run seed` writes the default echo agent at `ECHO_AGENT_URL` or `http://localhost:3001` and optional Feishu bootstrap binding.
- OpenClaw-compatible config is synthesized from runtime-owned bindings via `RuntimeOpenClawConfigProjection`.

The store is the source of truth for both:

- monitor reconciliation
- binding/account-to-agent routing through runtime desired-state projections

### Admin UI

`apps/web` is a Next.js 16 app for managing channels and agents. In development, it rewrites `/api/*` to the gateway so the browser can use same-origin API calls.

Before editing `apps/web`, read the local Next.js docs in `node_modules/next/dist/docs/` for the relevant API because this version has breaking changes and may differ from older Next.js conventions.

### Example A2A server

`apps/echo-agent/src/index.ts` is a standalone HTTP server implementing a minimal A2A-compatible JSON-RPC agent. It is useful for local end-to-end testing of the gateway without a real backend agent.

It exposes:

- `GET /.well-known/agent-card.json`
- `POST /` for JSON-RPC requests

## Repository-specific notes

- Feishu and Lark are treated as aliases; both are handled by the `@larksuite/openclaw-lark` plugin registered in `apps/gateway/src/register-plugins.ts`.
- Channel bindings persist `agentId`; the gateway resolves the effective target URL from the Agent config when building runtime/OpenClaw config or routing messages.
- All OpenClaw-compatible channel plugins should work without a dedicated wrapper package — registering them in `register-plugins.ts` is sufficient.
- Gateway environment variables include `PORT`, `DB_PATH`, `CORS_ORIGIN`, `ECHO_AGENT_URL`, and Feishu bootstrap credentials; see `.env.example` and `README.md` for details.
- Runtime boundary rule: `RuntimeAssignmentCoordinator` must not route binding reconciliation through `RelayRuntime`. Do not call `assignBinding`, `releaseBinding`, `listOwnedBindingIds`, or similar methods via the runtime facade from the coordinator. Reconcile logic must depend on a dedicated narrow boundary for binding ownership/assignment commands and queries, and `RelayRuntime` may consume that same lower-level service rather than acting as an extra hop.
