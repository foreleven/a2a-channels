# InversifyJS 依赖注入改造设计

日期：2026-04-21  
范围：`a2a-channels` monorepo  
目标：在不污染 `domain` 的前提下，引入 InversifyJS 作为统一的依赖注入与组合根机制，并借此收敛当前代码结构与整洁架构之间的差距。

## 1. 背景与目标

当前仓库已经具备 `domain / application / infra / runtime` 的分层意图，但关键依赖方向仍未完全收敛：

- `runtime` 与 `scheduler` 仍直接触碰具体基础设施实现。
- `RelayRuntime` 同时承担本地状态聚合、OpenClaw runtime 装配、agent client 生命周期、连接协调与重连控制，职责过重。
- 查询侧快照读取仍通过 helper 直接 `new` 具体 repository，而不是依赖抽象 port。
- 入口文件同时承担环境初始化、对象组装、HTTP 组装与 runtime 生命周期管理，composition root 不够集中。

本设计的目标不是“把 `new` 替换成容器解析”，而是把 InversifyJS 作为外层装配工具，用于强制收敛依赖边界。

## 2. 设计原则

### 2.1 核心原则

1. InversifyJS 只服务于外层装配，不进入 `packages/domain`。
2. `domain` 继续保持零 Inversify 依赖、零 decorator、零 container symbol。
3. `application`、`runtime`、`infra` 的 class 统一采用 `@injectable()` 与 constructor `@inject(...)`。
4. 业务代码禁止使用 `container.get()`，禁止 service locator。
5. 依赖关系必须持续向内：use case 依赖 port，adapter 实现 port，composition root 负责绑定。

### 2.2 架构目标

改造完成后，仓库应满足以下目标：

- app 入口只负责启动，不再手工 `new` 核心对象。
- runtime / scheduler 不再直接依赖 Prisma repository 或快照 helper。
- `RelayRuntime` 被拆小为职责明确的多个服务。
- 查询侧与命令侧的依赖边界清晰。
- monorepo 中多个 app 采用统一的 container 组织方式。

## 3. 分层边界

### 3.1 Domain

`packages/domain` 只保留：

- entities / aggregates
- value objects
- domain events
- repository ports

明确不引入：

- InversifyJS
- `@injectable`
- `@inject`
- container token
- container module

### 3.2 Application

`application` 层负责 use case 编排，只依赖抽象 port，例如：

- `ChannelBindingRepository`
- `AgentConfigRepository`
- `DesiredStateReader`
- `RuntimeCoordinator`

该层允许 class + constructor injection，但不直接 import container，不依赖 Prisma、Hono、OpenClaw、Redis 等具体实现。

### 3.3 Runtime

`runtime` 层视为 application 与 adapter 之间的执行协调层，需要被进一步拆分。它应负责：

- 本地 ownership 状态维护
- runtime 投影与本地索引管理
- 连接生命周期协调
- reconcile 执行

它不应负责：

- 直接构造 repository
- 决定具体基础设施实现
- 在内部决定 transport 组合

### 3.4 Infra

`infra` 提供所有外部实现，包括：

- Prisma repositories
- 查询侧 reader
- outbox worker
- domain event bus
- OpenClaw 适配器
- transport registry / client factory
- Redis coordination

这些实现类允许使用 `@injectable()`，但不拥有装配权。

### 3.5 Composition Root

composition root 只存在于 app 入口，优先放在 `apps/gateway/src/bootstrap` 与 `apps/gateway/src/container`。

职责包括：

- 读取配置
- 创建 container
- 注册 modules / bindings
- 启动 runtime 生命周期
- 启动 HTTP 服务
- 处理 shutdown

## 4. Inversify 采用策略

### 4.1 使用范围

允许使用 `@injectable()` / `@inject()` 的对象：

- application services
- use case classes
- runtime services
- infra implementations
- provider / factory classes
- app bootstrap support services

禁止使用的对象：

- `packages/domain/*`
- interfaces / type aliases
- value objects
- 纯函数 utility 模块

### 4.2 注入规范

统一采用 constructor injection：

- 不使用 property injection
- 不在 class 内部调用 `container.get()`
- 不把 container 当作依赖下传

factory 仅用于：

- 第三方对象创建
- 按配置切换实现
- 异步资源初始化

## 5. Token 设计

### 5.1 命名规则

所有 `Symbol.for()` 的描述统一采用：

- 前缀小写
- 最后一段使用 `PascalCase`
- 最后一段必须与类名或抽象名一致

格式：

```text
lowercase.package.ClassName
```

示例：

- `ports.ChannelBindingRepository`
- `ports.AgentConfigRepository`
- `application.useCases.CreateChannelBinding`
- `application.useCases.ReconcileRuntimeState`
- `runtime.RelayRuntimeCoordinator`
- `runtime.RuntimeOwnershipService`
- `runtime.scheduling.LocalScheduler`
- `infra.persistence.PrismaChannelBindingRepository`
- `infra.events.DomainEventBus`
- `system.Config`

### 5.2 设计规则

1. 抽象 token 使用抽象名。
2. 具体实现 token 使用实现类名。
3. token 名称反映职责，不反映 binding 关系。
4. 不使用字符串字面量散落各处，统一由 token 常量导出。

## 6. 目录调整方案

推荐目标结构如下：

```text
apps/gateway/src/
  bootstrap/
    config.ts
    container.ts
    runtime.ts
    shutdown.ts

  container/
    tokens/
      ports.ts
      use-cases.ts
      runtime.ts
      infra.ts
      system.ts
    modules/
      application.ts
      runtime.ts
      infra.ts
      http.ts

  application/
    ports/
      desired-state-reader.ts
      domain-event-subscriber.ts
      runtime-coordinator.ts
    use-cases/
      create-channel-binding.ts
      update-channel-binding.ts
      delete-channel-binding.ts
      register-agent.ts
      update-agent.ts
      delete-agent.ts
      reconcile-runtime-state.ts
    services/
      channel-binding-service.ts
      agent-service.ts

  runtime/
    coordinator/
      relay-runtime-coordinator.ts
    ownership/
      runtime-ownership-service.ts
    projection/
      binding-runtime-projector.ts
    scheduling/
      scheduler.ts
      local-scheduler.ts
    connections/
      channel-connection-operator.ts
      reconnect-policy.ts

  infra/
    persistence/
      prisma-agent-config-repository.ts
      prisma-channel-binding-repository.ts
      prisma-desired-state-reader.ts
    events/
      domain-event-bus.ts
      outbox-worker.ts
    openclaw/
      openclaw-runtime-factory.ts
      openclaw-plugin-host-factory.ts
    transport/
      agent-transport-registry.ts
      agent-client-factory.ts
    cluster/
      redis-coordination.ts
      redis-ownership-gate.ts

  http/
    app.ts
    routes/
      channels.ts
      agents.ts
      runtime.ts

  index.ts
```

## 7. 关键重构落点

### 7.1 Composition Root 收敛

当前 `apps/gateway/src/index.ts` 同时负责：

- store 初始化
- repo 实例化
- service 装配
- runtime bootstrap
- Hono app 组装
- 进程生命周期管理

改造后应拆为：

- `bootstrap/config.ts`
- `bootstrap/container.ts`
- `bootstrap/runtime.ts`
- `http/app.ts`
- `bootstrap/shutdown.ts`

最终 `index.ts` 只负责流程编排。

### 7.2 Runtime 拆分

当前 `RelayRuntime` 需要拆分为以下对象：

- `RuntimeOwnershipService`
  - 维护 owned bindings
  - 维护 connection status
  - 产出 reconnect decision

- `BindingRuntimeProjector`
  - 维护 `bindingsById`
  - 维护 `agentsById`
  - 构建 runtime config 与索引

- `ChannelConnectionOperator`
  - 执行 start/stop/restart side effects
  - 对接 OpenClaw 与 agent client

- `RelayRuntimeCoordinator`
  - 编排 attach / refresh / detach
  - 作为 runtime 对外接口

### 7.3 Scheduler / Reconcile 重构

推荐拆分为：

- `Scheduler`
  - 只负责定时和事件触发

- `RuntimeReconciler`
  - 负责 desired state 与 local owned state 的比较
  - 产出 attach / detach / repair 决策

- `DesiredStateReader`
  - 负责读取查询侧快照

- `RuntimeCoordinator`
  - 负责执行 runtime attach / detach / refresh

这样 scheduler 不再直接依赖具体 snapshot helper 或 repository。

### 7.4 Query Port 引入

当前 runtime 读取配置的方式仍然是 helper 内直接构造具体 repository。改造后应引入：

- `DesiredStateReader`
- `RuntimeStatusReader`（如后续 UI 需要 operational state 查询）

由 infra 提供：

- `PrismaDesiredStateReader`

命令侧 repository 与查询侧 reader 分开注册与绑定，不再混成“store service”。

## 8. 分阶段迁移计划

### Phase 0：容器基础设施

目标：

- 引入 InversifyJS 与 decorator 元数据支持
- 建立 token、container、module 骨架
- 保证 gateway 可通过 container 启动

验收标准：

- `index.ts` 不再直接手工实例化核心 service / repo
- `domain` 无 Inversify 依赖

### Phase 1：应用层与基础设施层迁移

范围：

- `ChannelBindingService`
- `AgentService`
- use case classes
- Prisma repositories
- `DomainEventBus`
- `OutboxWorker`

验收标准：

- `/api/channels` 与 `/api/agents` 的依赖由 container 装配
- 单元测试可用 mock binding 替换 repo

### Phase 2：Runtime / Scheduler 重构并接入容器

范围：

- 拆小 `RelayRuntime`
- 引入 `DesiredStateReader`
- 重构 `LocalScheduler`
- 引入 `RuntimeReconciler`

验收标准：

- runtime / scheduler 不再直接构造 infra repository
- runtime 类职责明显收敛
- 现有 runtime 行为测试通过

### Phase 3：扩展到其余 app

范围：

- `apps/echo-agent`
- 后续 cluster bootstrap
- 其他 app 入口

验收标准：

- 各 app 采用统一 container 规范
- package 间不出现互相 import container 的情况

## 9. 测试策略

### 9.1 Domain Test

- 完全不经过 container
- 直接实例化 domain 对象

### 9.2 Application / Runtime Unit Test

- 通过 constructor 注入 mock port
- 或使用测试专用 container

### 9.3 Integration Test

- 使用真实 container
- 覆盖 wiring、Prisma、Outbox、runtime adapter 的协作

测试规则：

1. 单测不 import 全局 container。
2. integration test 才验证 wiring。
3. 每个 use case / runtime service 都应可以脱离真实基础设施测试。

## 10. 非目标

本次改造不直接包含以下事项：

- 把 `packages/domain` 改成 Inversify aware
- 用容器替代领域建模问题
- 一次性完成所有 runtime 语义重构
- 用全局 container 解决测试隔离

## 11. 风险与控制

主要风险：

- 先铺满 decorator，后补边界，导致结构问题被“注入语法”掩盖。
- runtime 未拆分前直接接入容器，形成更隐蔽的 God object。
- token 命名与目录组织不稳定，后续扩展到 monorepo 时失控。

控制策略：

1. 先引入 port，再引入 binding。
2. 先拆 runtime / scheduler 边界，再全面接入容器。
3. 统一 token 命名规则与 module 组织方式。
4. 严格禁止 service locator。

## 12. 最终建议

推荐采用以下落地顺序：

1. 建立 container、token、module 基础设施。
2. 先迁移 application + infra 命令侧。
3. 引入 `DesiredStateReader`，清理 runtime 中直接构造 repo 的路径。
4. 拆分 `RelayRuntime`，引入 `RuntimeReconciler`。
5. 重写 scheduler 依赖方向。
6. 最后推广到 monorepo 其他 app。

该顺序的核心价值在于：InversifyJS 被用作整洁架构的执行机制，而不是单纯的实例化工具。
