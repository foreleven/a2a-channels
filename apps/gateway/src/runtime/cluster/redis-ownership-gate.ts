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
  /**
   * Lease TTL is intentionally 3× the scheduler renewal interval (30 s) so
   * that transient renewal delays or a 100 ms debounce cannot expire the lease
   * before the next successful renew call.
   */
  private readonly LEASE_TTL_MS = 90_000;
  private readonly KEY_PREFIX = "a2a:lease:";

  // Lua: refresh TTL only when value matches
  private static readonly RENEW_SCRIPT = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("PEXPIRE", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  // Lua: delete only when value matches
  private static readonly RELEASE_SCRIPT = `
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    else
      return 0
    end
  `;

  /** Receives the Redis client service used to perform lease operations. */
  constructor(
    @inject(RedisClientService)
    private readonly redis: RedisClientService,
  ) {}

  /** Attempts to atomically acquire a lease key for a binding or leader role. */
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

  /** Extends a lease only when the stored Redis token still matches this owner. */
  async renew(lease: OwnershipLease): Promise<boolean> {
    const key = this.leaseKey(lease.bindingId);
    const result = await this.redis
      .getClient()
      .eval(
        RedisOwnershipGate.RENEW_SCRIPT,
        1,
        key,
        lease.token,
        String(this.LEASE_TTL_MS),
      );
    return result === 1;
  }

  /** Deletes a lease only when the stored Redis token still matches this owner. */
  async release(lease: OwnershipLease): Promise<void> {
    const key = this.leaseKey(lease.bindingId);
    await this.redis
      .getClient()
      .eval(RedisOwnershipGate.RELEASE_SCRIPT, 1, key, lease.token);
  }

  /** Checks whether any owner currently holds the lease key. */
  async isHeld(bindingId: string): Promise<boolean> {
    const key = this.leaseKey(bindingId);
    const value = await this.redis.getClient().exists(key);
    return value === 1;
  }

  /** Builds the namespaced Redis key for a binding or coordinator lease. */
  private leaseKey(bindingId: string): string {
    return `${this.KEY_PREFIX}${bindingId}`;
  }
}
