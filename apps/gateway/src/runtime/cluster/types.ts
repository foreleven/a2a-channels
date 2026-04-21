export interface ClusterRuntimeOptions {
  instanceId: string;
  leaseTtlMs: number;
  heartbeatTtlMs: number;
}

export interface RedisCoordinationKeys {
  bindingLeaseKey: string;
  instanceHeartbeatKey: string;
  leaderLeaseKey: string;
}
