import type { RuntimeConnectionStatus } from "@a2a-channels/core";

import type { GatewayConfig } from "../bootstrap/config.js";

export type LocalRuntimeLifecycle =
  | "bootstrapping"
  | "ready"
  | "stopping"
  | "stopped";

export interface LocalRuntimeSnapshot {
  nodeId: string;
  displayName: string;
  mode: "cluster" | "local";
  lastKnownAddress: string;
  lifecycle: LocalRuntimeLifecycle;
  bindingStatuses: RuntimeConnectionStatus[];
  updatedAt: string;
}

export class RuntimeNodeState {
  private lifecycle: LocalRuntimeLifecycle = "stopped";
  private readonly bindingStatuses = new Map<string, RuntimeConnectionStatus>();

  constructor(private readonly config: GatewayConfig) {}

  markBootstrapping(): LocalRuntimeSnapshot {
    return this.updateLifecycle("bootstrapping");
  }

  markReady(): LocalRuntimeSnapshot {
    return this.updateLifecycle("ready");
  }

  markStopping(): LocalRuntimeSnapshot {
    return this.updateLifecycle("stopping");
  }

  markStopped(): LocalRuntimeSnapshot {
    this.bindingStatuses.clear();
    return this.updateLifecycle("stopped");
  }

  attachBinding(bindingId: string): LocalRuntimeSnapshot {
    return this.setBindingStatus(bindingId, "idle");
  }

  detachBinding(bindingId: string): LocalRuntimeSnapshot {
    this.bindingStatuses.delete(bindingId);
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
      lastKnownAddress: this.config.runtimeAddress,
      lifecycle: this.lifecycle,
      bindingStatuses: Array.from(this.bindingStatuses.values(), (status) => ({
        ...status,
      })).sort((left, right) => left.bindingId.localeCompare(right.bindingId)),
      updatedAt: new Date().toISOString(),
    };
  }

  private updateLifecycle(lifecycle: LocalRuntimeLifecycle): LocalRuntimeSnapshot {
    this.lifecycle = lifecycle;
    return this.snapshot();
  }

  private setBindingStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    agentUrl?: string,
    error?: string,
  ): LocalRuntimeSnapshot {
    this.bindingStatuses.set(bindingId, {
      bindingId,
      status,
      agentUrl,
      error,
      updatedAt: new Date().toISOString(),
    });
    return this.snapshot();
  }
}
