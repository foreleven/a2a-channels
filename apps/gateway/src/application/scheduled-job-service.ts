import {
  ScheduledJobRepository,
  type CreateScheduledJobData,
  type ScheduledJobRecord,
  type ScheduledJobRepository as ScheduledJobRepositoryPort,
  type UpdateScheduledJobData,
} from "@agent-relay/domain";
import { inject, injectable } from "inversify";

/** Application service for managing scheduled job definitions. */
@injectable()
export class ScheduledJobService {
  constructor(
    @inject(ScheduledJobRepository)
    private readonly repo: ScheduledJobRepositoryPort,
  ) {}

  async list(): Promise<ScheduledJobRecord[]> {
    return this.repo.findAll();
  }

  async getById(id: string): Promise<ScheduledJobRecord | null> {
    return this.repo.findById(id);
  }

  async create(data: CreateScheduledJobData): Promise<ScheduledJobRecord> {
    return this.repo.create(data);
  }

  async update(
    id: string,
    data: UpdateScheduledJobData,
  ): Promise<ScheduledJobRecord | null> {
    return this.repo.update(id, data);
  }

  async delete(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
