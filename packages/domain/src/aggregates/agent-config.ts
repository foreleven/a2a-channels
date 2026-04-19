/**
 * AgentConfigAggregate – write-model aggregate root for agent configurations.
 *
 * Mirrors the same event-sourcing pattern as ChannelBindingAggregate.
 */

import type {
  AgentDeleted,
  AgentEvent,
  AgentRegistered,
  AgentUpdated,
} from "../events.js";

export interface AgentConfigSnapshot {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly protocol?: string;
  readonly description?: string;
  readonly createdAt: string;
}

export class AgentConfigAggregate {
  id!: string;
  name!: string;
  url!: string;
  protocol!: string;
  description?: string;
  createdAt!: string;

  /** Number of events applied (stream version). */
  version = 0;

  /** True after an `AgentDeleted` event has been applied. */
  isDeleted = false;

  private _pendingEvents: AgentEvent[] = [];

  get pendingEvents(): readonly AgentEvent[] {
    return this._pendingEvents;
  }

  clearPendingEvents(): void {
    this._pendingEvents = [];
  }

  snapshot(): AgentConfigSnapshot {
    return {
      id: this.id,
      name: this.name,
      url: this.url,
      protocol: this.protocol,
      description: this.description,
      createdAt: this.createdAt,
    };
  }

  // -------------------------------------------------------------------------
  // Factory
  // -------------------------------------------------------------------------

  static register(data: {
    id: string;
    name: string;
    url: string;
    protocol?: string;
    description?: string;
  }): AgentConfigAggregate {
    const agg = new AgentConfigAggregate();
    agg.raiseEvent({
      eventType: "AgentRegistered.v1",
      agentId: data.id,
      name: data.name,
      url: data.url,
      protocol: data.protocol ?? "a2a",
      description: data.description,
      occurredAt: new Date().toISOString(),
    });
    return agg;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  update(
    changes: Partial<Omit<AgentConfigSnapshot, "id" | "createdAt">>,
  ): void {
    if (this.isDeleted) {
      throw new Error(`AgentConfig ${this.id} has been deleted`);
    }
    if (Object.keys(changes).length === 0) return;
    this.raiseEvent({
      eventType: "AgentUpdated.v1",
      agentId: this.id,
      changes: {
        name: changes.name,
        url: changes.url,
        protocol: changes.protocol,
        description:
          changes.description === undefined ? undefined : (changes.description ?? null),
      },
      occurredAt: new Date().toISOString(),
    });
  }

  delete(): void {
    if (this.isDeleted) {
      throw new Error(`AgentConfig ${this.id} is already deleted`);
    }
    this.raiseEvent({
      eventType: "AgentDeleted.v1",
      agentId: this.id,
      occurredAt: new Date().toISOString(),
    });
  }

  // -------------------------------------------------------------------------
  // Reconstitution
  // -------------------------------------------------------------------------

  static reconstitute(events: AgentEvent[]): AgentConfigAggregate {
    const agg = new AgentConfigAggregate();
    for (const event of events) {
      agg.apply(event);
      agg.version++;
    }
    return agg;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private raiseEvent(event: AgentEvent): void {
    this.apply(event);
    this._pendingEvents.push(event);
    this.version++;
  }

  apply(event: AgentEvent): void {
    switch (event.eventType) {
      case "AgentRegistered.v1":
        this.id = event.agentId;
        this.name = event.name;
        this.url = event.url;
        this.protocol = event.protocol;
        this.description = event.description;
        this.createdAt = event.occurredAt;
        break;

      case "AgentUpdated.v1": {
        const c = event.changes;
        if (c.name !== undefined) this.name = c.name;
        if (c.url !== undefined) this.url = c.url;
        if (c.protocol !== undefined) this.protocol = c.protocol;
        if (c.description !== undefined)
          this.description = c.description ?? undefined;
        break;
      }

      case "AgentDeleted.v1":
        this.isDeleted = true;
        break;
    }
  }
}
