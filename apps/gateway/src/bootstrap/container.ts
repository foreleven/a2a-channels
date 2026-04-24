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
import { RedisOwnershipGate } from "../runtime/cluster/redis-ownership-gate.js";
import { LeaderScheduler } from "../runtime/cluster/leader-scheduler.js";
import { ConnectionManager } from "../runtime/connection-manager.js";
import { LocalOwnershipGate } from "../runtime/local/local-ownership-gate.js";
import { LocalScheduler } from "../runtime/local/local-scheduler.js";
import { NodeRuntimeStateStore } from "../runtime/node-runtime-state-store.js";
import { OpenClawConfigBuilder } from "../runtime/openclaw-config.js";
import { OpenClawRuntimeAssembler } from "../runtime/openclaw-runtime-assembler.js";
import { RuntimeOwnershipState } from "../runtime/ownership-state.js";
import { RuntimeOwnershipGate } from "../runtime/ownership-gate.js";
import { RelayRuntime } from "../runtime/relay-runtime.js";
import { RuntimeAgentRegistry } from "../runtime/runtime-agent-registry.js";
import { RuntimeAssignmentCoordinator } from "../runtime/runtime-assignment-coordinator.js";
import { RuntimeAssignmentService } from "../runtime/runtime-assignment-service.js";
import { RuntimeBootstrapper } from "../runtime/runtime-bootstrapper.js";
import { RuntimeClusterStateReader } from "../runtime/runtime-cluster-state-reader.js";
import { RuntimeDesiredStateQuery } from "../runtime/runtime-desired-state-query.js";
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
  const container = createGatewayContainer();
  container.bind(GatewayConfigOverrides).toConstantValue(config);
  container.bind(GatewayConfigService).toSelf().inSingletonScope();
  bindInfrastructure(container);
  bindApplication(container);
  bindRuntime(container, config);
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

function bindRuntime(
  container: Container,
  config: Pick<GatewayConfigSnapshot, "clusterMode">,
): void {
  container
    .bind(LocalScheduler)
    .toDynamicValue(() => new LocalScheduler())
    .inSingletonScope();
  container.bind(NodeRuntimeStateStore).toService(LocalScheduler);

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
  container.bind(OpenClawConfigBuilder).toSelf().inSingletonScope();

  container.bind(RuntimeNodeState).toSelf().inSingletonScope();
  container.bind(RuntimeDesiredStateQuery).toSelf().inSingletonScope();
  container.bind(RuntimeSnapshotPublisher).toSelf().inSingletonScope();

  container.bind(AgentClientRegistry).toSelf().inSingletonScope();
  container.bind(RuntimeAgentRegistry).toSelf().inSingletonScope();
  container.bind(RuntimeOpenClawConfigProjection).toSelf().inSingletonScope();

  container.bind(RuntimeOwnershipState).toSelf().inSingletonScope();

  container.bind(RuntimeAssignmentService).toSelf().inSingletonScope();
  container.bind(RelayRuntime).toSelf().inSingletonScope();

  container.bind(RuntimeAssignmentCoordinator).toSelf().inSingletonScope();

  if (config.clusterMode) {
    container
      .bind(RuntimeOwnershipGate)
      .to(RedisOwnershipGate)
      .inSingletonScope();
    container.bind(RuntimeScheduler).to(LeaderScheduler).inSingletonScope();
  } else {
    container
      .bind(RuntimeOwnershipGate)
      .to(LocalOwnershipGate)
      .inSingletonScope();
    container
      .bind(RuntimeScheduler)
      .toDynamicValue(() =>
        container
          .get(LocalScheduler)
          .configure(
            container.get(RuntimeAssignmentCoordinator),
            container.get(DomainEventBus),
          ),
      )
      .inSingletonScope();
  }

  container.bind(RuntimeClusterStateReader).toSelf().inSingletonScope();
  container.bind(RuntimeBootstrapper).toSelf().inSingletonScope();
}

function bindHttp(container: Container): void {
  container.bind(GatewayWebDir).toConstantValue(DEFAULT_GATEWAY_WEB_DIR);
  container.bind(ChannelRoutes).toSelf().inSingletonScope();
  container.bind(AgentRoutes).toSelf().inSingletonScope();
  container.bind(RuntimeRoutes).toSelf().inSingletonScope();
  container.bind(HonoGatewayApp).toSelf().inSingletonScope();
  container.bind(GatewayApp).toService(HonoGatewayApp);
  container.bind(RuntimeStatusSourceToken).toService(RuntimeClusterStateReader);
}

function bindBootstrap(container: Container): void {
  container.bind(GatewayServer).toSelf().inSingletonScope();
}
