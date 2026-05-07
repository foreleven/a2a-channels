import { inject, injectable, unmanaged } from "inversify";

import type { RuntimeScheduler } from "../scheduler.js";
import { RuntimeAssignmentCoordinator } from "../runtime-assignment-coordinator.js";
import { RuntimeAssignmentService } from "../runtime-assignment-service.js";
import { RuntimeCommandHandler } from "../runtime-command-handler.js";
import {
  LOCAL_NODE_ID,
  RuntimeEventBus as RuntimeEventBusToken,
  type RuntimeEventBus,
} from "../event-transport/runtime-event-bus.js";
import type { RuntimeBroadcastEvent } from "../event-transport/types.js";
import {
  createSilentGatewayLogger,
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "../../infra/logger.js";

/** Timing options for local debounce and periodic reconciliation. */
export interface LocalSchedulerOptions {
  readonly debounceMs?: number;
  readonly reconcileIntervalMs?: number;
}

/** Converts local runtime bus events into debounced assignment reconciliation. */
@injectable()
export class LocalScheduler implements RuntimeScheduler {
  private nodeJoinedDebounceTimer: NodeJS.Timeout | null = null;
  private fullScanDebounceTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private unsubscribeBroadcast: (() => void) | null = null;
  private unsubscribeDirected: (() => void) | null = null;

  /** Receives runtime collaborators and optional timing settings. */
  constructor(
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(RuntimeCommandHandler)
    private readonly commandHandler: RuntimeCommandHandler,
    @inject(RuntimeEventBusToken)
    private readonly runtimeBus: RuntimeEventBus,
    @inject(RuntimeAssignmentCoordinator)
    private readonly coordinator: RuntimeAssignmentCoordinator,
    @unmanaged()
    private readonly options: LocalSchedulerOptions = {},
    @inject(GatewayLogger)
    private readonly logger: GatewayLoggerPort = createSilentGatewayLogger(),
  ) {}

  /** Subscribes to the local bus and schedules periodic desired-state reconciliation. */
  start(): void {
    if (!this.stopped) return;
    const bus = this.runtimeBus;
    this.stopped = false;
    this.logger.info("local runtime scheduler starting");

    this.unsubscribeBroadcast = bus.onBroadcast((event) =>
      this.handleBroadcast(event),
    );

    this.unsubscribeDirected = bus.onDirectedCommand((command) => {
      void this.commandHandler.handle(command);
    });

    this.intervalTimer = setInterval(
      () => this.scheduleNodeJoined(),
      this.options.reconcileIntervalMs ?? 30_000,
    );

    // Start from durable desired state, not from previous process memory.
    // This is the single-instance recovery path after restarts or missed events.
    this.scheduleNodeJoined();
  }

  /** Cancels timers and unsubscribes from local runtime bus events. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.nodeJoinedDebounceTimer) {
      clearTimeout(this.nodeJoinedDebounceTimer);
    }
    if (this.fullScanDebounceTimer) {
      clearTimeout(this.fullScanDebounceTimer);
    }
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.nodeJoinedDebounceTimer = null;
    this.fullScanDebounceTimer = null;
    this.intervalTimer = null;
    this.unsubscribeBroadcast?.();
    this.unsubscribeDirected?.();
    this.unsubscribeBroadcast = null;
    this.unsubscribeDirected = null;
    this.logger.info("local runtime scheduler stopped");
  }

  // Public wake-up hook for callers that know desired state may have drifted.
  // The scheduler debounces this into the same path as startup reconciliation.
  /** Debounces an explicit reconciliation request through the node-joined path. */
  scheduleReconcile(): void {
    if (this.stopped) return;
    this.scheduleNodeJoined();
  }

  /** Converts broadcast events into local directed commands and full scans. */
  private handleBroadcast(event: RuntimeBroadcastEvent): void {
    if (this.stopped) return;
    const bus = this.runtimeBus;

    switch (event.type) {
      case "NodeJoined": {
        // Refresh locally owned bindings first, then run a desired-state scan
        // for bindings that this process does not yet own.
        const owned = this.assignments.listOwnedBindingIds();
        for (const bindingId of owned) {
          void bus
            .sendDirected(LOCAL_NODE_ID, {
              type: "RefreshBinding",
              bindingId,
            })
            .catch((error) => {
              this.logger.error(
                { bindingId, err: error },
                "failed to send refresh command",
              );
            });
        }
        this.debounceFullScan();
        break;
      }

      case "BindingChanged": {
        void bus
          .sendDirected(LOCAL_NODE_ID, {
            type: "AttachBinding",
            bindingId: event.bindingId,
          })
          .catch((error) => {
            this.logger.error(
              { bindingId: event.bindingId, err: error },
              "failed to send attach command",
            );
          });
        break;
      }

      case "AgentChanged": {
        // Refresh every binding currently owned by this node that uses the
        // changed agent.
        const affectedIds = this.assignments
          .listBindings()
          .filter((b) => b.agentId === event.agentId)
          .map((b) => b.id);
        for (const bindingId of affectedIds) {
          void bus
            .sendDirected(LOCAL_NODE_ID, {
              type: "RefreshBinding",
              bindingId,
            })
            .catch((error) => {
              this.logger.error(
                { bindingId, agentId: event.agentId, err: error },
                "failed to send refresh command",
              );
            });
        }
        break;
      }

      case "NodeLeft":
        // Not applicable in single-instance mode; ignored.
        break;
    }
  }

  /** Debounces a synthetic NodeJoined broadcast to refresh local desired state. */
  private scheduleNodeJoined(): void {
    if (this.stopped) return;
    if (this.nodeJoinedDebounceTimer) {
      clearTimeout(this.nodeJoinedDebounceTimer);
    }
    this.nodeJoinedDebounceTimer = setTimeout(() => {
      this.nodeJoinedDebounceTimer = null;
      void this.runtimeBus
        .broadcast({ type: "NodeJoined", nodeId: LOCAL_NODE_ID })
        .catch((error) => {
          this.logger.error(
            { nodeId: LOCAL_NODE_ID, err: error },
            "failed to broadcast local node join",
          );
        });
    }, this.options.debounceMs ?? 100);
  }

  /**
   * Full single-instance desired-state scan.
   *
   * LocalScheduler owns timing and debounce only. The coordinator owns DB reads
   * and assignment decisions so the scheduler stays an event-loop adapter.
   */
  private debounceFullScan(): void {
    if (this.stopped) return;
    if (this.fullScanDebounceTimer) {
      clearTimeout(this.fullScanDebounceTimer);
    }
    this.fullScanDebounceTimer = setTimeout(() => {
      this.fullScanDebounceTimer = null;
      void this.fullScan();
    }, this.options.debounceMs ?? 100);
  }

  /** Runs the coordinator reconciliation unless the scheduler has been stopped. */
  private async fullScan(): Promise<void> {
    if (this.stopped) return;

    await this.coordinator.reconcile();
  }
}
