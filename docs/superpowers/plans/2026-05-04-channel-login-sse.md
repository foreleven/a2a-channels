# Channel Login SSE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a unified Web channel login flow that runs plugin `auth.login` in a child process, streams stdout and structured state over SSE, accepts stdin input, and supports Feishu through the same path while keeping existing QR endpoints.

**Architecture:** Add a gateway-owned login session subsystem under `apps/gateway/src/runtime/channel-login/`, expose it through application and HTTP routes, and add a Web client/EventSource wrapper that replaces QR polling for login-capable channels. Keep human terminal output separate from structured child-process protocol events so success is never inferred from stdout text.

**Tech Stack:** Node.js child processes, Hono, Inversify, TypeScript, OpenClaw plugin host/runtime, Next.js App Router client components, browser `EventSource`, `node:test`.

---

## File Structure

- Modify: `packages/openclaw-compat/src/plugin-host.ts`
  - Add a typed `runChannelLogin` support surface and a `hasChannelLogin` query that resolve aliases the same way QR login does.
- Test: `packages/openclaw-compat/src/plugin-host.test.ts`
  - Cover alias resolution and unsupported login behavior.
- Create: `apps/gateway/src/runtime/channel-login/types.ts`
  - Define session state, event DTOs, runner request/result contracts, and protocol prefix.
- Create: `apps/gateway/src/runtime/channel-login/session.ts`
  - Implement `ChannelLoginSession`, event history, subscribers, terminal-state guards, and input delegation.
- Create: `apps/gateway/src/runtime/channel-login/process-runner.ts`
  - Implement `ChannelLoginProcessRunner`, protocol-line parsing, stdout/stderr forwarding, stdin writes, cancellation.
- Create: `apps/gateway/src/runtime/channel-login/manager.ts`
  - Implement `ChannelLoginManager`, duplicate active session policy, session lookup, retention cleanup.
- Create: `apps/gateway/src/runtime/channel-login/login-child.ts`
  - Child process entrypoint that resolves the plugin and invokes `auth.login`.
- Create: `apps/gateway/src/runtime/channel-login/feishu-config-result.ts`
  - Extract Feishu `channelConfig` from before/after OpenClaw-compatible config snapshots.
- Create: `apps/gateway/src/runtime/channel-login/*.test.ts`
  - Focused tests for session, manager, process runner, protocol parsing, and Feishu config extraction.
- Create: `apps/gateway/src/application/channel-login-service.ts`
  - Application boundary used by HTTP routes.
- Create: `apps/gateway/src/application/channel-login-service.test.ts`
  - Cover unsupported channel, start, input, cancel, and missing session translation.
- Modify: `apps/gateway/src/bootstrap/container.ts`
  - Bind login service, manager, runner, and plugin-host dependency.
- Modify: `apps/gateway/src/http/schemas/request-schemas.ts`
  - Add `startChannelLoginBodySchema` and `channelLoginInputBodySchema`.
- Create: `apps/gateway/src/http/routes/channel-login.ts`
  - Add start/input/cancel/events routes.
- Modify: `apps/gateway/src/http/app.ts`
  - Register `ChannelLoginRoutes`.
- Test: `apps/gateway/src/http/app.test.ts`
  - Cover route wiring and SSE response format.
- Modify: `apps/web/src/lib/api.ts`
  - Add typed login session HTTP client methods.
- Create: `apps/web/src/lib/channel-login.ts`
  - Add EventSource wrapper and event parsing.
- Test: `apps/web/src/lib/channel-login.test.ts`
  - Cover event parsing and callback dispatch.
- Modify: `apps/web/src/app/channels/new/page.tsx`
  - Prefer login session UI for WeChat and Feishu; keep manual form and existing QR fallback.
- Modify: `apps/web/src/lib/channel-binding-form.ts`
  - Add `supportsLogin` metadata while preserving `supportsQr`.
- Test: `apps/web/src/lib/channel-binding-form.test.ts`
  - Cover login support metadata.

## Task 1: Plugin Host Login Surface

**Files:**
- Modify: `packages/openclaw-compat/src/plugin-host.ts`
- Create: `packages/openclaw-compat/src/plugin-host.test.ts`

- [ ] **Step 1: Write the failing plugin host tests**

Create `packages/openclaw-compat/src/plugin-host.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { OpenClawPluginHost, OpenClawPluginRuntime } from "./index.js";

function createHost() {
  const runtime = new OpenClawPluginRuntime({
    config: {
      loadConfig: () => ({ channels: {} }),
      writeConfigFile: async () => {},
    },
  });
  return new OpenClawPluginHost(runtime);
}

describe("OpenClawPluginHost channel login", () => {
  test("runs auth.login through a registered alias", async () => {
    const host = createHost();
    const calls: string[] = [];

    host.registerPlugin((api) => {
      api.registerChannel({
        id: "openclaw-example",
        meta: { aliases: ["example"] },
        auth: {
          login: async ({ accountId, verbose, runtime }) => {
            calls.push(`${accountId}:${String(verbose)}`);
            runtime?.log?.("login-output");
          },
        },
      });
    });
    host.registerChannelAlias("demo", "openclaw-example");

    assert.equal(host.hasChannelLogin("demo"), true);
    await host.runChannelLogin("demo", {
      accountId: "default",
      verbose: true,
      runtime: { log: (message) => calls.push(String(message)), error: () => {}, exit: () => {} },
    });

    assert.deepEqual(calls, ["default:true", "login-output"]);
  });

  test("rejects a channel without auth.login", async () => {
    const host = createHost();
    host.registerPlugin((api) => {
      api.registerChannel({ id: "no-login", meta: { aliases: ["plain"] } });
    });

    assert.equal(host.hasChannelLogin("plain"), false);
    await assert.rejects(
      () => host.runChannelLogin("plain", { accountId: "default" }),
      /Channel login is not supported for plain/,
    );
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --import tsx/esm --test packages/openclaw-compat/src/plugin-host.test.ts
```

Expected: FAIL because `hasChannelLogin` and `runChannelLogin` do not exist.

- [ ] **Step 3: Add typed login methods to the plugin host**

In `packages/openclaw-compat/src/plugin-host.ts`, add exported request types near the QR types:

```ts
export interface ChannelLoginRuntimeEnv {
  log?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  exit?: (code: number) => void;
}

export interface ChannelLoginParams {
  accountId?: string;
  verbose?: boolean;
  runtime?: ChannelLoginRuntimeEnv;
}
```

Add methods on `OpenClawPluginHost`:

```ts
  hasChannelLogin(channelType: string): boolean {
    return Boolean(this.resolveChannel(channelType)?.auth?.login);
  }

  async runChannelLogin(
    channelType: string,
    params: ChannelLoginParams,
  ): Promise<void> {
    const channel = this.resolveChannel(channelType);
    const login = channel?.auth?.login;
    if (!login) {
      throw new Error(`Channel login is not supported for ${channelType}`);
    }

    await login({
      cfg: this.runtime.getConfig(),
      accountId: params.accountId,
      verbose: params.verbose,
      runtime: params.runtime,
    });
  }
```

Keep the existing QR methods unchanged.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node --import tsx/esm --test packages/openclaw-compat/src/plugin-host.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit plugin host login support**

Run:

```bash
git add packages/openclaw-compat/src/plugin-host.ts packages/openclaw-compat/src/plugin-host.test.ts
git commit -m "feat: expose channel auth login through plugin host"
```

## Task 2: Channel Login Session Model

**Files:**
- Create: `apps/gateway/src/runtime/channel-login/types.ts`
- Create: `apps/gateway/src/runtime/channel-login/session.ts`
- Create: `apps/gateway/src/runtime/channel-login/session.test.ts`

- [ ] **Step 1: Write the failing session tests**

Create `apps/gateway/src/runtime/channel-login/session.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ChannelLoginSession } from "./session.js";
import type { ChannelLoginRunnerHandle } from "./types.js";

function handle(): ChannelLoginRunnerHandle {
  const writes: string[] = [];
  return {
    writes,
    writeInput: async (text: string) => {
      writes.push(text);
    },
    cancel: async () => {
      writes.push("cancelled");
    },
  };
}

describe("ChannelLoginSession", () => {
  test("stores event history and replays it in order", () => {
    const session = new ChannelLoginSession({
      sessionId: "login_1",
      channelType: "wechat",
      accountId: "default",
      historyLimit: 10,
    });

    session.append({ type: "output", stream: "stdout", text: "one" });
    session.append({ type: "output", stream: "stderr", text: "two" });

    assert.deepEqual(
      session.snapshot().events.map((event) => event.type),
      ["started", "output", "output"],
    );
  });

  test("notifies subscribers and stops after unsubscribe", () => {
    const session = new ChannelLoginSession({
      sessionId: "login_2",
      channelType: "feishu",
      accountId: "default",
      historyLimit: 10,
    });
    const received: string[] = [];
    const unsubscribe = session.subscribe((event) => received.push(event.type));

    session.append({ type: "output", stream: "stdout", text: "one" });
    unsubscribe();
    session.append({ type: "output", stream: "stdout", text: "two" });

    assert.deepEqual(received, ["output"]);
  });

  test("writes input only while running", async () => {
    const runner = handle();
    const session = new ChannelLoginSession({
      sessionId: "login_3",
      channelType: "wechat",
      accountId: "default",
      historyLimit: 10,
    });
    session.attachRunner(runner);

    await session.writeInput("123456");
    session.complete({ connected: true, accountId: "wx", channelConfig: {}, message: "done" });

    await assert.rejects(() => session.writeInput("later"), /already completed/);
    assert.deepEqual(runner.writes, ["123456\n"]);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/runtime/channel-login/session.test.ts
```

Expected: FAIL because the session model does not exist.

- [ ] **Step 3: Add the shared login types**

Create `apps/gateway/src/runtime/channel-login/types.ts`:

```ts
export const CHANNEL_LOGIN_PROTOCOL_PREFIX = "__A2A_CHANNEL_LOGIN_EVENT__";

export type ChannelLoginState =
  | "running"
  | "waiting-for-input"
  | "completed"
  | "failed"
  | "cancelled";

export type ChannelLoginOutputStream = "stdout" | "stderr";

export interface ChannelLoginStartRequest {
  channelType: string;
  accountId?: string;
  force?: boolean;
  verbose?: boolean;
  initialConfig?: Record<string, unknown>;
}

export interface ChannelLoginStartResult {
  sessionId: string;
  eventsUrl: string;
  inputUrl: string;
  cancelUrl: string;
}

export interface ChannelLoginResult {
  connected: boolean;
  accountId?: string;
  channelConfig?: Record<string, unknown>;
  message: string;
}

export type ChannelLoginEvent =
  | {
      type: "started";
      sessionId: string;
      channelType: string;
      accountId: string;
      startedAt: string;
    }
  | { type: "output"; stream: ChannelLoginOutputStream; text: string }
  | { type: "qr"; text: string; format: "url" | "data-url" | "text" }
  | { type: "prompt"; kind: "text"; message: string; sensitive: boolean }
  | ({ type: "result" } & ChannelLoginResult)
  | { type: "exited"; code: number | null; signal: string | null }
  | { type: "cancelled"; message: string }
  | { type: "error-state"; message: string };

export interface ChannelLoginSnapshot {
  sessionId: string;
  channelType: string;
  accountId: string;
  state: ChannelLoginState;
  events: ChannelLoginEvent[];
}

export interface ChannelLoginRunnerHandle {
  writeInput(text: string): Promise<void>;
  cancel(): Promise<void>;
}
```

- [ ] **Step 4: Implement the session model**

Create `apps/gateway/src/runtime/channel-login/session.ts`:

```ts
import type {
  ChannelLoginEvent,
  ChannelLoginResult,
  ChannelLoginRunnerHandle,
  ChannelLoginSnapshot,
  ChannelLoginState,
} from "./types.js";

export interface ChannelLoginSessionOptions {
  sessionId: string;
  channelType: string;
  accountId?: string;
  historyLimit: number;
}

export class ChannelLoginSession {
  private state: ChannelLoginState = "running";
  private readonly events: ChannelLoginEvent[] = [];
  private readonly subscribers = new Set<(event: ChannelLoginEvent) => void>();
  private runner?: ChannelLoginRunnerHandle;
  readonly sessionId: string;
  readonly channelType: string;
  readonly accountId: string;

  constructor(private readonly options: ChannelLoginSessionOptions) {
    this.sessionId = options.sessionId;
    this.channelType = options.channelType;
    this.accountId = options.accountId?.trim() || "default";
    this.append({
      type: "started",
      sessionId: this.sessionId,
      channelType: this.channelType,
      accountId: this.accountId,
      startedAt: new Date().toISOString(),
    });
  }

  attachRunner(runner: ChannelLoginRunnerHandle): void {
    this.runner = runner;
  }

  append(event: ChannelLoginEvent): void {
    this.events.push(event);
    while (this.events.length > this.options.historyLimit) {
      this.events.shift();
    }
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  subscribe(subscriber: (event: ChannelLoginEvent) => void): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  snapshot(): ChannelLoginSnapshot {
    return {
      sessionId: this.sessionId,
      channelType: this.channelType,
      accountId: this.accountId,
      state: this.state,
      events: [...this.events],
    };
  }

  async writeInput(text: string): Promise<void> {
    if (this.isTerminal()) {
      throw new Error(`Login session ${this.sessionId} already ${this.state}.`);
    }
    if (!this.runner) {
      throw new Error(`Login session ${this.sessionId} has no process stdin.`);
    }
    await this.runner.writeInput(`${text}\n`);
  }

  complete(result: ChannelLoginResult): void {
    if (this.isTerminal()) return;
    this.state = "completed";
    this.append({ type: "result", ...result });
  }

  fail(message: string): void {
    if (this.isTerminal()) return;
    this.state = "failed";
    this.append({ type: "error-state", message });
  }

  async cancel(): Promise<void> {
    if (this.isTerminal()) return;
    this.state = "cancelled";
    await this.runner?.cancel();
    this.append({ type: "cancelled", message: "Login cancelled." });
  }

  markWaitingForInput(message: string): void {
    if (this.isTerminal()) return;
    this.state = "waiting-for-input";
    this.append({ type: "prompt", kind: "text", message, sensitive: false });
  }

  markRunning(): void {
    if (this.isTerminal()) return;
    this.state = "running";
  }

  private isTerminal(): boolean {
    return this.state === "completed" || this.state === "failed" || this.state === "cancelled";
  }
}
```

- [ ] **Step 5: Run the focused test and verify it passes**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/runtime/channel-login/session.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the session model**

Run:

```bash
git add apps/gateway/src/runtime/channel-login/types.ts apps/gateway/src/runtime/channel-login/session.ts apps/gateway/src/runtime/channel-login/session.test.ts
git commit -m "feat: add channel login session model"
```

## Task 3: Process Runner and Protocol Parsing

**Files:**
- Create: `apps/gateway/src/runtime/channel-login/process-runner.ts`
- Create: `apps/gateway/src/runtime/channel-login/process-runner.test.ts`

- [ ] **Step 1: Write protocol parsing tests**

Create `apps/gateway/src/runtime/channel-login/process-runner.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseChannelLoginOutputChunk } from "./process-runner.js";
import { CHANNEL_LOGIN_PROTOCOL_PREFIX } from "./types.js";

describe("parseChannelLoginOutputChunk", () => {
  test("separates display output from structured protocol events", () => {
    const parsed = parseChannelLoginOutputChunk(
      [
        "hello",
        `${CHANNEL_LOGIN_PROTOCOL_PREFIX}{\"type\":\"result\",\"connected\":true,\"accountId\":\"default\",\"channelConfig\":{},\"message\":\"done\"}`,
        "world",
      ].join("\n"),
    );

    assert.equal(parsed.displayText, "hello\nworld\n");
    assert.deepEqual(parsed.events, [
      { type: "result", connected: true, accountId: "default", channelConfig: {}, message: "done" },
    ]);
  });

  test("keeps malformed protocol lines visible", () => {
    const parsed = parseChannelLoginOutputChunk(`${CHANNEL_LOGIN_PROTOCOL_PREFIX}not-json\n`);

    assert.equal(parsed.events.length, 0);
    assert.match(parsed.displayText, /not-json/);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/runtime/channel-login/process-runner.test.ts
```

Expected: FAIL because `process-runner.ts` does not exist.

- [ ] **Step 3: Implement protocol parsing and runner skeleton**

Create `apps/gateway/src/runtime/channel-login/process-runner.ts`:

```ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { injectable } from "inversify";

import { ChannelLoginSession } from "./session.js";
import {
  CHANNEL_LOGIN_PROTOCOL_PREFIX,
  type ChannelLoginEvent,
  type ChannelLoginRunnerHandle,
  type ChannelLoginStartRequest,
} from "./types.js";

export interface ParsedLoginOutput {
  displayText: string;
  events: ChannelLoginEvent[];
}

export function parseChannelLoginOutputChunk(text: string): ParsedLoginOutput {
  const events: ChannelLoginEvent[] = [];
  const displayLines: string[] = [];

  for (const line of text.split(/\n/)) {
    if (!line) continue;
    if (!line.startsWith(CHANNEL_LOGIN_PROTOCOL_PREFIX)) {
      displayLines.push(line);
      continue;
    }

    const raw = line.slice(CHANNEL_LOGIN_PROTOCOL_PREFIX.length);
    try {
      events.push(JSON.parse(raw) as ChannelLoginEvent);
    } catch {
      displayLines.push(line);
    }
  }

  return {
    displayText: displayLines.length > 0 ? `${displayLines.join("\n")}\n` : "",
    events,
  };
}

export interface ChannelLoginProcessRunnerOptions {
  childScript?: string;
}

@injectable()
export class ChannelLoginProcessRunner {
  constructor(private readonly options: ChannelLoginProcessRunnerOptions = {}) {}

  start(session: ChannelLoginSession, request: ChannelLoginStartRequest): ChannelLoginRunnerHandle {
    const childScript =
      this.options.childScript ??
      fileURLToPath(new URL("./login-child.ts", import.meta.url));
    const child = spawn(process.execPath, ["--import", "tsx/esm", childScript], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        A2A_CHANNEL_LOGIN_REQUEST: JSON.stringify(request),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.pipeOutput(child, session);

    child.on("exit", (code, signal) => {
      session.append({ type: "exited", code, signal });
      const snapshot = session.snapshot();
      if (snapshot.state === "running" || snapshot.state === "waiting-for-input") {
        if (code === 0) {
          session.complete({ connected: true, accountId: request.accountId, channelConfig: {}, message: "Login completed." });
        } else {
          session.fail(`Login process exited with code ${String(code)}.`);
        }
      }
    });

    return {
      writeInput: async (text: string) => {
        child.stdin.write(text);
      },
      cancel: async () => {
        child.kill("SIGTERM");
      },
    };
  }

  private pipeOutput(child: ChildProcessWithoutNullStreams, session: ChannelLoginSession): void {
    child.stdout.on("data", (chunk: Buffer) => {
      const parsed = parseChannelLoginOutputChunk(chunk.toString("utf8"));
      if (parsed.displayText) {
        session.append({ type: "output", stream: "stdout", text: parsed.displayText });
      }
      for (const event of parsed.events) {
        this.applyProtocolEvent(session, event);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      session.append({ type: "output", stream: "stderr", text: chunk.toString("utf8") });
    });
  }

  private applyProtocolEvent(session: ChannelLoginSession, event: ChannelLoginEvent): void {
    if (event.type === "result") {
      session.complete(event);
      return;
    }
    if (event.type === "prompt") {
      session.markWaitingForInput(event.message);
      return;
    }
    session.append(event);
  }
}
```

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/runtime/channel-login/process-runner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the runner**

Run:

```bash
git add apps/gateway/src/runtime/channel-login/process-runner.ts apps/gateway/src/runtime/channel-login/process-runner.test.ts
git commit -m "feat: add channel login process runner"
```

## Task 4: Login Manager and Application Service

**Files:**
- Create: `apps/gateway/src/runtime/channel-login/manager.ts`
- Create: `apps/gateway/src/runtime/channel-login/manager.test.ts`
- Create: `apps/gateway/src/application/channel-login-service.ts`
- Create: `apps/gateway/src/application/channel-login-service.test.ts`

- [ ] **Step 1: Write the manager tests**

Create `apps/gateway/src/runtime/channel-login/manager.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ChannelLoginManager } from "./manager.js";
import type { ChannelLoginProcessRunner } from "./process-runner.js";

describe("ChannelLoginManager", () => {
  test("starts a session and returns stable URLs", () => {
    const runner = { start: () => ({ writeInput: async () => {}, cancel: async () => {} }) } as ChannelLoginProcessRunner;
    const manager = new ChannelLoginManager(runner);

    const result = manager.start({ channelType: "wechat", accountId: "default" });

    assert.match(result.sessionId, /^login_/);
    assert.equal(result.eventsUrl, `/api/channel-login-sessions/${result.sessionId}/events`);
    assert.equal(manager.get(result.sessionId)?.channelType, "wechat");
  });

  test("returns the active session for duplicate channel and account", () => {
    const runner = { start: () => ({ writeInput: async () => {}, cancel: async () => {} }) } as ChannelLoginProcessRunner;
    const manager = new ChannelLoginManager(runner);

    const first = manager.start({ channelType: "wechat", accountId: "default" });
    const second = manager.start({ channelType: "wechat", accountId: "default" });

    assert.equal(first.sessionId, second.sessionId);
  });
});
```

- [ ] **Step 2: Write the application service tests**

Create `apps/gateway/src/application/channel-login-service.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ChannelLoginService,
  UnsupportedChannelLoginError,
} from "./channel-login-service.js";

describe("ChannelLoginService", () => {
  test("rejects unsupported channel login", async () => {
    const service = new ChannelLoginService(
      { hasChannelLogin: () => false },
      { start: () => { throw new Error("unused"); } },
      { getConfig: () => ({ channels: {} }) },
    );

    await assert.rejects(
      () => service.start({ channelType: "plain", accountId: "default" }),
      UnsupportedChannelLoginError,
    );
  });
});
```

- [ ] **Step 3: Run focused tests and verify they fail**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/runtime/channel-login/manager.test.ts apps/gateway/src/application/channel-login-service.test.ts
```

Expected: FAIL because the manager and service do not exist.

- [ ] **Step 4: Implement manager and application service**

Create `apps/gateway/src/runtime/channel-login/manager.ts`:

```ts
import { randomUUID } from "node:crypto";
import { inject, injectable } from "inversify";

import { ChannelLoginProcessRunner } from "./process-runner.js";
import { ChannelLoginSession } from "./session.js";
import type { ChannelLoginStartRequest, ChannelLoginStartResult } from "./types.js";

@injectable()
export class ChannelLoginManager {
  private readonly sessions = new Map<string, ChannelLoginSession>();
  private readonly activeKeys = new Map<string, string>();

  constructor(
    @inject(ChannelLoginProcessRunner)
    private readonly runner: ChannelLoginProcessRunner,
  ) {}

  start(request: ChannelLoginStartRequest): ChannelLoginStartResult {
    const accountId = request.accountId?.trim() || "default";
    const key = `${request.channelType}:${accountId}`;
    const existingId = this.activeKeys.get(key);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && !["completed", "failed", "cancelled"].includes(existing.snapshot().state)) {
        return this.toStartResult(existing.sessionId);
      }
    }

    const session = new ChannelLoginSession({
      sessionId: `login_${randomUUID()}`,
      channelType: request.channelType,
      accountId,
      historyLimit: 200,
    });
    this.sessions.set(session.sessionId, session);
    this.activeKeys.set(key, session.sessionId);
    session.attachRunner(this.runner.start(session, { ...request, accountId }));
    return this.toStartResult(session.sessionId);
  }

  get(sessionId: string): ChannelLoginSession | undefined {
    return this.sessions.get(sessionId);
  }

  private toStartResult(sessionId: string): ChannelLoginStartResult {
    return {
      sessionId,
      eventsUrl: `/api/channel-login-sessions/${sessionId}/events`,
      inputUrl: `/api/channel-login-sessions/${sessionId}/input`,
      cancelUrl: `/api/channel-login-sessions/${sessionId}/cancel`,
    };
  }
}
```

Create `apps/gateway/src/application/channel-login-service.ts`:

```ts
import { inject, injectable } from "inversify";
import { OpenClawPluginHost } from "@a2a-channels/openclaw-compat";

import { ChannelLoginManager } from "../runtime/channel-login/manager.js";
import { RuntimeOpenClawConfigProjection } from "../runtime/runtime-openclaw-config-projection.js";
import type { ChannelLoginStartRequest, ChannelLoginStartResult } from "../runtime/channel-login/types.js";

export class UnsupportedChannelLoginError extends Error {
  constructor(readonly channelType: string) {
    super(`Channel login is not supported for ${channelType}`);
  }
}

export class ChannelLoginSessionNotFoundError extends Error {
  constructor(readonly sessionId: string) {
    super(`Channel login session ${sessionId} was not found.`);
  }
}

export interface ChannelLoginSupportGateway {
  hasChannelLogin(channelType: string): boolean;
}

export interface ChannelLoginConfigProjection {
  getConfig(): Record<string, unknown>;
}

@injectable()
export class ChannelLoginService {
  constructor(
    @inject(OpenClawPluginHost)
    private readonly pluginHost: ChannelLoginSupportGateway,
    @inject(ChannelLoginManager)
    private readonly manager: ChannelLoginManager,
    @inject(RuntimeOpenClawConfigProjection)
    private readonly configProjection: ChannelLoginConfigProjection,
  ) {}

  async start(request: ChannelLoginStartRequest): Promise<ChannelLoginStartResult> {
    if (!this.pluginHost.hasChannelLogin(request.channelType)) {
      throw new UnsupportedChannelLoginError(request.channelType);
    }
    return this.manager.start({
      ...request,
      initialConfig: this.configProjection.getConfig(),
    });
  }

  async writeInput(sessionId: string, text: string): Promise<void> {
    const session = this.manager.get(sessionId);
    if (!session) throw new ChannelLoginSessionNotFoundError(sessionId);
    await session.writeInput(text);
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.manager.get(sessionId);
    if (!session) throw new ChannelLoginSessionNotFoundError(sessionId);
    await session.cancel();
  }
}
```

- [ ] **Step 5: Run focused tests and verify they pass**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/runtime/channel-login/manager.test.ts apps/gateway/src/application/channel-login-service.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit manager and service**

Run:

```bash
git add apps/gateway/src/runtime/channel-login/manager.ts apps/gateway/src/runtime/channel-login/manager.test.ts apps/gateway/src/application/channel-login-service.ts apps/gateway/src/application/channel-login-service.test.ts
git commit -m "feat: add channel login manager service"
```

## Task 5: Gateway HTTP Routes and SSE

**Files:**
- Modify: `apps/gateway/src/http/schemas/request-schemas.ts`
- Create: `apps/gateway/src/http/routes/channel-login.ts`
- Modify: `apps/gateway/src/http/app.ts`
- Modify: `apps/gateway/src/bootstrap/container.ts`
- Test: `apps/gateway/src/http/app.test.ts`

- [ ] **Step 1: Add route tests**

Append tests to `apps/gateway/src/http/app.test.ts` that build the real app container and call:

```ts
const startResponse = await app.request("/api/channels/wechat/auth/login/start", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ accountId: "default" }),
});
```

Assert supported channels return JSON with `sessionId`, `eventsUrl`, `inputUrl`, and `cancelUrl`. Add a second assertion for an unsupported channel returning 404:

```ts
assert.equal(unsupported.status, 404);
assert.match(await unsupported.text(), /Channel login is not supported/);
```

- [ ] **Step 2: Run the route test and verify it fails**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/http/app.test.ts
```

Expected: FAIL because login routes are not registered.

- [ ] **Step 3: Add schemas**

In `apps/gateway/src/http/schemas/request-schemas.ts`, add:

```ts
export const startChannelLoginBodySchema = z.object({
  accountId: z.string().optional(),
  force: z.boolean().optional(),
  verbose: z.boolean().optional(),
});

export const channelLoginInputBodySchema = z.object({
  text: z.string(),
});
```

- [ ] **Step 4: Add `ChannelLoginRoutes`**

Create `apps/gateway/src/http/routes/channel-login.ts`:

```ts
import { Hono, type Context } from "hono";
import { inject, injectable } from "inversify";

import {
  ChannelLoginService,
  ChannelLoginSessionNotFoundError,
  UnsupportedChannelLoginError,
} from "../../application/channel-login-service.js";
import { ChannelLoginManager } from "../../runtime/channel-login/manager.js";
import type { ChannelLoginEvent } from "../../runtime/channel-login/types.js";
import { parseJsonBody } from "../utils/schema.js";
import { channelLoginInputBodySchema, startChannelLoginBodySchema } from "../schemas/request-schemas.js";

const encoder = new TextEncoder();

function encodeSse(event: ChannelLoginEvent): Uint8Array {
  return encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}

function mapLoginError(c: Context, error: unknown) {
  if (error instanceof UnsupportedChannelLoginError) return c.json({ error: error.message }, 404);
  if (error instanceof ChannelLoginSessionNotFoundError) return c.json({ error: error.message }, 404);
  throw error;
}

@injectable()
export class ChannelLoginRoutes {
  constructor(
    @inject(ChannelLoginService)
    private readonly loginService: ChannelLoginService,
    @inject(ChannelLoginManager)
    private readonly manager: ChannelLoginManager,
  ) {}

  register(app: Hono): void {
    app.post("/api/channels/:channelType/auth/login/start", async (c) => {
      const parsed = await parseJsonBody(c, startChannelLoginBodySchema);
      if (!parsed.success) return parsed.response;
      try {
        return c.json(await this.loginService.start({
          channelType: c.req.param("channelType"),
          ...parsed.data,
        }));
      } catch (error) {
        return mapLoginError(c, error);
      }
    });

    app.post("/api/channel-login-sessions/:sessionId/input", async (c) => {
      const parsed = await parseJsonBody(c, channelLoginInputBodySchema);
      if (!parsed.success) return parsed.response;
      try {
        await this.loginService.writeInput(c.req.param("sessionId"), parsed.data.text);
        return c.json({ accepted: true });
      } catch (error) {
        return mapLoginError(c, error);
      }
    });

    app.post("/api/channel-login-sessions/:sessionId/cancel", async (c) => {
      try {
        await this.loginService.cancel(c.req.param("sessionId"));
        return c.json({ cancelled: true });
      } catch (error) {
        return mapLoginError(c, error);
      }
    });

    app.get("/api/channel-login-sessions/:sessionId/events", (c) => {
      const session = this.manager.get(c.req.param("sessionId"));
      if (!session) return c.json({ error: "Channel login session not found." }, 404);

      const stream = new ReadableStream({
        start(controller) {
          for (const event of session.snapshot().events) {
            controller.enqueue(encodeSse(event));
          }
          const unsubscribe = session.subscribe((event) => controller.enqueue(encodeSse(event)));
          c.req.raw.signal.addEventListener("abort", () => {
            unsubscribe();
            controller.close();
          });
        },
      });

      return new Response(stream, {
        headers: {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
        },
      });
    });
  }
}
```

- [ ] **Step 5: Register routes and DI**

In `apps/gateway/src/bootstrap/container.ts`, bind `ChannelLoginProcessRunner`, `ChannelLoginManager`, `ChannelLoginService`, and `ChannelLoginRoutes`.

In `apps/gateway/src/http/app.ts`, inject `ChannelLoginRoutes` and call `this.channelLoginRoutes.register(app)` after `this.channelRoutes.register(app)`.

- [ ] **Step 6: Run route tests and verify they pass**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/http/app.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit routes**

Run:

```bash
git add apps/gateway/src/http/schemas/request-schemas.ts apps/gateway/src/http/routes/channel-login.ts apps/gateway/src/http/app.ts apps/gateway/src/bootstrap/container.ts apps/gateway/src/http/app.test.ts
git commit -m "feat: expose channel login http sse routes"
```

## Task 6: Child Entrypoint and Feishu Result Extraction

**Files:**
- Create: `apps/gateway/src/runtime/channel-login/login-child.ts`
- Create: `apps/gateway/src/runtime/channel-login/feishu-config-result.ts`
- Create: `apps/gateway/src/runtime/channel-login/feishu-config-result.test.ts`

- [ ] **Step 1: Write Feishu extraction tests**

Create `apps/gateway/src/runtime/channel-login/feishu-config-result.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractFeishuLoginResult } from "./feishu-config-result.js";

describe("extractFeishuLoginResult", () => {
  test("extracts default account fields from top-level Feishu config", () => {
    const result = extractFeishuLoginResult({
      before: { channels: {} },
      after: {
        channels: {
          feishu: {
            appId: "cli_a",
            appSecret: "secret",
            allowFrom: ["ou_1"],
            domain: "feishu",
            connectionMode: "websocket",
            groupPolicy: "open",
          },
        },
      },
      requestedAccountId: "default",
    });

    assert.deepEqual(result, {
      connected: true,
      accountId: "default",
      channelConfig: {
        appId: "cli_a",
        appSecret: "secret",
        allowFrom: ["ou_1"],
        domain: "feishu",
        connectionMode: "websocket",
        groupPolicy: "open",
      },
      message: "Feishu app authorization completed.",
    });
  });
});
```

- [ ] **Step 2: Run the extraction test and verify it fails**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/runtime/channel-login/feishu-config-result.test.ts
```

Expected: FAIL because the extraction module does not exist.

- [ ] **Step 3: Implement Feishu extraction**

Create `apps/gateway/src/runtime/channel-login/feishu-config-result.ts`:

```ts
import type { ChannelLoginResult } from "./types.js";

interface ExtractParams {
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  requestedAccountId?: string;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function copyKnownFields(source: Record<string, unknown>): Record<string, unknown> {
  const keys = ["appId", "appSecret", "allowFrom", "domain", "connectionMode", "dmPolicy", "groupPolicy", "requireMention"];
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      result[key] = source[key];
    }
  }
  return result;
}

export function extractFeishuLoginResult(params: ExtractParams): ChannelLoginResult {
  const accountId = params.requestedAccountId?.trim() || "default";
  const afterChannels = record(params.after.channels);
  const feishu = record(afterChannels.feishu);
  const account =
    accountId === "default"
      ? feishu
      : { ...feishu, ...record(record(feishu.accounts)[accountId]) };
  const channelConfig = copyKnownFields(account);

  return {
    connected: Boolean(channelConfig.appId && channelConfig.appSecret),
    accountId,
    channelConfig,
    message: "Feishu app authorization completed.",
  };
}
```

- [ ] **Step 4: Implement the child entrypoint**

Create `apps/gateway/src/runtime/channel-login/login-child.ts`:

```ts
import { OpenClawPluginHost, OpenClawPluginRuntime } from "@a2a-channels/openclaw-compat";

import { registerAllPlugins } from "../../register-plugins.js";
import { CHANNEL_LOGIN_PROTOCOL_PREFIX, type ChannelLoginEvent, type ChannelLoginStartRequest } from "./types.js";

function emit(event: ChannelLoginEvent): void {
  process.stdout.write(`${CHANNEL_LOGIN_PROTOCOL_PREFIX}${JSON.stringify(event)}\n`);
}

function readRequest(): ChannelLoginStartRequest {
  const raw = process.env.A2A_CHANNEL_LOGIN_REQUEST;
  if (!raw) throw new Error("A2A_CHANNEL_LOGIN_REQUEST is missing.");
  return JSON.parse(raw) as ChannelLoginStartRequest;
}

async function main(): Promise<void> {
  const request = readRequest();
  const runtime = new OpenClawPluginRuntime({
    config: {
      loadConfig: () => ({ channels: {} }),
      writeConfigFile: async () => {},
    },
  });
  const host = new OpenClawPluginHost(runtime);
  registerAllPlugins(host);

  await host.runChannelLogin(request.channelType, {
    accountId: request.accountId,
    verbose: request.verbose,
    runtime: {
      log: (...args) => process.stdout.write(`${args.map(String).join(" ")}\n`),
      error: (...args) => process.stderr.write(`${args.map(String).join(" ")}\n`),
      exit: (code) => process.exit(code),
    },
  });

  emit({
    type: "result",
    connected: true,
    accountId: request.accountId ?? "default",
    channelConfig: {},
    message: "Login completed.",
  });
}

main().catch((error: unknown) => {
  emit({ type: "error-state", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
```

Then update the child entrypoint so Feishu login writes only to a temporary OpenClaw config file owned by the child process:

```ts
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function createIsolatedConfig(initialConfig: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "a2a-channel-login-"));
  const configPath = join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify(initialConfig, null, 2), "utf8");
  process.env.OPENCLAW_CONFIG_PATH = configPath;
  return configPath;
}

async function readConfig(configPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
}
```

At the start of `main`, call:

```ts
const beforeConfig = request.initialConfig ?? { channels: {} };
const configPath = await createIsolatedConfig(beforeConfig);
```

After `host.runChannelLogin(...)`, call:

```ts
const afterConfig = await readConfig(configPath);
if (request.channelType === "feishu" || request.channelType === "lark") {
  emit({ type: "result", ...extractFeishuLoginResult({
    before: beforeConfig,
    after: afterConfig,
    requestedAccountId: request.accountId,
  }) });
  return;
}
```

This keeps Feishu on plugin `auth.login` while preventing the gateway process from depending on global user config mutation.

- [ ] **Step 5: Run focused tests and typecheck the child**

Run:

```bash
node --import tsx/esm --test apps/gateway/src/runtime/channel-login/feishu-config-result.test.ts
node --import tsx/esm apps/gateway/src/runtime/channel-login/login-child.ts
```

Expected: the extraction test passes. The child command exits non-zero with `A2A_CHANNEL_LOGIN_REQUEST is missing`, proving the entrypoint loads.

- [ ] **Step 6: Commit child entrypoint**

Run:

```bash
git add apps/gateway/src/runtime/channel-login/login-child.ts apps/gateway/src/runtime/channel-login/feishu-config-result.ts apps/gateway/src/runtime/channel-login/feishu-config-result.test.ts
git commit -m "feat: add channel login child entrypoint"
```

## Task 7: Web API Client and EventSource Wrapper

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/channel-login.ts`
- Create: `apps/web/src/lib/channel-login.test.ts`

- [ ] **Step 1: Read local Next.js docs before Web edits**

Run:

```bash
sed -n '1,180p' apps/web/node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md
sed -n '1,160p' apps/web/node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md
```

Expected: files exist. If either path differs in this Next version, locate the App Router route handler docs with:

```bash
find apps/web/node_modules/next/dist/docs -path '*route*' -type f | head -30
```

- [ ] **Step 2: Add Web event parsing tests**

Create `apps/web/src/lib/channel-login.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseChannelLoginEvent } from "./channel-login";

describe("parseChannelLoginEvent", () => {
  test("parses a result event", () => {
    const result = parseChannelLoginEvent("result", JSON.stringify({
      type: "result",
      connected: true,
      accountId: "default",
      channelConfig: { appId: "cli_a" },
      message: "done",
    }));

    assert.equal(result.type, "result");
    assert.equal(result.accountId, "default");
  });
});
```

- [ ] **Step 3: Run the Web parsing test and verify it fails**

Run:

```bash
cd apps/web && node --import tsx/esm --test src/lib/channel-login.test.ts
```

Expected: FAIL because `channel-login.ts` does not exist.

- [ ] **Step 4: Add API DTOs and methods**

In `apps/web/src/lib/api.ts`, add:

```ts
export interface ChannelLoginStartResult {
  sessionId: string;
  eventsUrl: string;
  inputUrl: string;
  cancelUrl: string;
}

export async function startChannelLogin(
  channelType: string,
  data: { accountId?: string; force?: boolean; verbose?: boolean },
): Promise<ChannelLoginStartResult> {
  const res = await fetch(`${BASE}/api/channels/${encodeURIComponent(channelType)}/auth/login/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<ChannelLoginStartResult>;
}

export async function sendChannelLoginInput(inputUrl: string, text: string): Promise<void> {
  const res = await fetch(inputUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(await res.text());
}

export async function cancelChannelLogin(cancelUrl: string): Promise<void> {
  const res = await fetch(cancelUrl, { method: "POST" });
  if (!res.ok) throw new Error(await res.text());
}
```

- [ ] **Step 5: Add EventSource wrapper**

Create `apps/web/src/lib/channel-login.ts`:

```ts
export type ChannelLoginEvent =
  | { type: "output"; stream: "stdout" | "stderr"; text: string }
  | { type: "qr"; text: string; format: "url" | "data-url" | "text" }
  | { type: "prompt"; kind: "text"; message: string; sensitive: boolean }
  | { type: "result"; connected: boolean; accountId?: string; channelConfig?: Record<string, unknown>; message: string }
  | { type: "error-state"; message: string }
  | { type: "cancelled"; message: string }
  | { type: "started"; sessionId: string; channelType: string; accountId: string; startedAt: string }
  | { type: "exited"; code: number | null; signal: string | null };

export function parseChannelLoginEvent(_eventName: string, rawData: string): ChannelLoginEvent {
  return JSON.parse(rawData) as ChannelLoginEvent;
}

export class ChannelLoginEventStream {
  private source: EventSource | null = null;

  constructor(private readonly url: string) {}

  connect(options: {
    onEvent(event: ChannelLoginEvent): void;
    onDisconnect(message: string): void;
  }): void {
    this.close();
    this.source = new EventSource(this.url);
    this.source.onerror = () => options.onDisconnect("Channel login stream is disconnected.");
    for (const eventName of ["started", "output", "qr", "prompt", "result", "error-state", "cancelled", "exited"]) {
      this.source.addEventListener(eventName, (event) => {
        options.onEvent(parseChannelLoginEvent(eventName, (event as MessageEvent).data));
      });
    }
  }

  close(): void {
    this.source?.close();
    this.source = null;
  }
}
```

- [ ] **Step 6: Run Web parsing test and verify it passes**

Run:

```bash
cd apps/web && node --import tsx/esm --test src/lib/channel-login.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Web client wrapper**

Run:

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/channel-login.ts apps/web/src/lib/channel-login.test.ts
git commit -m "feat: add web channel login client"
```

## Task 8: Web Channel Creation UI

**Files:**
- Modify: `apps/web/src/lib/channel-binding-form.ts`
- Modify: `apps/web/src/lib/channel-binding-form.test.ts`
- Modify: `apps/web/src/app/channels/new/page.tsx`

- [ ] **Step 1: Add metadata test for login support**

In `apps/web/src/lib/channel-binding-form.test.ts`, add assertions:

```ts
assert.equal(getChannelBindingFormDefinition("wechat").supportsLogin, true);
assert.equal(getChannelBindingFormDefinition("feishu").supportsLogin, true);
assert.equal(getChannelBindingFormDefinition("lark").supportsLogin, true);
```

- [ ] **Step 2: Run the metadata test and verify it fails**

Run:

```bash
cd apps/web && node --import tsx/esm --test src/lib/channel-binding-form.test.ts
```

Expected: FAIL because `supportsLogin` is not defined.

- [ ] **Step 3: Add `supportsLogin` metadata**

In `apps/web/src/lib/channel-binding-form.ts`, extend the definition type with:

```ts
supportsLogin?: boolean;
```

Set `supportsLogin: true` for `wechat`, `weixin`, `feishu`, and `lark`. Keep `supportsQr` unchanged.

- [ ] **Step 4: Integrate login panel in the new channel page**

In `apps/web/src/app/channels/new/page.tsx`:

- import `startChannelLogin`, `sendChannelLoginInput`, and `cancelChannelLogin`
- import `ChannelLoginEventStream`
- add state for `loginSession`, `loginEvents`, `loginPrompt`, `loginInput`, and `loginError`
- replace the QR polling action for `definition.supportsLogin` with a start-login action
- on `result`, update form state:

```ts
setForm((current) => ({
  ...current,
  accountId: event.accountId ?? current.accountId,
  channelConfig: event.channelConfig ?? current.channelConfig,
}));
```

- render output events in a compact monospace panel
- render prompt input when `loginPrompt` is present
- cancel non-terminal session in the `useEffect` cleanup for navigation/unmount

- [ ] **Step 5: Run Web tests and typecheck**

Run:

```bash
cd apps/web && node --import tsx/esm --test src/lib/channel-binding-form.test.ts src/lib/channel-login.test.ts
cd apps/web && npx tsc --noEmit
```

Expected: tests and typecheck pass.

- [ ] **Step 6: Commit Web UI integration**

Run:

```bash
git add apps/web/src/lib/channel-binding-form.ts apps/web/src/lib/channel-binding-form.test.ts apps/web/src/app/channels/new/page.tsx
git commit -m "feat: use login session for channel setup ui"
```

## Task 9: Full Verification and Completion Audit

**Files:**
- Inspect all files changed by previous tasks.

- [ ] **Step 1: Run backend and repo verification**

Run:

```bash
npm run typecheck
npm test
```

Expected: both commands pass.

- [ ] **Step 2: Run Web verification**

Run:

```bash
cd apps/web && npx tsc --noEmit
cd apps/web && npm run lint
```

Expected: both commands pass.

- [ ] **Step 3: Audit the implementation against the spec**

Use this checklist:

- `auth.login` is exposed through `OpenClawPluginHost` and alias-aware.
- Feishu is login-capable through the same start/session/SSE API as WeChat.
- The child process captures stdout and stderr.
- Structured protocol events are separated from human output.
- The gateway exposes start, events, input, and cancel endpoints.
- SSE replays existing session events.
- Input API writes to child stdin and rejects terminal sessions.
- Existing QR start/wait endpoints remain in place.
- Web UI no longer depends on 30-second QR wait for WeChat/Feishu login-capable flows.
- No new code uses `as unknown as` or equivalent double-cast bypasses.

- [ ] **Step 4: Commit any final fixes**

If Step 3 finds a gap, make a narrow fix and commit it with:

```bash
git add <changed-files>
git commit -m "fix: complete channel login sse flow"
```

If Step 3 finds no gap, do not create an empty commit.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-04-channel-login-sse.md`. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
