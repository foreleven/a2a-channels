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

  /** Acquires an in-memory lease when no local owner currently holds it. */
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

  /** Renews by verifying the caller still owns the in-memory token. */
  async renew(lease: OwnershipLease): Promise<boolean> {
    return this.held.get(lease.bindingId)?.token === lease.token;
  }

  /** Releases the in-memory lease only when the token matches. */
  async release(lease: OwnershipLease): Promise<void> {
    if (this.held.get(lease.bindingId)?.token === lease.token) {
      this.held.delete(lease.bindingId);
    }
  }

  /** Reports whether this process currently holds a lease for the id. */
  async isHeld(bindingId: string): Promise<boolean> {
    return this.held.has(bindingId);
  }
}
