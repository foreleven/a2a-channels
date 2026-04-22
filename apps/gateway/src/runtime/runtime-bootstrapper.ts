import { inject, injectable, unmanaged } from "inversify";

import { GatewayConfigService } from "../bootstrap/config.js";
import { DomainEventBus } from "../infra/domain-event-bus.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { buildRuntimeBootstrap, type RuntimeBootstrap } from "./bootstrap.js";
import { NodeRuntimeStateStoreToken } from "./node-runtime-state-store.js";
import type { NodeRuntimeStateStore } from "./node-runtime-state-store.js";
import { RelayRuntime } from "./relay-runtime.js";
import { RuntimeAssignmentCoordinator } from "./runtime-assignment-coordinator.js";
import type { LocalRuntimeSnapshot } from "./runtime-node-state.js";

export type RuntimeBootstrapFactory = (
  options: Parameters<typeof buildRuntimeBootstrap>[0],
) => RuntimeBootstrap;

@injectable()
export class RuntimeBootstrapper {
  private runtimeBootstrap: RuntimeBootstrap | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private bootstrapped = false;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(RuntimeNodeStateRepository)
    private readonly runtimeNodeRepository: RuntimeNodeStateRepository,
    @inject(NodeRuntimeStateStoreToken)
    private readonly stateStore: NodeRuntimeStateStore,
    @inject(RelayRuntime)
    private readonly relay: RelayRuntime,
    @inject(RuntimeAssignmentCoordinator)
    private readonly coordinator: RuntimeAssignmentCoordinator,
    @inject(DomainEventBus)
    private readonly eventBus: DomainEventBus,
    @unmanaged()
    private readonly bootstrapFactory: RuntimeBootstrapFactory = buildRuntimeBootstrap,
  ) {}

  async bootstrap(): Promise<void> {
    if (this.bootstrapped) {
      return;
    }

    if (this.bootstrapPromise) {
      return await this.bootstrapPromise;
    }

    const bootstrapPromise = this.performBootstrap();
    this.bootstrapPromise = bootstrapPromise;

    try {
      await bootstrapPromise;
      this.bootstrapped = true;
    } finally {
      if (this.bootstrapPromise === bootstrapPromise) {
        this.bootstrapPromise = null;
      }
    }
  }

  async shutdown(): Promise<void> {
    const bootstrapPromise = this.bootstrapPromise;
    if (bootstrapPromise) {
      try {
        await bootstrapPromise;
      } catch {}
    }

    const runtimeBootstrap = this.runtimeBootstrap;
    this.runtimeBootstrap = null;

    if (runtimeBootstrap) {
      await runtimeBootstrap.scheduler.stop();
    }

    if (!this.bootstrapped) {
      return;
    }

    this.bootstrapped = false;
    await this.relay.shutdown();
  }

  private async performBootstrap(): Promise<void> {
    const now = new Date();
    let relayBootstrapped = false;
    let runtimeBootstrap: RuntimeBootstrap | null = null;

    try {
      await this.runtimeNodeRepository.upsert({
        nodeId: this.config.nodeId,
        displayName: this.config.nodeDisplayName,
        mode: this.config.clusterMode ? "cluster" : "local",
        lastKnownAddress: this.config.runtimeAddress,
        registeredAt: now,
        updatedAt: now,
      });

      await this.relay.bootstrap();
      relayBootstrapped = true;

      runtimeBootstrap = this.bootstrapFactory({
        clusterMode: this.config.clusterMode,
        redisUrl: this.config.redisUrl,
        coordinator: this.coordinator,
        eventBus: this.eventBus,
      });
      runtimeBootstrap.scheduler.start();
      this.runtimeBootstrap = runtimeBootstrap;
    } catch (error) {
      const cleanupErrors = await this.cleanupFailedBootstrap({
        relayBootstrapped,
        runtimeBootstrap,
      });
      await this.publishErrorSnapshot(error);

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Runtime bootstrap failed and cleanup did not complete cleanly",
        );
      }

      throw error;
    }
  }

  private async publishErrorSnapshot(error: unknown): Promise<void> {
    const snapshot: LocalRuntimeSnapshot = {
      nodeId: this.config.nodeId,
      displayName: this.config.nodeDisplayName,
      mode: this.config.clusterMode ? "cluster" : "local",
      schedulerRole: this.config.clusterMode ? "unknown" : "local",
      lastKnownAddress: this.config.runtimeAddress,
      lifecycle: "error",
      lastHeartbeatAt: null,
      lastError: String(error),
      bindingStatuses: [],
      updatedAt: new Date().toISOString(),
    };

    try {
      await this.stateStore.publishNodeSnapshot(snapshot);
    } catch (publishError) {
      console.error(
        "[runtime] failed to publish bootstrap error snapshot:",
        publishError,
      );
    }
  }

  private async cleanupFailedBootstrap(context: {
    relayBootstrapped: boolean;
    runtimeBootstrap: RuntimeBootstrap | null;
  }): Promise<unknown[]> {
    const cleanupErrors: unknown[] = [];

    if (context.runtimeBootstrap) {
      try {
        await context.runtimeBootstrap.scheduler.stop();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    if (context.relayBootstrapped) {
      try {
        await this.relay.shutdown();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    this.runtimeBootstrap = null;
    return cleanupErrors;
  }
}
