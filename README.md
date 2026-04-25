# a2a-channels

**a2a-channels turns the OpenClaw channel plugin ecosystem into an A2A gateway.**

OpenClaw already has channel plugins for messaging platforms. This project hosts those plugins, keeps their account monitors running, and forwards inbound messages to any A2A-compatible agent server.

```text
OpenClaw channel plugin
  Feishu / Lark today, more channels by registration
          |
          | provider WebSocket / webhook runtime
          v
    a2a-channels Gateway
          |
          | A2A JSON-RPC
          v
      Agent Server
```

The goal is to avoid writing one gateway per channel. A channel integration should live in the OpenClaw plugin ecosystem; this gateway supplies the runtime, configuration store, lifecycle management, admin API, and A2A transport.

## Why This Exists

Most agent projects solve the same channel problem repeatedly:

- connect to Feishu, Lark, Slack, Discord, or another messaging platform
- keep a long-lived account connection alive
- normalize inbound messages
- call an agent backend
- send the answer back through the original channel

OpenClaw plugins already model the channel side of that work. `a2a-channels` focuses on the other half: binding those plugins to remote agents through A2A.

## OpenClaw Plugin Model

The gateway is intentionally channel-agnostic.

- `packages/openclaw-compat` provides the OpenClaw-compatible host and runtime surface used by channel plugins.
- `apps/gateway/src/register-plugins.ts` is the only place where channel plugins are registered.
- `apps/gateway` owns account lifecycle, monitor reconciliation, REST APIs, SQLite persistence, and routing.
- `packages/agent-transport` calls the bound agent with A2A JSON-RPC.

Today the repo registers `@larksuite/openclaw-lark`, with Feishu and Lark treated as aliases. To add another OpenClaw channel plugin, install it and register it in `apps/gateway/src/register-plugins.ts`:

```typescript
import someChannelPlugin from "@example/openclaw-some-channel";
import type { OpenClawPluginHost } from "@a2a-channels/openclaw-compat";

export function registerSomeChannelPlugin(host: OpenClawPluginHost): void {
  host.registerPlugin((api) => someChannelPlugin.default.register(api));
}

export function registerAllPlugins(host: OpenClawPluginHost): void {
  registerLarkPlugin(host);
  registerSomeChannelPlugin(host);
}
```

No per-channel wrapper package is required when the plugin conforms to the OpenClaw channel plugin API.

## Message Flow

1. A platform account receives a message through an OpenClaw channel plugin.
2. The gateway runtime receives the plugin's reply dispatch event.
3. The gateway resolves the enabled `ChannelBinding` for the channel account.
4. The binding points to an `AgentConfig`, whose URL identifies the target A2A server.
5. `@a2a-channels/agent-transport` sends a `message/send` JSON-RPC request.
6. The first text reply from the agent is sent back through the same OpenClaw plugin dispatcher.

```text
Feishu/Lark account
    -> @larksuite/openclaw-lark
    -> OpenClawPluginRuntime
    -> ChannelBinding(agentId)
    -> A2ATransport
    -> remote agent
    -> plugin dispatcher reply
```

## Monorepo Layout

```text
apps/
  gateway/      Hono HTTP server, OpenClaw host, runtime orchestration, SQLite store
  echo-agent/   Minimal A2A-compatible echo agent for local testing
  web/          Next.js 16 admin UI for channels and agents
packages/
  domain/            DDD aggregates, domain events, snapshots, repository ports
  event-store/       Event-store port and domain-event publishing primitives
  agent-transport/   Agent transport ports plus A2A / ACP clients
  openclaw-compat/   OpenClaw plugin host/runtime compatibility layer
```

## Quick Start

Prerequisites: Node.js 20 or newer, pnpm 10.32.0 or compatible.

```bash
pnpm install

# Terminal 1: example A2A agent on port 3001
pnpm echo-agent

# Terminal 2: gateway API on port 7890
pnpm gateway

# Terminal 3: admin UI on port 3000
pnpm web
```

Open the admin UI at `http://localhost:3000`.

Optional seed data:

```bash
pnpm seed
```

The seed command writes the default echo agent at `ECHO_AGENT_URL` or `http://localhost:3001`, plus optional Feishu bootstrap binding data when Feishu credentials are present.

## Configuration

Create `.env` at the repo root when you need to override gateway defaults.

| Variable | Default | Description |
|---|---:|---|
| `PORT` | `7890` | Gateway HTTP port |
| `DB_PATH` | `./db/a2a-channels.db` | SQLite database path used by Makefile-backed commands |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed CORS origin for `/api/*` |
| `ECHO_AGENT_URL` | `http://localhost:3001` | Default agent URL used by `pnpm seed` |
| `FEISHU_APP_ID` | - | Feishu/Lark app ID used by the bootstrap binding |
| `FEISHU_APP_SECRET` | - | Feishu/Lark app secret |
| `FEISHU_ACCOUNT_ID` | `default` | Account ID for the bootstrap binding |
| `FEISHU_VERIFICATION_TOKEN` | - | Feishu event verification token |
| `FEISHU_ENCRYPT_KEY` | - | Feishu message encrypt key |

For the admin UI, create `apps/web/.env.local` when you need to override the gateway URL.

| Variable | Default | Description |
|---|---:|---|
| `GATEWAY_URL` | `http://localhost:7890` | Gateway base URL for the Next.js server-side rewrite in dev |
| `NEXT_PUBLIC_GATEWAY_URL` | empty | Gateway base URL for browser-side production calls |

## REST API

The admin UI uses the gateway JSON API under `/api/*`.

### Channel Bindings

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/channels` | List channel bindings |
| `GET` | `/api/channels/:id` | Get one channel binding |
| `POST` | `/api/channels` | Create a channel binding |
| `PATCH` | `/api/channels/:id` | Update a channel binding |
| `DELETE` | `/api/channels/:id` | Delete a channel binding |

```json
{
  "name": "Feishu Bot",
  "channelType": "feishu",
  "accountId": "default",
  "agentId": "agent-config-id",
  "enabled": true,
  "channelConfig": {
    "appId": "cli_xxxx",
    "appSecret": "...",
    "verificationToken": "...",
    "encryptKey": "...",
    "allowFrom": ["*"]
  }
}
```

`channelType` must match a registered OpenClaw channel id or alias. `channelConfig` is passed through to the plugin account startup hook, so its shape is channel-specific.

### Agent Configs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents` | List agent configs |
| `GET` | `/api/agents/:id` | Get one agent config |
| `POST` | `/api/agents` | Create an agent config |
| `PATCH` | `/api/agents/:id` | Update an agent config |
| `DELETE` | `/api/agents/:id` | Delete an agent config |

```json
{
  "name": "My Agent",
  "url": "http://my-agent.example.com/a2a/jsonrpc",
  "description": "Optional description"
}
```

## Implementing an A2A Agent

Any A2A-compatible server can sit behind a channel binding. The gateway sends `message/send` and reads the first text part from the agent response.

Minimal `@a2a-js/sdk` executor:

```typescript
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from "@a2a-js/sdk/server";

class MyExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus) {
    const text = ctx.userMessage.parts
      .filter((part) => part.kind === "text")
      .map((part) => part.text)
      .join("\n");

    bus.publish({
      kind: "message",
      role: "agent",
      parts: [{ kind: "text", text: `Hello: ${text}` }],
    });
    bus.finished();
  }

  cancelTask = async () => {};
}
```

Register the agent URL in the admin UI or through `POST /api/agents`, then create a channel binding that points to that agent.

## Development

```bash
# Type-check the non-web TypeScript project
pnpm typecheck

# Type-check the admin UI
cd apps/web && npx tsc --noEmit

# Run gateway tests
pnpm test

# Build the admin UI
cd apps/web && pnpm build
```

There is no repo-wide lint script. The checked-in test script covers gateway store and monitor-manager tests.

## Architecture Notes

- The store is the source of truth for channel bindings and agent configs.
- `RuntimeAssignmentCoordinator` grants enabled bindings to the local runtime.
- `ConnectionManager` starts, restarts, and stops plugin accounts through `OpenClawPluginHost`.
- `RuntimeOpenClawConfigProjection` builds OpenClaw-compatible config from runtime-owned bindings.
- `OpenClawPluginRuntime` implements the subset of OpenClaw runtime behavior needed for channel-to-A2A forwarding.
- `RelayRuntime` assembles the runtime and consumes lower-level assignment services, but assignment reconciliation must not route through the runtime facade.

## Current Channel Support

The active channel plugin is `@larksuite/openclaw-lark`.

- `feishu` and `lark` are treated as aliases.
- Additional OpenClaw-compatible channel plugins should be added by registration, not by building gateway-specific channel packages.
- Channel-specific credential fields belong in `channelConfig`; agent routing stays in `agentId`.
