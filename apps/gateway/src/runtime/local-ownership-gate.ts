import { randomUUID } from "node:crypto";

import type {
  OwnershipGate,
  OwnershipLease,
} from "./ownership-gate.js";

export function createLocalOwnershipGate(): OwnershipGate {
  const held = new Map<string, OwnershipLease>();

  return {
    async acquire(bindingId) {
      if (held.has(bindingId)) {
        return null;
      }

      const lease = {
        bindingId,
        token: randomUUID(),
      };

      held.set(bindingId, lease);
      return lease;
    },
    async renew(lease) {
      return held.get(lease.bindingId)?.token === lease.token;
    },
    async release(lease) {
      if (held.get(lease.bindingId)?.token === lease.token) {
        held.delete(lease.bindingId);
      }
    },
    async isHeld(bindingId) {
      return held.has(bindingId);
    },
  };
}
