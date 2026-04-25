import "reflect-metadata";

import { Container } from "inversify";
import { fileURLToPath } from "node:url";
import {
  A2ATransport,
  ACPTransport,
  type AgentTransport,
} from "@a2a-channels/agent-transport";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";
import { AgentService } from "../application/agent-service.js";
import { RuntimeStatusQueryService } from "../application/queries/runtime-status/runtime-status-query-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import { GatewayServer } from "./gateway-server.js";
import { GatewayApp, GatewayWebDir, HonoGatewayApp } from "../http/app.js";
import { AgentRoutes } from "../http/routes/agents.js";
import { ChannelRoutes } from "../http/routes/channels.js";
import {
  RuntimeRoutes,
  RuntimeStatusSourceToken,
} from "../http/routes/runtime.js";
import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { DomainEventBus } from "../infra/domain-event-bus.js";
import { OutboxWorker } from "../infra/outbox-worker.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { AgentClientRegistry } from "../runtime/agent-client-registry.js";
import { AgentClientFactory } from "../runtime/agent-clients.js";
import { RuntimeScheduler } from "../runtime/scheduler.js";
import { ConnectionManager } from "../runtime/connection-manager.js";
import { LocalOwnershipGate } from "../runtime/local/local-ownership-gate.js";
import { LocalRuntimeSnapshotStore } from "../runtime/local/local-runtime-snapshot-store.js";
import { LocalScheduler } from "../runtime/local/local-scheduler.js";
import {
  NodeRuntimeSnapshotReader,
  NodeRuntimeSnapshotWriter,
} from "../runtime/node-runtime-snapshot-store.js";
import { OpenClawRuntimeAssembler } from "../runtime/openclaw-runtime-assembler.js";
import { RuntimeOwnershipState } from "../runtime/ownership-state.js";
import { RuntimeOwnershipGate } from "../runtime/ownership-gate.js";
import { RelayRuntime } from "../runtime/relay-runtime.js";
import { RuntimeAgentRegistry } from "../runtime/runtime-agent-registry.js";
import { RuntimeAssignmentCoordinator } from "../runtime/runtime-assignment-coordinator.js";
import { RuntimeCommandHandler } from "../runtime/runtime-command-handler.js";
import { DomainEventBridge } from "../runtime/domain-event-bridge.js";
import {
  LocalRuntimeEventBus,
  RuntimeEventBus,
} from "../runtime/event-transport/index.js";
import { RuntimeAssignmentService } from "../runtime/runtime-assignment-service.js";
import { RuntimeNodeState } from "../runtime/runtime-node-state.js";
import { RuntimeOpenClawConfigProjection } from "../runtime/runtime-openclaw-config-projection.js";
import { RuntimeSnapshotPublisher } from "../runtime/runtime-snapshot-publisher.js";
import { AgentTransportToken } from "../runtime/transport-tokens.js";
import type { GatewayConfigSnapshot } from "./config.js";
import {
  buildGatewayConfig,
  GatewayConfigOverrides,
  GatewayConfigService,
} from "./config.js";

const DEFAULT_GATEWAY_WEB_DIR = fileURLToPath(
  new URL("../../web", import.meta.url),
);

/**
 * Builds the process-wide DI container.
 *
 * Module order documents the intended dependency direction:
 * infrastructure -> application -> runtime -> HTTP -> bootstrap surface.
 *
 * Inversify resolves lazily, so this order is not a hard runtime requirement,
 * but keeping it explicit makes composition easier to audit.
 */
export function buildGatewayContainer(
  overrides: Partial<GatewayConfigSnapshot> = {},
): Container {
  const config = buildGatewayConfig(overrides);
  // Cluster mode is intentionally guarded at composition time. Keeping the
  // unsupported mode out of the object graph is safer than wiring partial
  // Redis/leader classes that would violate the runtime ownership boundary.
  if (config.clusterMode) {
    throw new Error(
      "Cluster runtime mode is not implemented yet. Run with CLUSTER_MODE=false until Redis RuntimeEventBus, membership, binding leases, and directed scheduling are implemented.",
    );
  }

  const container = createGatewayContainer();
  container.bind(GatewayConfigOverrides).toConstantValue(config);
  container.bind(GatewayConfigService).toSelf().inSingletonScope();
  bindInfrastructure(container);
  bindApplication(container);
  bindRuntime(container);
  bindHttp(container);
  bindBootstrap(container);
  return container;
}

/**
 * Creates an empty gateway DI container with the project-wide Inversify
 * options. Keep direct Container construction here so alternate composition
 * paths and focused tests do not drift from production defaults.
 */
export function createGatewayContainer(): Container {
  return new Container({ defaultScope: "Singleton" });
}

function bindInfrastructure(container: Container): void {
  // Infrastructure adapters are the only concrete implementations of domain
  // repository ports. Application services consume the ports below, not Prisma.
  container.bind(AgentConfigStateRepository).toSelf().inSingletonScope();
  container.bind(ChannelBindingStateRepository).toSelf().inSingletonScope();
  container.bind(RuntimeNodeStateRepository).toSelf().inSingletonScope();
  container.bind(DomainEventBus).toSelf().inSingletonScope();
  container.bind(OutboxWorker).toSelf().inSingletonScope();
}

function bindApplication(container: Container): void {
  container
    .bind(ChannelBindingRepository)
    .toService(ChannelBindingStateRepository);
  container.bind(AgentConfigRepository).toService(AgentConfigStateRepository);
  container.bind(ChannelBindingService).toSelf().inSingletonScope();
  container.bind(AgentService).toSelf().inSingletonScope();
}

function bindRuntime(container: Container): void {
  // Runtime services are split by responsibility:
  // - Scheduler/Coordinator decide what this node should own.
  // - CommandHandler reloads one binding and delegates local side effects.
  // - AssignmentService mutates the local runtime aggregate.
  // - ConnectionManager performs the imperative plugin/transport work.
  container
    .bind(LocalScheduler)
    .toDynamicValue(() => new LocalScheduler())
    .inSingletonScope();
  container.bind(LocalRuntimeSnapshotStore).toSelf().inSingletonScope();
  container
    .bind(NodeRuntimeSnapshotWriter)
    .toService(LocalRuntimeSnapshotStore);
  container
    .bind(NodeRuntimeSnapshotReader)
    .toService(LocalRuntimeSnapshotStore);

  container.bind(OpenClawRuntimeAssembler).toSelf().inSingletonScope();
  container.bind(ConnectionManager).toSelf().inSingletonScope();

  container
    .bind<AgentTransport>(AgentTransportToken)
    .toDynamicValue(() => new A2ATransport())
    .inSingletonScope();
  container
    .bind<AgentTransport>(AgentTransportToken)
    .toDynamicValue(() => new ACPTransport())
    .inSingletonScope();
  container.bind(AgentClientFactory).toSelf().inSingletonScope();
  container.bind(RuntimeNodeState).toSelf().inSingletonScope();
  container.bind(RuntimeSnapshotPublisher).toSelf().inSingletonScope();

  container.bind(AgentClientRegistry).toSelf().inSingletonScope();
  container.bind(RuntimeAgentRegistry).toSelf().inSingletonScope();
  container.bind(RuntimeOpenClawConfigProjection).toSelf().inSingletonScope();

  container.bind(RuntimeOwnershipState).toSelf().inSingletonScope();

  container.bind(RuntimeAssignmentService).toSelf().inSingletonScope();
  container.bind(RelayRuntime).toSelf().inSingletonScope();

  container.bind(RuntimeAssignmentCoordinator).toSelf().inSingletonScope();
  container.bind(RuntimeCommandHandler).toSelf().inSingletonScope();
  container.bind(DomainEventBridge).toSelf().inSingletonScope();

  container
    .bind(RuntimeOwnershipGate)
    .to(LocalOwnershipGate)
    .inSingletonScope();
  container.bind(RuntimeEventBus).to(LocalRuntimeEventBus).inSingletonScope();
  container
    .bind(RuntimeScheduler)
    .toDynamicValue(() =>
      container
        .get(LocalScheduler)
        .configure(
          container.get(RuntimeAssignmentService),
          container.get(RuntimeCommandHandler),
          container.get(RuntimeEventBus),
          container.get(RuntimeAssignmentCoordinator),
        ),
    )
    .inSingletonScope();

}

function bindHttp(container: Container): void {
  // HTTP routes depend on application query boundaries. They must not
  // reach into RelayRuntime or ConnectionManager directly.
  container.bind(GatewayWebDir).toConstantValue(DEFAULT_GATEWAY_WEB_DIR);
  container.bind(ChannelRoutes).toSelf().inSingletonScope();
  container.bind(AgentRoutes).toSelf().inSingletonScope();
  container.bind(RuntimeRoutes).toSelf().inSingletonScope();
  container.bind(RuntimeStatusQueryService).toSelf().inSingletonScope();
  container.bind(HonoGatewayApp).toSelf().inSingletonScope();
  container.bind(GatewayApp).toService(HonoGatewayApp);
  container.bind(RuntimeStatusSourceToken).toService(RuntimeStatusQueryService);
}

function bindBootstrap(container: Container): void {
  container.bind(GatewayServer).toSelf().inSingletonScope();
}
