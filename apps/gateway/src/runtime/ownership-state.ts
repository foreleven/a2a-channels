import type { ChannelBinding, RuntimeConnectionStatus } from "@a2a-channels/core";

import {
  createReconnectPolicy,
  type ReconnectDecision,
  type ReconnectPolicy,
} from "./reconnect-policy.js";

export const RuntimeOwnershipStateToken = Symbol.for(
  "runtime.RuntimeOwnershipState",
);

export interface OwnedRuntimeBinding {
  binding: ChannelBinding;
  status: RuntimeConnectionStatus;
  reconnectAttempt: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

export interface RuntimeOwnershipUpsertResult {
  publishSnapshot: boolean;
  shouldRestart: boolean;
  shouldStop: boolean;
}

export interface RuntimeOwnershipUpsertOptions {
  forceRestart: boolean;
  hasActiveConnection: boolean;
  runnable: boolean;
}

export interface RuntimeOwnershipState {
  attachBinding(binding: ChannelBinding): void;
  detachBinding(bindingId: string): void;
  upsertBinding(
    binding: ChannelBinding,
    options: RuntimeOwnershipUpsertOptions,
  ): RuntimeOwnershipUpsertResult;
  releaseBinding(bindingId: string): boolean;
  getOwnedBinding(bindingId: string): OwnedRuntimeBinding | undefined;
  listOwnedBindings(): OwnedRuntimeBinding[];
  listConnectionStatuses(): RuntimeConnectionStatus[];
  scheduleReconnect(
    bindingId: string,
    delayMs: number,
    callback: () => void | Promise<void>,
  ): void;
  clearReconnect(bindingId: string): void;
  markIdle(bindingId: string): RuntimeConnectionStatus;
  markConnecting(bindingId: string, agentUrl?: string): RuntimeConnectionStatus;
  markConnected(bindingId: string, agentUrl?: string): RuntimeConnectionStatus;
  markDisconnected(bindingId: string, agentUrl?: string): ReconnectDecision;
  markError(bindingId: string, error: unknown, agentUrl?: string): ReconnectDecision;
}

export interface CreateRuntimeOwnershipStateOptions {
  reconnectPolicy?: ReconnectPolicy;
}

function cloneBinding(binding: ChannelBinding): ChannelBinding {
  return structuredClone(binding);
}

function cloneStatus(
  status: RuntimeConnectionStatus,
): RuntimeConnectionStatus {
  return { ...status };
}

function cloneOwnedBinding(entry: OwnedRuntimeBinding): OwnedRuntimeBinding {
  return {
    binding: cloneBinding(entry.binding),
    status: cloneStatus(entry.status),
    reconnectAttempt: entry.reconnectAttempt,
    reconnectTimer: entry.reconnectTimer,
  };
}

export function areBindingsEquivalent(
  left: ChannelBinding,
  right: ChannelBinding,
): boolean {
  return (
    left.name === right.name &&
    left.channelType === right.channelType &&
    left.accountId === right.accountId &&
    left.agentId === right.agentId &&
    left.enabled === right.enabled &&
    JSON.stringify(left.channelConfig) === JSON.stringify(right.channelConfig)
  );
}

function createOwnedBinding(binding: ChannelBinding): OwnedRuntimeBinding {
  const now = new Date().toISOString();
  return {
    binding: cloneBinding(binding),
    status: {
      bindingId: binding.id,
      status: "idle",
      updatedAt: now,
    },
    reconnectAttempt: 0,
    reconnectTimer: null,
  };
}

export function createRuntimeOwnershipState(
  options: CreateRuntimeOwnershipStateOptions = {},
): RuntimeOwnershipState {
  const reconnectPolicy = options.reconnectPolicy ?? createReconnectPolicy();
  const bindings = new Map<string, OwnedRuntimeBinding>();

  function getOwnedBindingOrThrow(bindingId: string): OwnedRuntimeBinding {
    const owned = bindings.get(bindingId);
    if (!owned) {
      throw new Error(`Binding ${bindingId} not found`);
    }

    return owned;
  }

  function setStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    agentUrl?: string,
    error?: unknown,
  ): RuntimeConnectionStatus {
    const owned = getOwnedBindingOrThrow(bindingId);

    owned.status = {
      bindingId,
      status,
      agentUrl: agentUrl ?? owned.status.agentUrl,
      error: error === undefined ? undefined : String(error),
      updatedAt: new Date().toISOString(),
    };

    return cloneStatus(owned.status);
  }

  function clearReconnectTimer(bindingId: string): void {
    const owned = bindings.get(bindingId);
    if (!owned || !owned.reconnectTimer) {
      return;
    }

    clearTimeout(owned.reconnectTimer);
    owned.reconnectTimer = null;
  }

  function resetToIdle(bindingId: string): RuntimeConnectionStatus {
    clearReconnectTimer(bindingId);
    const owned = getOwnedBindingOrThrow(bindingId);
    owned.reconnectAttempt = 0;
    return setStatus(bindingId, "idle");
  }

  function advanceReconnect(
    bindingId: string,
    status: "disconnected" | "error",
    agentUrl?: string,
    error?: unknown,
  ): ReconnectDecision {
    const owned = getOwnedBindingOrThrow(bindingId);

    const attempt = owned.reconnectAttempt + 1;
    owned.reconnectAttempt = attempt;
    setStatus(bindingId, status, agentUrl, error);
    return reconnectPolicy.next(attempt);
  }

  function upsertBinding(
    binding: ChannelBinding,
    options: RuntimeOwnershipUpsertOptions,
  ): RuntimeOwnershipUpsertResult {
    const existing = bindings.get(binding.id);
    const equivalent = existing
      ? areBindingsEquivalent(existing.binding, binding)
      : false;

    if (!existing) {
      bindings.set(binding.id, createOwnedBinding(binding));
    } else {
      existing.binding = cloneBinding(binding);
    }

    const owned = getOwnedBindingOrThrow(binding.id);

    if (!binding.enabled || !options.runnable) {
      resetToIdle(binding.id);
      return {
        publishSnapshot: true,
        shouldRestart: false,
        shouldStop: true,
      };
    }

    if (existing && equivalent && options.hasActiveConnection && !options.forceRestart) {
      return {
        publishSnapshot: false,
        shouldRestart: false,
        shouldStop: false,
      };
    }

    resetToIdle(binding.id);
    owned.binding = cloneBinding(binding);

    return {
      publishSnapshot: true,
      shouldRestart: true,
      shouldStop: false,
    };
  }

  return {
    attachBinding(binding: ChannelBinding): void {
      upsertBinding(binding, {
        forceRestart: false,
        hasActiveConnection: false,
        runnable: false,
      });
    },

    detachBinding(bindingId: string): void {
      this.releaseBinding(bindingId);
    },

    upsertBinding,

    releaseBinding(bindingId: string): boolean {
      const owned = bindings.get(bindingId);
      if (!owned) {
        return false;
      }

      clearReconnectTimer(bindingId);
      bindings.delete(bindingId);
      return true;
    },

    getOwnedBinding(bindingId: string): OwnedRuntimeBinding | undefined {
      const owned = bindings.get(bindingId);
      return owned ? cloneOwnedBinding(owned) : undefined;
    },

    listOwnedBindings(): OwnedRuntimeBinding[] {
      return Array.from(bindings.values())
        .map((entry) => cloneOwnedBinding(entry))
        .sort((left, right) => left.binding.id.localeCompare(right.binding.id));
    },

    listConnectionStatuses(): RuntimeConnectionStatus[] {
      return Array.from(bindings.values())
        .map((entry) => cloneStatus(entry.status))
        .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
    },

    scheduleReconnect(
      bindingId: string,
      delayMs: number,
      callback: () => void | Promise<void>,
    ): void {
      const owned = getOwnedBindingOrThrow(bindingId);

      clearReconnectTimer(bindingId);
      const timer = setTimeout(() => {
        const current = bindings.get(bindingId);
        if (current) {
          current.reconnectTimer = null;
        }

        void callback();
      }, delayMs);

      owned.reconnectTimer = timer;
    },

    clearReconnect(bindingId: string): void {
      clearReconnectTimer(bindingId);
    },

    markIdle(bindingId: string): RuntimeConnectionStatus {
      return resetToIdle(bindingId);
    },

    markConnecting(bindingId: string, agentUrl?: string): RuntimeConnectionStatus {
      clearReconnectTimer(bindingId);
      return setStatus(bindingId, "connecting", agentUrl);
    },

    markConnected(bindingId: string, agentUrl?: string): RuntimeConnectionStatus {
      clearReconnectTimer(bindingId);
      const owned = getOwnedBindingOrThrow(bindingId);
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
