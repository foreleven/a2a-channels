import { inject, injectable } from "inversify";
import type { RuntimeConnectionStatus } from "./runtime-connection-status.js";

import { GatewayConfigService } from "../bootstrap/config.js";

export type LocalRuntimeLifecycle =
  | "bootstrapping"
  | "ready"
  | "error"
  | "stopping"
  | "stopped";

export type LocalRuntimeSchedulerRole = "local" | "unknown";

export interface LocalRuntimeSnapshot {
  nodeId: string;
  displayName: string;
  mode: "cluster" | "local";
  schedulerRole: LocalRuntimeSchedulerRole;
  lastKnownAddress: string;
  lifecycle: LocalRuntimeLifecycle;
  lastHeartbeatAt: string | null;
  lastError: string | null;
  bindingStatuses: RuntimeConnectionStatus[];
  updatedAt: string;
}

@injectable()
export class RuntimeNodeState {
  private lifecycle: LocalRuntimeLifecycle = "stopped";
  private lastError: string | null = null;
  private lastHeartbeatAt: string | null = null;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
  ) {}

  markBootstrapping(): LocalRuntimeSnapshot {
    return this.updateLifecycle("bootstrapping", null, true);
  }

  markReady(
    bindingStatuses: RuntimeConnectionStatus[] = [],
  ): LocalRuntimeSnapshot {
    return this.updateLifecycle("ready", null, true, bindingStatuses);
  }

  markError(
    error: unknown,
    bindingStatuses: RuntimeConnectionStatus[] = [],
  ): LocalRuntimeSnapshot {
    return this.updateLifecycle("error", String(error), false, bindingStatuses);
  }

  markStopping(
    bindingStatuses: RuntimeConnectionStatus[] = [],
  ): LocalRuntimeSnapshot {
    return this.updateLifecycle("stopping", null, false, bindingStatuses);
  }

  markStopped(): LocalRuntimeSnapshot {
    return this.updateLifecycle("stopped", null, false);
  }

  snapshot(
    bindingStatuses: RuntimeConnectionStatus[] = [],
  ): LocalRuntimeSnapshot {
    const clonedBindingStatuses = bindingStatuses
      .map((status) => ({ ...status }))
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId));

    return {
      nodeId: this.config.nodeId,
      displayName: this.config.nodeDisplayName,
      mode: this.config.clusterMode ? "cluster" : "local",
      schedulerRole: this.config.clusterMode ? "unknown" : "local",
      lastKnownAddress: this.config.runtimeAddress,
      lifecycle: this.lifecycle,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      bindingStatuses: clonedBindingStatuses,
      updatedAt: new Date().toISOString(),
    };
  }

  private updateLifecycle(
    lifecycle: LocalRuntimeLifecycle,
    lastError: string | null,
    touchHeartbeat: boolean,
    bindingStatuses: RuntimeConnectionStatus[] = [],
  ): LocalRuntimeSnapshot {
    this.lifecycle = lifecycle;
    this.lastError = lastError;
    if (touchHeartbeat) {
      this.lastHeartbeatAt = new Date().toISOString();
    }
    return this.snapshot(bindingStatuses);
  }
}
