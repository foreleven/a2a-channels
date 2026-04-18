# a2a-channels

A **Node.js gateway** that connects messaging-channel plugins (Feishu / Lark) to [A2A](https://github.com/google/a2a) agent servers.

```
Feishu/Lark ──WebSocket──▶ Gateway ──A2A JSON-RPC──▶ Agent Server
                           (port 7890)               (any URL)
```

## Monorepo layout

```
apps/
  gateway/      Hono HTTP server + OpenClaw runtime + SQLite store
  echo-agent/   Example A2A echo agent (mirrors messages back)
  web/          Next.js 16 admin UI (channel & agent management)
packages/
  core/              Shared domain types and store interfaces
  agent-transport/   A2A JSON-RPC client
  openclaw-compat/   OpenClaw plugin runtime bridge
  store-sqlite/      SQLite-backed ChannelStore & AgentStore
```

## Quick start

**Prerequisites:** Node.js ≥ 20, pnpm ≥ 10

```bash
# Install dependencies
pnpm install

# Terminal 1 – echo agent (port 3001)
npm run echo-agent

# Terminal 2 – gateway (port 7890)
npm run gateway

# Terminal 3 – admin UI (port 3000)
npm run web
```

Open **http://localhost:3000** for the admin UI, or **http://localhost:7890** for the legacy static UI.

## Environment variables

### Gateway (`apps/gateway`)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7890` | Gateway HTTP port |
| `DB_PATH` | `./a2a-channels.db` | SQLite database file path |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed CORS origin for `/api/*` |
| `ECHO_AGENT_URL` | `http://localhost:3001` | Default agent URL (seeded on first launch) |
| `FEISHU_APP_ID` | – | Bootstrap a Feishu binding on startup |
| `FEISHU_APP_SECRET` | – | Bootstrap a Feishu binding on startup |
| `FEISHU_ACCOUNT_ID` | `default` | Account ID for the bootstrap binding |
| `FEISHU_VERIFICATION_TOKEN` | – | Feishu event verification token |
| `FEISHU_ENCRYPT_KEY` | – | Feishu message encrypt key |

Copy `.env.example` → `.env` and fill in the values, then `npm run gateway` picks them up automatically.

### Admin UI (`apps/web`)

| Variable | Default | Description |
|---|---|---|
| `GATEWAY_URL` | `http://localhost:7890` | Gateway base URL (server-side rewrite in dev) |
| `NEXT_PUBLIC_GATEWAY_URL` | _(empty)_ | Gateway base URL for production (browser-side) |

Copy `apps/web/.env.local.example` → `apps/web/.env.local` if you need to override these.

## REST API

The gateway exposes a JSON REST API used by the admin UI. All endpoints are under `/api/`.

### Channel bindings

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/channels` | List all channel bindings |
| `GET` | `/api/channels/:id` | Get a single binding |
| `POST` | `/api/channels` | Create a binding |
| `PATCH` | `/api/channels/:id` | Update a binding |
| `DELETE` | `/api/channels/:id` | Delete a binding |

**Create / update body**

```json
{
  "name": "My Feishu Bot",
  "channelType": "feishu",
  "accountId": "default",
  "agentUrl": "http://localhost:3001/a2a/jsonrpc",
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

### Agent configs

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/agents` | List all agents |
| `GET` | `/api/agents/:id` | Get a single agent |
| `POST` | `/api/agents` | Create an agent |
| `PATCH` | `/api/agents/:id` | Update an agent |
| `DELETE` | `/api/agents/:id` | Delete an agent |

**Create / update body**

```json
{
  "name": "My Agent",
  "url": "http://my-agent.example.com/a2a/jsonrpc",
  "description": "Optional description"
}
```

## Implementing a custom A2A agent

Any [A2A-compliant](https://github.com/google/a2a) server works. The gateway sends a `message/send` JSON-RPC call and reads the first text part of the response. Here is a minimal example using `@a2a-js/sdk`:

```typescript
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import type { AgentExecutor, RequestContext, ExecutionEventBus } from '@a2a-js/sdk/server';

class MyExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus) {
    const text = ctx.userMessage.parts
      .filter((p) => p.kind === 'text')
      .map((p) => p.text)
      .join('\n');

    bus.publish({
      kind: 'message',
      role: 'agent',
      parts: [{ kind: 'text', text: `Hello: ${text}` }],
    });
    bus.finished();
  }
  cancelTask = async () => {};
}
```

Register the agent URL in the admin UI (or via `POST /api/agents`), then bind it to a channel.

## How it works

1. **Channel binding** – each binding stores a channel type, credentials (`channelConfig`), an `accountId`, and the `agentUrl` to forward messages to. All bindings live in a single SQLite table (`channel_bindings`).
2. **Monitor lifecycle** – `MonitorManager` keeps one long-lived WebSocket monitor per `channelType:accountId` pair, started/stopped whenever bindings change.
3. **Message flow** – inbound messages hit the OpenClaw plugin runtime, which resolves the agent URL from the store and calls the A2A server via `@a2a-channels/agent-transport`. The reply is sent back through the plugin dispatcher.
4. **Admin UI** – the Next.js app at `apps/web` calls the gateway's `/api/*` endpoints directly. In development, Next.js rewrites `/api/*` to the gateway so no CORS configuration is needed.

## Development

```bash
# Type-check the entire monorepo (excludes apps/web which has its own tsconfig)
npm run typecheck

# Type-check the admin UI
cd apps/web && npx tsc --noEmit
```

The project has no test suite yet. End-to-end testing can be done by running the gateway and echo agent together and sending messages through a connected Feishu bot.
