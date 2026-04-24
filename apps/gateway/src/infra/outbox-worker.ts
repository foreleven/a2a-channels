import type { DomainEvent } from "@a2a-channels/domain";
import { inject, injectable } from "inversify";

import { prisma } from "../store/prisma.js";
import { DomainEventBus } from "./domain-event-bus.js";

export interface OutboxWorkerOptions {
  readonly pollIntervalMs?: number;
  readonly batchSize?: number;
}

@injectable()
export class OutboxWorker {
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    @inject(DomainEventBus)
    private readonly eventBus: DomainEventBus,
    private readonly options: OutboxWorkerOptions = {},
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.drain();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await prisma.outboxEvent.findMany({
        where: { processedAt: null },
        orderBy: { occurredAt: "asc" },
        take: this.options.batchSize ?? 50,
      });

      for (const row of rows) {
        const event = JSON.parse(row.payload) as DomainEvent;
        this.eventBus.publish(event);
        await prisma.outboxEvent.update({
          where: { id: row.id },
          data: { processedAt: new Date() },
        });
      }
    } finally {
      this.running = false;
      if (!this.stopped) {
        this.timer = setTimeout(
          () => void this.drain(),
          this.options.pollIntervalMs ?? 1000,
        );
      }
    }
  }
}
