import type { DomainEvent } from "@a2a-channels/domain";

import type { DomainEventBus } from "../infra/domain-event-bus.js";
import type { RuntimeAssignmentCoordinator } from "./runtime-assignment-coordinator.js";

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

export class LocalScheduler {
  private debounceTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private reconciling = false;
  private readonly eventHandlers = new Map<
    DomainEvent["eventType"],
    () => void
  >();

  constructor(
    private readonly coordinator: RuntimeAssignmentCoordinator,
    private readonly eventBus: DomainEventBus,
    private readonly options: LocalSchedulerOptions = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    for (const eventType of RUNTIME_EVENT_TYPES) {
      const handler = () => this.scheduleReconcile();
      this.eventHandlers.set(eventType, handler);
      this.eventBus.on(eventType, handler);
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
    for (const [eventType, handler] of this.eventHandlers) {
      this.eventBus.off(eventType, handler);
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
    this.reconciling = true;
    try {
      await this.coordinator.reconcile();
    } finally {
      this.reconciling = false;
    }
  }
}
