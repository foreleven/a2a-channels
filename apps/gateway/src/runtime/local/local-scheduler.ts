import type { DomainEvent } from "@a2a-channels/domain";
import { injectable } from "inversify";

import { DomainEventBus } from "../../infra/domain-event-bus.js";
import type { NodeRuntimeStateStore } from "../node-runtime-state-store.js";
import type { RuntimeScheduler } from "../scheduler.js";
import { RuntimeAssignmentCoordinator } from "../runtime-assignment-coordinator.js";
import type { LocalRuntimeSnapshot } from "../runtime-node-state.js";

export interface LocalSchedulerOptions {
  readonly debounceMs?: number;
  readonly reconcileIntervalMs?: number;
}

const RUNTIME_EVENT_TYPES: DomainEvent["eventType"][] = [
  "ChannelBindingCreated.v1",
  "ChannelBindingUpdated.v1",
  "ChannelBindingDeleted.v1",
  "AgentUpdated.v1",
  "AgentDeleted.v1",
];

@injectable()
export class LocalScheduler implements RuntimeScheduler, NodeRuntimeStateStore {
  private debounceTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private reconciling = false;
  private coordinator: RuntimeAssignmentCoordinator | null;
  private eventBus: DomainEventBus | null;
  private readonly snapshots: LocalRuntimeSnapshot[] = [];
  private readonly eventHandlers = new Map<
    DomainEvent["eventType"],
    () => void
  >();

  constructor(
    coordinator: RuntimeAssignmentCoordinator | null = null,
    eventBus: DomainEventBus | null = null,
    private readonly options: LocalSchedulerOptions = {},
  ) {
    this.coordinator = coordinator;
    this.eventBus = eventBus;
  }

  configure(
    coordinator: RuntimeAssignmentCoordinator,
    eventBus: DomainEventBus,
  ): this {
    if (!this.stopped) {
      throw new Error("Cannot configure LocalScheduler after it has started");
    }

    this.coordinator = coordinator;
    this.eventBus = eventBus;
    return this;
  }

  start(): void {
    if (!this.stopped) return;
    const eventBus = this.requireEventBus();
    this.stopped = false;

    for (const eventType of RUNTIME_EVENT_TYPES) {
      const handler = () => this.scheduleReconcile();
      this.eventHandlers.set(eventType, handler);
      eventBus.on(eventType, handler);
    }

    this.intervalTimer = setInterval(
      () => this.scheduleReconcile(),
      this.options.reconcileIntervalMs ?? 30_000,
    );
    void this.reconcile();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.debounceTimer = null;
    this.intervalTimer = null;
    const eventBus = this.eventBus;
    for (const [eventType, handler] of this.eventHandlers) {
      eventBus?.off(eventType, handler);
    }
    this.eventHandlers.clear();
    while (this.reconciling) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  scheduleReconcile(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(
      () => void this.reconcile(),
      this.options.debounceMs ?? 100,
    );
  }

  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    const coordinator = this.requireCoordinator();
    this.reconciling = true;
    try {
      await coordinator.reconcile();
    } finally {
      this.reconciling = false;
    }
  }

  async publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void> {
    this.snapshots.unshift(cloneSnapshot(snapshot));
  }

  listNodeSnapshots(): LocalRuntimeSnapshot[] {
    return this.snapshots.map(cloneSnapshot);
  }

  private requireCoordinator(): RuntimeAssignmentCoordinator {
    if (!this.coordinator) {
      throw new Error("LocalScheduler coordinator is not configured");
    }

    return this.coordinator;
  }

  private requireEventBus(): DomainEventBus {
    if (!this.eventBus) {
      throw new Error("LocalScheduler event bus is not configured");
    }

    return this.eventBus;
  }
}

function cloneSnapshot(snapshot: LocalRuntimeSnapshot): LocalRuntimeSnapshot {
  return {
    ...snapshot,
    bindingStatuses: snapshot.bindingStatuses.map((status) => ({ ...status })),
  };
}
