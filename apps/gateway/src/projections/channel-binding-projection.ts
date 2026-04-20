/**
 * ChannelBindingProjection – maintains the `channel_bindings` Prisma table
 * as a read model (query side) by consuming domain events from the bus.
 *
 * On startup, `catchUp()` replays any events that occurred since the last
 * known checkpoint, so the read model is always consistent with the event log.
 */

import type {
  ChannelBindingCreated,
  ChannelBindingDeleted,
  ChannelBindingUpdated,
} from "@a2a-channels/domain";
import type { EventStore } from "@a2a-channels/event-store";

import type { DomainEventBus } from "../domain/event-bus.js";
import { prisma } from "../store/prisma.js";

const PROJECTION_NAME = "ChannelBindingProjection";

export class ChannelBindingProjection {
  constructor(
    private readonly eventBus: DomainEventBus,
    private readonly eventStore: EventStore,
  ) {}

  /** Register event handlers so the projection stays up to date at runtime. */
  register(): void {
    this.eventBus.on("ChannelBindingCreated.v1", (e) => {
      this.dispatchHandler("ChannelBindingCreated.v1", this.onCreated(e));
    });
    this.eventBus.on("ChannelBindingUpdated.v1", (e) => {
      this.dispatchHandler("ChannelBindingUpdated.v1", this.onUpdated(e));
    });
    this.eventBus.on("ChannelBindingDeleted.v1", (e) => {
      this.dispatchHandler("ChannelBindingDeleted.v1", this.onDeleted(e));
    });
  }

  /**
   * Fires an async handler and logs any rejection so it never becomes an
   * unhandled promise rejection that could crash the process.
   */
  private dispatchHandler(eventType: string, handler: Promise<void>): void {
    void handler.catch((err: unknown) => {
      console.error(`[${PROJECTION_NAME}] Failed to apply ${eventType} event`, err);
    });
  }

  /**
   * Replay events from the event store that the projection has not yet seen.
   * Should be called once during gateway startup before `register()`.
   */
  async catchUp(): Promise<void> {
    const checkpoint = await prisma.projectionCheckpoint.upsert({
      where: { name: PROJECTION_NAME },
      create: { name: PROJECTION_NAME, seq: 0 },
      update: {},
    });

    let lastSeq = checkpoint.seq;

    for await (const stored of this.eventStore.loadAll(lastSeq)) {
      if (stored.eventType === "ChannelBindingCreated.v1") {
        await this.onCreated(stored.payload as ChannelBindingCreated);
      } else if (stored.eventType === "ChannelBindingUpdated.v1") {
        await this.onUpdated(stored.payload as ChannelBindingUpdated);
      } else if (stored.eventType === "ChannelBindingDeleted.v1") {
        await this.onDeleted(stored.payload as ChannelBindingDeleted);
      }
      lastSeq = stored.globalSeq;
    }

    if (lastSeq !== checkpoint.seq) {
      await prisma.projectionCheckpoint.update({
        where: { name: PROJECTION_NAME },
        data: { seq: lastSeq },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private async onCreated(e: ChannelBindingCreated): Promise<void> {
    await prisma.channelBinding.upsert({
      where: { id: e.bindingId },
      create: {
        id: e.bindingId,
        name: e.name,
        channelType: e.channelType,
        accountId: e.accountId,
        channelConfig: JSON.stringify(e.channelConfig),
        agentUrl: e.agentUrl,
        enabled: e.enabled,
        createdAt: new Date(e.occurredAt),
      },
      update: {
        name: e.name,
        channelType: e.channelType,
        accountId: e.accountId,
        channelConfig: JSON.stringify(e.channelConfig),
        agentUrl: e.agentUrl,
        enabled: e.enabled,
      },
    });
  }

  private async onUpdated(e: ChannelBindingUpdated): Promise<void> {
    const c = e.changes;
    await prisma.channelBinding.updateMany({
      where: { id: e.bindingId },
      data: {
        ...(c.name !== undefined && { name: c.name }),
        ...(c.channelType !== undefined && { channelType: c.channelType }),
        ...(c.accountId !== undefined && { accountId: c.accountId }),
        ...(c.channelConfig !== undefined && {
          channelConfig: JSON.stringify(c.channelConfig),
        }),
        ...(c.agentUrl !== undefined && { agentUrl: c.agentUrl }),
        ...(c.enabled !== undefined && { enabled: c.enabled }),
      },
    });
  }

  private async onDeleted(e: ChannelBindingDeleted): Promise<void> {
    await prisma.channelBinding.deleteMany({ where: { id: e.bindingId } });
  }
}
