# Channel Login SSE Design

## Goal

Unify Web channel authentication around each OpenClaw channel plugin's `auth.login` entry point, including Feishu/Lark, while preserving the existing QR start/wait endpoints for compatibility.

The new flow must support interactive login behavior that cannot fit into the current request/response QR wait API:

- long-running login sessions
- stdout/stderr progress output
- QR code text or URL emitted by plugins
- prompts that require stdin input, such as WeChat verification codes
- structured completion data for creating or updating channel bindings

## Current Problem

The current Web UI uses:

- `POST /api/channels/:channelType/auth/qr/start`
- `POST /api/channels/:channelType/auth/qr/wait`

This works only for simple QR flows. The WeChat plugin's complete path is `auth.login`; it prints the QR code, waits much longer than the UI timeout, may prompt for verification input through stdin, and persists login data after success. A Web request waiting for 30 seconds cannot represent that interaction.

Feishu is also not currently using the same path. `ChannelAuthService` special-cases Feishu by directly calling `@openclaw/feishu/src/app-registration.js`. That makes Feishu behave differently from other channels and duplicates part of the plugin setup surface.

## Design Summary

Add a generic channel login session system:

1. The Web UI starts a login session for a channel.
2. The gateway creates a managed child process for that session.
3. The child process loads the same registered channel plugin and invokes `channel.auth.login`.
4. The gateway captures stdout, stderr, lifecycle, and structured result events.
5. The gateway exposes those events through Server-Sent Events.
6. The Web UI sends user input back through a separate HTTP input endpoint when the plugin prompts.
7. On completion, the session exposes `accountId` and `channelConfig` for binding creation.

Existing QR endpoints remain available. The Web channel creation flow should prefer the new login session API for channels that support `auth.login`.

## Public HTTP Contract

### Start Login

`POST /api/channels/:channelType/auth/login/start`

Request:

```json
{
  "accountId": "default",
  "force": true,
  "verbose": false
}
```

Response:

```json
{
  "sessionId": "login_01HY...",
  "eventsUrl": "/api/channel-login-sessions/login_01HY.../events",
  "inputUrl": "/api/channel-login-sessions/login_01HY.../input",
  "cancelUrl": "/api/channel-login-sessions/login_01HY.../cancel"
}
```

The route validates the channel type through the existing plugin host alias resolution. If the resolved plugin has no `auth.login`, the route returns 404 with a clear unsupported-channel error.

### Stream Events

`GET /api/channel-login-sessions/:sessionId/events`

Response content type:

```http
text/event-stream; charset=utf-8
```

Events:

```text
event: started
data: {"sessionId":"login_01HY...","channelType":"wechat","accountId":"default","startedAt":"2026-05-04T...Z"}

event: output
data: {"stream":"stdout","text":"正在启动..."}

event: qr
data: {"text":"https://...","format":"url"}

event: prompt
data: {"kind":"text","message":"请输入验证码","sensitive":false}

event: result
data: {"connected":true,"accountId":"default","channelConfig":{},"message":"Login completed."}

event: exited
data: {"code":0,"signal":null}

event: error-state
data: {"message":"Login failed: ..."}
```

The stream first replays the current session snapshot so a browser refresh does not lose the latest state. After replay, it streams new events until the session reaches a terminal state or the client disconnects.

### Send Input

`POST /api/channel-login-sessions/:sessionId/input`

Request:

```json
{
  "text": "123456"
}
```

The gateway writes `text + "\n"` to the child process stdin. If the session is terminal or stdin is unavailable, the route returns 409.

### Cancel Login

`POST /api/channel-login-sessions/:sessionId/cancel`

The gateway terminates the child process and marks the session cancelled. The SSE stream receives:

```text
event: cancelled
data: {"message":"Login cancelled."}
```

## Backend Components

### `ChannelLoginService`

Application service used by HTTP routes. It owns input validation, channel support checks, and delegates session lifecycle to `ChannelLoginManager`.

Responsibilities:

- start a login session for a channel type and account id
- fetch a session for SSE streaming
- write input to a session
- cancel a session
- translate unsupported-channel and missing-session cases into application errors

### `ChannelLoginManager`

Runtime service that owns in-memory login sessions for the gateway process.

Responsibilities:

- allocate session ids
- enforce one active login per `channelType + accountId`
- keep a bounded event history per session for SSE replay
- expire terminal sessions after a short retention window
- close or kill active child processes on gateway shutdown if lifecycle hooks are added later

This is intentionally process-local. Login is an operator action from the admin UI, not a cluster-wide long-lived channel runtime. In cluster mode, the admin UI must call the gateway node that owns the HTTP session.

### `ChannelLoginSession`

OOP session object with explicit state:

- `pending`
- `running`
- `waiting-for-input`
- `completed`
- `failed`
- `cancelled`

Responsibilities:

- append typed events
- notify SSE subscribers
- expose current snapshot
- guard writes to stdin
- transition once to a terminal state

### `ChannelLoginProcessRunner`

Infrastructure adapter around `node:child_process`.

Responsibilities:

- spawn the child process with inherited project environment
- pipe stdout and stderr to the session
- write stdin from input requests
- terminate the process on cancellation
- report exit code and signal

The runner must not parse arbitrary human text as the source of truth for completion. Human output is for display. Structured completion comes from the child runner protocol.

### Login Child Entrypoint

Create a gateway-owned script, for example:

`apps/gateway/src/runtime/channel-login/login-child.ts`

The child process:

1. receives a JSON payload through environment or argv
2. builds the same OpenClaw-compatible runtime config projection needed for login
3. resolves the channel plugin
4. invokes `channel.auth.login({ cfg, accountId, verbose, runtime })`
5. emits structured protocol lines to stdout with a reserved prefix

Protocol line example:

```text
__A2A_CHANNEL_LOGIN_EVENT__{"type":"result","connected":true,"accountId":"default","channelConfig":{}}
```

The parent strips these protocol lines from user-visible output and records them as typed events.

## Feishu Behavior

Feishu should use the same login session path as other channels.

The Feishu plugin's `auth.login` currently uses `runFeishuLogin` and then writes config through `replaceConfigFile`. The gateway child process should prevent the gateway runtime from depending on that global config mutation as the only result. Instead, the child must emit a structured result derived from the before/after OpenClaw config:

- compare the original projected config with the config produced by Feishu login
- extract the resolved Feishu account config
- return `accountId: "default"` unless a named account is explicitly selected later
- return `channelConfig` with the fields needed by `ChannelBindingService`

The initial implementation can preserve the current Web security default:

```json
{
  "appId": "...",
  "appSecret": "...",
  "allowFrom": ["ou_..."]
}
```

If Feishu login also collects `domain`, `connectionMode`, `dmPolicy`, or `groupPolicy`, those fields should be preserved in `channelConfig` because the runtime projection can pass them back to the plugin.

## WeChat Behavior

WeChat should run through the plugin's `auth.login`.

Expected UI behavior:

- output event shows startup text
- QR event or output event shows the QR code information
- the session remains open up to the plugin's login timeout
- if the plugin asks for verification code, the UI shows an input field
- successful login returns the normalized `accountId`
- `channelConfig` may be `{}` because the plugin persists token material through its own account store

The initial QR event extraction can be conservative:

- if the child emits a structured QR event, render it as QR
- otherwise show stdout verbatim in a terminal-style panel

Do not rely on parsing ANSI QR art to decide login success.

## Frontend Components

The existing new channel page should replace the QR polling panel with a login session panel for login-capable channels.

Client behavior:

- call `startChannelLogin`
- open `EventSource` to `eventsUrl`
- append output lines to a log panel
- render QR URL/data when a `qr` event arrives
- show a text input when a `prompt` event arrives
- on `result`, fill form fields from `accountId` and `channelConfig`
- on terminal error, show the error and allow restart
- on navigation away, close EventSource and call cancel for non-terminal sessions

The UI should not block on a single fetch timeout. Login progress comes from SSE.

Before editing `apps/web`, read the relevant local Next.js docs under `node_modules/next/dist/docs/`, per repository instructions.

## Error Handling

Unsupported channel:

- `POST /auth/login/start` returns 404
- UI falls back to manual config if available

Duplicate active session:

- return the existing session if it belongs to the same channel/account and is still running, or return 409 with the existing session id

Child startup failure:

- session transitions to `failed`
- SSE emits `error-state`

Child non-zero exit:

- if no structured success result was emitted, session transitions to `failed`
- include stderr summary in the failure message

SSE disconnect:

- does not cancel the child process
- a reconnect replays the session snapshot

Input after terminal state:

- return 409

Gateway restart:

- active sessions are lost
- UI should show a disconnected session and allow starting a new login

## Testing Plan

Backend tests:

- `ChannelLoginManager` creates sessions and enforces duplicate policy
- session event replay returns previous events in order
- input writes to the process runner
- cancel transitions state and terminates runner
- child result protocol line creates a typed `result` event
- non-zero child exit without result fails the session
- login start route returns 404 for plugin without `auth.login`
- login start route returns session URLs for supported channels
- SSE route emits replayed events in EventSource format

Frontend tests:

- API client exposes `startChannelLogin`, `sendChannelLoginInput`, and `cancelChannelLogin`
- EventSource wrapper parses `output`, `prompt`, `result`, and `error-state`
- new channel page fills `accountId` and `channelConfig` from a result event
- timeout-based QR wait is no longer required for WeChat/Feishu login-capable flows

Verification commands:

```bash
npm run typecheck
npm test
cd apps/web && npx tsc --noEmit
cd apps/web && npm run lint
```

## Non-Goals

- Do not remove `/auth/qr/start` or `/auth/qr/wait` in this change.
- Do not introduce cluster-wide login session persistence.
- Do not store secret token material in SSE events.
- Do not parse human stdout as the authoritative success signal.
- Do not bypass TypeScript with `as unknown as` or equivalent double casts.

## Open Implementation Notes

The exact extraction logic from Feishu's post-login config should be implemented in a small, tested adapter rather than inside HTTP routes.

The child process command should use the repo's existing TypeScript execution path, such as `node --import tsx/esm`, to avoid adding a build step for local development.

The SSE implementation can follow existing Web route patterns in:

- `apps/web/src/app/api/runtime/channel-statuses/events/route.ts`
- `apps/web/src/lib/channel-status.ts`

The gateway-side SSE route should live in the gateway HTTP layer, not only in the Next.js app, because login state is owned by the gateway process.
