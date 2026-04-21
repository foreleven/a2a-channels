import { inject, injectable } from "inversify";

import type { GatewayConfig } from "../bootstrap/config.js";
import { GatewayConfigToken } from "../bootstrap/config.js";
import { DomainEventBus } from "../infra/domain-event-bus.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { buildRuntimeBootstrap, type RuntimeBootstrap } from "./bootstrap.js";
import { RelayRuntime } from "./relay-runtime.js";

@injectable()
export class RuntimeBootstrapper {
  private runtimeBootstrap: RuntimeBootstrap | null = null;
  private bootstrapPromise: Promise<void> | null = null;
  private bootstrapped = false;

  constructor(
    @inject(GatewayConfigToken)
    private readonly config: GatewayConfig,
    @inject(RuntimeNodeStateRepository)
    private readonly runtimeNodeRepository: RuntimeNodeStateRepository,
    @inject(RelayRuntime)
    private readonly relay: RelayRuntime,
    @inject(DomainEventBus)
    private readonly eventBus: DomainEventBus,
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

      runtimeBootstrap = buildRuntimeBootstrap({
        clusterMode: this.config.clusterMode,
        redisUrl: this.config.redisUrl,
        relay: this.relay,
        eventBus: this.eventBus,
      });
      runtimeBootstrap.scheduler.start();
      this.runtimeBootstrap = runtimeBootstrap;
    } catch (error) {
      await this.cleanupFailedBootstrap(error, {
        relayBootstrapped,
        runtimeBootstrap,
      });
    }
  }

  private async cleanupFailedBootstrap(
    error: unknown,
    context: {
      relayBootstrapped: boolean;
      runtimeBootstrap: RuntimeBootstrap | null;
    },
  ): Promise<never> {
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

    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Runtime bootstrap failed and cleanup did not complete cleanly",
      );
    }

    throw error;
  }
}
