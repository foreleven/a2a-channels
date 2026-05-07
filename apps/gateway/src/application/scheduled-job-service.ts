import type {
  CreateScheduledJobData,
  ScheduledJobRecord,
  UpdateScheduledJobData,
} from "@agent-relay/domain";

export const ScheduledJobService = Symbol.for(
  "application.ScheduledJobService",
);

export class ScheduledJobQueueUnavailableError extends Error {
  constructor() {
    super(
      "BunQueue scheduled jobs are disabled. Set BUNQUEUE_ENABLED=true to manage scheduled tasks.",
    );
    this.name = "ScheduledJobQueueUnavailableError";
  }
}

export interface ScheduledJobService {
  list(): Promise<ScheduledJobRecord[]>;
  getById(id: string): Promise<ScheduledJobRecord | null>;
  create(data: CreateScheduledJobData): Promise<ScheduledJobRecord>;
  update(
    id: string,
    data: UpdateScheduledJobData,
  ): Promise<ScheduledJobRecord | null>;
  delete(id: string): Promise<boolean>;
}
