# Inversify DI Foundation and Gateway Command Side Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce InversifyJS as the gateway composition mechanism for configuration, repositories, application services, and HTTP assembly without changing runtime behavior.

**Architecture:** This first execution slice intentionally stops before the `RelayRuntime` split from the spec. It creates a shared DI token package, moves gateway command-side wiring behind a container, injects infra/application classes with `@injectable()` and `@inject()`, and moves HTTP assembly out of `index.ts`. Runtime refactoring, query-port introduction, and cross-app rollout remain follow-up plans.

**Tech Stack:** TypeScript 6, Node.js test runner, InversifyJS, reflect-metadata, Prisma + SQLite, Hono, tsx, pnpm workspaces

---

## Scope Check

The spec covers three subsystems that should not ship in one execution plan:

1. Gateway DI foundation and command-side migration
2. Runtime/scheduler refactor and query-port introduction
3. Expansion to `apps/echo-agent` and later app entrypoints

This plan only implements subsystem 1. Create separate follow-up plans for subsystems 2 and 3 after this slice lands cleanly.

## File Structure

- Create: `packages/di/package.json`
  Workspace package for shared DI token exports used by apps without importing a concrete container.

- Create: `packages/di/src/index.ts`
- Create: `packages/di/src/tokens/ports.ts`
- Create: `packages/di/src/tokens/services.ts`
- Create: `packages/di/src/tokens/system.ts`
  Shared token constants using the `lowercase.package.ClassName` naming convention.

- Modify: `tsconfig.json`
  Add the `@a2a-channels/di` path alias plus decorator metadata compiler settings.

- Modify: `apps/gateway/package.json`
  Add `inversify`, `reflect-metadata`, and `@a2a-channels/di`.

- Create: `apps/gateway/src/bootstrap/config.ts`
  Parse environment into a typed `GatewayConfig` object that can be injected.

- Create: `apps/gateway/src/bootstrap/container.ts`
  Build the gateway container and load infra/application/http modules.

- Create: `apps/gateway/src/container/modules/infra.ts`
- Create: `apps/gateway/src/container/modules/application.ts`
  Register repositories, event bus, outbox worker, config, and application services.

- Create: `apps/gateway/src/container/container.test.ts`
  Smoke-test container resolution, singleton behavior, and application service wiring.

- Modify: `apps/gateway/src/infra/agent-config-repo.ts`
- Modify: `apps/gateway/src/infra/channel-binding-repo.ts`
- Modify: `apps/gateway/src/infra/domain-event-bus.ts`
- Modify: `apps/gateway/src/infra/outbox-worker.ts`
  Convert infra implementations to `@injectable()` classes with constructor injection.

- Modify: `apps/gateway/src/application/agent-service.ts`
- Modify: `apps/gateway/src/application/channel-binding-service.ts`
  Convert application facades to injectable classes that resolve repo ports by token.

- Create: `apps/gateway/src/http/app.ts`
- Create: `apps/gateway/src/http/routes/channels.ts`
- Create: `apps/gateway/src/http/routes/agents.ts`
- Create: `apps/gateway/src/http/routes/runtime.ts`
- Create: `apps/gateway/src/http/app.test.ts`
  Assemble the Hono app from injected services and verify the REST surface still works.

- Modify: `apps/gateway/src/index.ts`
  Replace manual repo/service construction with config parsing, container build, app build, and container-resolved worker startup.

---

### Task 1: Establish the DI Foundation

**Files:**
- Create: `packages/di/package.json`
- Create: `packages/di/src/index.ts`
- Create: `packages/di/src/tokens/ports.ts`
- Create: `packages/di/src/tokens/services.ts`
- Create: `packages/di/src/tokens/system.ts`
- Create: `apps/gateway/src/bootstrap/config.ts`
- Create: `apps/gateway/src/bootstrap/container.ts`
- Create: `apps/gateway/src/container/container.test.ts`
- Modify: `tsconfig.json`
- Modify: `apps/gateway/package.json`

- [ ] **Step 1: Write the failing container smoke test**

```ts
// apps/gateway/src/container/container.test.ts
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { Container } from "inversify";
import { SYSTEM_TOKENS } from "@a2a-channels/di";

import { initStore } from "../services/initialization.js";
import { buildGatewayConfig } from "../bootstrap/config.js";
import { buildGatewayContainer } from "../bootstrap/container.js";

describe("buildGatewayContainer", () => {
  before(async () => {
    process.env["DB_PATH"] = "/tmp/test-a2a-container.db";
    await initStore();
  });

  test("resolves typed config", async () => {
    const config = buildGatewayConfig({ port: 7891 });
    const container: Container = buildGatewayContainer(config);

    assert.equal(container.get(SYSTEM_TOKENS.GatewayConfig).port, 7891);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-container.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts
```

Expected:

```text
not ok 1 - buildGatewayContainer
error: Cannot find module '../bootstrap/container.js'
```

- [ ] **Step 3: Add the DI workspace package, compiler settings, and minimal container**

```json
// packages/di/package.json
{
  "name": "@a2a-channels/di",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" }
}
```

```ts
// packages/di/src/tokens/system.ts
export const SYSTEM_TOKENS = {
  GatewayConfig: Symbol.for("system.GatewayConfig"),
} as const;

// packages/di/src/tokens/services.ts
export const SERVICE_TOKENS = {
  ChannelBindingService: Symbol.for("services.ChannelBindingService"),
  AgentService: Symbol.for("services.AgentService"),
} as const;

// packages/di/src/tokens/ports.ts
export const PORT_TOKENS = {
  ChannelBindingRepository: Symbol.for("ports.ChannelBindingRepository"),
  AgentConfigRepository: Symbol.for("ports.AgentConfigRepository"),
} as const;

// packages/di/src/index.ts
export * from "./tokens/ports.js";
export * from "./tokens/services.js";
export * from "./tokens/system.js";
```

```json
// apps/gateway/package.json
{
  "dependencies": {
    "@a2a-channels/di": "workspace:*",
    "inversify": "^7.7.1",
    "reflect-metadata": "^0.2.2"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "paths": {
      "@a2a-channels/di": [
        "./packages/di/src/index.ts"
      ]
    }
  }
}
```

```ts
// apps/gateway/src/bootstrap/config.ts
export interface GatewayConfig {
  port: number;
  corsOrigin: string;
}

export function buildGatewayConfig(overrides: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    port: overrides.port ?? Number(process.env["PORT"] ?? 7890),
    corsOrigin: overrides.corsOrigin ?? process.env["CORS_ORIGIN"] ?? "http://localhost:3000",
  };
}
```

```ts
// apps/gateway/src/bootstrap/container.ts
import "reflect-metadata";
import { Container } from "inversify";
import { SYSTEM_TOKENS } from "@a2a-channels/di";

import type { GatewayConfig } from "./config.js";

export function buildGatewayContainer(config: GatewayConfig): Container {
  const container = new Container({ defaultScope: "Singleton" });
  container.bind(SYSTEM_TOKENS.GatewayConfig).toConstantValue(config);
  return container;
}
```

Run:

```bash
pnpm --dir /Users/feng/Projects/a2a-channels install
```

- [ ] **Step 4: Run the test and typecheck to verify the DI skeleton works**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-container.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts
pnpm --dir /Users/feng/Projects/a2a-channels typecheck
```

Expected:

```text
ok 1 - resolves typed config
Found 0 errors.
```

- [ ] **Step 5: Commit**

```bash
git add packages/di apps/gateway/package.json apps/gateway/src/bootstrap apps/gateway/src/container/container.test.ts tsconfig.json
git commit -m "feat: add inversify container foundation"
```

### Task 2: Inject Infra Implementations Through Container Modules

**Files:**
- Create: `apps/gateway/src/container/modules/infra.ts`
- Modify: `apps/gateway/src/infra/agent-config-repo.ts`
- Modify: `apps/gateway/src/infra/channel-binding-repo.ts`
- Modify: `apps/gateway/src/infra/domain-event-bus.ts`
- Modify: `apps/gateway/src/infra/outbox-worker.ts`
- Modify: `apps/gateway/src/bootstrap/container.ts`
- Test: `apps/gateway/src/container/container.test.ts`

- [ ] **Step 1: Extend the smoke test to cover infra singletons**

```ts
test("reuses singleton infra bindings", async () => {
  const config = buildGatewayConfig({ port: 7892 });
  const container = buildGatewayContainer(config);

  const busA = container.get(DI_TOKENS.DomainEventBus);
  const busB = container.get(DI_TOKENS.DomainEventBus);
  const worker = container.get(DI_TOKENS.OutboxWorker);

  assert.equal(busA, busB);
  assert.equal(worker["eventBus"], busA);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-container.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts --test-name-pattern "singleton infra"
```

Expected:

```text
error: No bindings found for service identifier: Symbol(infra.events.DomainEventBus)
```

- [ ] **Step 3: Make infra classes injectable and register them**

```ts
// packages/di/src/tokens/services.ts
export const DI_TOKENS = {
  DomainEventBus: Symbol.for("infra.events.DomainEventBus"),
  OutboxWorker: Symbol.for("infra.events.OutboxWorker"),
} as const;
```

```ts
// apps/gateway/src/infra/domain-event-bus.ts
import { injectable } from "inversify";

@injectable()
export class DomainEventBus {
  // keep existing implementation unchanged
}

// apps/gateway/src/infra/outbox-worker.ts
import { inject, injectable } from "inversify";
import { DI_TOKENS } from "@a2a-channels/di";

@injectable()
export class OutboxWorker {
  constructor(
    @inject(DI_TOKENS.DomainEventBus)
    private readonly eventBus: DomainEventBus,
    private readonly options: OutboxWorkerOptions = {},
  ) {}
}

// apps/gateway/src/infra/channel-binding-repo.ts
import { injectable } from "inversify";

@injectable()
export class ChannelBindingStateRepository implements ChannelBindingRepository {
  // keep existing methods unchanged
}

// apps/gateway/src/infra/agent-config-repo.ts
import { injectable } from "inversify";

@injectable()
export class AgentConfigStateRepository implements AgentConfigRepository {
  // keep existing methods unchanged
}
```

```ts
// apps/gateway/src/container/modules/infra.ts
import { ContainerModule } from "inversify";
import { DI_TOKENS, PORT_TOKENS } from "@a2a-channels/di";

import { AgentConfigStateRepository } from "../../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../../infra/channel-binding-repo.js";
import { DomainEventBus } from "../../infra/domain-event-bus.js";
import { OutboxWorker } from "../../infra/outbox-worker.js";

export const infraModule = new ContainerModule(({ bind }) => {
  bind(PORT_TOKENS.AgentConfigRepository).to(AgentConfigStateRepository).inSingletonScope();
  bind(PORT_TOKENS.ChannelBindingRepository).to(ChannelBindingStateRepository).inSingletonScope();
  bind(DI_TOKENS.DomainEventBus).to(DomainEventBus).inSingletonScope();
  bind(DI_TOKENS.OutboxWorker).to(OutboxWorker).inSingletonScope();
});
```

```ts
// apps/gateway/src/bootstrap/container.ts
import { infraModule } from "../container/modules/infra.js";

export function buildGatewayContainer(config: GatewayConfig): Container {
  const container = new Container({ defaultScope: "Singleton" });
  container.bind(SYSTEM_TOKENS.GatewayConfig).toConstantValue(config);
  container.loadSync(infraModule);
  return container;
}
```

- [ ] **Step 4: Run the targeted test**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-container.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts --test-name-pattern "singleton infra"
```

Expected:

```text
ok 1 - reuses singleton infra bindings
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/infra apps/gateway/src/container/modules/infra.ts apps/gateway/src/bootstrap/container.ts packages/di/src
git commit -m "feat: bind gateway infra through container modules"
```

### Task 3: Inject Application Services

**Files:**
- Create: `apps/gateway/src/container/modules/application.ts`
- Modify: `apps/gateway/src/application/channel-binding-service.ts`
- Modify: `apps/gateway/src/application/agent-service.ts`
- Modify: `apps/gateway/src/bootstrap/container.ts`
- Test: `apps/gateway/src/container/container.test.ts`

- [ ] **Step 1: Extend the smoke test to verify service resolution and basic reads**

```ts
test("resolves application services backed by injected repositories", async () => {
  const config = buildGatewayConfig({ port: 7893 });
  const container = buildGatewayContainer(config);

  const channels = await container
    .get<ChannelBindingService>(SERVICE_TOKENS.ChannelBindingService)
    .list();
  const agents = await container
    .get<AgentService>(SERVICE_TOKENS.AgentService)
    .list();

  assert.ok(Array.isArray(channels));
  assert.ok(Array.isArray(agents));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-container.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts --test-name-pattern "application services"
```

Expected:

```text
error: No bindings found for service identifier: Symbol(services.ChannelBindingService)
```

- [ ] **Step 3: Decorate services and bind them to the container**

```ts
// apps/gateway/src/application/channel-binding-service.ts
import { inject, injectable } from "inversify";
import { PORT_TOKENS } from "@a2a-channels/di";

@injectable()
export class ChannelBindingService {
  constructor(
    @inject(PORT_TOKENS.ChannelBindingRepository)
    private readonly repo: ChannelBindingRepository,
    @inject(PORT_TOKENS.AgentConfigRepository)
    private readonly agentRepo: AgentConfigRepository,
  ) {}
}

// apps/gateway/src/application/agent-service.ts
import { inject, injectable } from "inversify";
import { PORT_TOKENS } from "@a2a-channels/di";

@injectable()
export class AgentService {
  constructor(
    @inject(PORT_TOKENS.AgentConfigRepository)
    private readonly repo: AgentConfigRepository,
    @inject(PORT_TOKENS.ChannelBindingRepository)
    private readonly bindingRepo: ChannelBindingRepository,
  ) {}
}
```

```ts
// apps/gateway/src/container/modules/application.ts
import { ContainerModule } from "inversify";
import { SERVICE_TOKENS } from "@a2a-channels/di";

import { AgentService } from "../../application/agent-service.js";
import { ChannelBindingService } from "../../application/channel-binding-service.js";

export const applicationModule = new ContainerModule(({ bind }) => {
  bind(SERVICE_TOKENS.ChannelBindingService).to(ChannelBindingService).inSingletonScope();
  bind(SERVICE_TOKENS.AgentService).to(AgentService).inSingletonScope();
});
```

```ts
// apps/gateway/src/bootstrap/container.ts
import { applicationModule } from "../container/modules/application.js";

container.loadSync(infraModule, applicationModule);
```

- [ ] **Step 4: Run the targeted test and the existing gateway test suite**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-container.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts --test-name-pattern "application services"
pnpm --dir /Users/feng/Projects/a2a-channels/apps/gateway test
```

Expected:

```text
ok 1 - resolves application services backed by injected repositories
# existing gateway tests remain green
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/application apps/gateway/src/container/modules/application.ts apps/gateway/src/bootstrap/container.ts apps/gateway/src/container/container.test.ts
git commit -m "feat: inject gateway application services"
```

### Task 4: Assemble the HTTP App From Injected Services

**Files:**
- Create: `apps/gateway/src/http/app.ts`
- Create: `apps/gateway/src/http/routes/channels.ts`
- Create: `apps/gateway/src/http/routes/agents.ts`
- Create: `apps/gateway/src/http/routes/runtime.ts`
- Create: `apps/gateway/src/http/app.test.ts`
- Modify: `apps/gateway/src/index.ts`

- [ ] **Step 1: Write the failing HTTP composition test**

```ts
// apps/gateway/src/http/app.test.ts
import { before, describe, test } from "node:test";
import assert from "node:assert/strict";

import { initStore } from "../services/initialization.js";
import { buildGatewayConfig } from "../bootstrap/config.js";
import { buildGatewayContainer } from "../bootstrap/container.js";
import { buildHttpApp } from "./app.js";

describe("buildHttpApp", () => {
  before(async () => {
    process.env["DB_PATH"] = "/tmp/test-a2a-http.db";
    await initStore();
  });

  test("serves channel and agent APIs through container-injected services", async () => {
    const app = buildHttpApp(buildGatewayContainer(buildGatewayConfig({ port: 7894 })));

    const channels = await app.request("/api/channels");
    const agents = await app.request("/api/agents");

    assert.equal(channels.status, 200);
    assert.equal(agents.status, 200);
    assert.ok(Array.isArray(await channels.json()));
    assert.ok(Array.isArray(await agents.json()));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-http.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/http/app.test.ts
```

Expected:

```text
error: Cannot find module './app.js'
```

- [ ] **Step 3: Extract HTTP assembly and switch `index.ts` to it**

```ts
// apps/gateway/src/http/routes/channels.ts
import { Hono } from "hono";
import { SERVICE_TOKENS } from "@a2a-channels/di";
import type { Container } from "inversify";

import { ChannelBindingService } from "../../application/channel-binding-service.js";
import type { UpdateChannelBindingData } from "../../application/channel-binding-service.js";
import {
  AgentNotFoundError,
  DuplicateEnabledBindingError,
} from "../../application/errors.js";

export function registerChannelRoutes(app: Hono, container: Container): void {
  const channelBindingService = container.get<ChannelBindingService>(SERVICE_TOKENS.ChannelBindingService);

  app.get("/api/channels", async (c) => c.json(await channelBindingService.list()));
  app.get("/api/channels/:id", async (c) => {
    const binding = await channelBindingService.getById(c.req.param("id"));
    return binding ? c.json(binding) : c.json({ error: "Not found" }, 404);
  });

  app.post("/api/channels", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    try {
      const binding = await channelBindingService.create({
        name: String(body["name"]),
        channelType: (body["channelType"] as string | undefined) ?? "feishu",
        channelConfig: body["channelConfig"] as Record<string, unknown>,
        accountId: (body["accountId"] as string | undefined) ?? "default",
        agentId: String(body["agentId"]),
        enabled: (body["enabled"] as boolean | undefined) ?? true,
      });
      return c.json(binding, 201);
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof DuplicateEnabledBindingError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  app.patch("/api/channels/:id", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    try {
      const updated = await channelBindingService.update(
        c.req.param("id"),
        body as UpdateChannelBindingData,
      );
      return updated
        ? c.json(updated)
        : c.json({ error: `Channel ${c.req.param("id")} not found` }, 404);
    } catch (err) {
      if (err instanceof AgentNotFoundError) return c.json({ error: err.message }, 404);
      if (err instanceof DuplicateEnabledBindingError) return c.json({ error: err.message }, 409);
      throw err;
    }
  });

  app.delete("/api/channels/:id", async (c) => {
    const deleted = await channelBindingService.delete(c.req.param("id"));
    return deleted
      ? c.json({ deleted: true })
      : c.json({ error: `Channel ${c.req.param("id")} not found` }, 404);
  });
}
```

```ts
// apps/gateway/src/http/routes/agents.ts
import { Hono } from "hono";
import { SERVICE_TOKENS } from "@a2a-channels/di";
import type { Container } from "inversify";

import { AgentService, ReferencedAgentError } from "../../application/agent-service.js";
import type { UpdateAgentData } from "../../application/agent-service.js";

export function registerAgentRoutes(app: Hono, container: Container): void {
  const agentService = container.get<AgentService>(SERVICE_TOKENS.AgentService);
  app.get("/api/agents", async (c) => c.json(await agentService.list()));
  app.get("/api/agents/:id", async (c) => {
    const agent = await agentService.getById(c.req.param("id"));
    return agent ? c.json(agent) : c.json({ error: "Not found" }, 404);
  });

  app.post("/api/agents", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const agent = await agentService.register({
      name: String(body["name"]),
      url: String(body["url"]),
      protocol: (body["protocol"] as string | undefined) ?? "a2a",
      description: body["description"] as string | undefined,
    });
    return c.json(agent, 201);
  });

  app.patch("/api/agents/:id", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    const updated = await agentService.update(c.req.param("id"), body as UpdateAgentData);
    return updated
      ? c.json(updated)
      : c.json({ error: `Agent ${c.req.param("id")} not found` }, 404);
  });

  app.delete("/api/agents/:id", async (c) => {
    try {
      const deleted = await agentService.delete(c.req.param("id"));
      return deleted
        ? c.json({ deleted: true })
        : c.json({ error: `Agent ${c.req.param("id")} not found` }, 404);
    } catch (err) {
      if (err instanceof ReferencedAgentError) {
        return c.json({ error: err.message, bindingIds: err.bindingIds }, 409);
      }
      throw err;
    }
  });
}
```

```ts
// apps/gateway/src/http/routes/runtime.ts
import { Hono } from "hono";

export function registerRuntimeRoutes(app: Hono, listConnectionStatuses: () => unknown): void {
  app.get("/api/runtime/connections", async (c) => c.json(listConnectionStatuses()));
}
```

```ts
// apps/gateway/src/http/app.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Container } from "inversify";
import { SYSTEM_TOKENS } from "@a2a-channels/di";

import type { GatewayConfig } from "../bootstrap/config.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerRuntimeRoutes } from "./routes/runtime.js";

export function buildHttpApp(
  container: Container,
  options: { listConnectionStatuses?: () => unknown } = {},
): Hono {
  const config = container.get<GatewayConfig>(SYSTEM_TOKENS.GatewayConfig);
  const app = new Hono();

  app.use(
    "/api/*",
    cors({
      origin: config.corsOrigin,
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  registerChannelRoutes(app, container);
  registerAgentRoutes(app, container);
  registerRuntimeRoutes(app, options.listConnectionStatuses ?? (() => []));
  return app;
}
```

```ts
// apps/gateway/src/index.ts
import "reflect-metadata";

const config = buildGatewayConfig();
const container = buildGatewayContainer(config);
const app = buildHttpApp(container, {
  listConnectionStatuses: () => relay.listConnectionStatuses(),
});
```

- [ ] **Step 4: Run the HTTP test and typecheck**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-http.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/http/app.test.ts
pnpm --dir /Users/feng/Projects/a2a-channels typecheck
```

Expected:

```text
ok 1 - serves channel and agent APIs through container-injected services
Found 0 errors.
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/http apps/gateway/src/index.ts
git commit -m "feat: assemble gateway http app from injected services"
```

### Task 5: Finish Bootstrap Handoff and Verify the Slice

**Files:**
- Modify: `apps/gateway/src/index.ts`
- Modify: `apps/gateway/src/bootstrap/container.ts`
- Test: `apps/gateway/src/container/container.test.ts`
- Test: `apps/gateway/src/http/app.test.ts`

- [ ] **Step 1: Write a final bootstrap regression assertion**

```ts
test("container builds once and can start the outbox worker", async () => {
  const container = buildGatewayContainer(buildGatewayConfig({ port: 7895 }));
  const worker = container.get<OutboxWorker>(DI_TOKENS.OutboxWorker);

  worker.start();
  await worker.stop();

  assert.ok(worker);
});
```

- [ ] **Step 2: Run the regression assertion and existing gateway suite**

Run:

```bash
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-http.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts --test-name-pattern "outbox worker"
pnpm --dir /Users/feng/Projects/a2a-channels/apps/gateway test
```

Expected:

```text
ok 1 - container builds once and can start the outbox worker
# existing gateway tests remain green
```

- [ ] **Step 3: Move the manual event-bus/worker wiring in `index.ts` behind the container**

```ts
// apps/gateway/src/index.ts
const container = buildGatewayContainer(config);
const outboxWorker = container.get<OutboxWorker>(DI_TOKENS.OutboxWorker);

await initStore();
await seedDefaults();
outboxWorker.start();

process.on("SIGINT", async () => {
  await bootstrap.scheduler.stop();
  await outboxWorker.stop();
  await relay.shutdown();
  server.close();
});
```

- [ ] **Step 4: Run the full verification set**

Run:

```bash
pnpm --dir /Users/feng/Projects/a2a-channels typecheck
pnpm --dir /Users/feng/Projects/a2a-channels/apps/gateway test
cd /Users/feng/Projects/a2a-channels/apps/gateway && DB_PATH=/tmp/test-a2a-http.db NODE_PATH=../../node_modules/.pnpm/node_modules node --import tsx/esm --test src/container/container.test.ts src/http/app.test.ts
```

Expected:

```text
Found 0 errors.
# test suites pass
```

- [ ] **Step 5: Commit**

```bash
git add apps/gateway/src/index.ts apps/gateway/src/bootstrap/container.ts apps/gateway/src/container/container.test.ts apps/gateway/src/http/app.test.ts
git commit -m "refactor: move gateway bootstrap wiring behind container"
```

## Self-Review

### Spec coverage

- Covered from the spec:
  - Inversify only in outer layers
  - shared token package
  - config/container bootstrap
  - infra/application constructor injection
  - HTTP assembly moved out of `index.ts`
  - token naming convention

- Explicitly deferred to follow-up plans:
  - `RelayRuntime` split
  - `DesiredStateReader`
  - scheduler/reconciler redesign
  - `apps/echo-agent` rollout

### Placeholder scan

- No `TBD`/`TODO` placeholders remain.
- Every task includes exact files, code snippets, commands, and expected output.

### Type consistency

- Shared token names are consistent across tasks:
  - `PORT_TOKENS`
  - `SERVICE_TOKENS`
  - `SYSTEM_TOKENS`
  - `DI_TOKENS`
- `buildGatewayConfig` and `buildGatewayContainer` names are used consistently.
