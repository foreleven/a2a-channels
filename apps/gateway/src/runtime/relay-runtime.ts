import { inject, injectable } from "inversify";
import {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@agent-relay/openclaw-compat";

import { GatewayConfigService } from "../bootstrap/config.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { ConnectionManager } from "./connection/index.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";
import { RuntimeAssignmentService } from "./runtime-assignment-service.js";
import { RuntimeScheduler } from "./scheduler.js";

/**
 * Process-local lifecycle boundary for the gateway runtime.
 *
 * RelayRuntime does not decide binding ownership, route channel messages, or
 * mutate connection status. Those responsibilities live in scheduler,
 * assignment, and connection collaborators. This class only sequences process
 * startup/shutdown and exposes the already-composed OpenClaw runtime objects
 * needed by bootstrap surfaces.
 *
 * Keep this class thin: if logic needs to inspect bindings, agents, or
 * connection status, it belongs below this boundary.
 */
@injectable()
export class RelayRuntime {
  readonly runtime: OpenClawPluginRuntime;
  readonly pluginHost: OpenClawPluginHost;
  private bootstrapPromise: Promise<void> | null = null;
  private bootstrapped = false;
  private schedulerStarted = false;

  /** Receives the runtime collaborators already composed by DI. */
  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(RuntimeNodeStateRepository)
    private readonly runtimeNodeRepository: RuntimeNodeStateRepository,
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(RuntimeAgentRegistry)
    private readonly agentRegistry: RuntimeAgentRegistry,
    @inject(ConnectionManager)
    private readonly connectionManager: ConnectionManager,
    @inject(RuntimeScheduler)
    private readonly scheduler: RuntimeScheduler,
    @inject(OpenClawPluginRuntime)
    runtime: OpenClawPluginRuntime,
    @inject(OpenClawPluginHost)
    pluginHost: OpenClawPluginHost,
  ) {
    this.runtime = runtime;
    this.pluginHost = pluginHost;
  }

  /** Registers this node and starts the scheduler once. */
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

  /** Stops scheduling first, then drains this node's runtime resources. */
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

    if (!this.bootstrapped) {
      return;
    }

    this.bootstrapped = false;
    await this.shutdownRelay();
  }

  /** Runs startup in dependency order and rolls back work that already began. */
  private async performBootstrap(): Promise<void> {
    const now = new Date();
    let relayBootstrapped = false;
    let schedulerStarted = false;

    try {
      await this.runtimeNodeRepository.upsert({
        nodeId: this.config.nodeId,
        displayName: this.config.nodeDisplayName,
        mode: this.config.clusterMode ? "cluster" : "local",
        lastKnownAddress: this.config.runtimeAddress,
        registeredAt: now,
        updatedAt: now,
      });

      await this.bootstrapRelay();
      relayBootstrapped = true;

      this.scheduler.start();
      schedulerStarted = true;
      this.schedulerStarted = true;
    } catch (error) {
      const cleanupErrors = await this.cleanupFailedBootstrap({
        relayBootstrapped,
        schedulerStarted,
      });

      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Runtime bootstrap failed and cleanup did not complete cleanly",
        );
      }

      throw error;
    }
  }

  /** Placeholder for future resources that are owned directly by this shell. */
  private async bootstrapRelay(): Promise<void> {
    // Binding ownership and connection startup are scheduler-driven.
  }

  /** Cancels reconnect work, stops owned channel connections, and closes agent clients. */
  private async shutdownRelay(): Promise<void> {
    this.assignments.clearReconnectsForOwnedBindings();
    await this.connectionManager.stopAllConnections();
    await this.agentRegistry.stopAllClients();
  }

  /** Best-effort rollback for resources started before bootstrap failed. */
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

    if (context.relayBootstrapped) {
      try {
        await this.shutdownRelay();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }

    this.schedulerStarted = false;
    return cleanupErrors;
  }
}
