import "reflect-metadata";

import { Container } from "inversify";
import { fileURLToPath } from "node:url";
import {
  A2ATransport,
  ACPTransport,
  type AgentTransportFactory,
} from "@a2a-channels/agent-transport";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";
import { AgentService } from "../application/agent-service.js";
import { AccountIdGenerator } from "../application/account-id-generator.js";
import { AccountService } from "../application/account-service.js";
import { ChannelAuthService } from "../application/channel-auth-service.js";
import {
  ChannelQrLoginProviderToken,
  FeishuQrLoginProvider,
  PluginQrLoginProvider,
  WechatQrLoginProvider,
} from "../application/channel-qr-login-provider.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import { RuntimeStatusService } from "../application/runtime-status-service.js";
import { GatewayServer } from "./gateway-server.js";
import { GatewayApp, GatewayWebDir, HonoGatewayApp } from "../http/app.js";
import { AgentRoutes } from "../http/routes/agents.js";
import { AccountRoutes } from "../http/routes/accounts.js";
import { ChannelRoutes } from "../http/routes/channels.js";
import { RuntimeStatusRoutes } from "../http/routes/runtime-status.js";
import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { AccountStateRepository } from "../infra/account-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { RedisClientService } from "../infra/redis-client.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { registerAllPlugins } from "../register-plugins.js";
import { AgentClientRegistry } from "../runtime/agent-client-registry.js";
import { AgentClientFactory } from "../runtime/agent-clients.js";
import { RuntimeScheduler } from "../runtime/scheduler.js";
import { ConnectionManager } from "../runtime/connection/index.js";
import { LeaderScheduler } from "../runtime/cluster/leader-scheduler.js";
import { RedisOwnershipGate } from "../runtime/cluster/redis-ownership-gate.js";
import { RedisRuntimeEventBus } from "../runtime/cluster/redis-runtime-event-bus.js";
import { LocalOwnershipGate } from "../runtime/local/local-ownership-gate.js";
import { LocalScheduler } from "../runtime/local/local-scheduler.js";
import { RuntimeOwnershipState } from "../runtime/ownership-state.js";
import { RuntimeOwnershipGate } from "../runtime/ownership-gate.js";
import { RelayRuntime } from "../runtime/relay-runtime.js";
import { RuntimeAgentRegistry } from "../runtime/runtime-agent-registry.js";
import { RuntimeAssignmentCoordinator } from "../runtime/runtime-assignment-coordinator.js";
import { RuntimeCommandHandler } from "../runtime/runtime-command-handler.js";
import {
  LocalRuntimeEventBus,
  RuntimeEventBus,
} from "../runtime/event-transport/index.js";
import { RuntimeAssignmentService } from "../runtime/runtime-assignment-service.js";
import { RuntimeOpenClawConfigProjection } from "../runtime/runtime-openclaw-config-projection.js";
import { AgentTransportToken } from "../runtime/transport-tokens.js";
import type { GatewayConfigSnapshot } from "./config.js";
import {
  buildGatewayConfig,
  GatewayConfigOverrides,
  GatewayConfigService,
} from "./config.js";
import {
  type ServiceContribution,
  ServiceContributionToken,
} from "./service-contribution.js";

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
  bindInfrastructure(container, config);
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

function bindInfrastructure(
  container: Container,
  config: GatewayConfigSnapshot,
): void {
  // Infrastructure adapters are the only concrete implementations of domain
  // repository ports. Application services consume the ports below, not Prisma.
  container.bind(AccountStateRepository).toSelf().inSingletonScope();
  container.bind(AgentConfigStateRepository).toSelf().inSingletonScope();
  container.bind(ChannelBindingStateRepository).toSelf().inSingletonScope();
  container.bind(RuntimeNodeStateRepository).toSelf().inSingletonScope();

  if (config.clusterMode) {
    container.bind(RedisClientService).toSelf().inSingletonScope();
    container.bind(RedisRuntimeEventBus).toSelf().inSingletonScope();
    container
      .bind<ServiceContribution>(ServiceContributionToken)
      .toService(RedisClientService);
    container
      .bind<ServiceContribution>(ServiceContributionToken)
      .toService(RedisRuntimeEventBus);
  }
}

function bindApplication(container: Container): void {
  container
    .bind(ChannelBindingRepository)
    .toService(ChannelBindingStateRepository);
  container.bind(AgentConfigRepository).toService(AgentConfigStateRepository);
  container.bind(AccountService).toSelf().inSingletonScope();
  container.bind(ChannelBindingService).toSelf().inSingletonScope();
  container.bind(ChannelAuthService).toSelf().inSingletonScope();
  container.bind(AccountIdGenerator).toSelf().inSingletonScope();
  container
    .bind(ChannelQrLoginProviderToken)
    .to(FeishuQrLoginProvider)
    .inSingletonScope();
  container
    .bind(ChannelQrLoginProviderToken)
    .to(WechatQrLoginProvider)
    .inSingletonScope();
  container
    .bind(ChannelQrLoginProviderToken)
    .to(PluginQrLoginProvider)
    .inSingletonScope();
  container.bind(AgentService).toSelf().inSingletonScope();
  container.bind(RuntimeStatusService).toSelf().inSingletonScope();
}

function bindRuntime(
  container: Container,
  config: GatewayConfigSnapshot,
): void {
  // Runtime services are split by responsibility:
  // - Scheduler/Coordinator decide what this node should own.
  // - CommandHandler reloads one binding and delegates local side effects.
  // - AssignmentService mutates the local runtime aggregate.
  // - ConnectionManager performs the imperative plugin/transport work.

  container.bind(ConnectionManager).toSelf().inSingletonScope();

  container
    .bind<AgentTransportFactory>(AgentTransportToken)
    .toDynamicValue(() => new A2ATransport())
    .inSingletonScope();
  container
    .bind<AgentTransportFactory>(AgentTransportToken)
    .toDynamicValue(() => new ACPTransport())
    .inSingletonScope();
  container.bind(AgentClientFactory).toSelf().inSingletonScope();

  container.bind(AgentClientRegistry).toSelf().inSingletonScope();
  container.bind(RuntimeAgentRegistry).toSelf().inSingletonScope();
  container.bind(RuntimeOpenClawConfigProjection).toSelf().inSingletonScope();
  container
    .bind(OpenClawPluginRuntime)
    .toDynamicValue(() =>
      new OpenClawPluginRuntime({
        config: {
          loadConfig: () =>
            container.get(RuntimeOpenClawConfigProjection).getConfig(),
          writeConfigFile: async () => {
            throw new Error("Not implemented");
          },
        },
      }),
    )
    .inSingletonScope();
  container
    .bind(OpenClawPluginHost)
    .toDynamicValue(() => {
      const host = new OpenClawPluginHost(
        container.get(OpenClawPluginRuntime),
      );
      registerAllPlugins(host);
      return host;
    })
    .inSingletonScope();

  container.bind(RuntimeOwnershipState).toSelf().inSingletonScope();

  container.bind(RuntimeAssignmentService).toSelf().inSingletonScope();
  container.bind(RelayRuntime).toSelf().inSingletonScope();

  container.bind(RuntimeAssignmentCoordinator).toSelf().inSingletonScope();
  container.bind(RuntimeCommandHandler).toSelf().inSingletonScope();

  if (config.clusterMode) {
    bindClusterRuntime(container);
  } else {
    bindLocalRuntime(container);
  }
}

function bindLocalRuntime(container: Container): void {
  container
    .bind(RuntimeOwnershipGate)
    .to(LocalOwnershipGate)
    .inSingletonScope();
  container.bind(RuntimeEventBus).to(LocalRuntimeEventBus).inSingletonScope();

  container.bind(LocalScheduler).toSelf().inSingletonScope();
  container.bind(RuntimeScheduler).toService(LocalScheduler);
}

function bindClusterRuntime(container: Container): void {
  container
    .bind(RuntimeOwnershipGate)
    .to(RedisOwnershipGate)
    .inSingletonScope();
  // RedisRuntimeEventBus is already bound in bindInfrastructure (cluster path).
  container
    .bind(RuntimeEventBus)
    .toService(RedisRuntimeEventBus);

  container.bind(LeaderScheduler).toSelf().inSingletonScope();
  container
    .bind(RuntimeScheduler)
    .toService(LeaderScheduler);
}

function bindHttp(container: Container): void {
  // HTTP routes depend on application query boundaries. They must not
  // reach into RelayRuntime or ConnectionManager directly.
  container.bind(GatewayWebDir).toConstantValue(DEFAULT_GATEWAY_WEB_DIR);
  container.bind(AccountRoutes).toSelf().inSingletonScope();
  container.bind(ChannelRoutes).toSelf().inSingletonScope();
  container.bind(AgentRoutes).toSelf().inSingletonScope();
  container.bind(RuntimeStatusRoutes).toSelf().inSingletonScope();
  container.bind(HonoGatewayApp).toSelf().inSingletonScope();
  container.bind(GatewayApp).toService(HonoGatewayApp);
}

function bindBootstrap(container: Container): void {
  container.bind(GatewayServer).toSelf().inSingletonScope();
}
