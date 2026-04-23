import { injectable } from "inversify";

import type {
  OwnershipGate,
  OwnershipLease,
} from "../ownership-gate.js";

@injectable()
export class RedisOwnershipGate implements OwnershipGate {
  async acquire(_bindingId: string): Promise<OwnershipLease | null> {
    throw new Error("Redis ownership gate not wired yet");
  }

  async renew(): Promise<boolean> {
    throw new Error("Redis ownership gate not wired yet");
  }

  async release(): Promise<void> {
    throw new Error("Redis ownership gate not wired yet");
  }

  async isHeld(): Promise<boolean> {
    return false;
  }
}
