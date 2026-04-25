import type { RedisCoordinationKeys } from "./types.js";

/** Builds the Redis keys used by older cluster coordination helpers. */
export function buildRedisCoordinationKeys(input: {
  instanceId: string;
  bindingId: string;
}): RedisCoordinationKeys {
  return {
    bindingLeaseKey: `a2a:binding:${input.bindingId}:lease`,
    instanceHeartbeatKey: `a2a:instance:${input.instanceId}:heartbeat`,
    leaderLeaseKey: "a2a:cluster:leader",
  };
}
