# A2A Channels 架构设计（DDD + 混合持久化 + Runtime Ownership）

本文档把当前项目的核心 use-case、DDD/持久化设计、运行时内存状态、单实例部署和集群部署统一说明清楚。

## 1. 项目目标

A2A Channels Gateway 的核心职责是把外部消息渠道连接到 A2A Agent：

```text
Channel Provider（如 Feishu/Lark）
  -> Gateway channel connection / monitor
  -> OpenClaw-compatible runtime
  -> A2A Agent transport
  -> Agent response
  -> Channel reply dispatcher
```

这个项目不是为了优化高频配置写入。Agent 配置和 Channel Binding 配置都是低频操作。

引入 DDD + 领域事件驱动的核心原因是：

1. Channel Binding 是一条持久化的"期望状态"。
2. Channel Binding 变化后，Gateway 需要可靠地启动、停止或重启对应 connection。
3. 在多实例集群模式下，系统必须决定"哪个 Gateway 实例拥有并运行这个 connection"。
4. 如果实例重启、宕机、错过通知，系统仍然应该能从持久化状态恢复正确的运行时状态。

### 1.1 为什么不采用完整 Event Sourcing

Agent 和 Channel Binding 是低频修改的配置对象，没有以下需求：

- 完整变更历史 + 审计追溯
- 时间旅行查询
- 依赖"事件顺序"的复杂 CQRS 投影

对这类对象强制走完整 Event Sourcing（事件回放重建聚合 → 产生事件 → 写入 Event Store → 投影更新读模型）带来的复杂度与收益不成比例：

- 每次命令都需要事件回放，基础设施更重。
- 需要维护事件存储、快照、版本控制、投影 catch-up 等全套设施。
- 读操作也需要先追平投影才能使用，增加启动延迟。

### 1.2 采用的混合持久化策略

本项目对 Agent 和 Channel Binding 采用**状态持久化 + 领域事件广播**的模式：

1. **状态持久化**：用 Prisma / SQLite 直接保存聚合的当前状态（Current State）。加载时从 DB 直接读取，不需要事件回放。
2. **领域事件**：聚合执行业务逻辑后产生领域事件（Domain Event），通过 **Outbox Pattern** 保证"状态写入 + 事件记录"的原子性，再由 Outbox Worker 异步发布。
3. **运行时调度通知**：领域事件通过 in-process `DomainEventBus` 触发 fast-path 通知，唤醒 Scheduler/Lead reconciliation。

这样既保留了 DDD 的领域事件驱动优点，又避免了完整 ES 的开销。

因此，架构的关键边界是：

```text
DB State Tables        决定应该存在什么配置（source of truth）
Outbox Table           保证"状态写入 + 事件"原子性
RuntimeEventBus        传递调度信号（启动/变更/节点变化），当前仅有单实例本地实现
Redis（未来集群模式）    RuntimeEventBus 的分布式实现 + binding ownership lease
RelayRuntime           只执行本实例拥有的 Binding
ConnectionManager      管理本地 connection lifecycle
```

长期目标是让单实例与集群模式主要通过 runtime transport / ownership gate 边界切换，但当前生产实现只支持单实例。集群模式不能仅替换 `RuntimeEventBus` 就成立；它还需要成员探活、leader lease、binding lease、lease renew、rebalance/failover 和定向调度闭环。

### 1.3 当前实现状态（Phase 1 / Phase 2）

本文档同时描述了目标架构和后续集群扩展方向，但当前仓库代码只完成了 **Phase 1（单机收敛）**。为了避免把设计目标误读成“已经实现”，这里明确区分：

#### Phase 1（已实现）

- `RelayRuntime` 持有 `RuntimeOwnershipState`，作为单机本地聚合根管理 owned bindings 与连接状态。
- `ConnectionManager` 只负责 channel connection side effects，不持有重连策略。
- `RelayRuntime` 通过 reconnect policy 为 `disconnected` / `error` 状态安排本地 backoff 重连。
- `LocalScheduler` 只负责唤醒 reconciliation，并修复缺失或失活的本地连接。
- `channel_bindings.enabled_key` 与 `agent_id -> agents.id` 外键共同收敛单机 desired-state 不变量。

#### Phase 2（尚未实现）

- Redis RuntimeEventBus
- Redis leader lease / binding ownership lease
- ownership gate abstraction
- rebalance / failover / cluster scheduler
- 跨实例同步的 ownership / operational state 查询

当前生产装配会在 `CLUSTER_MODE=true` 时 fail fast。`LeaderScheduler` / Redis ownership 相关代码只能视为 Phase 2 设计草稿或实验边界，不是当前可运行能力；真实的 Redis event transport、leader lease、binding lease 和跨实例调度还没有接入。

下文中凡是涉及 Redis ownership gate、lease、集群调度的内容，都应视为 **Phase 2 设计目标**，不是当前代码已经具备的行为。

## 2. 核心概念

### 2.1 Agent

Agent 表示一个后端 A2A/ACP 服务端点。

它的配置包括：

```text
agent id
name
url
protocol
description
```

Agent 配置是低频操作，通常不会直接创建一个长连接，但会影响 channel 消息路由到哪个 Agent。

### 2.2 Channel Binding

Channel Binding 表示一个 channel account 与 Agent 配置的绑定关系。Binding 持久化 `agentId`，运行时再从 Agent 配置解析实际 URL。

它的配置包括：

```text
binding id
name
channel type
account id
channel config
agent id
enabled flag
```

Channel Binding 是本项目中最重要的运行时配置：

- 如果 binding enabled，Gateway 可能需要启动一个长期运行的 connection / monitor。
- 如果 binding disabled 或 deleted，Gateway 必须停止对应 connection。
- 如果 binding 更新了 channel config、agentId，或关联 Agent 的 url/protocol 变化，Gateway 可能需要重启或刷新 connection。
- 在集群模式下，同一个 enabled binding 只能由一个健康实例运行。

除以上配置字段外，Channel Binding 还有一个独立的运行时连接状态（Connection Status），详见 2.3 节。

### 2.3 Desired State、Owner State 与 Connection Status

Channel Binding 有三类状态，分别回答不同层次的问题。

#### Desired State

Desired State 存在于持久化 DB 的状态表中（`channel_bindings`），直接从表读取。

它回答：

```text
这个 Binding 应不应该存在？
它是否 enabled？
它应该连接哪个 channel account？
它应该路由到哪个 Agent（agentId）？
```

#### Owner State

Owner State 是 **Phase 2** 的概念，计划在集群模式下存在于 Redis 中。

它回答：

```text
当前哪个 Gateway 实例负责运行这个 Binding 的 connection？
该 ownership lease 是否仍然有效？
```

当前 **Phase 1** 单实例模式下没有分布式 owner state；所有 enabled runnable bindings 都由本地 `LocalScheduler` + `RelayRuntime` 收敛到当前进程。

#### Connection Status

Connection Status 是 Channel Binding 的实际连接状态，反映 owning Gateway 实例的真实运行情况。

可能的值：

```text
idle          - binding 未 enabled，或尚未被任何实例拥有
connecting    - binding 已 owned，正在建立连接
connected     - 连接已建立并活跃
disconnected  - 连接已断开，可能在重连中
error         - 连接失败，需要关注
```

Connection Status 与 Desired State 的典型组合：

| enabled | Connection Status | 含义 |
|---|---|---|
| false | idle | 正常：未启用 |
| true | connecting | 正在建立连接 |
| true | connected | 正常：已连接 |
| true | disconnected | 暂时断线，等待重连 |
| true | error | 异常：需要干预 |

Connection Status 不是配置事实，**不写入 DB**。它属于 operational state：

- 单实例：存在于 `RelayRuntime` 本地聚合根的内存状态中（见 3.4 节）。
- 集群：owning 实例持有本地内存状态；如需跨实例查询（例如 Admin UI 展示），可额外同步至 Redis。
- 进程重启后，所有 connection status 从 `idle` 开始，通过 reconciliation 和实际连接尝试逐步重建。

## 3. 分层架构

```text
packages/domain/
  - Aggregates（AgentConfigAggregate、ChannelBindingAggregate）
  - Domain Events
  - Repository ports
  - Domain invariants

apps/gateway/src/application/
  - Application services
  - Use-case orchestration
  - Command handling
  - Application query services（如 RuntimeStatusQueryService，组合配置状态与运行时快照供查询）

apps/gateway/src/infra/
  - Prisma-backed repositories（直接状态持久化）
  - Outbox table（事件原子写入）
  - Outbox Worker（异步事件发布）
  - In-process DomainEventBus（写入侧 fast-path）

apps/gateway/src/runtime/event-transport/
  - RuntimeEventBus interface（调度信号传输抽象）
  - LocalRuntimeEventBus（in-process 实现，单实例/多进程本地）
  - RedisRuntimeEventBus（Redis pub/sub 实现，集群）

apps/gateway/src/runtime/
  - Scheduler/Lead（订阅 RuntimeEventBus，驱动调度决策）
  - RelayRuntime（本地聚合根，管理 RuntimeOwnershipState）
  - RuntimeCommandHandler（接收定向命令，调用 RelayRuntime）
  - local side-effect execution
  - 不承载应用查询服务；HTTP 查询通过 application/queries 读取

Redis（cluster mode）
  - RuntimeEventBus 的分布式实现（pub/sub）
  - instance membership heartbeat
  - binding ownership leases
```

### 3.1 Domain Layer

Domain layer 只表达业务事实和聚合状态变化。

领域事件：

```text
AgentRegistered.v1
AgentUpdated.v1
AgentDeleted.v1
ChannelBindingCreated.v1
ChannelBindingUpdated.v1
ChannelBindingDeleted.v1
```

Domain layer 不应该依赖：

- Hono routes
- Prisma
- SQLite / MySQL
- Redis
- EventEmitter
- RelayRuntime
- OpenClaw runtime

### 3.2 Application Layer

Application services 负责编排 use-case：

```text
HTTP request
  -> application service
  -> load aggregate from DB
  -> call aggregate method
  -> save aggregate through repository (state + outbox, in one transaction)
  -> return result
```

Application service 可以处理跨聚合或应用级约束，例如 enabled binding 的重复检查。

但需要注意：如果约束依赖查询结果，在集群或 eventual consistency 场景下它不是强一致不变量。强一致约束应通过 DB unique constraint 或专门聚合建模。

### 3.3 Infrastructure Layer

Infrastructure layer 提供：

- **Prisma-backed repositories**：直接读写 `agents`、`channel_bindings` 状态表。加载聚合时从表中读取当前状态，不需要事件回放；保存时原子更新状态 + 写入 outbox 记录。
- **Outbox Table**：在同一事务中记录 pending 领域事件，保证"状态写入 + 事件"的原子性。
- **Outbox Worker**：异步轮询 pending outbox 记录，发布到 `DomainEventBus`，标记为已处理。提供 best-effort、at-least-once 的事件投递。
- **In-process `DomainEventBus`**：EventEmitter-backed fast-path 通知总线，用于唤醒 Scheduler/Lead reconciliation。

当前已经落地的持久化不变量还有两条：

- `channel_bindings.enabled_key`：保证同一个 `channel_type + account_id` 只能存在一条 enabled binding。
- `channel_bindings.agent_id -> agents.id`：保证 binding 持有的 `agentId` 必须引用存在的 Agent。

`DomainEventBus` 是 best-effort，不提供：

- durable delivery（durable 语义由 Outbox 保证）
- retry（Outbox Worker 负责重试）
- cross-process ordering
- cluster broadcast

因此 DomainEventBus 不能作为 runtime correctness 的唯一机制。

### 3.4 Runtime Layer

`RelayRuntime` 是本地运行时执行器，不是全局 owner selector。

它负责：

- 创建 OpenClaw plugin runtime
- 注册 channel plugins
- 管理 Agent clients
- 维护本地 in-memory indexes
- 生成 OpenClaw-compatible config
- 通过内部聚合方法启停本地 connections（不允许外部直接操作 `ConnectionManager`）
- 持有 `RuntimeOwnershipState`，统一维护 owned bindings 的 `idle / connecting / connected / disconnected / error` 状态
- 在本地 runtime 内应用 reconnect policy，安排 backoff repair

它不应该负责：

- 决定集群中哪个实例拥有 binding
- 把 domain event 当作 ownership 的依据
- 替代 DB 状态持久化

#### RelayRuntime 作为本地聚合根

`RelayRuntime` 的运行时状态应以**本地聚合根（local aggregate root）**的方式建模。它持有一个 `RuntimeOwnershipState`，记录本实例当前 owned bindings 及各自的 Connection Status。

核心不变量：

```text
∀ binding ∈ ownedBindings:
  存在且仅存在一个对应的 connection 实例
  该 connection 的状态与 connectionStatusById[binding.id] 一致
```

所有 connection 操作（start、stop、restart、setStatus）都通过聚合内部方法发起，不允许外部绕过聚合直接调用 `ConnectionManager`。这样可以保证：

- `ownedBindings` 集合与实际运行的 connections 数量始终一致。
- `connectionStatusById` 中每条记录都有对应的 connection 实例，不存在孤立状态。
- connection 状态转换（如 `connecting → connected → disconnected`）只通过聚合方法触发，外部可订阅聚合发出的状态变更通知。

这个聚合是 in-process 的，**不写入 DB**。其状态变化可通过 operational metrics / log 记录，或在集群模式下同步至 Redis 供 Admin UI 查询。

#### Phase 1 中的协作边界

当前代码里三者的边界应该理解为：

- `RelayRuntime`：维护 `RuntimeOwnershipState`、Agent client 生命周期、binding attach/refresh/detach 语义。
- `ConnectionManager`：只执行 start/stop/restart 与消息转发 side effects，不负责判断 ownership，也不持有 backoff policy。
- `LocalScheduler`：只负责加载最新 desired state、唤醒 reconcile，并修复“本地未拥有”或“本地连接缺失”的 binding。

### 3.5 Runtime Event Transport Layer

`RuntimeEventBus` 是运行时协调信号的传输边界。当前实现只有单实例的 in-process EventEmitter；集群模式需要在这个边界之外补齐 membership、ownership lease、leader election 和 directed scheduling，不能把“更换传输层”当成完整实现。

#### 两类信号

| 类型 | 说明 | 发布方 | 消费方 |
|---|---|---|---|
| 广播事件（Broadcast） | 配置变更、节点加入/离开 | Outbox Worker / 成员探活 | **所有**节点的 Scheduler |
| 定向命令（Directed Command） | 发给指定节点的 attach/detach/refresh | Lead Scheduler | 指定节点的 RuntimeCommandHandler |

广播事件类型：

```text
BindingChanged   { bindingId }         binding 创建/更新/删除后广播
AgentChanged     { agentId }           agent 更新/删除后广播
NodeJoined       { nodeId }            新节点加入成员列表
NodeLeft         { nodeId }            节点心跳超时或主动离开
```

定向命令类型（仅发给指定节点）：

```text
AttachBinding    { bindingId }         目标节点 acquire lease 并 attach
DetachBinding    { bindingId }         目标节点 detach 并 release lease
RefreshBinding   { bindingId }         目标节点 refresh 已 owned binding
```

#### 不同模式的实现

| 模式 | 广播事件 | 定向命令 | Ownership Gate |
|---|---|---|---|
| 单实例 | in-process EventEmitter | 同一 EventEmitter（instanceId = LOCAL） | local grant（无需外部协调） |
| 本地多进程 | Unix socket / named pipe pub/sub | 进程间 IPC channel | local file lock 或 in-memory（进程内） |
| 集群（Redis，未来） | Redis PUBLISH `runtime:broadcast` | Redis PUBLISH `runtime:node:{instanceId}` | Redis SET NX lease |

单实例模式里不存在“其他节点”，广播和定向是对同一 in-process handler 的调用：

```text
DomainEventBus.publish(ChannelBindingCreated)
  -> OutboxWorker -> RuntimeEventBus.broadcast(BindingChanged { bindingId })
  -> LocalScheduler.onBroadcast()
  -> lead decides: send AttachBinding to LOCAL instance
  -> RuntimeCommandHandler.handle(AttachBinding { bindingId })
  -> assignService.assignBinding(binding, agent)
  -> ConnectionManager.restartConnection(binding)
```

未来集群模式的目标路径如下。当前代码尚未实现这条生产路径：

```text
DomainEventBus.publish(ChannelBindingCreated)
  -> OutboxWorker -> Redis PUBLISH runtime:broadcast { type: BindingChanged, bindingId }
  -> ALL instances receive broadcast
  -> lead instance runs assignment loop, selects node B
  -> Redis PUBLISH runtime:node:B { type: AttachBinding, bindingId }
  -> node B receives directed command
  -> RuntimeCommandHandler.handle(AttachBinding { bindingId })
  -> acquire Redis binding lease
  -> assignService.assignBinding(binding, agent)
  -> ConnectionManager.restartConnection(binding)
```

#### 启动时的事件链

进程启动时没有来自 DB 的 domain event，但启动本身作为一个“节点加入”事件触发调度：

```text
process start
  -> node registers in membership (or local bootstrap)
  -> RuntimeEventBus.broadcast(NodeJoined { nodeId: THIS })
  -> lead Scheduler receives NodeJoined
  -> lead scans unowned enabled bindings
  -> for each unowned binding:
       send AttachBinding { bindingId } to selected instance
```

单实例模式下 NodeJoined 是 in-process 信号，lead 和执行者是同一个 LocalScheduler。

#### 节点变化时的事件链

```text
node A heartbeat stops
  -> membership monitor detects timeout
  -> RuntimeEventBus.broadcast(NodeLeft { nodeId: A })
  -> lead Scheduler receives NodeLeft
  -> lead finds bindings whose owner was A (lease expired / no heartbeat)
  -> for each affected binding:
       send AttachBinding { bindingId } to a healthy instance
```

#### 边界规则

- `RelayRuntime` 不订阅 `RuntimeEventBus`，只接收来自 `RuntimeCommandHandler` 的命令。
- Lead Scheduler 通过广播事件了解全局变化，通过定向命令触发单节点操作。
- 非 lead 节点收到广播事件后，只更新本地 cached state 或做健康检查，不主动抢占 binding。
- 所有节点自己负责定期 renew 已持有的 binding lease；renew 失败时主动 detach 并广播 NodeLeft 等效信号。
- **集群模式下没有全量扫描**：Lead 只对变化的 binding 发送命令，各节点只处理自己拥有的 binding；`reconcile()` 的全量扫描是单实例 Phase 1 的临时简化，不应沿用到集群实现。

## 4. 持久化模型

### 4.1 State Tables（当前状态 / source of truth）

`agents` 和 `channel_bindings` 表直接存储聚合的当前状态，是这两类聚合的 source of truth。

`agents` 表：

```text
id              Agent 唯一 ID
name            名称
url             Agent endpoint URL
protocol        a2a / acp 等
description     描述
created_at
updated_at
```

`channel_bindings` 表：

```text
id              Binding 唯一 ID
name            名称
channel_type    渠道类型（feishu、lark 等）
account_id      渠道账号 ID
channel_config  渠道配置（JSON）
agent_id        关联的 Agent ID（外键引用 agents）
enabled         是否启用
enabled_key     仅当 enabled=true 时写入 `${channel_type}:${account_id}`，用于唯一约束
created_at
updated_at
```

加载聚合时直接从表读取，不需要事件回放。保存时直接更新记录（upsert 或 update）。

### 4.2 Outbox Table（事件原子性保证）

Outbox 表用于保证"聚合状态写入 + 领域事件记录"的原子性：

```text
id              Outbox 记录 ID
aggregate_type  AgentConfig / ChannelBinding
aggregate_id    聚合 ID
event_type      事件类型（AgentRegistered.v1 等）
payload         事件 payload（JSON）
occurred_at     事件发生时间
processed_at    处理时间（null = pending）
```

写入时：在同一事务中 upsert 状态表 + INSERT outbox 记录。  
Outbox Worker 异步读取 pending 记录，通过 DomainEventBus 发布，标记 processed_at。

### 4.3 为什么不需要独立 Events Table 或 Projection

Agent 和 Channel Binding 是低频配置，state tables 直接就是配置读模型：

- Admin UI 的配置页可以直接读 `agents`、`channel_bindings` 表。
- Admin UI 的运行时状态页使用 `apps/gateway/src/application/queries/runtime-status/RuntimeStatusQueryService`，把配置状态、节点注册和 runtime snapshot 组合成查询视图；该服务不放在 runtime 执行层。
- Runtime bootstrap 直接读表，不需要 projection catch-up。
- 进程重启后即可得到最新配置状态，无需等待追平投影。

如果未来有审计需求，可在 Outbox 表保留已处理记录，或单独增加 audit_log 表，不影响当前持久化路径。

## 5. RelayRuntime 状态设计

本节描述 `RelayRuntime` 作为本地聚合根的内部状态结构，以及它在启动和增量变更时如何与 DB 状态、集群 ownership 保持一致。

### 5.1 RelayRuntime 的聚合根状态

`RelayRuntime` 是一个 in-process 聚合根，只持有**本实例已经获得运行权**的 bindings 及其连接状态。它不负责扫描全局 bindings，也不在启动时加载所有 binding。全局配置扫描和分发由 Scheduler/Lead 负责。

**本地配置索引**（Local Config Index）：只包含本实例 owned bindings 运行所需的配置，可从 DB 按 binding id / agent id 重新加载。

```text
bindingsById           - owned binding id → ChannelBinding 配置（含 agentId）
agentsById             - owned bindings 引用到的 agent id → Agent 配置（含 url、protocol）
agentsByUrl            - agent url → Agent 配置（辅助索引，用于 client 复用）
agentClients           - agent id → 已实例化的 agent transport client
openClawConfig         - 由本地 owned bindings + agents 生成的 OpenClaw 插件配置
```

**Ownership State**（本实例拥有的 bindings 及其连接）：进程重启后从 idle 重建，不写入 DB。

```text
ownedBindingIds        - 本实例当前拥有的 binding id 集合
connectionById         - binding id → connection 实例句柄
connectionStatusById   - binding id → Connection Status（idle/connecting/connected/disconnected/error）
```

这两部分状态必须分开管理：

- Local Config Index 反映"本实例正在运行什么配置"，不是全局配置缓存。
- Ownership State 反映"本实例拥有哪些 binding 的运行权"，不同实例各不相同。
- 全局 Desired State 仍在 DB 中，由 Scheduler/Lead 扫描和分发。

所有 connection 操作（start、stop、restart、setStatus）只能通过聚合根内部方法发起，不允许外部代码直接操作 `ConnectionManager`，以保证 `ownedBindingIds`、`connectionById`、`connectionStatusById` 三者始终一致。

### 5.2 启动时的状态加载

启动时 `RelayRuntime` 不读取所有 agents 和 channel_bindings。启动流程分为两层：

1. Scheduler/Lead 负责扫描全局 Desired State，并决定哪些 binding 应该被分发给哪个实例。
2. `RelayRuntime` 只接收本实例被分配且成功获得 lease 的 binding，然后加载这些 binding 运行所需的最小配置。

#### 统一启动流程

```text
process start
  -> initialize Prisma, DomainEventBus, Outbox Worker
  -> seed default data if needed
  -> start local Scheduler/Lead participant
  -> RelayRuntime.bootstrapEmpty()
       -> register channel plugins
       -> initialize empty local indexes
       -> ownedBindingIds = ∅
```

之后由 Scheduler/Lead 驱动 binding 分发：

```text
scheduler / lead loop
  -> read enabled channel_bindings from DB
  -> find unowned / unscheduled bindings
  -> choose target instance
  -> send schedule(bindingId) to target instance

instance receives schedule(bindingId)
  -> reload binding by id from DB
  -> reload referenced agent by agentId from DB
  -> acquire local ownership gate
       single-instance: local scheduler grants ownership
       cluster: acquire Redis binding lease
  -> RelayRuntime.attachBinding(bindingId)
       -> update Local Config Index
       -> build/reuse agent client
       -> rebuild OpenClaw config for local owned bindings
       -> connection.start()
       -> connectionStatusById[id] = connecting
```

#### 单实例模式下的 lead

单实例模式也保留同一套 Scheduler/Lead 语义，只是 lead 和 executor 都在同一个进程内：

```text
local lead
  -> read enabled channel_bindings from DB
  -> for each unowned enabled binding:
       schedule(bindingId) to local instance

local instance
  -> no Redis lease required
  -> attachBinding(binding, agent)
```

这样单实例和集群模式的差异只在 ownership gate：单实例是本地 grant，集群是 Redis lease。`RelayRuntime` 本身不需要知道全局有多少 bindings，也不需要在启动时加载所有 bindings。

#### 集群模式下的 lead

集群模式由 Redis leader lease 选出 lead：

```text
cluster lead
  -> scan enabled bindings
  -> scan active instances
  -> scan existing binding-owner leases
  -> schedule unowned bindings to selected instances
```

被选中的实例仍必须 acquire Redis binding lease 成功后，才能调用 `RelayRuntime.attachBinding(bindingId)`。Lead 只能分发任务，不能直接改变 `RelayRuntime` 的本地 ownership。

### 5.3 增量变更的处理

当平台注册了新 binding、更新了 binding 或删除了 binding，事件不直接驱动 `RelayRuntime` 全量读取 DB。事件只唤醒 Scheduler/Lead，由它判断需要调度、刷新或释放哪些 binding。

#### 变更处理的正确语义

```text
变更发生（DB 写入 + outbox）
  -> DomainEventBus 触发 fast-path（best-effort）
  -> wake scheduler / lead reconcile

scheduler / lead reconcile
  -> read affected binding from DB, or periodically scan enabled bindings
  -> if binding enabled and unowned:
       schedule(bindingId) to selected instance
  -> if binding disabled/deleted:
       notify current owner to detach(bindingId)
  -> if binding config or referenced agent changed:
       notify current owner to refresh(bindingId)
```

`RelayRuntime` 只处理本地 owned binding 的 attach / refresh / detach：

```text
attachBinding(bindingId)
  -> reload binding by id from DB
  -> reload referenced agent by agentId from DB
  -> pass ownership gate
  -> add binding to ownedBindingIds
  -> start connection

refreshBinding(bindingId)
  -> only if bindingId ∈ ownedBindingIds
  -> reload binding + agent from DB
  -> if no longer runnable: detachBinding(bindingId)
  -> if config changed: restart connection
  -> rebuild local OpenClaw config

detachBinding(bindingId)
  -> only if bindingId ∈ ownedBindingIds
  -> stop connection
  -> release ownership gate if needed
  -> remove local config and connection status
```

#### 新 binding 注册的端到端流程

以注册一个新的 enabled binding 为例：

```text
POST /api/channels
  -> DB: INSERT channel_bindings + INSERT outbox (in one transaction)
  -> DB commit

Outbox Worker
  -> DomainEventBus.publish(ChannelBindingCreated.v1)   // fast-path

Scheduler/Lead（收到通知）
  -> wake scheduler reconcile
  -> read new binding from DB
  -> choose target instance
  -> schedule(bindingId) to target instance

Target instance
  -> reload binding + agent from DB
  -> acquire ownership gate
       single-instance: local grant
       cluster: Redis binding lease
  -> RelayRuntime.attachBinding(bindingId)
  -> connectionStatusById[binding.id] = connecting
```

#### 容错保证

- 如果 DomainEventBus 通知丢失，Scheduler/Lead 的定时扫描会发现 enabled 但 unowned 的 binding。
- 如果 lead 分发任务丢失，下一轮 scheduler reconcile 会重新分发。
- 如果实例收到重复 schedule，ownership gate 和 `ownedBindingIds` diff 会避免重复 connection。
- 进程重启后，`RelayRuntime` 从空状态启动，由 Scheduler/Lead 重新分发 binding，不依赖旧内存状态。

#### 不允许的绕过路径

```text
// 错误做法：收到事件后直接操作 connection，跳过 scheduler 和 ownership gate
DomainEventBus.on(ChannelBindingCreated, (event) => {
  connectionManager.start(event.bindingId)  // ❌ 绕过了调度、ownership 和聚合根
})

// 正确做法：事件只负责唤醒 scheduler/lead
DomainEventBus.on(ChannelBindingCreated, () => {
  scheduler.scheduleReconcile()  // ✅
})
```

## 6. Use-case 事件流程设计

本节统一说明命令写 DB、领域事件发布、Scheduler/Lead 调度、ownership gate 和 `RelayRuntime` 本地 side effect 的边界。

统一规则：

```text
Command
  -> Application Service
  -> Aggregate validates business rules
  -> Repository writes state table, and optionally writes outbox events when runtime/external notification is needed
  -> DB commit succeeds
  -> if outbox event exists: Outbox Worker publishes domain event
  -> if runtime-relevant event exists: Scheduler/Lead receives wakeup and reloads DB state
  -> Scheduler/Lead schedules attach / refresh / detach
  -> target instance passes ownership gate
  -> RelayRuntime applies local side effect
```

`RelayRuntime` 不扫描全局 DB，不决定 binding 分配，也不直接响应 domain event。它只处理本实例 owned binding 的 `attachBinding(bindingId)`、`refreshBinding(bindingId)`、`detachBinding(bindingId)`。

## 6.1 Use-case: 注册 Agent

### 目标

用户注册一个新的 Agent endpoint。

### Command Flow

```text
POST /api/agents
  -> AgentService.register()
  -> AgentConfigAggregate.register()
  -> AgentConfigRepository.save()
  -> INSERT agents row
  -> optionally INSERT outbox record if external audit/integration needs AgentRegistered.v1
  -> DB commit
```

### Scheduler / Runtime Flow

Agent 注册本身不启动 connection，也不需要触发 Scheduler/Lead 调度。新 Agent 只有在后续被某个 enabled Channel Binding 引用时，才会进入 runtime 路径：

```text
AgentRegistered.v1
  -> optional audit / notification only
  -> no Scheduler/Lead scheduling required
  -> no RelayRuntime side effect

later ChannelBindingCreated / ChannelBindingUpdated(agentId)
  -> Scheduler/Lead reloads binding + referenced agent
  -> schedule(bindingId) if binding is enabled and runnable
```

因此，`AgentRegistered.v1` 可以保留为审计、扩展通知或外部集成事件，但不是 Gateway connection lifecycle 的必要事件。

### 边界

- Agent 表是 Agent 配置的 source of truth。
- Agent 注册后不直接更新 `RelayRuntime` 全局内存。
- 只有 binding 被调度且通过 ownership gate 后，runtime 才加载对应 agent 配置。

## 6.2 Use-case: 更新 Agent

### 目标

用户修改 Agent name、url、protocol 或 description。

### Command Flow

```text
PATCH /api/agents/:id
  -> AgentService.update()
  -> AgentConfigRepository.findById(id)
  -> rehydrate AgentConfigAggregate from current state
  -> aggregate.update(changes)
  -> AgentUpdated.v1
  -> AgentConfigRepository.save()
  -> UPDATE agents row + INSERT outbox record (in one transaction)
  -> DB commit
```

### Scheduler / Runtime Flow

如果 Agent.url 或 protocol 改变，引用该 Agent 的 owned bindings 可能需要 refresh：

```text
AgentUpdated notification
  -> wake Scheduler/Lead
  -> Scheduler/Lead finds enabled bindings referencing agentId
  -> for each binding:
       if binding is currently owned:
         notify owner to refresh(bindingId)
       else if binding is enabled and unowned:
         schedule(bindingId)
```

Owner 实例：

```text
RelayRuntime.refreshBinding(bindingId)
  -> reload binding by id
  -> reload referenced agent by agentId
  -> if agent no longer runnable: detachBinding(bindingId)
  -> if agent url/protocol changed: restart or refresh connection
  -> rebuild local OpenClaw config
```

### 边界

- DB commit 前不更新 runtime 内存。
- Scheduler/Lead 可以查询全局 bindings 来找引用关系。
- `RelayRuntime` 只刷新本地 owned binding，不构建全局 desired snapshot。

## 6.3 Use-case: 删除 Agent / Agent 不可用

### 目标

处理两类不同问题：

1. 用户删除一个 Agent config。
2. Runtime 调用下游 Agent 时发现服务不可用。

### Command Flow: 删除 Agent

```text
DELETE /api/agents/:id
  -> AgentService.delete()
  -> AgentConfigRepository.findById(id)
  -> aggregate.delete()
  -> AgentDeleted.v1
  -> AgentConfigRepository.save()
  -> DELETE agents row + INSERT outbox record (in one transaction)
  -> DB commit
```

### 策略边界

删除 Agent 对仍引用它的 Channel Bindings 有两种策略，必须在 application layer 明确选择：

1. **Restrict delete**：如果存在任何 binding 引用该 agentId，则拒绝删除。
2. **Cascade disable/delete**：删除 Agent 时同步 disable 或 delete affected bindings，并在同一业务流程中写入对应 outbox events。

不建议允许 enabled binding 引用不存在的 Agent；这会把配置错误推迟到 runtime 才暴露。

### Runtime Flow: Agent 调用失败

Agent 服务不可用不是配置事实，不应直接修改 `agents` 或 `channel_bindings` 表。它属于 connection/message processing 的 operational event，由 owning instance 在调用下游 Agent 失败时产生。

```text
owned connection receives channel message
  -> RelayRuntime resolves agent client by binding.agentId
  -> call downstream Agent
  -> call fails with transport error / timeout / 5xx / protocol error
  -> emit AgentCallFailed.v1 or BindingDeliveryFailed.v1
  -> update local Connection Status / health state
  -> apply retry/backoff policy for this binding-agent route
```

建议事件按 binding 维度携带上下文，而不是只按 agent 维度：

```text
BindingDeliveryFailed.v1 {
  bindingId,
  agentId,
  failureType,
  occurredAt,
  retryable,
  attempt,
  ownerInstanceId
}
```

后续处理分为三层：

1. **本地即时处理**：当前 connection 对该消息执行 retry/backoff；如果达到阈值，将该 binding 的 connection status 或 health 标记为 degraded/error。
2. **观测与告警**：失败事件写入 operational event stream / metrics / logs，用于 Admin UI 展示、告警和排障。
3. **调度决策**：Scheduler/Lead 默认不因为 Agent 调用失败迁移 binding，因为迁移 owner 不能修复下游 Agent 宕机；只有当失败被判定为本实例网络问题或局部故障时，才可触发小批量 reschedule。

不推荐 Runtime 在发现 Agent 不可用时自动 disable binding 或 delete agent。是否禁用 binding 是配置决策，应由用户操作、策略引擎或明确的 application service command 完成。

### Scheduler / Runtime Flow: 删除 Agent

```text
AgentDeleted notification
  -> wake Scheduler/Lead
  -> Scheduler/Lead finds affected bindings
  -> if policy is restrict:
       normally no affected bindings should remain
  -> if policy is cascade disable/delete:
       notify current owners to detach(bindingId)
```

Owner 实例：

```text
RelayRuntime.detachBinding(bindingId)
  -> stop connection
  -> release ownership gate if needed
  -> remove local config and connection status
```

### 边界

- 删除 Agent 是配置命令；Agent 调用失败是运行时 operational event，二者不能混为一谈。
- 删除 Agent 不是 runtime 直接决定是否停止 connection 的依据；策略必须在 application layer 或 Scheduler/Lead 中明确。
- Runtime 只执行 detach，不修改 Agent 或 Binding 配置 DB。
- Agent 调用失败事件可以驱动重试、backoff、health/status 更新、metrics 和告警，但不能直接改写配置 Desired State。
- Scheduler/Lead 默认不通过迁移 binding 来处理下游 Agent 宕机；迁移只适用于 owner 实例局部故障或网络路径异常。

## 6.4 Use-case: 创建 Channel Binding

### 目标

用户把一个 channel account 绑定到 Agent 配置（`agentId`）。这是最关键的 use-case，因为它可能导致 connection 启动。

### Command Flow

```text
POST /api/channels
  -> ChannelBindingService.create()
  -> check application-level constraints
  -> ChannelBindingAggregate.create()
  -> ChannelBindingCreated.v1
  -> ChannelBindingRepository.save()
  -> INSERT channel_bindings row + INSERT outbox record (in one transaction)
  -> DB commit
```

### Scheduler / Runtime Flow

```text
ChannelBindingCreated notification
  -> wake Scheduler/Lead
  -> Scheduler/Lead reloads binding from DB
  -> if binding is disabled:
       no runtime scheduling
  -> if binding enabled and runnable:
       choose target instance
       schedule(bindingId) to target instance
  -> if binding enabled but referenced agent is missing/not runnable:
       keep desired state in DB
       report config error / health issue
       do not attach runtime connection
```

Target instance：

```text
schedule(bindingId)
  -> reload binding by id
  -> reload referenced agent by agentId
  -> pass ownership gate
       single-instance: local grant
       cluster: Redis binding lease
  -> RelayRuntime.attachBinding(bindingId)
       -> add binding to ownedBindingIds
       -> update Local Config Index
       -> start connection
       -> connectionStatusById[id] = connecting
```

### 边界

- DB commit 成功是配置生效的持久化边界。
- Domain event 只 wake Scheduler/Lead，不能直接启动 connection。
- Disabled binding 只写 Desired State，不进入 runtime attach。
- Enabled binding 必须能解析到 runnable Agent，才能被 Scheduler/Lead 调度。
- Cluster mode 下，只有成功 acquire Redis binding lease 的实例可以 attach binding。
- Single-instance mode 也走 local lead / local grant，而不是 `RelayRuntime` 自己扫描所有 bindings。

## 6.5 Use-case: 更新 Channel Binding

### 目标

用户修改 binding name、channel config、agentId、enabled 状态等。

### Command Flow

```text
PATCH /api/channels/:id
  -> ChannelBindingService.update()
  -> ChannelBindingRepository.findById(id)
  -> rehydrate ChannelBindingAggregate from current state
  -> check constraints
  -> aggregate.update(changes)
  -> ChannelBindingUpdated.v1
  -> ChannelBindingRepository.save()
  -> UPDATE channel_bindings row + INSERT outbox record (in one transaction)
  -> DB commit
```

### Scheduler / Runtime Flow: enabled true -> false

```text
Binding disabled
  -> DB updated + outbox committed
  -> ChannelBindingUpdated notification wakes Scheduler/Lead
  -> Scheduler/Lead finds current owner
  -> notify owner to detach(bindingId)
  -> owner RelayRuntime.detachBinding(bindingId)
  -> owner releases binding lease if cluster mode
```

### Scheduler / Runtime Flow: enabled false -> true

```text
Binding enabled
  -> DB updated + outbox committed
  -> Scheduler/Lead reloads binding
  -> if referenced agent is missing/not runnable:
       report config error / health issue
       do not attach runtime connection
  -> if binding is runnable:
       choose target instance
       schedule(bindingId)
       target instance passes ownership gate
       RelayRuntime.attachBinding(bindingId)
```

### Scheduler / Runtime Flow: channel config changed

```text
Binding channelConfig changed
  -> DB updated + outbox committed
  -> if binding is disabled:
       no runtime refresh
  -> if binding is enabled and currently owned:
       Scheduler/Lead finds current owner
       notify owner to refresh(bindingId)
       RelayRuntime.refreshBinding(bindingId)
       restart connection if runtime-relevant config changed
  -> if binding is enabled and unowned:
       Scheduler/Lead may schedule(bindingId) if runnable
```

### Scheduler / Runtime Flow: binding 关联的 agentId changed

```text
Binding agentId changed
  -> DB updated + outbox committed
  -> if binding is disabled:
       no runtime refresh
  -> if new agent is missing/not runnable:
       notify current owner to detach(bindingId) if currently owned
       report config error / health issue
  -> if binding is enabled and currently owned:
       Scheduler/Lead finds current owner
       notify owner to refresh(bindingId)
       RelayRuntime.refreshBinding(bindingId)
            -> reload binding
            -> reload new agent
            -> rebuild local routing/OpenClaw config
            -> restart or refresh connection if needed
  -> if binding is enabled and unowned:
       Scheduler/Lead may schedule(bindingId) if runnable
```

### Scheduler / Runtime Flow: owner 变化或 rebalance

```text
Lead chooses to move binding from A to B
  -> notify A to detach(bindingId)
  -> A stops connection and releases lease by token
  -> lead schedules bindingId to B
  -> B acquires Redis binding lease
  -> B attachBinding(bindingId)
```

### 边界

- Binding 更新的 DB commit 先于任何 runtime side effect。
- Scheduler/Lead 可以决定 attach、refresh、detach，但不能绕过 ownership gate。
- Runtime 不写 `channel_bindings` 表，也不修改 outbox。

## 6.6 Use-case: 删除 Channel Binding

### 目标

用户删除 binding，并停止相关 connection。

### Command Flow

```text
DELETE /api/channels/:id
  -> ChannelBindingService.delete()
  -> ChannelBindingRepository.findById(id)
  -> aggregate.delete()
  -> ChannelBindingDeleted.v1
  -> ChannelBindingRepository.save()
  -> DELETE channel_bindings row + INSERT outbox record (in one transaction)
  -> DB commit
```

### Scheduler / Runtime Flow

```text
ChannelBindingDeleted notification
  -> wake Scheduler/Lead
  -> Scheduler/Lead finds current owner from ownership state
  -> if owner exists:
       notify owner to detach(bindingId)
  -> if owner does not exist:
       no runtime side effect needed
```

Owner 实例：

```text
RelayRuntime.detachBinding(bindingId)
  -> stop connection
  -> release Redis binding lease if cluster mode
  -> remove binding from ownedBindingIds
  -> remove local config and connection status
```

如果 owner miss notification：

```text
owner periodic local check / lease renew path
  -> reload owned binding by id or validate runnable state
  -> binding missing/deleted
  -> detachBinding(bindingId)
```

### 边界

- 删除写入 DB 后才触发 runtime detach。
- Delete event 必须携带 `bindingId`，但 runtime detach 前仍以 DB/ownership state 校验为准。
- Scheduler/Lead 不能只依赖事件，必须通过定时扫描/owner 校验修复漏通知。
- `detachBinding(bindingId)` 必须幂等：binding 已经不在 owned set、connection 已停止或 lease 已释放时也应安全返回。
- Non-owner 实例保持 idle，不需要操作。

## 6.7 Use-case: Gateway 进程启动

### 目标

Gateway 启动时从持久化状态恢复运行时状态，并参与 Scheduler/Lead 调度。

### Flow

```text
process start
  -> initialize Prisma
  -> create DomainEventBus
  -> start Outbox Worker
  -> create application services
  -> seed default data if needed
  -> start membership heartbeat
  -> start Scheduler/Lead participant
  -> RelayRuntime.bootstrapEmpty()
       -> register channel plugins
       -> initialize empty Local Config Index
       -> ownedBindingIds = ∅
```

之后：

```text
single-instance
  -> local lead scans enabled bindings
  -> local lead schedules bindingId to local instance
  -> local ownership grant
  -> RelayRuntime.attachBinding(bindingId)

cluster
  -> Redis leader lease elects lead
  -> lead scans enabled bindings and active members
  -> lead schedules unowned bindings with cooldown/rate limit
  -> selected instances acquire Redis binding leases
  -> RelayRuntime.attachBinding(bindingId)
```

### 什么时候写 DB

启动时通常不写业务数据，除非需要 seed 默认 Agent 或默认配置。

如果 seed 发生，也应走 application service / aggregate / repository（状态写入 + outbox）。

### 边界

- `RelayRuntime` 启动时不读取所有 agents 或 channel_bindings。
- 全局 Desired State 由 Scheduler/Lead 读取。
- Runtime 内存从空状态恢复，依赖调度重新 attach owned bindings。

## 6.8 Use-case: Outbox Worker 事件发布

### 目标

保证领域事件的 at-least-once 可靠投递，解耦"DB 写入"和"调度唤醒"。

### Flow

```text
Outbox Worker 定期轮询
  -> SELECT * FROM outbox WHERE processed_at IS NULL ORDER BY occurred_at
  -> for each pending record:
      -> DomainEventBus.publish(event)
      -> UPDATE outbox SET processed_at = now() WHERE id = ...
```

### 关键特性

- **原子性**：业务状态写入 + outbox 记录在同一事务中，保证二者一致。
- **At-least-once**：如果进程崩溃在 publish 和 mark processed 之间，重启后会重新发布。
- **幂等消费**：Scheduler/Lead 和 Runtime attach/refresh/detach 都必须幂等。
- **顺序性**：单实例下 Outbox Worker 可按 occurred_at 顺序发布；集群模式下不能依赖跨实例全局顺序。

### 边界

- Outbox Worker 只写 outbox 表（标记 processed_at）。不写业务状态表。
- DomainEventBus 只负责 wake Scheduler/Lead，不负责 runtime correctness。

## 6.9 Use-case: Scheduler/Lead reconciliation

### 目标

保证持久化 Desired State 中 enabled runnable bindings 最终被调度给某个实例，并处理配置变更、删除和未连接 binding。

### Single-instance Flow

```text
local scheduler reconcile
  -> read enabled channel_bindings from DB
  -> for each enabled runnable binding:
       if not locally owned:
         schedule(bindingId) to local instance
  -> for each locally owned binding:
       if deleted/disabled/no longer runnable:
         RelayRuntime.detachBinding(bindingId)
       else if config changed:
         RelayRuntime.refreshBinding(bindingId)
```

### Cluster Flow

```text
cluster lead reconcile
  -> read enabled channel_bindings from DB
  -> read active instance membership from Redis
  -> read current binding-owner leases from Redis
  -> for each enabled runnable binding without owner:
       choose target instance using load-aware policy
       schedule(bindingId) with cooldown/rate limit
  -> for deleted/disabled bindings with owner:
       notify owner to detach(bindingId)
  -> for changed bindings with owner:
       notify owner to refresh(bindingId)
```

### 什么时候写 DB

Scheduler/Lead reconciliation 不写主 DB 的业务状态或 outbox。

它可能写 Redis：

```text
membership heartbeat
leader lease acquire / renew
binding schedule task / wakeup
```

### 边界

- Scheduler/Lead 可以扫描全局 DB，但不直接启动 connection。
- Scheduler/Lead 的任务是 advisory；实例执行前必须通过 ownership gate。
- 定时 reconcile 是事件丢失、任务丢失、lead failover 后的最终修复机制。

## 6.10 Use-case: Local Runtime binding reconciliation

### 目标

保证本地 `RelayRuntime` 的 side effects 与本实例 owned bindings 一致。

### Flow: 本地 binding 状态校验

```text
local runtime check
  -> for each ownedBindingId:
       validate ownership gate still valid
       reload binding by id
       reload referenced agent
       if lease lost / binding missing / disabled / not runnable:
         detachBinding(bindingId)
       else if config changed:
         refreshBinding(bindingId)
       else:
         keep connection running
```

### Flow: Channel connection 建连失败 / 中途断开

Channel provider connection 是本地 side effect。建连失败或运行中断开时，owning instance 应先在本地处理，不直接修改 Desired State，也不立即释放 binding ownership。

```text
RelayRuntime.attachBinding(bindingId)
  -> connection.start()
  -> connection start fails
  -> emit ChannelConnectionFailed.v1
  -> connectionStatusById[bindingId] = error
  -> schedule local reconnect with backoff

owned connection running
  -> channel websocket / monitor disconnected
  -> emit ChannelConnectionDisconnected.v1
  -> connectionStatusById[bindingId] = disconnected
  -> schedule local reconnect with backoff
```

建议事件携带 binding 维度上下文：

```text
ChannelConnectionFailed.v1 {
  bindingId,
  channelType,
  accountId,
  ownerInstanceId,
  failureType,
  occurredAt,
  retryable,
  attempt
}
```

后续处理：

1. **本地重连**：`RelayRuntime` / `ConnectionManager` 对同一个 binding 执行指数退避或固定间隔重连，并限制最大并发 connecting 数。
2. **状态更新**：建连失败标记为 `error`，运行中断开标记为 `disconnected`；重连开始时回到 `connecting`，成功后变为 `connected`。
3. **观测告警**：失败/断开事件进入 operational logs、metrics 或 health projection，用于 Admin UI 展示和告警。
4. **释放 ownership 的条件**：只有当 ownership gate 失效、binding 被删除/禁用、配置不再 runnable，或实例判断自己无法继续服务该 binding 时，才 `detachBinding(bindingId)` 并释放 lease。
5. **Scheduler/Lead 处理**：Scheduler/Lead 默认不因单次建连失败或短暂断线迁移 binding；只有持续失败超过阈值，且判断为 owner 实例局部故障时，才可触发 reschedule。

### 什么时候写 DB

Local Runtime 不写主 DB 或 outbox。

Cluster mode 下它会写 Redis：

```text
binding lease renew
binding lease release
```

### 边界

- Local runtime reconciliation 只处理本地 owned bindings。
- Channel connection failed/disconnected 是 operational event，不是配置 domain event；它可以进入 logs、metrics 或 health projection，但不写配置 outbox。
- Runtime 不能扫描全局 bindings 来抢 ownership，除非处于明确的 no-leader fallback 模式。
- Connection status 是本地 operational state，不写入配置 DB。

## 6.11 Use-case: 集群实例宕机与接管

### 目标

一个 Gateway 实例宕机后，它拥有的 bindings 应由其他健康实例接管。

### Flow

```text
instance A dies
  -> Redis membership heartbeat stops
  -> binding leases owned by A expire
  -> Scheduler/Lead observes expired/unowned bindings
  -> lead schedules affected bindingIds to healthy instances
  -> instance B acquires Redis binding lease
  -> instance B RelayRuntime.attachBinding(bindingId)
```

如果宕机的是 lead：

```text
lead A dies
  -> leader lease expires
  -> another instance acquires leader lease
  -> new lead runs full scheduler reconcile
  -> unowned enabled bindings are scheduled again
```

### 什么时候写 DB

不写主 DB 业务状态。

实例宕机不是 Channel Binding 配置事实。它属于 runtime coordination / operational state。

### 边界

- 旧 owner 恢复后不能继续使用旧内存状态，必须重新加入 membership 并重新通过 ownership gate。
- Lease 过期和重新 acquire 决定接管，不依赖 domain event。

## 6.12 Use-case: 实例暂时失去 Redis

### 目标

防止 split-brain，即两个实例同时运行同一个 binding connection。

### Flow

```text
instance loses Redis connectivity
  -> cannot renew binding ownership leases
  -> treat local leases as unsafe
  -> RelayRuntime.detachBinding(bindingId) for affected bindings
  -> stop or avoid starting owned connections
  -> keep trying to reconnect Redis
  -> after Redis recovers, rejoin membership
  -> wait for Scheduler/Lead scheduling and acquire leases again
```

如果失去 Redis 的实例是 lead：

```text
lead loses Redis connectivity
  -> cannot renew leader lease
  -> must stop acting as lead
  -> another instance may become lead after TTL
```

### 什么时候写 DB

不写配置 DB。

### 边界

- 无法确认 lease 时必须停止本地 side effect，优先避免 split-brain。
- Redis 恢复后不能直接恢复旧 connection，必须重新通过 ownership gate。

## 6.13 Use-case: 新实例加入与平滑分配

### 目标

新 Gateway 实例加入集群时，避免立即重分配大量已有连接，同时让新实例逐步承担负载。

### Flow

```text
new instance joins
  -> starts membership heartbeat
  -> lead observes active instance count changed
  -> lead does not immediately migrate all existing owned bindings
  -> new unowned bindings are preferentially scheduled to underloaded instance
  -> rebalance loop may later move small batches from overloaded owners
```

### 边界

- 新实例加入不是重算所有 binding owner 的触发条件。
- 已连接 binding 默认保持原 owner。
- 均衡通过低频、小批量、可中断的 rebalance 完成。

## 6.14 Use-case: Lead 启动冷却与限速分配

### 目标

防止第一个启动的 lead 在只看到自己一个 member 时立即占有全部 bindings。

### Flow

```text
lead elected
  -> enter startup cooldown window
  -> if active instances < expectedInstances:
       reduce assignment rate or extend cooldown within max limit
  -> assign at most CLUSTER_STARTUP_MIN_ASSIGNMENTS during cooldown
  -> after cooldown:
       assign unowned bindings by CLUSTER_ASSIGNMENT_BATCH_SIZE
       respect CLUSTER_MAX_CONNECTING_PER_INSTANCE
```

### 边界

- `CLUSTER_EXPECTED_INSTANCES` 是 hint，不是硬依赖。
- 冷却窗口结束后必须继续限速分配，不能无限等待实例全部 ready。
- 启动限速只影响平滑性，不影响 Redis lease correctness。

## 6.15 Use-case: Rebalance 小批量迁移

### 目标

在不造成大量 connection churn 的前提下逐步改善实例间 binding 分布。

### Flow

```text
rebalance loop
  -> compute owned count / connecting count per instance
  -> if maxLoad > targetLoad * CLUSTER_REBALANCE_THRESHOLD:
       choose at most CLUSTER_REBALANCE_BATCH_SIZE bindings
       skip bindings moved within CLUSTER_REBALANCE_COOLDOWN_MS
       ask overloaded owner to detach(bindingId)
       after lease released, schedule bindingId to underloaded instance
```

### 边界

- Rebalance 是优化，不是 correctness 机制。
- 每轮迁移必须限速，避免大量长连接同时重建。
- 新 owner 仍必须 acquire Redis binding lease 成功后才能 attach。

## 7. 事件发布、DB 写入和内存更新顺序

推荐顺序：

```text
1. Handle command
2. Aggregate validates business rules, produces domain events
3. Repository writes current state + outbox record in one transaction
4. DB commit succeeds
5. Outbox Worker reads pending events, publishes via DomainEventBus (at-least-once)
6. DomainEventBus fast-path notification wakes Scheduler/Lead
7. Scheduler/Lead reloads needed DB state or performs periodic scan
8. Scheduler/Lead sends advisory attach / refresh / detach task
9. Target instance passes ownership gate
10. RelayRuntime updates local in-memory state
11. RelayRuntime applies local side effects
```

关键规则：

- 不要在 DB commit 前更新 runtime 内存状态。
- 不要把 DomainEventBus delivery 当作持久化保证（持久化由 Outbox 保证）。
- 不要把 Runtime event handler 当作 cluster ownership 依据。
- Scheduler/Lead 可以扫描全局 Desired State；`RelayRuntime` 只能处理本地 owned bindings。
- Runtime 内存状态可以丢失，因为它应该能从 DB state tables + Redis ownership 重建。
- DB state tables 是 Agent 和 ChannelBinding 的 source of truth。
- Outbox 是事件投递的持久化保证，保证 at-least-once。
- Redis binding lease 是集群模式下 connection ownership 的正确性边界。

## 8. 单实例模式设计

单实例模式依赖：

```text
SQLite
Outbox Worker（in-process）
in-process DomainEventBus
LocalRuntimeEventBus（in-process EventEmitter）
local Scheduler/Lead
local RelayRuntime
```

单实例模式的核心特征：**`RuntimeEventBus` 是 in-process 实现**，广播和定向命令都通过同一个 EventEmitter 传递，收发方在同一进程内。

配置变更流程：

```text
Command
  -> write state + outbox to SQLite (in one transaction)
  -> Outbox Worker publishes DomainEvent
  -> RuntimeEventBus.broadcast(BindingChanged { bindingId })
  -> LocalScheduler receives broadcast
  -> lead decides: send AttachBinding/DetachBinding/RefreshBinding to LOCAL
  -> RuntimeCommandHandler.handle(command)
  -> local ownership grant（无需 Redis）
  -> RelayRuntime.attach/refresh/detach(bindingId)
```

启动流程：

```text
process start
  -> RuntimeEventBus.broadcast(NodeJoined { nodeId: LOCAL })
  -> LocalScheduler receives NodeJoined
  -> scans all enabled bindings (startup-only full scan)
  -> for each enabled binding: send AttachBinding to LOCAL
  -> RuntimeCommandHandler handles each → RelayRuntime.attach(bindingId)
```

单实例模式也保留 Lead/Scheduler 语义：

```text
local lead = local scheduler in the same process
ownership gate = local grant（in-process，无竞争）
binding distribution = all bindings → LOCAL instance
```

`RelayRuntime` 在单实例模式下从空状态启动，由 LocalScheduler 通过 NodeJoined 触发全量 attach；后续增量变更通过 BindingChanged 广播触发。

## 9. 集群模式设计

本节是 Phase 2 目标设计，不是当前生产能力。当前 `CLUSTER_MODE=true` 会在 bootstrap container 阶段直接报错，避免把未完成的 `LeaderScheduler` / Redis ownership 草稿误用为可运行集群模式。

集群模式依赖：

```text
Durable DB（MySQL / PostgreSQL / other）
Redis
multiple Gateway instances
RedisRuntimeEventBus（Redis pub/sub 实现）
```

集群模式的目标边界是：`RuntimeEventBus` 使用 Redis pub/sub，ownership gate 使用 Redis lease，leader 只负责调度和均衡，不直接绕过 directed command 修改某个实例的本地 runtime state。实现时还必须补齐节点 membership、lease renew、失败转移和 rebalance。

配置变更流程：

```text
Command
  -> write state + outbox to durable DB (in one transaction)
  -> Outbox Worker publishes DomainEvent
  -> Redis PUBLISH runtime:broadcast { type: BindingChanged, bindingId }
  -> ALL instances receive broadcast
  -> lead instance decides target node B
  -> Redis PUBLISH runtime:node:B { type: AttachBinding, bindingId }
  -> node B receives directed command
  -> RuntimeCommandHandler.handle(AttachBinding)
  -> node B acquires Redis binding lease
  -> RelayRuntime.attach(bindingId)
```

启动流程：

```text
process start (node X)
  -> node X registers heartbeat key in Redis
  -> Redis PUBLISH runtime:broadcast { type: NodeJoined, nodeId: X }
  -> lead Scheduler receives NodeJoined
  -> lead scans unowned enabled bindings
  -> for each unowned binding:
       Redis PUBLISH runtime:node:{target} { type: AttachBinding, bindingId }
  -> target node RuntimeCommandHandler handles → acquire lease → RelayRuntime.attach
```

节点失联流程：

```text
node A heartbeat expires in Redis
  -> membership monitor detects timeout
  -> Redis PUBLISH runtime:broadcast { type: NodeLeft, nodeId: A }
  -> lead Scheduler receives NodeLeft
  -> lead finds bindings previously assigned to A (lease expired)
  -> for each affected binding:
       Redis PUBLISH runtime:node:{healthy} { type: AttachBinding, bindingId }
```

**集群模式没有全量 reconcile**：lead 只对变化的 binding 发送定向命令，各节点只处理自己收到的命令。各节点的定期任务只做两件事：

- 对已持有的 binding lease 执行 renew（最少的 Redis 调用）。
- 对已持有的 connection 做局部健康检查并应用 reconnect policy。

### 9.1 Sharding Strategy

#### 为什么不直接用一致性哈希

一致性哈希（包括 rendezvous hash）依赖一个**稳定的成员列表**。但集群启动是一个过程，实例逐步上线：

```text
t=0: 只有实例 A → 拥有所有 100 个 binding → 启动 100 个连接
t=5: 实例 B 加入 → 重新计算 → 50 个 binding 从 A 移到 B
      → A 停止 50 个连接，B 启动 50 个连接（大量 churn）
t=10: 实例 C 加入 → 再次重新计算 → 又一轮 churn
```

每次成员变化都触发大量连接的停止和重启。Feishu 的长连接重建代价很高，这不可接受。

一致性哈希的根本问题是：**它把分配策略和实时成员列表耦合了**。实时成员列表不稳定，分配结果就不稳定。

#### 把"正确性"和"调度"解耦

Redis lease 保证正确性：同一时刻只有一个实例持有某 binding 的 lease，就只有一个实例运行该 connection。Lead 只负责调度和均衡，不能作为 correctness 的唯一依据。

基于此，推荐 **Lead Scheduler + Redis Lease**：

```text
Redis lease = correctness boundary
Lead        = scheduler / balancer
Instance    = executor that only runs bindings after acquiring lease
```

#### Lead 的产生

集群通过 Redis 选出一个 lead：

```text
gateway:cluster-leader -> { instanceId, leaderToken, expiresAt }
```

规则：

- 第一个启动且成功 acquire leader lease 的实例成为 lead。
- lead 需要定期 renew leader lease。
- 如果 lead 宕机或无法续租，其他实例在 lease 过期后竞选新 lead。
- 所有 lead 操作都必须携带 `leaderToken`，避免旧 lead 恢复后继续分发任务。

Lead 选举只影响调度效率，不影响单 binding 的运行正确性。即使短时间出现两个 lead，实例仍必须先 acquire binding lease，成功后才能启动 connection。

#### Lead 的职责

Lead 负责把 binding 分发给实例，但不直接启动 connection：

```text
lead loop
  -> read enabled channel_bindings from DB
  -> read active instances from Redis membership
  -> read current binding-owner leases from Redis
  -> find unowned enabled bindings
  -> assign each unowned binding to a selected instance
  -> send schedule task / wakeup to selected instance
```

Lead 还需要监听领域事件：

```text
ChannelBindingCreated / Updated / Deleted
AgentUpdated / Deleted
  -> wake lead scheduler
  -> lead reloads DB state
  -> lead schedules affected bindings
```

事件只是 fast-path。Lead 仍必须定时扫描所有 enabled bindings，修复事件丢失、实例宕机、任务丢失造成的未连接 binding。

#### 实例执行规则

实例收到 lead 分发任务后，只能尝试获取 lease：

```text
schedule(bindingId, instanceId)
  -> instance reloads binding + agent state from DB
  -> if binding is not enabled/runnable: skip
  -> SET gateway:binding-owner:{bindingId} {instanceId, leaseToken, expiresAt} NX EX {ttl}
  -> success: add to local ownedBindings and start connection
  -> failure: skip; another instance owns it
```

因此 lead 分发任务是 advisory 的：重复分发、延迟分发、分发给错误实例都不会破坏 correctness。

#### 平滑启动行为

Lead 不能在刚启动且只看到自己一个 member 时立即把所有 binding 都分给自己。启动阶段应该先进入冷却窗口，并用限速方式分配：

```text
t=0: 实例 A 启动并成为 lead
     -> lead 发现当前只有 A
     -> 进入 startup cooldown，只分配少量 bootstrap bindings

t=5: 实例 B 加入 membership
     -> lead 把后续 unowned bindings 优先分给负载较低的 B
     -> 已连接 binding 默认保持原 owner

t=10: 实例 C 加入
      -> lead 继续按限速批次分配 unowned bindings
      -> 如 A 明显过载，再通过低频 rebalance 小批量迁移
```

这避免了“一致性 hash + 成员列表变化”导致的大量连接重启。实例陆续 ready 时，系统先以受控速度保证 enabled binding 被连接，再逐步考虑均衡。

#### Lead 调度配置参数

这些参数控制启动阶段和均衡阶段的速度。它们影响调度效率和连接 churn，不影响 correctness；binding 是否能运行仍由 Redis binding lease 决定。

```text
CLUSTER_EXPECTED_INSTANCES          预期实例数，仅作为启动调度 hint
CLUSTER_STARTUP_COOLDOWN_MS         lead 选出后的启动冷却窗口
CLUSTER_STARTUP_MIN_ASSIGNMENTS     冷却窗口内允许的最小启动分配数
CLUSTER_ASSIGNMENT_BATCH_SIZE       每轮最多分配多少个 unowned bindings
CLUSTER_ASSIGNMENT_INTERVAL_MS      lead 分配循环间隔
CLUSTER_MAX_CONNECTING_PER_INSTANCE 单实例同时处于 connecting 的 binding 上限
CLUSTER_MAX_OWNED_PER_INSTANCE      单实例 owned binding 硬上限，可选
CLUSTER_REBALANCE_INTERVAL_MS       均衡检查间隔
CLUSTER_REBALANCE_THRESHOLD         触发过载释放的阈值，例如 1.5
CLUSTER_REBALANCE_BATCH_SIZE        每轮最多迁移多少个 binding
CLUSTER_REBALANCE_COOLDOWN_MS       同一个 binding 两次迁移之间的最小间隔
CLUSTER_LEADER_LEASE_TTL_MS         leader lease TTL
CLUSTER_BINDING_LEASE_TTL_MS        binding owner lease TTL
```

推荐默认值：

```text
CLUSTER_EXPECTED_INSTANCES=0              // 0 表示未知，不作为硬等待条件
CLUSTER_STARTUP_COOLDOWN_MS=30000
CLUSTER_STARTUP_MIN_ASSIGNMENTS=5
CLUSTER_ASSIGNMENT_BATCH_SIZE=10
CLUSTER_ASSIGNMENT_INTERVAL_MS=5000
CLUSTER_MAX_CONNECTING_PER_INSTANCE=5
CLUSTER_MAX_OWNED_PER_INSTANCE=0          // 0 表示不启用硬上限
CLUSTER_REBALANCE_INTERVAL_MS=60000
CLUSTER_REBALANCE_THRESHOLD=1.5
CLUSTER_REBALANCE_BATCH_SIZE=5
CLUSTER_REBALANCE_COOLDOWN_MS=300000
CLUSTER_LEADER_LEASE_TTL_MS=15000
CLUSTER_BINDING_LEASE_TTL_MS=30000
```

`CLUSTER_EXPECTED_INSTANCES` 只能作为 hint：

- 如果 active instances 少于 expected，lead 可以延长冷却或降低分配速度。
- 不能无限等待 expected instances 全部出现，否则少一个实例就会导致 binding 永久不启动。
- 冷却窗口结束后，即使 active instances 仍不足，也必须继续按限速分配，优先保证可用性。
- 后续实例加入后，通过新 binding 优先分配和低频 rebalance 逐步恢复均衡。

#### 均衡策略

均衡由 lead 以低频、可控方式执行：

```text
rebalance loop
  -> compute load per active instance
  -> if maxLoad > targetLoad * threshold:
       choose small batch of bindings from overloaded instance
       ask owner to gracefully release leases
       schedule released bindings to underloaded instances
```

规则：

- 默认不因新实例加入而立即迁移已有连接。
- 每轮只迁移少量 binding，控制连接重建速率。
- owner release lease 前必须先 stop local connection，再按 token release Redis lease。
- 新 owner 仍必须 acquire binding lease 成功后才能 start connection。
- 如果 release 或 acquire 失败，下一轮定时扫描会修复。

#### Lead 失效时的行为

Lead 失效不会导致已有 connection 中断：

- 已有 owner 继续 renew binding lease 并运行 connection。
- 新 binding 可能暂时不被调度。
- 新 lead 选出后，通过全量扫描发现 unowned enabled bindings 并补齐。
- 如果 owner 实例宕机，对应 binding lease 过期，新 lead 或任意兜底 reconcile 会重新调度。

#### 是否还需要实例自发抢 lease

可以保留一个低频 fallback：非 lead 实例定期扫描 unowned enabled bindings 并尝试 acquire lease，但只作为 lead 不可用时的兜底。

```text
non-lead fallback reconcile
  -> if no healthy leader observed:
       try acquire unowned enabled bindings with conservative rate limit
```

这样 lead 是常规路径，Lease-First 是容灾路径。系统不会因为 lead 暂时不可用而永久漏连 binding。

### 9.2 Redis Lease

示例 key：

```text
gateway:binding-owner:{bindingId}
```

示例 value：

```json
{
  "instanceId": "gateway-1",
  "leaseToken": "uuid",
  "assignmentVersion": 42,
  "expiresAt": "2026-04-20T12:00:00.000Z"
}
```

规则：

- 只有 acquire lease 成功的实例可以启动 connection。
- renew/release 必须验证 lease token。
- lease 过期后其他实例可以接管。
- 续租失败时本地 Runtime 必须停止相关 connection。
- binding disabled/deleted 时 owner 必须 release lease 并停止 connection。

## 10. 推荐后续演进顺序

### Step 1: 明确当前边界（已完成）

- Application services 分层（application/infra/runtime）。
- DomainEventBus 作为 best-effort fast-path。
- `RelayRuntime` 作为本地聚合根建模 RuntimeOwnershipState。
- Channel Binding 增加 Connection Status 三类状态模型。
- 文档明确混合持久化策略（状态持久化 + 领域事件广播）。

### Step 2: Outbox Worker 实现

实现可靠事件投递：

```text
outbox 表 schema
  -> Outbox Worker 轮询 pending 记录
  -> 发布到 DomainEventBus
  -> 标记 processed_at
  -> 幂等消费者（reconciliation）
```

### Step 3: 单实例 Scheduler/Lead 与本地 Runtime reconciliation

在单实例模式实现 local Scheduler/Lead，并让 `RelayRuntime` 从空状态启动、只响应本地调度任务：

```text
process start
  -> RelayRuntime.bootstrapEmpty()
  -> local Scheduler/Lead scans enabled channel_bindings
  -> local Scheduler/Lead schedules runnable bindingId to local instance
  -> local ownership grant
  -> RelayRuntime.attachBinding(bindingId)

local runtime reconciliation
  -> for each ownedBindingId:
       validate binding still exists and runnable
       refreshBinding(bindingId) or detachBinding(bindingId)
```

这一步不需要 Redis，但会为集群模式中的 leader scheduling、binding lease 和 scheduled binding wakeup 打好基础。

### Step 4: Redis cluster coordination

实现：

- instance membership heartbeat
- leader election / leader lease renew
- lead scheduler for unowned bindings
- binding ownership lease acquire/renew/release
- scheduled binding wakeup
- low-rate rebalance
- lease loss handling

### Step 5: 高频连接消息处理（后续单独设计）

每个 connection 的消息监听、持久化和路由是高频操作，涉及独立的存储设计和吞吐量保障，与当前低频配置架构分开，在集群分片设计确定后单独扩展。

## 11. 总结规则

1. Agent 和 ChannelBinding 采用状态持久化：`agents`、`channel_bindings` 表直接存储当前状态，是 source of truth。不使用 Event Sourcing。
2. 领域事件通过 Outbox Pattern 保证原子性和 at-least-once 投递。DomainEventBus 是 fast-path，不是持久化保证。
3. Runtime in-memory snapshot 是可丢弃缓存，必须能从 DB state tables + Redis ownership 重建。
4. 进程启动时直接从 DB 读取配置状态，不需要 projection catch-up。
5. 单实例模式下 local Scheduler/Lead 会通过 local ownership grant 将所有 enabled runnable bindings 调度给本地进程；`RelayRuntime` 仍从空状态启动，只执行已调度的本地 bindings。
6. 集群模式下 Redis binding lease 决定哪个实例运行 binding；lead 只负责调度和均衡，不负责 correctness。
7. `RelayRuntime` 只执行本实例拥有的 bindings。
8. Domain events 可以 wake Scheduler/Lead，但不能替代 Scheduler/Lead reconciliation 和 local runtime reconciliation。
9. DB commit 先于事件发布，事件发布先于 runtime side effects。
10. connection lifecycle 是 side effect，不应和配置事实混在一起建模。
11. Channel Binding 有三类状态：Desired State（配置，写入 DB state tables）、Owner State（集群协调，写入 Redis）、Connection Status（运行时，存在于 RelayRuntime 本地聚合根）。三类状态独立管理，来源和生命周期各不相同。
12. `RelayRuntime` 以本地聚合根建模其 RuntimeOwnershipState：所有 connection 操作通过聚合方法发起，`ownedBindings` 集合与实际 connection 实例及其 Connection Status 始终保持一致。
13. 集群 lead 负责发现未连接 binding、监听配置事件并分发调度任务；实例收到任务后仍必须成功 acquire Redis binding lease，才能启动 connection。
14. 启动冷却、期望实例数、分配批次和 rebalance 参数只影响调度速度与均衡效果，不能作为 binding 是否运行的正确性前提。
