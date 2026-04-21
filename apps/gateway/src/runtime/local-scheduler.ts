import type { DomainEvent } from "@a2a-channels/domain";

import type { DomainEventBus } from "../infra/domain-event-bus.js";
import type { RelayRuntime } from "./relay-runtime.js";
import {
  loadDesiredStateSnapshot,
  type RuntimeStateSnapshot,
} from "./state.js";

export interface LocalSchedulerOptions {
  readonly debounceMs?: number;
  readonly loadSnapshot?: () => Promise<RuntimeStateSnapshot>;
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
    private readonly runtime: RelayRuntime,
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
      const snapshot = await (
        this.options.loadSnapshot ?? loadDesiredStateSnapshot
      )();
      const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
      const desiredBindingIds = new Set<string>();

      for (const binding of snapshot.bindings) {
        const agent = agentsById.get(binding.agentId);
        if (!binding.enabled || !agent) {
          await this.runtime.detachBinding(binding.id);
          continue;
        }

        const isOwnedLocally = this.runtime
          .listBindings()
          .some((owned) => owned.id === binding.id);
        const needsRepair =
          !isOwnedLocally || !this.runtime.hasActiveConnection(binding.id);

        desiredBindingIds.add(binding.id);
        if (needsRepair) {
          await this.runtime.refreshBinding(binding, agent);
        }
      }

      for (const owned of this.runtime.listBindings()) {
        if (!desiredBindingIds.has(owned.id)) {
          await this.runtime.detachBinding(owned.id);
        }
      }
    } finally {
      this.reconciling = false;
    }
  }
}
