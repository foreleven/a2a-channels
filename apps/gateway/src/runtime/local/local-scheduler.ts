import { injectable } from "inversify";

import type { RuntimeScheduler } from "../scheduler.js";
import { RuntimeAssignmentCoordinator } from "../runtime-assignment-coordinator.js";
import { RuntimeAssignmentService } from "../runtime-assignment-service.js";
import { RuntimeCommandHandler } from "../runtime-command-handler.js";
import {
  LOCAL_NODE_ID,
  RuntimeEventBus,
} from "../event-transport/runtime-event-bus.js";
import type { RuntimeBroadcastEvent } from "../event-transport/types.js";

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

  private assignments: RuntimeAssignmentService | null;
  private commandHandler: RuntimeCommandHandler | null;
  private runtimeBus: RuntimeEventBus | null;
  private coordinator: RuntimeAssignmentCoordinator | null;

  /** Accepts optional collaborators so tests can construct before container wiring. */
  constructor(
    assignments: RuntimeAssignmentService | null = null,
    commandHandler: RuntimeCommandHandler | null = null,
    runtimeBus: RuntimeEventBus | null = null,
    coordinator: RuntimeAssignmentCoordinator | null = null,
    private readonly options: LocalSchedulerOptions = {},
  ) {
    this.assignments = assignments;
    this.commandHandler = commandHandler;
    this.runtimeBus = runtimeBus;
    this.coordinator = coordinator;
  }

  /** Supplies collaborators before start when the scheduler is created early by DI. */
  configure(
    assignments: RuntimeAssignmentService,
    commandHandler: RuntimeCommandHandler,
    runtimeBus: RuntimeEventBus,
    coordinator: RuntimeAssignmentCoordinator,
  ): this {
    if (!this.stopped) {
      throw new Error("Cannot configure LocalScheduler after it has started");
    }

    this.assignments = assignments;
    this.commandHandler = commandHandler;
    this.runtimeBus = runtimeBus;
    this.coordinator = coordinator;
    return this;
  }

  /** Subscribes to the local bus and schedules periodic desired-state reconciliation. */
  start(): void {
    if (!this.stopped) return;
    const bus = this.requireRuntimeBus();
    this.stopped = false;

    this.unsubscribeBroadcast = bus.onBroadcast((event) =>
      this.handleBroadcast(event),
    );

    this.unsubscribeDirected = bus.onDirectedCommand((command) => {
      void this.requireCommandHandler().handle(command);
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
    const bus = this.runtimeBus!;

    switch (event.type) {
      case "NodeJoined": {
        // Refresh locally owned bindings first, then run a desired-state scan
        // for bindings that this process does not yet own.
        const owned = this.assignments?.listOwnedBindingIds() ?? [];
        for (const bindingId of owned) {
          void bus
            .sendDirected(LOCAL_NODE_ID, {
              type: "RefreshBinding",
              bindingId,
            })
            .catch((error) => {
              console.error("[runtime] failed to send refresh command:", error);
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
            console.error("[runtime] failed to send attach command:", error);
          });
        break;
      }

      case "AgentChanged": {
        // Refresh every binding currently owned by this node that uses the
        // changed agent.
        const affectedIds = (this.assignments?.listBindings() ?? [])
          .filter((b) => b.agentId === event.agentId)
          .map((b) => b.id);
        for (const bindingId of affectedIds) {
          void bus
            .sendDirected(LOCAL_NODE_ID, {
              type: "RefreshBinding",
              bindingId,
            })
            .catch((error) => {
              console.error("[runtime] failed to send refresh command:", error);
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
        ?.broadcast({ type: "NodeJoined", nodeId: LOCAL_NODE_ID })
        .catch((error) => {
          console.error("[runtime] failed to broadcast local node join:", error);
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

    await this.requireCoordinator().reconcile();
  }

  /** Returns the configured runtime bus or fails before scheduler startup. */
  private requireRuntimeBus(): RuntimeEventBus {
    if (!this.runtimeBus) {
      throw new Error("LocalScheduler runtimeBus is not configured");
    }

    return this.runtimeBus;
  }

  /** Returns the configured command handler or fails before directed handling. */
  private requireCommandHandler(): RuntimeCommandHandler {
    if (!this.commandHandler) {
      throw new Error("LocalScheduler commandHandler is not configured");
    }

    return this.commandHandler;
  }

  /** Returns the configured assignment coordinator or fails before full scans. */
  private requireCoordinator(): RuntimeAssignmentCoordinator {
    if (!this.coordinator) {
      throw new Error("LocalScheduler coordinator is not configured");
    }

    return this.coordinator;
  }
}
