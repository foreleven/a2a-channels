import type {
  ConnectionOptions,
  Queue,
  SchedulerInfo,
} from "bunqueue/client";
import type {
  CreateScheduledJobData,
  ScheduledJobRecord,
  UpdateScheduledJobData,
} from "@agent-relay/domain";
import { inject, injectable } from "inversify";
import { randomUUID } from "node:crypto";

import {
  ScheduledJobQueueUnavailableError,
  type ScheduledJobService as ScheduledJobServicePort,
} from "../application/scheduled-job-service.js";
import { GatewayConfigService } from "../bootstrap/config.js";
import type { ScheduledJobPayload } from "../runtime/cron/scheduled-job-executor.js";

const DEFINITION_JOB_NAME = "scheduled-job-definition";

interface ScheduledJobDefinitionData extends ScheduledJobRecord {}

@injectable()
export class BunQueueScheduledJobService implements ScheduledJobServicePort {
  private schedulerQueue: Queue<ScheduledJobPayload> | null = null;
  private definitionsQueue: Queue<ScheduledJobDefinitionData> | null = null;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
  ) {}

  async list(): Promise<ScheduledJobRecord[]> {
    if (!this.config.bunQueueEnabled) {
      return [];
    }

    const queue = await this.getDefinitionsQueue();
    const jobs = await queue.getJobsAsync({
      state: ["waiting", "delayed", "active", "completed", "failed"],
      start: 0,
      end: -1,
      asc: false,
    });
    return jobs
      .map((job) => parseDefinitionData(job.data))
      .filter((job): job is ScheduledJobRecord => job !== null)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getById(id: string): Promise<ScheduledJobRecord | null> {
    if (!this.config.bunQueueEnabled) {
      return null;
    }

    const job = await (await this.getDefinitionsQueue()).getJob(id);
    return job ? parseDefinitionData(job.data) : null;
  }

  async create(data: CreateScheduledJobData): Promise<ScheduledJobRecord> {
    this.assertQueueEnabled();

    const now = new Date().toISOString();
    const record: ScheduledJobRecord = {
      id: randomUUID(),
      name: data.name,
      channelBindingId: data.channelBindingId,
      sessionKey: data.sessionKey,
      prompt: data.prompt,
      cronExpression: data.cronExpression,
      enabled: data.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    await this.saveDefinition(record);
    if (record.enabled) {
      await this.upsertScheduler(record);
    }
    return record;
  }

  async update(
    id: string,
    data: UpdateScheduledJobData,
  ): Promise<ScheduledJobRecord | null> {
    this.assertQueueEnabled();

    const current = await this.getById(id);
    if (!current) {
      return null;
    }

    const updated: ScheduledJobRecord = {
      ...current,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.channelBindingId !== undefined
        ? { channelBindingId: data.channelBindingId }
        : {}),
      ...(data.sessionKey !== undefined ? { sessionKey: data.sessionKey } : {}),
      ...(data.prompt !== undefined ? { prompt: data.prompt } : {}),
      ...(data.cronExpression !== undefined
        ? { cronExpression: data.cronExpression }
        : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      updatedAt: new Date().toISOString(),
    };

    await this.saveDefinition(updated);
    if (updated.enabled) {
      await this.upsertScheduler(updated);
    } else {
      await this.removeScheduler(updated.id);
    }
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    if (!this.config.bunQueueEnabled) {
      return false;
    }

    const existing = await this.getById(id);
    if (!existing) {
      return false;
    }

    await Promise.all([
      this.removeDefinition(id),
      this.removeScheduler(id),
    ]);
    return true;
  }

  private assertQueueEnabled(): void {
    if (!this.config.bunQueueEnabled) {
      throw new ScheduledJobQueueUnavailableError();
    }
  }

  private async saveDefinition(record: ScheduledJobRecord): Promise<void> {
    const queue = await this.getDefinitionsQueue();
    await this.removeDefinition(record.id);
    await queue.add(DEFINITION_JOB_NAME, record, {
      jobId: record.id,
      durable: true,
    });
  }

  private async removeDefinition(id: string): Promise<void> {
    const queue = await this.getDefinitionsQueue();
    const job = await queue.getJob(id);
    if (job) {
      await queue.removeAsync(id);
    }
  }

  private async upsertScheduler(
    record: ScheduledJobRecord,
  ): Promise<SchedulerInfo | null> {
    const queue = await this.getSchedulerQueue();
    return queue.upsertJobScheduler(
      record.id,
      {
        pattern: record.cronExpression,
        skipMissedOnRestart: true,
        preventOverlap: true,
      },
      {
        name: record.name,
        data: this.toPayload(record),
        opts: {
          jobId: `${record.id}:${Date.now()}`,
          durable: true,
        },
      },
    );
  }

  private async removeScheduler(id: string): Promise<void> {
    await (await this.getSchedulerQueue()).removeJobScheduler(id);
  }

  private toPayload(record: ScheduledJobRecord): ScheduledJobPayload {
    return {
      bindingId: record.channelBindingId,
      sessionKey: record.sessionKey,
      prompt: record.prompt,
    };
  }

  private async getSchedulerQueue(): Promise<Queue<ScheduledJobPayload>> {
    if (!this.schedulerQueue) {
      const { Queue } = await import("bunqueue/client");
      this.schedulerQueue = new Queue<ScheduledJobPayload>(
        this.config.bunQueueQueueName,
        {
          connection: this.connectionOptions(),
          prefixKey: this.config.bunQueuePrefix,
        },
      );
      await this.schedulerQueue.waitUntilReady();
    }
    return this.schedulerQueue;
  }

  private async getDefinitionsQueue(): Promise<Queue<ScheduledJobDefinitionData>> {
    if (!this.definitionsQueue) {
      const { Queue } = await import("bunqueue/client");
      this.definitionsQueue = new Queue<ScheduledJobDefinitionData>(
        `${this.config.bunQueueQueueName}:definitions`,
        {
          connection: this.connectionOptions(),
          prefixKey: this.config.bunQueuePrefix,
        },
      );
      await this.definitionsQueue.waitUntilReady();
    }
    return this.definitionsQueue;
  }

  private connectionOptions(): ConnectionOptions {
    return {
      host: this.config.bunQueueHost,
      port: this.config.bunQueuePort,
      ...(this.config.bunQueueToken ? { token: this.config.bunQueueToken } : {}),
    };
  }
}

function parseDefinitionData(value: unknown): ScheduledJobRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = readString(value, "id");
  const name = readString(value, "name");
  const channelBindingId = readString(value, "channelBindingId");
  const sessionKey = readString(value, "sessionKey");
  const prompt = readString(value, "prompt");
  const cronExpression = readString(value, "cronExpression");
  const createdAt = readString(value, "createdAt");
  const updatedAt = readString(value, "updatedAt");
  const enabled = value["enabled"];

  if (
    !id ||
    !name ||
    !channelBindingId ||
    !sessionKey ||
    !prompt ||
    !cronExpression ||
    !createdAt ||
    !updatedAt ||
    typeof enabled !== "boolean"
  ) {
    return null;
  }

  return {
    id,
    name,
    channelBindingId,
    sessionKey,
    prompt,
    cronExpression,
    enabled,
    createdAt,
    updatedAt,
  };
}

function readString(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
