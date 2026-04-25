import { EventEmitter } from "node:events";
import { injectable } from "inversify";

import type { RuntimeEventBus } from "./runtime-event-bus.js";
import type { RuntimeBroadcastEvent, RuntimeDirectedCommand } from "./types.js";

/**
 * In-process implementation of RuntimeEventBus for single-instance mode.
 *
 * Broadcasts and directed commands are both delivered synchronously via a
 * single EventEmitter. There is no routing by nodeId – every sendDirected call
 * is handled locally regardless of the nodeId argument.
 */
@injectable()
export class LocalRuntimeEventBus implements RuntimeEventBus {
  private readonly emitter = new EventEmitter();

  /** Configures listener capacity for local runtime coordination subscribers. */
  constructor() {
    this.emitter.setMaxListeners(50);
  }

  /** Emits a broadcast event synchronously within this process. */
  broadcast(event: RuntimeBroadcastEvent): void {
    this.emitter.emit("broadcast", event);
  }

  /** Emits a directed command locally; node id is ignored in single-instance mode. */
  sendDirected(_nodeId: string, command: RuntimeDirectedCommand): void {
    this.emitter.emit("directed", command);
  }

  /** Registers a local broadcast listener and returns an unsubscribe callback. */
  onBroadcast(handler: (event: RuntimeBroadcastEvent) => void): () => void {
    this.emitter.on("broadcast", handler);
    return () => this.emitter.off("broadcast", handler);
  }

  /** Registers a local directed-command listener and returns an unsubscribe callback. */
  onDirectedCommand(
    handler: (command: RuntimeDirectedCommand) => void,
  ): () => void {
    this.emitter.on("directed", handler);
    return () => this.emitter.off("directed", handler);
  }
}
