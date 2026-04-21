import type { RelayRuntime } from "../relay-runtime.js";
import type { OwnershipGate } from "../ownership-gate.js";

export interface LeaderSchedulerOptions {
  relay: RelayRuntime;
  ownershipGate: OwnershipGate;
}

export class LeaderScheduler {
  readonly kind = "leader";

  constructor(private readonly options: LeaderSchedulerOptions) {}

  start(): void {
    // Phase 2 wiring point: leader lease acquisition and reconcile loop
    // will be introduced here without changing bootstrap selection.
    void this.options;
  }

  async stop(): Promise<void> {}
}
