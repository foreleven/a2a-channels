import { inject, injectable } from "inversify";

import { GatewayConfigService } from "../bootstrap/config.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { RuntimeScheduler } from "./scheduler.js";
import {
  NodeRuntimeSnapshotWriter,
  type NodeRuntimeSnapshotWriter as NodeRuntimeSnapshotWriterPort,
} from "./node-runtime-snapshot-store.js";
import { RelayRuntime } from "./relay-runtime.js";
import { DomainEventBridge } from "./domain-event-bridge.js";
import type { LocalRuntimeSnapshot } from "./runtime-node-state.js";

/**
 * Boots and tears down the runtime side of the gateway.
 *
 * This sits below GatewayServer: the server owns process lifetime, while this
 * class owns relay/runtime registration and scheduler startup for the current
 * node.
 */
@injectable()
export class RuntimeBootstrapper {
  private bootstrapPromise: Promise<void> | null = null;
  private bootstrapped = false;
  private schedulerStarted = false;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(RuntimeNodeStateRepository)
    private readonly runtimeNodeRepository: RuntimeNodeStateRepository,
    @inject(NodeRuntimeSnapshotWriter)
    private readonly snapshotWriter: NodeRuntimeSnapshotWriterPort,
    @inject(RelayRuntime)
    private readonly relay: RelayRuntime,
    @inject(RuntimeScheduler)
    private readonly scheduler: RuntimeScheduler,
    @inject(DomainEventBridge)
    private readonly domainEventBridge: DomainEventBridge,
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

    if (this.schedulerStarted) {
      this.schedulerStarted = false;
      await this.scheduler.stop();
    }

    this.domainEventBridge.stop();

    if (!this.bootstrapped) {
      return;
    }

    this.bootstrapped = false;
    await this.relay.shutdown();
  }

  private async performBootstrap(): Promise<void> {
    const now = new Date();
    let relayBootstrapped = false;
    let schedulerStarted = false;

    try {
      // Publish/update the current node record first so cluster-aware readers
      // can observe this node even if later runtime steps fail.
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

      // The bridge converts write-side domain events into runtime broadcasts.
      // LocalScheduler also schedules its own startup reconcile, so the runtime
      // does not depend on this synchronous NodeJoined broadcast being observed.
      this.domainEventBridge.start(this.config.nodeId);

      this.scheduler.start();
      schedulerStarted = true;
      this.schedulerStarted = true;
    } catch (error) {
      const cleanupErrors = await this.cleanupFailedBootstrap({
        relayBootstrapped,
        schedulerStarted,
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
      await this.snapshotWriter.publishNodeSnapshot(snapshot);
    } catch (publishError) {
      console.error(
        "[runtime] failed to publish bootstrap error snapshot:",
        publishError,
      );
    }
  }

  private async cleanupFailedBootstrap(context: {
    relayBootstrapped: boolean;
    schedulerStarted: boolean;
  }): Promise<unknown[]> {
    const cleanupErrors: unknown[] = [];

    if (context.schedulerStarted) {
      try {
        await this.scheduler.stop();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    this.domainEventBridge.stop();

    if (context.relayBootstrapped) {
      try {
        await this.relay.shutdown();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    this.schedulerStarted = false;
    return cleanupErrors;
  }
}
