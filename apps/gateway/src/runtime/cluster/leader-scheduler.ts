import type { DomainEvent } from "@a2a-channels/domain";
import type { DomainEventBus } from "../../infra/domain-event-bus.js";
import type { OwnershipGate } from "../ownership-gate.js";
import type { RuntimeAssignmentCoordinator } from "../runtime-assignment-coordinator.js";

export interface LeaderSchedulerOptions {
  coordinator: RuntimeAssignmentCoordinator;
  eventBus: DomainEventBus;
  ownershipGate: OwnershipGate;
}

export class LeaderScheduler {
  readonly kind = "leader";
  private debounceTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private reconciling = false;
  private leaderLease: { bindingId: string; token: string } | null = null;
  private readonly eventHandlers = new Map<DomainEvent["eventType"], () => void>();

  constructor(private readonly options: LeaderSchedulerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    const scheduleReconcile = () => this.scheduleReconcile();
    for (const eventType of RUNTIME_EVENT_TYPES) {
      const handler = scheduleReconcile;
      this.eventHandlers.set(eventType, handler);
      this.options.eventBus.on(eventType, handler);
    }

    this.intervalTimer = setInterval(
      () => this.scheduleReconcile(),
      30_000,
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
      this.options.eventBus.off(eventType, handler);
    }
    this.eventHandlers.clear();

    while (this.reconciling) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    if (this.leaderLease) {
      try {
        await this.options.ownershipGate.release(this.leaderLease);
      } catch {}
      this.leaderLease = null;
    }
  }

  private scheduleReconcile(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.reconcile(), 100);
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    try {
      const hasLeadership = await this.ensureLeadership();
      if (!hasLeadership) {
        return;
      }
      await this.options.coordinator.reconcile();
    } finally {
      this.reconciling = false;
    }
  }

  private async ensureLeadership(): Promise<boolean> {
    if (this.leaderLease) {
      try {
        const renewed = await this.options.ownershipGate.renew(this.leaderLease);
        if (renewed) {
          return true;
        }
      } catch {}

      try {
        await this.options.ownershipGate.release(this.leaderLease);
      } catch {}
      this.leaderLease = null;
    }

    if (this.leaderLease) {
      return true;
    }

    try {
      const lease = await this.options.ownershipGate.acquire(LEADER_LEASE_KEY);
      if (!lease) {
        return false;
      }

      this.leaderLease = lease;
      return true;
    } catch {
      return false;
    }
  }
}

const RUNTIME_EVENT_TYPES: DomainEvent["eventType"][] = [
  "ChannelBindingCreated.v1",
  "ChannelBindingUpdated.v1",
  "ChannelBindingDeleted.v1",
  "AgentUpdated.v1",
  "AgentDeleted.v1",
] as const;

const LEADER_LEASE_KEY = "runtime-assignment-coordinator";
