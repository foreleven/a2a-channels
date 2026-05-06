# Agent Relay 当前架构设计（代码现状对比版）

本文档重写自旧版 `architecture-design-zh.md`，目标是把**当前代码真实架构**说清楚，并明确它与旧文档中“目标态 / Phase 2 设计”的差异。

重点结论：当前仓库已经从早期“`RelayRuntime` 作为本地聚合根直接负责 attach / refresh / detach”的描述，演进为更清晰的 runtime 分层：

```text
持久化 desired state
  -> Scheduler / RuntimeAssignmentCoordinator
  -> RuntimeCommandHandler
  -> RuntimeAssignmentService
  -> RuntimeOwnershipState + ConnectionManager
  -> OpenClaw plugin monitor
  -> Agent transport
```

当前可运行模式是 **local single-node runtime**。集群相关的 Redis lease、leader scheduler、rebalance/failover 仍是未接入或占位能力，不能按已实现功能理解。

---

## 1. 当前系统目标

Agent Relay Gateway 的核心职责是把外部消息渠道连接到 A2A/ACP Agent：

```text
Channel Provider（如 Feishu/Lark）
  -> OpenClaw channel plugin monitor
  -> Gateway runtime connection manager
  -> Agent transport（A2A / ACP）
  -> Agent response text
  -> Channel reply dispatcher
```

系统处理两类变化：

1. **低频配置变化**：Agent 配置、Channel Binding 配置。
2. **高频运行时消息**：渠道 inbound message、Agent 调用、渠道 reply。

当前代码的主要设计选择是：

- Agent 和 Channel Binding 采用 **current-state persistence**，不采用完整 Event Sourcing。
- Runtime 通过启动和周期 reconcile 从 repository 读取最新 desired state，经过 scheduler / coordinator 变成本节点执行命令。
- OpenClaw runtime 只作为 channel plugin compatibility layer，不执行 OpenClaw 原生 LLM pipeline。
- Agent 调用统一通过 `@agent-relay/agent-transport` 的 A2A/ACP transport。

---

## 2. 与旧架构文档的关键差异

旧文档中有些内容仍然是正确方向，但已经不完全匹配当前代码。下面先列出最重要的变化，避免继续按旧 mental model 理解 runtime。

### 2.1 `RelayRuntime` 不再是 assignment 决策入口

旧文档多处把 `RelayRuntime` 描述为“本地聚合根”，并使用类似：

```text
RelayRuntime.attachBinding(bindingId)
RelayRuntime.refreshBinding(bindingId)
RelayRuntime.detachBinding(bindingId)
```

当前代码不是这样组织的。

当前实现中：

- `RuntimeAssignmentCoordinator` 负责 desired-state reconciliation。
- `RuntimeCommandHandler` 负责执行 `AttachBinding` / `DetachBinding` / `RefreshBinding` 命令。
- `RuntimeAssignmentService` 负责本节点 assignment side effects。
- `RuntimeOwnershipState` 保存 owned bindings 与 connection statuses。
- `ConnectionManager` 执行 channel connection side effects。
- `RelayRuntime` 只是 runtime relay path 的组合根：装配 OpenClaw runtime/host，并初始化 `ConnectionManager` 的 callbacks。

因此，当前边界规则是：

```text
Coordinator 不通过 RelayRuntime 分配 binding。
RelayRuntime 不从 DB 推导 desired state。
RuntimeAssignmentService 才是本节点 assignment 写入口。
ConnectionManager 只做 imperative side effects。
```

### 2.2 当前只有 local single-node runtime

旧文档较大篇幅描述了 Redis RuntimeEventBus、leader lease、binding lease、rebalance、failover 等集群目标态。

当前代码中：

- `CLUSTER_MODE=true` 会在 `buildGatewayContainer()` 阶段直接抛错。
- 当前实际绑定的是 `LocalRuntimeEventBus`、`LocalScheduler`、`LocalOwnershipGate`。
- `RedisOwnershipGate` 方法未接线，调用 acquire/renew/release 会抛错。
- `LeaderScheduler` 和 Redis coordination key 文件只表示未来边界，不是当前生产路径。

所以本文档后续只把集群内容作为“未实现边界”说明，不再把它写成已可运行流程。

### 2.3 重连职责已经下沉到 assignment / ownership 路径

旧文档说 `RelayRuntime` 持有 reconnect policy 并直接安排 backoff repair。

当前代码中，连接状态回调路径是：

```text
ConnectionManager callback
  -> RelayRuntime 初始化时注册的 callback
  -> RuntimeAssignmentService.handleOwnedConnectionStatus()
  -> RuntimeOwnershipState 状态转移
  -> RuntimeAssignmentService.scheduleReconnect()
  -> ConnectionManager.restartConnection()
```

也就是说，`RelayRuntime` 仍在 callback wiring 上出现，但不持有主要状态和重连决策。

### 2.4 OpenClaw 配置来自 runtime-owned bindings projection

旧文档中对 config 的描述较抽象。

当前实现中，`RuntimeOpenClawConfigProjection` 从 `RuntimeOwnershipState.listOwnedBindings()` 生成 OpenClaw config。只有当前节点 owned 且 enabled 的 bindings 会进入 OpenClaw-compatible config。binding/account 到 agent URL 的路由由 runtime agent registry 和 connection manager 解析，不由 OpenClaw 原生 agent pipeline 处理。

### 2.5 HTTP API 只暴露数据库读写模型

`/api/runtime/nodes` 和 `/api/runtime/connections` 已移除。它们依赖本节点内存或 Redis snapshot，HTTP 请求无法指定集群中的目标 gateway 节点，语义不稳定。

当前 HTTP API 应只暴露数据库里的 desired state，例如 channels 和 agents。runtime executor 的本地连接状态只用于进程内调度、重连和消息转发，不作为 gateway REST API 的 read model。

---

## 3. 核心概念

### 3.1 Agent

Agent 表示后端 A2A/ACP 服务端点。它的核心字段包括：

```text
id
name
url
protocol
description / metadata（如有）
createdAt / updatedAt
```

Agent 配置是低频状态。它自身不会启动 channel connection，但 binding 引用的 `agentId` 会决定 inbound message 被转发到哪个 Agent URL 和协议。

### 3.2 Channel Binding

Channel Binding 表示一个 channel account 与 Agent 的绑定关系。它的核心字段包括：

```text
id
name
channelType
accountId
credentials / config
agentId
enabled
createdAt / updatedAt
```

Binding 是 runtime connection 的 desired state。`enabled=true` 且引用的 agent 存在时，runtime 才会尝试为它启动 channel plugin monitor。

### 3.3 Desired State

Desired State 是持久化配置事实，来源是 repository / DB state tables。

它回答：

```text
系统希望有哪些 Agent？
系统希望有哪些 Channel Binding？
哪些 Binding enabled？
Binding 绑定哪个 Agent？
```

Desired State 不等于当前连接已经健康运行。runtime 必须通过 reconciliation 把 desired state 收敛为本进程的 side effects。

### 3.4 Runtime Ownership State

当前 local mode 下，ownership 是本进程内状态，由 `RuntimeOwnershipState` 和 `LocalOwnershipGate` 维护。

它回答：

```text
当前进程持有哪些 binding？
每个 binding 的 connection status 是什么？
失败次数是多少？
下一次重连是什么时候？
最近错误是什么？
```

当前没有分布式 owner state。Redis binding lease 是未实现目标。

### 3.5 Connection Status

Connection Status 是 operational state，不写入主配置表。当前状态类型包括：

```text
idle
connecting
connected
disconnected
error
```

状态来源是 `ConnectionManager` lifecycle callback，经 `RuntimeAssignmentService` 写入 `RuntimeOwnershipState`，再由 snapshot publisher 暴露给查询侧。

---

## 4. 当前分层架构

### 4.1 Bootstrap / Composition

负责进程启动、配置解析和 DI 装配。

关键文件：

- `apps/gateway/src/index.ts`
- `apps/gateway/src/bootstrap/config.ts`
- `apps/gateway/src/bootstrap/container.ts`
- `apps/gateway/src/bootstrap/gateway-server.ts`

执行链路：

```text
index.ts
  -> buildGatewayContainer()
  -> GatewayServer.start()
  -> RelayRuntime.bootstrap()
  -> HTTP listen
```

### 4.2 Runtime Coordination

负责把启动和周期 tick 变成 runtime 收敛。

关键文件：

- `apps/gateway/src/runtime/event-transport/*`
- `apps/gateway/src/runtime/local/local-scheduler.ts`
- `apps/gateway/src/runtime/runtime-assignment-coordinator.ts`
- `apps/gateway/src/runtime/runtime-command-handler.ts`

当前 local mode 的收敛路径：

```text
LocalScheduler startup / interval tick
  -> RuntimeAssignmentCoordinator.reconcile()
  -> LocalRuntimeEventBus.sendDirected(Attach / Detach / Refresh)
  -> RuntimeCommandHandler.handle()
```

### 4.3 Assignment / Ownership

负责把 directed command 应用到本节点 runtime state 和 connections。

关键文件：

- `apps/gateway/src/runtime/runtime-assignment-service.ts`
- `apps/gateway/src/runtime/ownership-state.ts`
- `apps/gateway/src/runtime/ownership-gate.ts`
- `apps/gateway/src/runtime/local/local-ownership-gate.ts`
- `apps/gateway/src/runtime/reconnect-policy.ts`
- `apps/gateway/src/runtime/runtime-connection-status.ts`

核心路径：

```text
RuntimeCommandHandler
  -> RuntimeAssignmentService.assignBinding(binding, agent)
  -> LocalOwnershipGate.acquire(binding.id)
  -> RuntimeAgentRegistry.upsertAgent(agent)
  -> RuntimeOwnershipState.upsertBinding(binding)
  -> RuntimeOpenClawConfigProjection.rebuild()
  -> ConnectionManager.restartConnection(binding)
```

### 4.4 Relay / Connection Execution

负责 OpenClaw runtime 装配、channel plugin monitor 生命周期和消息转发。

关键文件：

- `apps/gateway/src/runtime/relay-runtime.ts`
- `apps/gateway/src/runtime/openclaw-runtime-assembler.ts`
- `apps/gateway/src/runtime/connection-manager.ts`
- `apps/gateway/src/runtime/runtime-openclaw-config-projection.ts`
- `apps/gateway/src/register-plugins.ts`
- `packages/openclaw-compat/src/plugin-host.ts`
- `packages/openclaw-compat/src/plugin-runtime.ts`
- `packages/openclaw-compat/src/compatibilities/channel.ts`

核心路径：

```text
RelayRuntime constructor
  -> OpenClawRuntimeAssembler.assemble()
  -> registerAllPlugins(pluginHost)
  -> ConnectionManager.initialize({ host, getAgentClient, callbacks })
```

`ConnectionManager` 是 runtime 的 imperative edge：

- 启动 channel plugin monitor。
- 保存 per-binding connection。
- 停止 / 重启 connection。
- 处理 channel reply event。
- 调用 Agent client。
- 把 Agent response 发回 channel dispatcher。

### 4.5 Agent Transport

负责从 runtime request 到具体 Agent 协议调用。

关键文件：

- `apps/gateway/src/runtime/runtime-agent-registry.ts`
- `apps/gateway/src/runtime/agent-client-registry.ts`
- `apps/gateway/src/runtime/agent-clients.ts`
- `apps/gateway/src/runtime/transport-tokens.ts`
- `packages/agent-transport/src/transport.ts`
- `packages/agent-transport/src/a2a.ts`
- `packages/agent-transport/src/acp.ts`

核心路径：

```text
ConnectionManager
  -> RuntimeAgentRegistry.getAgentClient(agentId)
  -> AgentClientHandle.send(request)
  -> A2ATransport.send() / ACPTransport.send()
  -> AgentResponse.text
```

### 4.6 Runtime Status Query

负责把 runtime operational state 暴露给 admin UI。

runtime 状态不再投影为 REST 查询 API。需要 HTTP 查询的资源必须来自数据库读模型。

---

## 5. 当前端到端流程

### 5.1 Gateway 进程启动

```text
apps/gateway/src/index.ts
  -> buildGatewayContainer()
  -> GatewayServer.start()
  -> RelayRuntime.bootstrap()
  -> RuntimeNodeStateRepository.upsert(node metadata)
  -> RuntimeScheduler.start()
  -> LocalScheduler initial reconcile
  -> Hono server listen
```

关键点：

- runtime bootstrap 先同步完成，随后 HTTP server 开始监听。
- bootstrap 失败时 `GatewayServer` 会延迟重试。
- `RelayRuntime.bootstrap()` 当前很轻，只发布 bootstrapping / ready snapshot；binding 恢复靠 scheduler reconcile。

### 5.2 Binding / Agent 配置变更

```text
HTTP command
  -> application service
  -> repository writes current state
  -> next LocalScheduler reconcile observes repository state
  -> RuntimeAssignmentCoordinator.reconcile()
  -> RuntimeCommandHandler.handle(command)
  -> RuntimeAssignmentService
```

关键点：

- event 只唤醒 reconciliation，不携带完整执行事实。
- coordinator 必须重新读取 repository state。
- command handler attach/refresh 时也会重新读取 binding 和 agent，避免使用过期对象。

### 5.3 Attach Binding

```text
RuntimeCommandHandler.handle(AttachBinding)
  -> read binding by id
  -> read agent by binding.agentId
  -> RuntimeAssignmentService.assignBinding(binding, agent)
  -> acquire local ownership lease
  -> upsert agent client if needed
  -> RuntimeOwnershipState.upsertBinding(binding)
  -> RuntimeOpenClawConfigProjection.rebuild()
  -> ConnectionManager.restartConnection(binding)
```

关键点：

- 如果 agent URL/protocol 变化，会更新 agent client 并强制重启受影响 bindings。
- 如果 binding disabled，则 assignment service 会停止 connection 并让状态保持 idle / detached 语义。
- 每次 ownership 或 connection 状态变化都会发布 runtime snapshot。

### 5.4 Detach Binding

```text
RuntimeCommandHandler.handle(DetachBinding)
  -> RuntimeAssignmentService.releaseBinding(bindingId)
  -> clear reconnect timer
  -> ConnectionManager.stopConnection(bindingId)
  -> LocalOwnershipGate.release(lease)
  -> RuntimeOwnershipState.releaseBinding(bindingId)
  -> RuntimeOpenClawConfigProjection.rebuild()
  -> publish snapshot
```

关键点：

- detach 是本地 side effect，不删除 DB 中的 binding。
- 配置删除由 application service / repository 完成。

### 5.5 渠道消息到 Agent 回复

```text
Channel Provider
  -> OpenClaw channel plugin monitor
  -> OpenClaw reply dispatch runtime
  -> OpenClawPluginRuntime.handleChannelReplyEvent()
  -> ConnectionManager.handleEvent()
  -> resolve connection by channel/account
  -> emit message:inbound
  -> AgentClientHandle.send()
  -> A2ATransport / ACPTransport
  -> emit message:outbound
  -> OpenClaw dispatcher sends channel reply
```

关键点：

- runtime 不调用 OpenClaw 原生 LLM pipeline。
- inbound text extraction 和 final reply 都通过 OpenClaw compatibility surface 完成。
- Agent 返回文本是最终渠道回复文本。

### 5.6 Connection 断开 / 错误 / 重连

```text
ConnectionManager detects disconnected/error
  -> callbacks.onConnectionStatus()
  -> RuntimeAssignmentService.handleOwnedConnectionStatus()
  -> RuntimeOwnershipState.markDisconnected() / markError()
  -> reconnect policy computes delay
  -> schedule reconnect timer
  -> ConnectionManager.restartConnection(binding)
```

关键点：

- `ConnectionManager` 报告事实，不决定业务 ownership。
- reconnect timer 由 assignment service 管理。
- release binding 时必须清理 reconnect timer。

### 5.7 Runtime 状态不作为 REST 查询模型

runtime 状态是节点本地执行事实，包含连接生命周期、重连 timer、owned binding 等进程内状态。gateway REST API 不暴露这些状态；需要 HTTP 查询的资源必须来自数据库读模型。

关键点：

- HTTP runtime routes 是 read-only query boundary。
- routes 不直接调用 `RelayRuntime` 或 `ConnectionManager`。

---

## 6. 持久化模型

当前持久化策略仍是旧文档中描述的“状态持久化 + 事件唤醒”，但需要按当前代码理解：

### 6.1 State Tables 是 source of truth

Agent 和 Channel Binding 的当前状态直接保存在 DB state tables 中。

它们决定：

- 当前有哪些 agents。
- 当前有哪些 channel bindings。
- binding 是否 enabled。
- binding 绑定哪个 agent。
- binding 的 channel credentials/config 是什么。

Runtime event bus、snapshot store、connection status 都不能替代 state tables。

### 6.2 Runtime reconcile 是收敛机制

当前代码已移除 outbox / DomainEventBus fast-path。配置写入只更新 state tables；runtime 通过启动和周期 reconcile 从 repository state 收敛。

这意味着：

- 配置真相来源仍是 Agent 和 Channel Binding state tables；
- runtime 不依赖内存事件完成恢复；
- 配置变更最长可能等到下一次 scheduler reconcile 才反映到连接。

如果未来需要更低延迟，可以重新引入明确的 notification/outbox 机制，但不能替代 repository 查询。

### 6.3 Runtime Snapshot 是 operational cache

Runtime snapshot 用于 admin status 查询，不是 desired state。

它记录：

- node lifecycle；
- scheduler role；
- last heartbeat；
- last error；
- binding connection statuses。

当前 local mode 下 snapshot store 是内存实现，进程重启后可丢失。

---

## 7. 逐文件职责

### 7.1 启动与装配

#### `apps/gateway/src/index.ts`

- **职责**：进程入口；构建容器，启动 `GatewayServer`，处理 `SIGINT` shutdown。
- **输入/输出**：输入环境变量和 container builder；输出运行中的 server。
- **位置**：启动链路入口，不直接操作 runtime collaborator。

#### `apps/gateway/src/bootstrap/config.ts`

- **职责**：解析 gateway/runtime 配置。
- **输入/输出**：输入 overrides 和 process env；输出 `GatewayConfigSnapshot`。
- **位置**：为 node id、display name、runtime address、cluster mode guard 提供配置。

#### `apps/gateway/src/bootstrap/container.ts`

- **职责**：进程级 DI composition root。
- **输入/输出**：绑定 infrastructure、application、runtime、HTTP、bootstrap 服务。
- **位置**：决定当前 runtime 使用 local event bus、local scheduler、local ownership gate；cluster mode 在这里 fail fast。

#### `apps/gateway/src/bootstrap/gateway-server.ts`

- **职责**：外层进程生命周期；启动 HTTP、runtime bootstrap retry。
- **输入/输出**：依赖 config、app、runtime bootstrapper。
- **位置**：进程启动与 runtime lifecycle 编排之间的边界。

#### `apps/gateway/src/register-plugins.ts`

- **职责**：注册 OpenClaw channel plugins。
- **输入/输出**：输入 `OpenClawPluginHost`；输出已注册的 Lark/Feishu plugin。
- **位置**：OpenClaw host 与具体渠道插件之间的装配点。

#### `apps/gateway/src/runtime/openclaw-runtime-assembler.ts`

- **职责**：组装 `OpenClawPluginRuntime` 和 `OpenClawPluginHost`。
- **输入/输出**：输入 `PluginRuntimeOptions`；输出 runtime/host assembly。
- **位置**：Relay runtime 初始化 OpenClaw compatibility layer 的工厂。

#### `apps/gateway/src/runtime/relay-runtime.ts`

- **职责**：runtime relay path 组合根；初始化 OpenClaw assembly 和 connection manager callbacks，并负责 runtime node 注册、domain event bridge、scheduler 的 lifecycle。
- **输入/输出**：输入 assignment service、agent registry、config projection、runtime assembler、connection manager；输出已 wiring 的 runtime execution path。
- **位置**：不是 desired-state 决策者，而是 runtime lifecycle 与 OpenClaw / ConnectionManager 的 wiring 点。

### 7.2 调度与事件

#### `apps/gateway/src/runtime/domain-event-bridge.ts`

- **职责**：domain event 到 runtime broadcast event 的桥。
- **输入/输出**：输入 binding/agent domain events；输出 `BindingChanged` / `AgentChanged`。
- **位置**：配置变化后的 runtime fast-path wakeup。

#### `apps/gateway/src/runtime/event-transport/types.ts`

- **职责**：定义 runtime broadcast events 和 directed commands。
- **输入/输出**：输出 `RuntimeBroadcastEvent`、`RuntimeDirectedCommand`。
- **位置**：scheduler/coordinator/command handler 之间的消息契约。

#### `apps/gateway/src/runtime/event-transport/runtime-event-bus.ts`

- **职责**：定义 runtime event bus 抽象和 `LOCAL_NODE_ID`。
- **输入/输出**：输出 `RuntimeEventBus` interface 和 DI token。
- **位置**：隔离 local bus 与 future distributed bus。

#### `apps/gateway/src/runtime/event-transport/local-runtime-event-bus.ts`

- **职责**：进程内 event bus 实现。
- **输入/输出**：基于 `EventEmitter` 同步投递 broadcast 和 directed command。
- **位置**：当前实际使用的 runtime event transport。

#### `apps/gateway/src/runtime/local/local-scheduler.ts`

- **职责**：local mode scheduler；监听 runtime bus，debounce reconcile，并处理 directed command。
- **输入/输出**：依赖 assignment service、command handler、runtime bus、coordinator。
- **位置**：当前 runtime 收敛循环的调度器。

#### `apps/gateway/src/runtime/runtime-assignment-coordinator.ts`

- **职责**：读取 desired state 并决定 attach/detach/refresh commands。
- **输入/输出**：输入 repositories 和当前 owned binding ids；输出 directed commands。
- **位置**：配置状态到 runtime 命令的决策层。

#### `apps/gateway/src/runtime/runtime-command-handler.ts`

- **职责**：执行 directed command。
- **输入/输出**：attach/refresh 会重新读取 binding+agent 后调用 assignment service；detach 调用 release。
- **位置**：coordinator 与 assignment service 之间的命令执行边界。

### 7.3 Assignment 与 Ownership

#### `apps/gateway/src/runtime/runtime-assignment-service.ts`

- **职责**：应用本节点 assignment side effects。
- **输入/输出**：获取 lease、更新 agent registry、更新 ownership state、重建 OpenClaw config、启停 connection、发布 snapshot。
- **位置**：本节点 runtime aggregate 的写入口。

#### `apps/gateway/src/runtime/ownership-state.ts`

- **职责**：维护 owned bindings、connection statuses、失败次数、重连计划、last error。
- **输入/输出**：输入 binding upsert/release 和连接状态变化；输出 status list 和 reconnect decisions。
- **位置**：assignment service 背后的内存状态模型。

#### `apps/gateway/src/runtime/ownership-gate.ts`

- **职责**：定义 ownership lease 抽象。
- **输入/输出**：输出 `OwnershipGate` 和 `OwnershipLease`。
- **位置**：让 local ownership 与 future distributed ownership 共用同一边界。

#### `apps/gateway/src/runtime/local/local-ownership-gate.ts`

- **职责**：local mode ownership gate。
- **输入/输出**：用内存 map acquire/renew/release/isHeld。
- **位置**：当前实际使用的 ownership gate。

#### `apps/gateway/src/runtime/reconnect-policy.ts`

- **职责**：计算 reconnect backoff。
- **输入/输出**：输入 failure count；输出 delay。
- **位置**：连接失败后的重连决策辅助。

#### `apps/gateway/src/runtime/runtime-connection-status.ts`

- **职责**：定义 connection status 类型和视图。
- **输入/输出**：输出 status union 和 `RuntimeConnectionStatus`。
- **位置**：connection manager、ownership state、snapshot query 的共享类型。

### 7.4 连接执行与 OpenClaw 兼容

#### `apps/gateway/src/runtime/connection-manager.ts`

- **职责**：per-binding connection lifecycle 和 message dispatch。
- **输入/输出**：启动/停止/restart plugin monitor，调用 agent client，发送 channel reply，触发 lifecycle callbacks。
- **位置**：runtime imperative edge。

#### `apps/gateway/src/runtime/runtime-openclaw-config-projection.ts`

- **职责**：从 owned bindings 生成 OpenClaw config。
- **输入/输出**：输入 `RuntimeOwnershipState.listOwnedBindings()`；输出 `OpenClawConfig`。
- **位置**：OpenClaw plugin runtime 的 config provider。

#### `packages/openclaw-compat/src/plugin-host.ts`

- **职责**：注册 OpenClaw plugins，解析 channel，启动 binding monitor。
- **输入/输出**：输入 binding snapshot；输出运行中的 monitor promise 和 status updates。
- **位置**：ConnectionManager 与具体 channel plugin 的桥。

#### `packages/openclaw-compat/src/plugin-runtime.ts`

- **职责**：提供 OpenClaw plugin runtime surface，并把 reply dispatch 转给 gateway handler。
- **输入/输出**：输入 config provider 和 `handleChannelReplyEvent`；输出 `PluginRuntime`。
- **位置**：OpenClaw plugin 消息进入 gateway runtime 的入口。

#### `packages/openclaw-compat/src/compatibilities/channel.ts`

- **职责**：构造 channel runtime 兼容面。
- **输入/输出**：包装 OpenClaw SDK channel/reply/routing/text 能力，并产生 `ChannelReplyEvent`。
- **位置**：消息转发主路径中的 OpenClaw compatibility layer。

#### `packages/openclaw-compat/src/compatibilities/agent.ts`

- **职责**：OpenClaw agent surface stub。
- **输入/输出**：提供插件可能访问的 agent API 默认实现。
- **位置**：兼容面，不是当前 Agent bridge 主路径。

#### `packages/openclaw-compat/src/compatibilities/system.ts`

- **职责**：OpenClaw system surface stub。
- **输入/输出**：返回 heartbeat/command execution 等安全默认值。
- **位置**：兼容面。

#### `packages/openclaw-compat/src/compatibilities/tasks.ts`

- **职责**：OpenClaw tasks surface stub。
- **输入/输出**：返回 session-bound task runs/flows 的空实现。
- **位置**：兼容面。

#### `packages/openclaw-compat/src/compatibilities/media.ts`

- **职责**：OpenClaw media/tts/mediaUnderstanding surface stub。
- **输入/输出**：返回媒体处理相关安全默认值。
- **位置**：兼容面。

#### `packages/openclaw-compat/src/compatibilities/generation.ts`

- **职责**：OpenClaw image/video generation surface stub。
- **输入/输出**：返回不支持或空结果。
- **位置**：兼容面。

#### `packages/openclaw-compat/src/index.ts`

- **职责**：openclaw-compat package exports。
- **输入/输出**：导出 host、runtime 和事件类型。
- **位置**：gateway runtime 引用 package 的边界。

### 7.5 Agent Transport

#### `apps/gateway/src/runtime/runtime-agent-registry.ts`

- **职责**：维护 runtime agent snapshots 和 agent clients。
- **输入/输出**：输入 agent upsert/remove；输出 `getAgentClient(agentId)`。
- **位置**：ConnectionManager 解析 agent client 的来源。

#### `apps/gateway/src/runtime/agent-client-registry.ts`

- **职责**：按 agent URL 缓存和管理 `AgentClientHandle` 生命周期。
- **输入/输出**：依赖 factory 创建/停止 clients。
- **位置**：agent client cache。

#### `apps/gateway/src/runtime/agent-clients.ts`

- **职责**：根据 protocol 创建 agent client handle。
- **输入/输出**：输入 multi-injected transports；输出 handle whose send delegates to transport。
- **位置**：runtime 与 transport package 的工厂层。

#### `apps/gateway/src/runtime/transport-tokens.ts`

- **职责**：定义 agent transport multi-injection token。
- **输入/输出**：输出 `AgentTransportToken`。
- **位置**：container 绑定 A2A/ACP transports 的 DI token。

#### `packages/agent-transport/src/transport.ts`

- **职责**：定义 agent transport 抽象和 registry。
- **输入/输出**：输出 `AgentRequest`、`AgentResponse`、`AgentClientHandle`、`AgentTransport`、`TransportRegistry`。
- **位置**：runtime 与具体协议之间的接口层。

#### `packages/agent-transport/src/a2a.ts`

- **职责**：A2A transport 实现。
- **输入/输出**：输入 agent URL 和 request；调用 `@a2a-js/sdk`；输出 text response。
- **位置**：默认 Agent 调用协议路径。

#### `packages/agent-transport/src/acp.ts`

- **职责**：ACP transport 实现。
- **输入/输出**：创建 run、轮询终态、提取 output text。
- **位置**：ACP Agent 调用协议路径。

#### `packages/agent-transport/src/index.ts`

- **职责**：agent-transport package exports。
- **输入/输出**：导出 A2A/ACP transport 和 transport abstractions。
- **位置**：gateway container 和 runtime factory 的 package 边界。

### 7.6 Runtime Node Metadata

#### `apps/gateway/src/infra/runtime-node-repo.ts`

- **职责**：持久化 runtime node metadata。
- **输入/输出**：读写 Prisma `runtimeNode` 表。
- **位置**：runtime bootstrap 的节点注册记录；不再支撑 REST runtime status API。

## 8. 当前边界规则

### 8.1 Coordinator 不通过 RelayRuntime

`RuntimeAssignmentCoordinator` 不得通过 `RelayRuntime` 调用 assignment 行为。它只能读取必要状态并发送 directed commands。

这样保证：

- desired-state 决策和本地执行解耦；
- future distributed scheduler 可以替换 command routing；
- `RelayRuntime` 不成为全局所有权选择器。

### 8.2 RuntimeAssignmentService 是本地写入口

本节点 ownership 和 connection side effects 必须经 `RuntimeAssignmentService`。

它负责把以下行为放在同一事务式流程中维护一致性：

- acquire/release ownership lease；
- upsert/remove agent client；
- update owned binding state；
- rebuild OpenClaw config projection；
- start/stop/restart connection；

### 8.3 ConnectionManager 只做 side effects

`ConnectionManager` 不决定 binding 是否应该被本节点拥有，也不写 DB。

它只负责：

- channel plugin monitor lifecycle；
- agent request dispatch；
- channel reply dispatch；
- lifecycle callback reporting。

### 8.4 OpenClaw runtime 只是 compatibility layer

OpenClaw compatibility layer 不是 Agent pipeline。当前实际 Agent path 是：

```text
OpenClaw channel plugin
  -> OpenClawPluginRuntime reply dispatch
  -> ConnectionManager
  -> AgentClientHandle
  -> A2A/ACP transport
```

### 8.5 Runtime event bus 不是 source of truth

Runtime event bus 只唤醒收敛。正确性来自 repository desired state 和 assignment reconciliation。

### 8.6 Cluster mode 未实现

当前不能把 `LeaderScheduler`、`RedisOwnershipGate`、Redis keys 当作可用集群实现。

要实现 cluster mode，至少还需要：

- Redis RuntimeEventBus；
- instance membership heartbeat；
- leader lease acquire/renew/release；
- binding lease acquire/renew/release；
- lease loss handling；
- rebalance/failover；
- directed command routing；
- cluster-aware runtime status query。

---

## 9. 当前架构对比总结

| 主题 | 旧文档/旧 mental model | 当前代码事实 |
| --- | --- | --- |
| Runtime 执行入口 | `RelayRuntime.attach/refresh/detach` | `RuntimeCommandHandler` -> `RuntimeAssignmentService` |
| Desired-state 决策 | Scheduler/Lead 直接调 RelayRuntime | `RuntimeAssignmentCoordinator` 发送 directed commands |
| RelayRuntime 职责 | 本地聚合根 + reconnect policy + attach/detach | OpenClaw assembly + ConnectionManager callback wiring |
| Owned binding 状态 | RelayRuntime 内部聚合根 | `RuntimeOwnershipState` |
| 本地 ownership | local grant 概念 | `LocalOwnershipGate` + assignment service leases |
| Connection side effects | RelayRuntime 内部方法触发 | `ConnectionManager` 执行，assignment service 调用 |
| OpenClaw 角色 | 模糊地包含 runtime/agent pipeline | 仅 channel plugin compatibility layer |
| Agent 调用 | A2A bridge 概念 | `AgentClientRegistry` / `AgentClientFactory` / A2A/ACP transports |
| Status API | runtime 直接状态 | snapshot publisher/store + query service |
| Cluster mode | 文档描述较完整目标态 | 容器层 fail fast，Redis gate 未接线 |

---

## 10. 当前实现不变量

1. Agent 和 Channel Binding 的 desired state 以 DB state tables 为准。
2. Runtime 通过启动和周期 reconcile 从 repository state 收敛。
3. Scheduler / coordinator 必须能从 repository state 重新收敛。
4. `RuntimeAssignmentCoordinator` 不得绕过 command boundary 直接操作本地 executor。
5. `RuntimeAssignmentService` 是本节点 runtime assignment 的唯一写入口。
6. `RuntimeOwnershipState` 是本节点 owned binding 和 connection status 的内存模型。
7. `ConnectionManager` 只执行 channel/agent side effects，不决定 ownership。
8. `RuntimeOpenClawConfigProjection` 只投影当前 owned bindings。
9. OpenClaw compatibility layer 不执行 OpenClaw 原生 LLM pipeline。
10. A2A/ACP transport 不知道 binding ownership，只处理 Agent 协议调用。
11. Runtime snapshot 是 operational view，可从 runtime state 重新发布，不是配置事实。
12. 当前 production wiring 只支持 local single-node runtime。
13. Redis/leader/cluster 文件不能被视为已实现生产能力。

---

## 11. 后续演进建议

如果继续推进架构演进，建议按以下顺序：

1. **清理旧文档和旧命名残留**：避免 `RelayRuntime` 被继续理解成 assignment 聚合根。
2. **补齐 runtime tests**：覆盖 coordinator -> command handler -> assignment service -> connection manager 的关键路径。
3. **明确 OpenClaw compat contract**：记录哪些 surface 是必要能力，哪些是 stub。
4. **完善 runtime status 持久化策略**：决定 snapshot store 是否需要进程外持久化。
5. **单独设计 cluster mode**：不要只替换 event bus；必须完整设计 membership、leader lease、binding lease、directed routing、failover 和 status query。
