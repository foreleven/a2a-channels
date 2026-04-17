# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install dependencies: `npm install`
- Start the gateway server: `npm run gateway`
- Start the example echo agent: `npm run echo-agent`
- Start the gateway in the default dev mode: `npm run dev`
- Type-check the repo: `npx tsc --noEmit`

There is currently no dedicated lint or test script in `package.json`, and there are no test files checked into the repo.

## High-level architecture

This repository is a Node.js gateway that connects messaging-channel plugins to A2A agent servers.

End-to-end flow:

1. A channel provider such as Feishu/Lark delivers inbound messages over the plugin's WebSocket monitor.
2. `apps/gateway/src/monitor-manager.ts` keeps one long-lived monitor per `channelType:accountId`.
3. `packages/openclaw-compat/src/plugin-runtime.ts` implements the minimal OpenClaw plugin runtime surface that channel plugins actually use.
4. Instead of invoking an LLM pipeline, the runtime's reply dispatchers call an A2A server through `@a2a-channels/agent-transport` and send the returned text back through the plugin dispatcher.
5. The gateway HTTP API in `apps/gateway/src/index.ts` manages channel bindings and agent configs, and creates/restarts/stops monitors when bindings change.
6. `apps/gateway/web/index.html` is a single static admin UI served directly by the gateway; it uses the `/api/channels` and `/api/agents` endpoints with plain browser-side JavaScript.

## Main subsystems

### Gateway server

`apps/gateway/src/index.ts` is the main server. It serves the static web UI at `/` and exposes JSON APIs for:

- channel bindings under `/api/channels`
- agent configs under `/api/agents`

The server owns a single `MonitorManager` instance and uses it to keep channel monitors in sync with the current in-memory bindings.

### Channel adapter lifecycle

The monitor lifecycle is intentionally split in two layers:

- `packages/core/src/channel.ts` defines the `ChannelProvider` / `ChannelAccountRunner` contracts.
- `apps/gateway/src/monitor-manager.ts` is channel-agnostic lifecycle orchestration: start, restart, stop, and reconcile monitors against store state.
- `packages/openclaw-compat/src/channel-provider.ts` is the generic `OpenClawChannelProvider` that bridges any registered OpenClaw channel plugin to the `ChannelProvider` interface.

To add a new channel, register its OpenClaw plugin in `apps/gateway/src/register-plugins.ts`. No per-channel package is needed.

### Plugin registration

`apps/gateway/src/register-plugins.ts` is the single place where OpenClaw channel plugins are loaded and registered with the `OpenClawPluginHost`.  Adding support for a new channel means adding one `registerXxxPlugin(host)` call here.

### A2A bridge runtime

`packages/openclaw-compat/src/plugin-runtime.ts` is the core integration point. It provides a partial OpenClaw runtime with many stubbed capabilities, but the important behavior is in:

- `dispatchReplyFromConfig`
- `dispatchReplyWithBufferedBlockDispatcher`

Both functions extract inbound text from the channel context, resolve the bound agent URL from the store, call the remote A2A agent, and deliver the returned text as the final reply.

The runtime reuses selected helpers from `openclaw/plugin-sdk/*`, but most nonessential OpenClaw features are stubbed because this repo only needs enough runtime surface for channel-to-A2A forwarding.

### Store and configuration model

`apps/gateway/src/store/index.ts` is an in-memory store only. Important implications:

- channel bindings and agent configs are lost on process restart
- the gateway seeds a default echo agent at `http://localhost:3001`
- OpenClaw-compatible config is synthesized on demand from the current bindings via `buildOpenClawConfig()`

The store is the source of truth for both:

- monitor reconciliation
- account-to-agent routing (`getAgentUrlForAccount`)

### Example A2A server

`apps/echo-agent/src/index.ts` is a standalone HTTP server implementing a minimal A2A-compatible JSON-RPC agent. It is useful for local end-to-end testing of the gateway without a real backend agent.

It exposes:

- `GET /.well-known/agent-card.json`
- `POST /` for JSON-RPC requests

## Repository-specific notes

- Feishu and Lark are treated as aliases; both are handled by the `@larksuite/openclaw-lark` plugin registered in `apps/gateway/src/register-plugins.ts`.
- The web UI submits an `agentId`, but the backend persists and routes by `agentUrl`; the URL is the effective binding value.
- All OpenClaw-compatible channel plugins should work without a dedicated wrapper package — registering them in `register-plugins.ts` is sufficient.
