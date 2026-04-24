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

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  broadcast(event: RuntimeBroadcastEvent): void {
    this.emitter.emit("broadcast", event);
  }

  sendDirected(_nodeId: string, command: RuntimeDirectedCommand): void {
    this.emitter.emit("directed", command);
  }

  onBroadcast(handler: (event: RuntimeBroadcastEvent) => void): () => void {
    this.emitter.on("broadcast", handler);
    return () => this.emitter.off("broadcast", handler);
  }

  onDirectedCommand(
    handler: (command: RuntimeDirectedCommand) => void,
  ): () => void {
    this.emitter.on("directed", handler);
    return () => this.emitter.off("directed", handler);
  }
}
