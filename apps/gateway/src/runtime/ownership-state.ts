import type {
  ChannelBinding,
  RuntimeConnectionStatus,
} from "@a2a-channels/core";
import { injectable } from "inversify";

import {
  createReconnectPolicy,
  type ReconnectDecision,
  type ReconnectPolicy,
} from "./reconnect-policy.js";

export const RuntimeOwnershipState = Symbol.for(
  "runtime.RuntimeOwnershipState",
);

export interface OwnedRuntimeBinding {
  binding: ChannelBinding;
  status: RuntimeConnectionStatus;
  reconnectAttempt: number;
}

interface OwnedRuntimeBindingRecord extends OwnedRuntimeBinding {
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
  markError(
    bindingId: string,
    error: unknown,
    agentUrl?: string,
  ): ReconnectDecision;
}

export interface CreateRuntimeOwnershipStateOptions {
  reconnectPolicy?: ReconnectPolicy;
}

function cloneBinding(binding: ChannelBinding): ChannelBinding {
  return structuredClone(binding);
}

function cloneStatus(status: RuntimeConnectionStatus): RuntimeConnectionStatus {
  return { ...status };
}

function cloneOwnedBinding(entry: OwnedRuntimeBinding): OwnedRuntimeBinding {
  return {
    binding: cloneBinding(entry.binding),
    status: cloneStatus(entry.status),
    reconnectAttempt: entry.reconnectAttempt,
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

function createOwnedBinding(
  binding: ChannelBinding,
): OwnedRuntimeBindingRecord {
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

@injectable()
export class InMemoryRuntimeOwnershipState implements RuntimeOwnershipState {
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly bindings = new Map<string, OwnedRuntimeBindingRecord>();

  constructor(options: CreateRuntimeOwnershipStateOptions = {}) {
    this.reconnectPolicy = options.reconnectPolicy ?? createReconnectPolicy();
  }

  private getOwnedBindingOrThrow(bindingId: string): OwnedRuntimeBindingRecord {
    const owned = this.bindings.get(bindingId);
    if (!owned) {
      throw new Error(`Binding ${bindingId} not found`);
    }

    return owned;
  }

  private setStatus(
    bindingId: string,
    status: RuntimeConnectionStatus["status"],
    agentUrl?: string,
    error?: unknown,
  ): RuntimeConnectionStatus {
    const owned = this.getOwnedBindingOrThrow(bindingId);

    owned.status = {
      bindingId,
      status,
      agentUrl: agentUrl ?? owned.status.agentUrl,
      error: error === undefined ? undefined : String(error),
      updatedAt: new Date().toISOString(),
    };

    return cloneStatus(owned.status);
  }

  private clearReconnectTimer(bindingId: string): void {
    const owned = this.bindings.get(bindingId);
    if (!owned || !owned.reconnectTimer) {
      return;
    }

    clearTimeout(owned.reconnectTimer);
    owned.reconnectTimer = null;
  }

  private resetToIdle(bindingId: string): RuntimeConnectionStatus {
    this.clearReconnectTimer(bindingId);
    const owned = this.getOwnedBindingOrThrow(bindingId);
    owned.reconnectAttempt = 0;
    return this.setStatus(bindingId, "idle");
  }

  private advanceReconnect(
    bindingId: string,
    status: "disconnected" | "error",
    agentUrl?: string,
    error?: unknown,
  ): ReconnectDecision {
    const owned = this.getOwnedBindingOrThrow(bindingId);

    const attempt = owned.reconnectAttempt + 1;
    owned.reconnectAttempt = attempt;
    this.setStatus(bindingId, status, agentUrl, error);
    return this.reconnectPolicy.next(attempt);
  }

  upsertBinding(
    binding: ChannelBinding,
    options: RuntimeOwnershipUpsertOptions,
  ): RuntimeOwnershipUpsertResult {
    const existing = this.bindings.get(binding.id);
    const equivalent = existing
      ? areBindingsEquivalent(existing.binding, binding)
      : false;

    if (!existing) {
      this.bindings.set(binding.id, createOwnedBinding(binding));
    } else {
      existing.binding = cloneBinding(binding);
    }

    const owned = this.getOwnedBindingOrThrow(binding.id);

    if (!binding.enabled || !options.runnable) {
      this.resetToIdle(binding.id);
      return {
        publishSnapshot: true,
        shouldRestart: false,
        shouldStop: true,
      };
    }

    if (
      existing &&
      equivalent &&
      options.hasActiveConnection &&
      !options.forceRestart
    ) {
      return {
        publishSnapshot: false,
        shouldRestart: false,
        shouldStop: false,
      };
    }

    this.resetToIdle(binding.id);
    owned.binding = cloneBinding(binding);

    return {
      publishSnapshot: true,
      shouldRestart: true,
      shouldStop: false,
    };
  }

  attachBinding(binding: ChannelBinding): void {
    this.upsertBinding(binding, {
      forceRestart: false,
      hasActiveConnection: false,
      runnable: false,
    });
  }

  detachBinding(bindingId: string): void {
    this.releaseBinding(bindingId);
  }

  releaseBinding(bindingId: string): boolean {
    const owned = this.bindings.get(bindingId);
    if (!owned) {
      return false;
    }

    this.clearReconnectTimer(bindingId);
    this.bindings.delete(bindingId);
    return true;
  }

  getOwnedBinding(bindingId: string): OwnedRuntimeBinding | undefined {
    const owned = this.bindings.get(bindingId);
    return owned ? cloneOwnedBinding(owned) : undefined;
  }

  listOwnedBindings(): OwnedRuntimeBinding[] {
    return Array.from(this.bindings.values())
      .map((entry) => cloneOwnedBinding(entry))
      .sort((left, right) => left.binding.id.localeCompare(right.binding.id));
  }

  listConnectionStatuses(): RuntimeConnectionStatus[] {
    return Array.from(this.bindings.values())
      .map((entry) => cloneStatus(entry.status))
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  }

  scheduleReconnect(
    bindingId: string,
    delayMs: number,
    callback: () => void | Promise<void>,
  ): void {
    const owned = this.getOwnedBindingOrThrow(bindingId);

    this.clearReconnectTimer(bindingId);
    const timer = setTimeout(() => {
      const current = this.bindings.get(bindingId);
      if (current) {
        current.reconnectTimer = null;
      }

      void Promise.resolve(callback()).catch((error) => {
        console.error(
          `[runtime] reconnect callback failed for binding ${bindingId}:`,
          error,
        );
      });
    }, delayMs);

    owned.reconnectTimer = timer;
  }

  clearReconnect(bindingId: string): void {
    this.clearReconnectTimer(bindingId);
  }

  markIdle(bindingId: string): RuntimeConnectionStatus {
    return this.resetToIdle(bindingId);
  }

  markConnecting(
    bindingId: string,
    agentUrl?: string,
  ): RuntimeConnectionStatus {
    this.clearReconnectTimer(bindingId);
    return this.setStatus(bindingId, "connecting", agentUrl);
  }

  markConnected(bindingId: string, agentUrl?: string): RuntimeConnectionStatus {
    this.clearReconnectTimer(bindingId);
    const owned = this.getOwnedBindingOrThrow(bindingId);
    owned.reconnectAttempt = 0;
    return this.setStatus(bindingId, "connected", agentUrl);
  }

  markDisconnected(bindingId: string, agentUrl?: string): ReconnectDecision {
    return this.advanceReconnect(bindingId, "disconnected", agentUrl);
  }

  markError(
    bindingId: string,
    error: unknown,
    agentUrl?: string,
  ): ReconnectDecision {
    return this.advanceReconnect(bindingId, "error", agentUrl, error);
  }
}

export function createRuntimeOwnershipState(
  options: CreateRuntimeOwnershipStateOptions = {},
): RuntimeOwnershipState {
  return new InMemoryRuntimeOwnershipState(options);
}
