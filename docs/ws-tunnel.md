# ACP Remote (`ws-tunnel`) Agent Protocol & relay CLI

ACP Remote is the user-facing name for the `ws-tunnel` protocol. It lets an agent that cannot accept inbound TCP connections (e.g. a developer laptop behind NAT) connect _outward_ to the gateway instead. The relay CLI opens a persistent authenticated WebSocket to the gateway; the gateway then routes A2A JSON-RPC 2.0 frames through that tunnel rather than making a direct HTTP call to the agent.

```text
Channel user message
  -> AgentRelay gateway
  -> WsTunnelConnectionRegistry.send()    (gateway side)
       -> WebSocket frame to relay CLI
  -> WsTunnelClient.handleMessage()       (relay CLI side)
  -> ACPRemoteExecutor.execute()
       -> ACP session/prompt over executor stdio
  -> JSON-RPC response frame back over WebSocket
  -> channel reply
```

---

## Gateway side

### WsTunnelConnectionRegistry

`apps/gateway/src/runtime/ws-tunnel-registry.ts`

The registry holds one live WebSocket per `agentId` and correlates pending requests by JSON-RPC `id`.

**Key behaviour:**

| Scenario | Result |
|---|---|
| New connection for `agentId` that already has one | Previous connection is terminated; all its pending requests are rejected |
| Frame sent to an `agentId` with no live connection | `send()` throws immediately |
| Frame missing a non-empty string `id` | `send()` throws with a correlation-error message |
| Response arrives matching a pending `id` | Promise resolved with the raw JSON-RPC frame |
| Response contains an `"error"` key | Promise rejected with the agent error message |
| Request timeout expires | Promise rejected; pending entry removed |
| Gateway shutdown (`stop()`) | All connections terminated; all pending requests rejected |

The registry implements `ServiceContribution` so `GatewayServer` starts and stops it as part of the standard DI service lifecycle.

### WsTunnelRouteHandler

`apps/gateway/src/runtime/ws-tunnel-route-handler.ts`

Handles `GET /ws/a2a/:agentId` HTTP → WebSocket upgrade requests.

1. Matches the path against `/ws/a2a/:agentId`.  Returns `false` (unhandled) for all other upgrade paths — the caller destroys the socket.
2. Authenticates the `Authorization: Bearer <relayToken>` header against the stored `relayToken` for that agent.
3. Rejects with HTTP 401 when the token is missing or wrong; 404 when the agent does not exist or is not an ACP Remote (`ws-tunnel`) agent.
4. On success, promotes the raw TCP socket to a WebSocket and calls `WsTunnelConnectionRegistry.register()`.

### New gateway API endpoints

#### `GET /api/agents/:id/runner-config`

**Authentication:** relay token (Bearer), not JWT.  This endpoint is exempt from the standard JWT middleware so the relay CLI can bootstrap without an admin account.

**Response:**

```json
{
  "agentId": "agent-uuid",
  "name": "My Claude Agent",
  "gatewayWsUrl": "wss://gateway.example.com/ws/a2a/agent-uuid",
  "executor": {
    "type": "claude-code",
    "command": "claude",
    "args": ["--experimental-acp"],
    "permission": "reject_once",
    "timeoutMs": 120000
  }
}
```

`gatewayWsUrl` is derived by swapping the gateway HTTP URL protocol (`http` → `ws`, `https` → `wss`) and appending `/ws/a2a/<agentId>`.

#### `POST /api/agents/:id/regenerate-token`

**Authentication:** standard JWT.

Rotates the `relayToken` for the agent and returns the new token.  The old token is invalidated immediately; any relay CLI using the old token will be disconnected on the next ping cycle.

**Response:**

```json
{
  "relayToken": "<new-token>"
}
```

### Agent registration and token ownership

When an ACP Remote (`ws-tunnel`) agent is created via `POST /api/agents`, the gateway:

1. Always generates the `relayToken` server-side using `crypto.randomBytes`.  Any `relayToken` value in the request body is rejected (the schema does not accept that field).
2. Returns the full agent snapshot (including `relayToken`) only in the `runner-config` and `regenerate-token` responses.
3. Strips `relayToken` from `GET /api/agents` and `GET /api/agents/:id` responses so the credential is not exposed through general listing endpoints.

**Creating an ACP Remote agent:**

```json
POST /api/agents
{
  "name": "my-claude-agent",
  "protocol": "ws-tunnel",
  "config": {
    "transport": "ws-tunnel",
    "executor": {
      "type": "claude-code",
      "command": "claude",
      "args": ["--experimental-acp"],
      "timeoutMs": 120000
    }
  }
}
```

After creation, retrieve the token once via `runner-config` and store it securely.

---

## relay CLI (`apps/relay`)

### Installation and execution

The relay CLI is not published to npm.  In the monorepo you run it via:

```bash
# Ensure dependencies are installed first
pnpm install

# Or start directly with node/tsx
node --import tsx/esm apps/relay/src/index.ts serve <agent-id>
```

When installed as a package, the `relay` binary uses `apps/relay/bin/relay.js` — a plain JavaScript launcher that registers the tsx ESM loader before importing the TypeScript entry point.

### Environment variables

| Variable | Description |
|---|---|
| `RELAY_GATEWAY_URL` | Gateway base URL (default: `http://localhost:7890`) |
| `RELAY_TOKEN` | Relay token for this agent (no default; required) |
### `relay serve <agent-id>`

Fetches the runner config from the gateway, creates the configured ACP stdio executor, and opens a persistent WebSocket tunnel. Incoming `message/send` A2A JSON-RPC frames are converted to ACP `session/prompt` requests; responses are sent back over the same WebSocket.

```bash
relay serve <agent-id> \
  [--gateway-url <url>] \
  [--relay-token <token>]
```

**Reconnection behaviour:** The client reconnects automatically after disconnection with exponential back-off (1 s initial, 2× multiplier, 60 s cap).  Press `Ctrl+C` or send `SIGTERM` for a clean shutdown.

### `relay exec <agent-id> <message>`

Runs a single message through the local executor without opening a WebSocket connection.  Useful for testing the executor configuration in isolation.

```bash
relay exec <agent-id> "What is 2 + 2?" \
  [--gateway-url <url>] \
  [--relay-token <token>]
```

Output is written to stdout.

### ACP executors

The relay CLI supports ACP Remote executor configs with `type: "claude-code"` or `type: "codex"`. Both are launched as ACP stdio processes from the command stored in the remote agent config.

| Config field | Meaning |
|---|---|
| `type` | `claude-code` or `codex` |
| `command` | Executable started by the relay CLI |
| `args` | Arguments passed without shell parsing |
| `cwd` | Optional working directory |
| `permission` | ACP permission fallback such as `reject_once` |
| `timeoutMs` | ACP request timeout |

Example Codex executor:

```json
{
  "type": "codex",
  "command": "npx",
  "args": ["@zed-industries/codex-acp"],
  "permission": "reject_once"
}
```

The child process must speak Agent Client Protocol over stdio. If it exits or fails an ACP request, the relay returns an error response to the gateway.

---

## End-to-end setup

### 1. Create an ACP Remote agent in the gateway

```bash
curl -X POST http://localhost:7890/api/agents \
  -H "Content-Type: application/json" \
  -H "Cookie: a2a_auth_token=<jwt>" \
  -d '{
    "name": "my-claude-agent",
    "protocol": "ws-tunnel",
    "config": {
      "transport": "ws-tunnel",
      "executor": {
        "type": "claude-code",
        "command": "claude",
        "args": ["--experimental-acp"]
      }
    }
  }'
# → { "id": "agent-uuid", ... }
```

### 2. Retrieve the relay token

```bash
curl http://localhost:7890/api/agents/agent-uuid/runner-config \
  -H "Authorization: Bearer <relay-token-from-creation-response>"
```

> The relay token is only returned during the agent creation (`POST /api/agents`) response and through `runner-config`/`regenerate-token`.  Copy it immediately; it is redacted from general listing endpoints.

### 3. Bind a channel to the ACP Remote agent

Use the admin UI or `POST /api/channels` with `"agentId": "agent-uuid"` as for any other protocol.

### 4. Start the relay CLI on the agent host

```bash
export RELAY_TOKEN="<relay-token>"
relay serve agent-uuid --gateway-url https://gateway.example.com
# [relay] Fetching runner config from https://gateway.example.com …
# [relay] Agent: my-claude-agent (agent-uuid) | executor: claude-code
# [relay] Connected to gateway at wss://gateway.example.com/ws/a2a/agent-uuid
# [relay] Serving – press Ctrl+C to stop
```

### 5. Rotate the relay token (optional)

```bash
curl -X POST http://localhost:7890/api/agents/agent-uuid/regenerate-token \
  -H "Cookie: a2a_auth_token=<jwt>"
# → { "relayToken": "<new-token>" }
```

After rotation, restart the relay CLI with the new token.  The old relay connection is closed automatically when it next sends a frame.

---

## Security notes

- The relay token is generated with `crypto.randomBytes(32)` encoded as hex (64-character string).  Clients cannot supply or influence the token value.
- The token is transmitted in the `Authorization: Bearer` header.  Use TLS (`wss://`, `https://`) in production.
- Only `runner-config` and `regenerate-token` return the token; the general agent listing and get-by-id endpoints redact it.
- Each `agentId` supports at most one live relay connection.  A new connection from the same agent replaces the old one.
- The gateway enforces a `MAX_PENDING = 100` limit on concurrent in-flight requests per connection to prevent resource exhaustion.
