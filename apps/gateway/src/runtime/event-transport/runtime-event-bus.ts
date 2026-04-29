import type { RuntimeBroadcastEvent, RuntimeDirectedCommand } from "./types.js";

/**
 * RuntimeEventBus – the runtime coordination transport abstraction.
 *
 * Single-instance: backed by an in-process EventEmitter (LocalRuntimeEventBus).
 * Cluster: backed by Redis pub/sub (RedisRuntimeEventBus, future).
 *
 * The LOCAL_NODE_ID constant is used by single-instance implementations where
 * there is no real nodeId to route to.
 */
export const LOCAL_NODE_ID = "__local__";

/** Transport boundary for runtime coordination events and directed commands. */
export interface RuntimeEventBus {
  /** Broadcast an event to all nodes (including self). */
  broadcast(event: RuntimeBroadcastEvent): Promise<void>;

  /**
   * Send a directed command to a specific node.
   * In single-instance mode the nodeId is always LOCAL_NODE_ID.
   */
  sendDirected(
    nodeId: string,
    command: RuntimeDirectedCommand,
  ): Promise<void>;

  /**
   * Subscribe to broadcast events. Returns an unsubscribe function.
   */
  onBroadcast(handler: (event: RuntimeBroadcastEvent) => void): () => void;

  /**
   * Subscribe to directed commands addressed to this node.
   * Returns an unsubscribe function.
   */
  onDirectedCommand(
    handler: (command: RuntimeDirectedCommand) => void,
  ): () => void;
}

/** DI token for the active runtime event bus implementation. */
export const RuntimeEventBus = Symbol.for("runtime.RuntimeEventBus");
