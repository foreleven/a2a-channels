import { inject, injectable } from "inversify";
import type {
  OpenClawPluginHost,
  OpenClawPluginRuntime,
} from "@a2a-channels/openclaw-compat";

import { ConnectionManager } from "./connection-manager.js";
import { OpenClawRuntimeAssembler } from "./openclaw-runtime-assembler.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";
import { RuntimeAssignmentService } from "./runtime-assignment-service.js";
import { RuntimeOpenClawConfigProjection } from "./runtime-openclaw-config-projection.js";
import { RuntimeOwnedBindingManager } from "./runtime-owned-binding-manager.js";
import { RuntimeSnapshotPublisher } from "./runtime-snapshot-publisher.js";

/**
 * Runtime-side composition root for the relay path.
 *
 * This class wires together:
 * - desired binding/agent assignment services
 * - the OpenClaw host/runtime assembly
 * - live connection execution
 * - node snapshot publication
 *
 * It is intentionally orchestration-heavy. Domain decisions should already be
 * made by the injected collaborators before they reach this class.
 */
@injectable()
export class RelayRuntime {
  readonly runtime: OpenClawPluginRuntime;
  readonly pluginHost: OpenClawPluginHost;
  readonly connectionManager: ConnectionManager;

  constructor(
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(RuntimeAgentRegistry)
    private readonly agentRegistry: RuntimeAgentRegistry,
    @inject(RuntimeOpenClawConfigProjection)
    private readonly openClawConfigProjection: RuntimeOpenClawConfigProjection,
    @inject(RuntimeOwnedBindingManager)
    private readonly ownedBindingManager: RuntimeOwnedBindingManager,
    @inject(OpenClawRuntimeAssembler)
    runtimeAssembler: OpenClawRuntimeAssembler,
    @inject(ConnectionManager)
    connectionManager: ConnectionManager,
    @inject(RuntimeSnapshotPublisher)
    private readonly snapshotPublisher: RuntimeSnapshotPublisher,
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
          this.ownedBindingManager.handleOwnedConnectionStatus(binding.id, status, {
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

  async bootstrap(): Promise<void> {
    // Relay bootstrap is intentionally light; connection ownership is driven by
    // reconciliation and connection callbacks rather than by this method.
    await this.snapshotPublisher.publishBootstrapping();
    await this.snapshotPublisher.publishReady();
  }

  async shutdown(): Promise<void> {
    await this.snapshotPublisher.publishStoppingSafely();
    this.assignments.clearReconnectsForOwnedBindings();
    await this.connectionManager.stopAllConnections();
    await this.agentRegistry.stopAllClients();
    await this.snapshotPublisher.publishStoppedSafely();
  }
}
