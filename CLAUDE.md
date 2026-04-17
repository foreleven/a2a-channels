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

This repository is a Bun-based gateway that connects messaging-channel plugins to A2A agent servers.

End-to-end flow:

1. A channel provider such as Feishu/Lark delivers inbound messages over the plugin's WebSocket monitor.
2. `src/gateway/monitor-manager.ts` keeps one long-lived monitor per `channelType:accountId` and injects a shared plugin runtime into the channel SDK.
3. `src/gateway/plugin-runtime.ts` implements the minimal OpenClaw plugin runtime surface that `@larksuite/openclaw-lark` actually uses.
4. Instead of invoking an LLM pipeline, the runtime's reply dispatchers call an A2A server through `@a2a-js/sdk/client` and send the returned text back through the plugin dispatcher.
5. The gateway HTTP API in `src/gateway/index.ts` manages channel bindings and agent configs, and creates/restarts/stops monitors when bindings change.
6. `src/web/index.html` is a single static admin UI served directly by the gateway; it uses the `/api/channels` and `/api/agents` endpoints with plain browser-side JavaScript.

## Main subsystems

### Gateway server

`src/gateway/index.ts` is the main Bun server. It serves the static web UI at `/` and exposes JSON APIs for:

- channel bindings under `/api/channels`
- agent configs under `/api/agents`

The server owns a single `MonitorManager` instance and uses it to keep channel monitors in sync with the current in-memory bindings.

### Channel adapter lifecycle

The monitor lifecycle is intentionally split in two layers:

- `src/gateway/channel-adapter.ts` defines the small adapter contract for any channel integration.
- `src/gateway/monitor-manager.ts` is channel-agnostic lifecycle orchestration: start, restart, stop, and reconcile monitors against store state.
- `src/gateway/feishu-monitor.ts` is the Feishu/Lark-specific adapter. It opens the provider monitor via `monitorFeishuProvider(...)` and injects the shared runtime into the Lark client internals.

If adding another channel, follow the existing pattern: implement `ChannelAdapter`, then register it in the `MonitorManager` constructor in `src/gateway/index.ts`.

### A2A bridge runtime

`src/gateway/plugin-runtime.ts` is the core integration point. It provides a partial OpenClaw runtime with many stubbed capabilities, but the important behavior is in:

- `dispatchReplyFromConfig`
- `dispatchReplyWithBufferedBlockDispatcher`

Both functions extract inbound text from the channel context, resolve the bound agent URL from the store, call the remote A2A agent, and deliver the returned text as the final reply.

The runtime reuses selected helpers from `openclaw/plugin-sdk/*`, but most nonessential OpenClaw features are stubbed because this repo only needs enough runtime surface for channel-to-A2A forwarding.

### Store and configuration model

`src/store/index.ts` is an in-memory store only. Important implications:

- channel bindings and agent configs are lost on process restart
- the gateway seeds a default echo agent at `http://localhost:3001`
- OpenClaw-compatible config is synthesized on demand from the current bindings via `buildOpenClawConfig()`

The store is the source of truth for both:

- monitor reconciliation
- account-to-agent routing (`getAgentUrlForAccount`)

### Example A2A server

`src/echo-agent/index.ts` is a standalone Bun HTTP server implementing a minimal A2A-compatible JSON-RPC agent. It is useful for local end-to-end testing of the gateway without a real backend agent.

It exposes:

- `GET /.well-known/agent-card.json`
- `POST /` for JSON-RPC requests

## Repository-specific notes

- Feishu and Lark are treated as aliases at the gateway layer; both are backed by the same Feishu adapter instance in `src/gateway/index.ts`.
- The web UI submits an `agentId`, but the backend persists and routes by `agentUrl`; the URL is the effective binding value.
- `src/gateway/openclaw-api.ts` is a minimal plugin API builder but is not currently wired into the main gateway path.
- The repo uses Bun at runtime, but dependency installation in the README is documented with `npm install`.
