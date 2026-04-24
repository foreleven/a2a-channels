import type { RedisCoordinationKeys } from "./types.js";

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
