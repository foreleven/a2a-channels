import { randomUUID } from "node:crypto";
import { injectable, inject } from "inversify";

import { RedisClientService } from "../../infra/redis-client.js";
import type {
  OwnershipGate,
  OwnershipLease,
} from "../ownership-gate.js";

/**
 * Distributed binding/leader lease gate backed by Redis NX+PX SET.
 *
 * Each lease is a Redis key whose value is an opaque token. Acquire uses
 * SET NX PX to create the key atomically. Renew uses a Lua script to re-set
 * the TTL only when the current token matches (compare-and-refresh). Release
 * uses a Lua script to delete only when the token matches.
 *
 * Lease TTL is fixed at LEASE_TTL_MS. Callers are expected to renew
 * periodically (e.g. every 10 s) to prevent expiry.
 */
@injectable()
export class RedisOwnershipGate implements OwnershipGate {
  private readonly LEASE_TTL_MS = 30_000;
  private readonly KEY_PREFIX = "a2a:lease:";

  constructor(
    @inject(RedisClientService)
    private readonly redis: RedisClientService,
  ) {}

  async acquire(bindingId: string): Promise<OwnershipLease | null> {
    const token = randomUUID();
    const key = this.leaseKey(bindingId);
    const result = await this.redis
      .getClient()
      .set(key, token, "PX", this.LEASE_TTL_MS, "NX");
    if (result !== "OK") {
      return null;
    }
    return { bindingId, token };
  }

  async renew(lease: OwnershipLease): Promise<boolean> {
    const key = this.leaseKey(lease.bindingId);
    // Lua: refresh TTL only when value matches
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;
    const result = await this.redis
      .getClient()
      .eval(script, 1, key, lease.token, String(this.LEASE_TTL_MS));
    return result === 1;
  }

  async release(lease: OwnershipLease): Promise<void> {
    const key = this.leaseKey(lease.bindingId);
    // Lua: delete only when value matches
    const script = `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      else
        return 0
      end
    `;
    await this.redis.getClient().eval(script, 1, key, lease.token);
  }

  async isHeld(bindingId: string): Promise<boolean> {
    const key = this.leaseKey(bindingId);
    const value = await this.redis.getClient().exists(key);
    return value === 1;
  }

  private leaseKey(bindingId: string): string {
    return `${this.KEY_PREFIX}${bindingId}`;
  }
}
