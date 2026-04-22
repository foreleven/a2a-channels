import type { RuntimeConnectionStatus } from "@a2a-channels/core";

import type { GatewayConfig } from "../bootstrap/config.js";

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

export class RuntimeNodeState {
  private lifecycle: LocalRuntimeLifecycle = "stopped";
  private lastError: string | null = null;
  private lastHeartbeatAt: string | null = null;
  private readonly bindingStatuses = new Map<string, RuntimeConnectionStatus>();

  constructor(private readonly config: GatewayConfig) {}

  markBootstrapping(): LocalRuntimeSnapshot {
    return this.updateLifecycle("bootstrapping", null, true);
  }

  markReady(): LocalRuntimeSnapshot {
    return this.updateLifecycle("ready", null, true);
  }

  markError(error: unknown): LocalRuntimeSnapshot {
    return this.updateLifecycle("error", String(error), false);
  }

  markStopping(): LocalRuntimeSnapshot {
    return this.updateLifecycle("stopping", null, false);
  }

  markStopped(): LocalRuntimeSnapshot {
    this.bindingStatuses.clear();
    return this.updateLifecycle("stopped", null, false);
  }

  attachBinding(bindingId: string): LocalRuntimeSnapshot {
    return this.setBindingStatus(bindingId, "idle");
  }

  detachBinding(bindingId: string): LocalRuntimeSnapshot {
    this.bindingStatuses.delete(bindingId);
    this.touchHeartbeatIfLive();
    return this.snapshot();
  }

  markBindingIdle(bindingId: string): LocalRuntimeSnapshot {
    return this.setBindingStatus(bindingId, "idle");
  }

  markBindingConnecting(
    bindingId: string,
    agentUrl?: string,
  ): LocalRuntimeSnapshot {
    return this.setBindingStatus(bindingId, "connecting", agentUrl);
  }

  markBindingConnected(
    bindingId: string,
    agentUrl?: string,
  ): LocalRuntimeSnapshot {
    return this.setBindingStatus(bindingId, "connected", agentUrl);
  }

  markBindingDisconnected(
    bindingId: string,
    agentUrl?: string,
  ): LocalRuntimeSnapshot {
    return this.setBindingStatus(bindingId, "disconnected", agentUrl);
  }

  markBindingError(
    bindingId: string,
    error: unknown,
    agentUrl?: string,
  ): LocalRuntimeSnapshot {
    return this.setBindingStatus(bindingId, "error", agentUrl, String(error));
  }

  snapshot(): LocalRuntimeSnapshot {
    return {
      nodeId: this.config.nodeId,
      displayName: this.config.nodeDisplayName,
      mode: this.config.clusterMode ? "cluster" : "local",
      schedulerRole: this.config.clusterMode ? "unknown" : "local",
      lastKnownAddress: this.config.runtimeAddress,
      lifecycle: this.lifecycle,
      lastHeartbeatAt: this.lastHeartbeatAt,
      lastError: this.lastError,
      bindingStatuses: Array.from(this.bindingStatuses.values(), (status) => ({
        ...status,
      })).sort((left, right) => left.bindingId.localeCompare(right.bindingId)),
      updatedAt: new Date().toISOString(),
    };
  }

  private updateLifecycle(
    lifecycle: LocalRuntimeLifecycle,
    lastError: string | null,
    touchHeartbeat: boolean,
  ): LocalRuntimeSnapshot {
    this.lifecycle = lifecycle;
    this.lastError = lastError;
    if (touchHeartbeat) {
      this.lastHeartbeatAt = new Date().toISOString();
    }
    return this.snapshot();
  }

  private setBindingStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    agentUrl?: string,
    error?: string,
  ): LocalRuntimeSnapshot {
    this.touchHeartbeatIfLive();
    this.bindingStatuses.set(bindingId, {
      bindingId,
      status,
      agentUrl,
      error,
      updatedAt: new Date().toISOString(),
    });
    return this.snapshot();
  }

  private touchHeartbeatIfLive(): void {
    if (this.lifecycle !== "bootstrapping" && this.lifecycle !== "ready") {
      return;
    }

    this.lastHeartbeatAt = new Date().toISOString();
  }
}
