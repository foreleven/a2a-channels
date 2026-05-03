import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import { injectable } from "inversify";

import {
  createReconnectPolicy,
  type ReconnectDecision,
  type ReconnectPolicy,
} from "./connection/reconnect-policy.js";
import type { RuntimeConnectionStatus } from "./connection/connection-status.js";

type ChannelBinding = ChannelBindingSnapshot;

/** Snapshot of one binding owned by this runtime node. */
export interface OwnedRuntimeBinding {
  binding: ChannelBinding;
  status: RuntimeConnectionStatus;
  reconnectAttempt: number;
}

/** Mutable owned binding record including the pending reconnect timer handle. */
interface OwnedRuntimeBindingRecord extends OwnedRuntimeBinding {
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/** Decision returned when a binding snapshot is inserted or changed. */
export interface RuntimeOwnershipUpsertResult {
  publishSnapshot: boolean;
  shouldRestart: boolean;
  shouldStop: boolean;
}

/** Runtime facts used to decide whether an upsert should restart or stop work. */
export interface RuntimeOwnershipUpsertOptions {
  forceRestart: boolean;
  hasActiveConnection: boolean;
}

/** In-memory state port for owned binding snapshots, statuses, and reconnects. */
export interface OwnershipState {
  /** Adds a binding snapshot to local ownership state. */
  attachBinding(binding: ChannelBinding): void;
  /** Removes a binding snapshot from local ownership state. */
  detachBinding(bindingId: string): void;
  /** Inserts or updates a binding and returns the connection action to apply. */
  upsertBinding(
    binding: ChannelBinding,
    options: RuntimeOwnershipUpsertOptions,
  ): RuntimeOwnershipUpsertResult;
  /** Releases a binding and reports whether local ownership existed. */
  releaseBinding(bindingId: string): boolean;
  /** Returns one owned binding snapshot when this node owns it. */
  getOwnedBinding(bindingId: string): OwnedRuntimeBinding | undefined;
  /** Lists all owned binding snapshots. */
  listOwnedBindings(): OwnedRuntimeBinding[];
  /** Lists all tracked connection status snapshots. */
  listConnectionStatuses(): RuntimeConnectionStatus[];
  /** Schedules a delayed reconnect callback for an owned binding. */
  scheduleReconnect(
    bindingId: string,
    delayMs: number,
    callback: () => void | Promise<void>,
  ): void;
  /** Cancels the pending reconnect callback for a binding. */
  clearReconnect(bindingId: string): void;
  /** Marks a binding idle and resets retry state. */
  markIdle(bindingId: string): RuntimeConnectionStatus;
  /** Marks a binding as attempting to connect. */
  markConnecting(bindingId: string, agentUrl?: string): RuntimeConnectionStatus;
  /** Marks a binding connected and clears retry state. */
  markConnected(bindingId: string, agentUrl?: string): RuntimeConnectionStatus;
  /** Marks a binding disconnected and returns the next reconnect decision. */
  markDisconnected(bindingId: string, agentUrl?: string): ReconnectDecision;
  /** Marks a binding errored and returns the next reconnect decision. */
  markError(
    bindingId: string,
    error: unknown,
    agentUrl?: string,
  ): ReconnectDecision;
}

/** Optional dependencies for constructing runtime ownership state. */
export interface CreateRuntimeOwnershipStateOptions {
  reconnectPolicy?: ReconnectPolicy;
}

/** Clones binding snapshots before storing or returning them to avoid shared mutation. */
function cloneBinding(binding: ChannelBinding): ChannelBinding {
  return structuredClone(binding);
}

/** Clones status snapshots before exposing them outside the state holder. */
function cloneStatus(status: RuntimeConnectionStatus): RuntimeConnectionStatus {
  return { ...status };
}

/** Clones an owned binding entry without exposing reconnect timer internals. */
function cloneOwnedBinding(entry: OwnedRuntimeBinding): OwnedRuntimeBinding {
  return {
    binding: cloneBinding(entry.binding),
    status: cloneStatus(entry.status),
    reconnectAttempt: entry.reconnectAttempt,
  };
}

/** Compares the binding fields that affect runtime connection behavior. */
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

/** Creates the initial owned-binding record in the idle state. */
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

/** Tracks locally owned bindings, connection status, and reconnect timers. */
@injectable()
export class RuntimeOwnershipState implements OwnershipState {
  private readonly reconnectPolicy: ReconnectPolicy;
  private readonly bindings = new Map<string, OwnedRuntimeBindingRecord>();

  /** Builds state with the default reconnect policy unless a test/policy override is supplied. */
  constructor(options: CreateRuntimeOwnershipStateOptions = {}) {
    this.reconnectPolicy = options.reconnectPolicy ?? createReconnectPolicy();
  }

  /** Returns a mutable owned record or fails when callers reference non-owned state. */
  private getOwnedBindingOrThrow(bindingId: string): OwnedRuntimeBindingRecord {
    const owned = this.bindings.get(bindingId);
    if (!owned) {
      throw new Error(`Binding ${bindingId} not found`);
    }

    return owned;
  }

  /** Stores a new status snapshot while preserving the last known agent URL when omitted. */
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

  /** Cancels and forgets the pending reconnect timer for a binding if one exists. */
  private clearReconnectTimer(bindingId: string): void {
    const owned = this.bindings.get(bindingId);
    if (!owned || !owned.reconnectTimer) {
      return;
    }

    clearTimeout(owned.reconnectTimer);
    owned.reconnectTimer = null;
  }

  /** Clears retry state and marks a binding idle before a fresh lifecycle starts. */
  private resetToIdle(bindingId: string): RuntimeConnectionStatus {
    this.clearReconnectTimer(bindingId);
    const owned = this.getOwnedBindingOrThrow(bindingId);
    owned.reconnectAttempt = 0;
    return this.setStatus(bindingId, "idle");
  }

  /** Records a failed connection edge and asks the reconnect policy for the next delay. */
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

  /** Inserts or updates an owned binding and returns the connection action to perform next. */
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

    if (!binding.enabled) {
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

  /** Adds a binding without assuming there is already an active connection. */
  attachBinding(binding: ChannelBinding): void {
    this.upsertBinding(binding, {
      forceRestart: false,
      hasActiveConnection: false,
    });
  }

  /** Removes a binding from local ownership state. */
  detachBinding(bindingId: string): void {
    this.releaseBinding(bindingId);
  }

  /** Clears timers and deletes an owned binding, reporting whether anything was removed. */
  releaseBinding(bindingId: string): boolean {
    const owned = this.bindings.get(bindingId);
    if (!owned) {
      return false;
    }

    this.clearReconnectTimer(bindingId);
    this.bindings.delete(bindingId);
    return true;
  }

  /** Returns a cloned owned-binding snapshot for one binding id. */
  getOwnedBinding(bindingId: string): OwnedRuntimeBinding | undefined {
    const owned = this.bindings.get(bindingId);
    return owned ? cloneOwnedBinding(owned) : undefined;
  }

  /** Lists cloned owned-binding snapshots in stable binding-id order. */
  listOwnedBindings(): OwnedRuntimeBinding[] {
    return Array.from(this.bindings.values())
      .map((entry) => cloneOwnedBinding(entry))
      .sort((left, right) => left.binding.id.localeCompare(right.binding.id));
  }

  /** Lists cloned connection statuses in stable binding-id order. */
  listConnectionStatuses(): RuntimeConnectionStatus[] {
    return Array.from(this.bindings.values())
      .map((entry) => cloneStatus(entry.status))
      .sort((left, right) => left.bindingId.localeCompare(right.bindingId));
  }

  /** Replaces any pending reconnect timer with a new delayed callback. */
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

  /** Cancels any pending reconnect attempt for the binding. */
  clearReconnect(bindingId: string): void {
    this.clearReconnectTimer(bindingId);
  }

  /** Marks a binding idle and resets retry counters. */
  markIdle(bindingId: string): RuntimeConnectionStatus {
    return this.resetToIdle(bindingId);
  }

  /** Marks a binding as connecting and clears stale reconnect timers. */
  markConnecting(
    bindingId: string,
    agentUrl?: string,
  ): RuntimeConnectionStatus {
    this.clearReconnectTimer(bindingId);
    return this.setStatus(bindingId, "connecting", agentUrl);
  }

  /** Marks a binding connected and resets retry attempts after a successful edge. */
  markConnected(bindingId: string, agentUrl?: string): RuntimeConnectionStatus {
    this.clearReconnectTimer(bindingId);
    const owned = this.getOwnedBindingOrThrow(bindingId);
    owned.reconnectAttempt = 0;
    return this.setStatus(bindingId, "connected", agentUrl);
  }

  /** Marks a graceful disconnect and returns the retry decision for the next attempt. */
  markDisconnected(bindingId: string, agentUrl?: string): ReconnectDecision {
    return this.advanceReconnect(bindingId, "disconnected", agentUrl);
  }

  /** Marks a connection error and returns the retry decision for the next attempt. */
  markError(
    bindingId: string,
    error: unknown,
    agentUrl?: string,
  ): ReconnectDecision {
    return this.advanceReconnect(bindingId, "error", agentUrl, error);
  }
}

/** Factory used by DI/tests to create an ownership state through the interface type. */
export function createRuntimeOwnershipState(
  options: CreateRuntimeOwnershipStateOptions = {},
): OwnershipState {
  return new RuntimeOwnershipState(options);
}
