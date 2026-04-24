import { randomUUID } from "node:crypto";
import { injectable } from "inversify";

import type {
  OwnershipGate,
  OwnershipLease,
} from "../ownership-gate.js";

/** In-process ownership gate for single-node runtime assignments. */
@injectable()
export class LocalOwnershipGate implements OwnershipGate {
  private readonly held = new Map<string, OwnershipLease>();

  async acquire(bindingId: string): Promise<OwnershipLease | null> {
    if (this.held.has(bindingId)) {
      return null;
    }

    const lease = {
      bindingId,
      token: randomUUID(),
    };

    this.held.set(bindingId, lease);
    return lease;
  }

  async renew(lease: OwnershipLease): Promise<boolean> {
    return this.held.get(lease.bindingId)?.token === lease.token;
  }

  async release(lease: OwnershipLease): Promise<void> {
    if (this.held.get(lease.bindingId)?.token === lease.token) {
      this.held.delete(lease.bindingId);
    }
  }

  async isHeld(bindingId: string): Promise<boolean> {
    return this.held.has(bindingId);
  }
}
