import { inject, injectable } from "inversify";

import { RuntimeScheduler } from "../scheduler.js";
import { RuntimeOwnershipGate, type OwnershipGate } from "../ownership-gate.js";
import { RuntimeAssignmentCoordinator } from "../runtime-assignment-coordinator.js";

/** Coordinates desired-state reconciliation for the cluster leader role. */
@injectable()
export class LeaderScheduler implements RuntimeScheduler {
  readonly kind = "leader";
  private debounceTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private reconciling = false;
  private leaderLease: { bindingId: string; token: string } | null = null;

  /** Receives coordinator and lease gate used for leader-only scans. */
  constructor(
    @inject(RuntimeAssignmentCoordinator)
    private readonly coordinator: RuntimeAssignmentCoordinator,
    @inject(RuntimeOwnershipGate)
    private readonly ownershipGate: OwnershipGate,
  ) {}

  /** Starts periodic leader reconciliation. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;

    this.intervalTimer = setInterval(() => this.scheduleReconcile(), 30_000);
    void this.reconcile();
  }

  /** Unsubscribes, waits for in-flight reconciliation, and releases the leader lease. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.debounceTimer = null;
    this.intervalTimer = null;

    while (this.reconciling) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    if (this.leaderLease) {
      try {
        await this.ownershipGate.release(this.leaderLease);
      } catch {}
      this.leaderLease = null;
    }
  }

  /** Debounces leader reconciliation requests from domain events or interval ticks. */
  private scheduleReconcile(): void {
    if (this.stopped) return;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => void this.reconcile(), 100);
  }

  /** Runs desired-state reconciliation only while this node currently holds leadership. */
  private async reconcile(): Promise<void> {
    if (this.reconciling || this.stopped) return;
    this.reconciling = true;
    try {
      const hasLeadership = await this.ensureLeadership();
      if (!hasLeadership) {
        return;
      }
      await this.coordinator.reconcile();
    } finally {
      this.reconciling = false;
    }
  }

  /** Renews the existing leader lease or tries to acquire it before a cluster scan. */
  private async ensureLeadership(): Promise<boolean> {
    if (this.leaderLease) {
      try {
        const renewed = await this.ownershipGate.renew(this.leaderLease);
        if (renewed) {
          return true;
        }
      } catch {}

      try {
        await this.ownershipGate.release(this.leaderLease);
      } catch {}
      this.leaderLease = null;
    }

    if (this.leaderLease) {
      return true;
    }

    try {
      const lease = await this.ownershipGate.acquire(LEADER_LEASE_KEY);
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

const LEADER_LEASE_KEY = "runtime-assignment-coordinator";
