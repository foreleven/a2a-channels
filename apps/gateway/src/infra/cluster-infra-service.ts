import { inject, injectable } from "inversify";

import { RedisClientService } from "./redis-client.js";
import { RedisRuntimeEventBus } from "../runtime/cluster/redis-runtime-event-bus.js";

export const ClusterInfraLifecycle = Symbol.for(
  "infra.ClusterInfraLifecycle",
);

export interface ClusterInfraLifecyclePort {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Manages cluster-mode infrastructure connections (Redis client + pub/sub).
 *
 * GatewayServer injects this optionally and calls connect() before bootstrap
 * and disconnect() on shutdown, ensuring the Redis connections are properly
 * opened and closed around the relay runtime lifecycle.
 */
@injectable()
export class ClusterInfraService implements ClusterInfraLifecyclePort {
  constructor(
    @inject(RedisClientService)
    private readonly redisClient: RedisClientService,
    @inject(RedisRuntimeEventBus)
    private readonly runtimeEventBus: RedisRuntimeEventBus,
  ) {}

  async connect(): Promise<void> {
    await this.redisClient.connect();
    await this.runtimeEventBus.connect();
  }

  async disconnect(): Promise<void> {
    await this.runtimeEventBus.disconnect();
    await this.redisClient.disconnect();
  }
}
