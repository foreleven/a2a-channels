# a2a-channels

A **Bun.js gateway** that bridges messaging platform channel plugins with A2A (Agent-to-Agent) agent servers.

## Architecture

```
Feishu/Lark ──WebSocket──▶ Gateway ──A2A JSON-RPC──▶ Agent Server
                           (port 8080)              (port 3001)
```

- **Gateway** (`src/gateway/`) – Bun HTTP server + OpenClaw plugin runtime + in-memory channel/agent store
- **Echo Agent** (`src/echo-agent/`) – Example A2A-compliant agent that echoes messages back
- **Web UI** (`src/web/`) – Simple channel & agent management interface

## Quick Start

```bash
# Install dependencies
npm install

# Start the echo agent (terminal 1)
bun run echo-agent

# Start the gateway (terminal 2)
bun run gateway
```

Open http://localhost:8080 in your browser.

## Usage

### 1. Register an Agent

Go to the **Agents** tab and register an A2A agent server (e.g. `http://localhost:3001`).

### 2. Register a Feishu Channel

Go to the **Channels** tab, fill in your Feishu app credentials, and select an agent.

The gateway automatically starts a Feishu WebSocket connection for each enabled channel binding.

### 3. Send a Message

Once a channel is registered, any message sent to your Feishu bot will be forwarded to the bound A2A agent. The agent's reply will be sent back to the user in Feishu.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | Gateway HTTP port |
| `ECHO_AGENT_PORT` | `3001` | Echo agent port |
| `ECHO_AGENT_URL` | `http://localhost:3001` | Echo agent public URL (in agent card) |

## Implementing a Custom Agent

Any A2A-compliant server can be used. The gateway uses JSON-RPC `message/send`:

```typescript
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';

class MyExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus) {
    const text = ctx.userMessage.parts[0].text;
    bus.publish({ kind: 'message', role: 'agent', parts: [{ kind: 'text', text: `Hello: ${text}` }] });
    bus.finished();
  }
}
```

## How It Works

1. The gateway loads `@larksuite/openclaw-lark` and injects a custom `PluginRuntime`
2. Instead of calling an LLM, the runtime's `dispatchReplyFromConfig` forwards the message to the configured A2A agent
3. The A2A response is delivered back to Feishu via the plugin's built-in message dispatcher
