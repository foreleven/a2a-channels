import type { DomainEventBus } from "../infra/domain-event-bus.js";
import { createRedisOwnershipGate } from "./cluster/redis-ownership-gate.js";
import { LeaderScheduler } from "./cluster/leader-scheduler.js";
import { LocalScheduler } from "./local-scheduler.js";
import type { OwnershipGate } from "./ownership-gate.js";
import type { RuntimeAssignmentCoordinator } from "./runtime-assignment-coordinator.js";

export interface RuntimeBootstrapOptions {
  clusterMode: boolean;
  redisUrl?: string;
  coordinator: RuntimeAssignmentCoordinator;
  eventBus: DomainEventBus;
  ownershipGate?: OwnershipGate;
}

export type RuntimeBootstrap =
  | {
      schedulerKind: "leader";
      scheduler: LeaderScheduler;
    }
  | {
      schedulerKind: "local";
      scheduler: LocalScheduler;
    };

export function buildRuntimeBootstrap(
  options: RuntimeBootstrapOptions,
): RuntimeBootstrap {
  if (options.clusterMode) {
    return {
      schedulerKind: "leader",
      scheduler: new LeaderScheduler({
        coordinator: options.coordinator,
        eventBus: options.eventBus,
        ownershipGate: options.ownershipGate ?? createRedisOwnershipGate(),
      }),
    };
  }

  return {
    schedulerKind: "local",
    scheduler: new LocalScheduler(options.coordinator, options.eventBus),
  };
}
