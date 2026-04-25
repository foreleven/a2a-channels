/** Tunables for Redis-backed cluster coordination primitives. */
export interface ClusterRuntimeOptions {
  instanceId: string;
  leaseTtlMs: number;
  heartbeatTtlMs: number;
}

/** Namespaced Redis keys for binding leases, heartbeats, and leader election. */
export interface RedisCoordinationKeys {
  bindingLeaseKey: string;
  instanceHeartbeatKey: string;
  leaderLeaseKey: string;
}
