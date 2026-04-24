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

export interface LocalSchedulerOptions {
  readonly debounceMs?: number;
  readonly reconcileIntervalMs?: number;
}

/** Converts local runtime bus events into debounced assignment reconciliation. */
@injectable()
export class LocalScheduler implements RuntimeScheduler {
  private debounceTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private unsubscribeBroadcast: (() => void) | null = null;
  private unsubscribeDirected: (() => void) | null = null;

  private assignments: RuntimeAssignmentService | null;
  private commandHandler: RuntimeCommandHandler | null;
  private runtimeBus: RuntimeEventBus | null;
  private coordinator: RuntimeAssignmentCoordinator | null;

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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.debounceTimer = null;
    this.intervalTimer = null;
    this.unsubscribeBroadcast?.();
    this.unsubscribeDirected?.();
    this.unsubscribeBroadcast = null;
    this.unsubscribeDirected = null;
  }

  // Public wake-up hook for callers that know desired state may have drifted.
  // The scheduler debounces this into the same path as startup reconciliation.
  scheduleReconcile(): void {
    if (this.stopped) return;
    this.scheduleNodeJoined();
  }

  private handleBroadcast(event: RuntimeBroadcastEvent): void {
    if (this.stopped) return;
    const bus = this.runtimeBus!;

    switch (event.type) {
      case "NodeJoined": {
        // Refresh locally owned bindings first, then run a desired-state scan
        // for bindings that this process does not yet own.
        const owned = this.assignments?.listOwnedBindingIds() ?? [];
        for (const bindingId of owned) {
          bus.sendDirected(LOCAL_NODE_ID, {
            type: "RefreshBinding",
            bindingId,
          });
        }
        this.debounceFullScan();
        break;
      }

      case "BindingChanged": {
        bus.sendDirected(LOCAL_NODE_ID, {
          type: "AttachBinding",
          bindingId: event.bindingId,
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
          bus.sendDirected(LOCAL_NODE_ID, {
            type: "RefreshBinding",
            bindingId,
          });
        }
        break;
      }

      case "NodeLeft":
        // Not applicable in single-instance mode; ignored.
        break;
    }
  }

  private scheduleNodeJoined(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.runtimeBus?.broadcast({ type: "NodeJoined", nodeId: LOCAL_NODE_ID });
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
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      void this.fullScan();
    }, this.options.debounceMs ?? 100);
  }

  private async fullScan(): Promise<void> {
    if (this.stopped) return;

    await this.requireCoordinator().reconcile();
  }

  private requireRuntimeBus(): RuntimeEventBus {
    if (!this.runtimeBus) {
      throw new Error("LocalScheduler runtimeBus is not configured");
    }

    return this.runtimeBus;
  }

  private requireCommandHandler(): RuntimeCommandHandler {
    if (!this.commandHandler) {
      throw new Error("LocalScheduler commandHandler is not configured");
    }

    return this.commandHandler;
  }

  private requireCoordinator(): RuntimeAssignmentCoordinator {
    if (!this.coordinator) {
      throw new Error("LocalScheduler coordinator is not configured");
    }

    return this.coordinator;
  }
}
