import { inject, injectable } from "inversify";

import { DomainEventBus } from "../infra/domain-event-bus.js";
import type { DomainEvent } from "@a2a-channels/domain";
import {
  LOCAL_NODE_ID,
  RuntimeEventBus,
} from "./event-transport/runtime-event-bus.js";

/**
 * DomainEventBridge – translates write-side DomainEvents into RuntimeEventBus
 * broadcasts.
 *
 * The domain command handlers publish DomainEvents to DomainEventBus when an
 * aggregate changes. This bridge listens to those events and re-emits a
 * lightweight RuntimeBroadcastEvent so the runtime scheduling layer can react
 * without a direct dependency on the domain event bus.
 *
 * The bridge is lifecycle-managed because GatewayServer can retry runtime
 * bootstrap. start()/stop() must therefore be idempotent to avoid duplicated
 * event listeners and repeated runtime broadcasts.
 */
@injectable()
export class DomainEventBridge {
  private readonly handlers = new Map<
    DomainEvent["eventType"],
    (event: DomainEvent) => void
  >();

  constructor(
    @inject(DomainEventBus) private readonly domainBus: DomainEventBus,
    @inject(RuntimeEventBus) private readonly runtimeBus: RuntimeEventBus,
  ) {}

  start(nodeId: string = LOCAL_NODE_ID): void {
    if (this.handlers.size > 0) {
      return;
    }

    this.on("ChannelBindingCreated.v1", (event) =>
      this.broadcastBindingChanged(event.bindingId),
    );
    this.on("ChannelBindingUpdated.v1", (event) =>
      this.broadcastBindingChanged(event.bindingId),
    );
    this.on("ChannelBindingDeleted.v1", (event) =>
      this.broadcastBindingChanged(event.bindingId),
    );
    this.on("AgentUpdated.v1", (event) =>
      this.broadcastAgentChanged(event.agentId),
    );
    this.on("AgentDeleted.v1", (event) =>
      this.broadcastAgentChanged(event.agentId),
    );

    // Signal that this node is online. In local mode the scheduler also runs
    // its own startup reconcile, so this broadcast is a wake-up hint rather
    // than the sole correctness mechanism.
    this.runtimeBus.broadcast({ type: "NodeJoined", nodeId });
  }

  stop(): void {
    for (const [eventType, handler] of this.handlers) {
      this.domainBus.off(eventType, handler as never);
    }
    this.handlers.clear();
  }

  private on<T extends DomainEvent["eventType"]>(
    eventType: T,
    handler: (event: Extract<DomainEvent, { eventType: T }>) => void,
  ): void {
    const domainHandler = handler as (event: DomainEvent) => void;
    this.handlers.set(eventType, domainHandler);
    this.domainBus.on(eventType, handler);
  }

  private broadcastBindingChanged(bindingId: string): void {
    this.runtimeBus.broadcast({ type: "BindingChanged", bindingId });
  }

  private broadcastAgentChanged(agentId: string): void {
    this.runtimeBus.broadcast({ type: "AgentChanged", agentId });
  }
}
