import { Redis } from "ioredis";
import { inject, injectable } from "inversify";

import { GatewayConfigService } from "../bootstrap/config.js";

/**
 * Redis client lifecycle wrapper.
 *
 * Created once at process start and shared across all Redis-backed infra
 * services. Callers must call connect() before the first use and disconnect()
 * on graceful shutdown.
 */
@injectable()
export class RedisClientService {
  private client: Redis | null = null;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
  ) {}

  /**
   * Returns the shared Redis client, creating it lazily on first access.
   * Prefer connect() during bootstrap to surface connection errors early.
   */
  getClient(): Redis {
    if (!this.client) {
      this.client = this.createClient();
    }
    return this.client;
  }

  /** Opens the connection eagerly so boot-time failures are surfaced early. */
  async connect(): Promise<void> {
    const client = this.getClient();
    // ioredis connects lazily; ping forces an actual round-trip.
    await client.ping();
  }

  async disconnect(): Promise<void> {
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
