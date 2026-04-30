import { Redis } from "ioredis";
import { inject, injectable } from "inversify";

import { GatewayConfigService } from "../bootstrap/config.js";
import type { ServiceContribution } from "../bootstrap/service-contribution.js";

/**
 * Redis client lifecycle wrapper.
 *
 * Created once at process start and shared across all Redis-backed infra
 * services. GatewayServer starts it before runtime bootstrap and stops it
 * during graceful shutdown.
 */
@injectable()
export class RedisClientService implements ServiceContribution {
  private client: Redis | null = null;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
  ) {}

  /**
   * Returns the shared Redis client, creating it lazily on first access.
   * Prefer start() during bootstrap to surface connection errors early.
   */
  getClient(): Redis {
    if (!this.client) {
      this.client = this.createClient();
    }
    return this.client;
  }

  /** Opens the connection eagerly so boot-time failures are surfaced early. */
  async start(): Promise<void> {
    const client = this.getClient();
    // ioredis connects lazily; ping forces an actual round-trip.
    await client.ping();
  }

  async stop(): Promise<void> {
    if (this.client) {
      await this.client.quit();
      this.client = null;
    }
  }

  /** Returns a duplicate client for use in blocking subscribe mode. */
  createSubscriber(): Redis {
    return this.getClient().duplicate();
  }

  private createClient(): Redis {
    const url = this.config.redisUrl;
    if (!url) {
      throw new Error(
        "REDIS_URL is required when CLUSTER_MODE=true",
      );
    }
    return new Redis(url, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });
  }
}
