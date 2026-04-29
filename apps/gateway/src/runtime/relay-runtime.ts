import { inject, injectable } from "inversify";
import type {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";

import { GatewayConfigService } from "../bootstrap/config.js";
import { RuntimeNodeStateRepository } from "../infra/runtime-node-repo.js";
import { ConnectionManager } from "./connection-manager.js";
import { OpenClawRuntimeAssembler } from "./openclaw-runtime-assembler.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";
import { RuntimeAssignmentService } from "./runtime-assignment-service.js";
import { RuntimeScheduler } from "./scheduler.js";
import { RuntimeOpenClawConfigProjection } from "./runtime-openclaw-config-projection.js";

/**
 * Runtime-side composition root for the relay path.
 *
 * This class wires together:
 * - desired binding/agent assignment services
 * - the OpenClaw host/runtime assembly
 * - live connection execution
 * - scheduler and domain-event bridge lifecycle
 *
 * It is intentionally orchestration-heavy. Domain decisions should already be
 * made by the injected collaborators before they reach this class.
 */
@injectable()
export class RelayRuntime {
  readonly runtime: OpenClawPluginRuntime;
  readonly pluginHost: OpenClawPluginHost;
  readonly connectionManager: ConnectionManager;
  private bootstrapPromise: Promise<void> | null = null;
  private bootstrapped = false;
  private schedulerStarted = false;

  /** Builds the OpenClaw assembly and wires connection callbacks into runtime state. */
  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(RuntimeNodeStateRepository)
    private readonly runtimeNodeRepository: RuntimeNodeStateRepository,
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(RuntimeAgentRegistry)
    private readonly agentRegistry: RuntimeAgentRegistry,
    @inject(RuntimeOpenClawConfigProjection)
    private readonly openClawConfigProjection: RuntimeOpenClawConfigProjection,
    @inject(OpenClawRuntimeAssembler)
    runtimeAssembler: OpenClawRuntimeAssembler,
    @inject(ConnectionManager)
    connectionManager: ConnectionManager,
    @inject(RuntimeScheduler)
    private readonly scheduler: RuntimeScheduler,
  ) {
    this.connectionManager = connectionManager;

    // The OpenClaw runtime reads projected config on demand instead of owning
    // its own durable config file in this gateway.
    const assembly = runtimeAssembler.assemble({
      config: {
        loadConfig: () => this.openClawConfigProjection.getConfig(),
        writeConfigFile: async () => {
          throw new Error("Not implemented");
        },
      },
      handleChannelReplyEvent: (event) =>
        this.connectionManager.handleEvent(event),
    });
    this.runtime = assembly.runtime;
    this.pluginHost = assembly.pluginHost;

    // ConnectionManager handles the imperative edge of long-lived channel
    // bindings; RelayRuntime only translates its callbacks into runtime-state
    // updates and telemetry.
    this.connectionManager.initialize({
      host: this.pluginHost,
      getAgentClient: (agentId) => this.agentRegistry.getAgentClient(agentId),
      emitMessageInbound: (event) => this.runtime.emit("message:inbound", event),
      emitMessageOutbound: (event) =>
        this.runtime.emit("message:outbound", event),
      callbacks: {
        onConnectionStatus: ({ binding, status, agentUrl, error }) => {
          this.assignments.handleOwnedConnectionStatus(binding.id, status, {
            agentUrl,
            error,
            restartConnection: async (nextBinding) => {
              await this.connectionManager.restartConnection(nextBinding);
            },
          });
        },
        onAgentCallFailed: ({ binding, error }) => {
          console.error(
            `[runtime] agent call failed for binding ${binding.id}:`,
            String(error),
          );
        },
      },
    });
  }

  /** Registers this runtime node and starts the relay scheduler/event bridge once. */
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

  /** Stops scheduler/event subscriptions and drains relay-owned connections and clients. */
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

  /** Performs the ordered bootstrap sequence and rolls back partial startup on failure. */
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

  /** Reserves the relay bootstrap hook for future relay-owned startup work. */
  private async bootstrapRelay(): Promise<void> {
    // Relay bootstrap is intentionally light; connection ownership is driven by
    // reconciliation and connection callbacks rather than by this method.
  }

  /** Clears retry timers and stops all runtime-owned imperative resources. */
  private async shutdownRelay(): Promise<void> {
    this.assignments.clearReconnectsForOwnedBindings();
    await this.connectionManager.stopAllConnections();
    await this.agentRegistry.stopAllClients();
  }

  /** Best-effort cleanup for resources that may have started before bootstrap failed. */
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
