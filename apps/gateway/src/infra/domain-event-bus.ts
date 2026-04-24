/**
 * DomainEventBus – a typed, synchronous in-process event bus.
 *
 * Wraps Node's EventEmitter with generics so subscribers receive the
 * narrowly-typed event matching the eventType they subscribed to.
 */

import { EventEmitter } from "node:events";

import type { DomainEvent } from "@a2a-channels/domain";
import { injectable } from "inversify";

type EventHandler<T extends DomainEvent> = (event: T) => void;

@injectable()
export class DomainEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Prevent Node from warning about listener count for busy buses.
    this.emitter.setMaxListeners(50);
  }

  publish(event: DomainEvent): void {
    this.emitter.emit(event.eventType, event);
  }

  on<T extends DomainEvent["eventType"]>(
    eventType: T,
    handler: EventHandler<Extract<DomainEvent, { eventType: T }>>,
  ): this {
    this.emitter.on(
      eventType,
      handler as EventHandler<DomainEvent>,
    );
    return this;
  }

  off<T extends DomainEvent["eventType"]>(
    eventType: T,
    handler: EventHandler<Extract<DomainEvent, { eventType: T }>>,
  ): this {
    this.emitter.off(
      eventType,
      handler as EventHandler<DomainEvent>,
    );
    return this;
  }
}
