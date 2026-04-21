import type {
  OwnershipGate,
  OwnershipLease,
} from "../ownership-gate.js";

export function createRedisOwnershipGate(): OwnershipGate {
  return {
    async acquire(_bindingId): Promise<OwnershipLease | null> {
      throw new Error("Redis ownership gate not wired yet");
    },
    async renew() {
      throw new Error("Redis ownership gate not wired yet");
    },
    async release() {
      throw new Error("Redis ownership gate not wired yet");
    },
    async isHeld() {
      return false;
    },
  };
}
