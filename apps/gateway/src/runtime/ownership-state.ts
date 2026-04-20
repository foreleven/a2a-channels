import type { ChannelBinding, RuntimeConnectionStatus } from "@a2a-channels/core";

import {
  createReconnectPolicy,
  type ReconnectDecision,
  type ReconnectPolicy,
} from "./reconnect-policy.js";

interface OwnedRuntimeBinding {
  binding: ChannelBinding;
  status: RuntimeConnectionStatus;
  reconnectAttempt: number;
}

export interface RuntimeOwnershipState {
  attachBinding(binding: ChannelBinding): void;
  detachBinding(bindingId: string): void;
  listConnectionStatuses(): RuntimeConnectionStatus[];
  markConnecting(bindingId: string, agentUrl?: string): RuntimeConnectionStatus;
  markConnected(bindingId: string, agentUrl?: string): RuntimeConnectionStatus;
  markDisconnected(bindingId: string, agentUrl?: string): ReconnectDecision;
  markError(bindingId: string, error: unknown, agentUrl?: string): ReconnectDecision;
}

export interface CreateRuntimeOwnershipStateOptions {
  reconnectPolicy?: ReconnectPolicy;
}

export function createRuntimeOwnershipState(
  options: CreateRuntimeOwnershipStateOptions = {},
): RuntimeOwnershipState {
  const reconnectPolicy = options.reconnectPolicy ?? createReconnectPolicy();
  const bindings = new Map<string, OwnedRuntimeBinding>();

  function getOwnedBinding(bindingId: string): OwnedRuntimeBinding | undefined {
    return bindings.get(bindingId);
  }

  function setStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    agentUrl?: string,
    error?: unknown,
  ): RuntimeConnectionStatus {
    const owned = bindings.get(bindingId);
    if (!owned) {
      throw new Error(`Binding ${bindingId} not found`);
    }

    owned.status = {
      bindingId,
      status,
      agentUrl: agentUrl ?? owned.status.agentUrl,
      error: error === undefined ? undefined : String(error),
      updatedAt: new Date().toISOString(),
    };

    return owned.status;
  }

  function advanceReconnect(
    bindingId: string,
    status: "disconnected" | "error",
    agentUrl?: string,
    error?: unknown,
  ): ReconnectDecision {
    const owned = bindings.get(bindingId);
    if (!owned) {
      throw new Error(`Binding ${bindingId} not found`);
    }

    const attempt = owned.reconnectAttempt + 1;
    owned.reconnectAttempt = attempt;
    setStatus(bindingId, status, agentUrl, error);
    return reconnectPolicy.next(attempt);
  }

  return {
    attachBinding(binding: ChannelBinding): void {
      bindings.set(binding.id, {
        binding,
        status: {
          bindingId: binding.id,
          status: "idle",
          updatedAt: new Date().toISOString(),
        },
        reconnectAttempt: 0,
      });
    },

    detachBinding(bindingId: string): void {
      bindings.delete(bindingId);
    },

    listConnectionStatuses(): RuntimeConnectionStatus[] {
      return Array.from(bindings.values())
        .map((entry) => entry.status)
        .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
    },

    markConnecting(bindingId: string, agentUrl?: string): RuntimeConnectionStatus {
      const owned = bindings.get(bindingId);
      if (!owned) {
        throw new Error(`Binding ${bindingId} not found`);
      }

      return setStatus(bindingId, "connecting", agentUrl);
    },

    markConnected(bindingId: string, agentUrl?: string): RuntimeConnectionStatus {
      const owned = bindings.get(bindingId);
      if (!owned) {
        throw new Error(`Binding ${bindingId} not found`);
      }

      owned.reconnectAttempt = 0;
      return setStatus(bindingId, "connected", agentUrl);
    },

    markDisconnected(
      bindingId: string,
      agentUrl?: string,
    ): ReconnectDecision {
      return advanceReconnect(bindingId, "disconnected", agentUrl);
    },

    markError(
      bindingId: string,
      error: unknown,
      agentUrl?: string,
    ): ReconnectDecision {
      return advanceReconnect(bindingId, "error", agentUrl, error);
    },
  };
}
