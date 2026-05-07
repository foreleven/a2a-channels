import type { ConnectionOptions, Job, Worker } from "bunqueue/client";
import { inject, injectable } from "inversify";

import { GatewayConfigService } from "../../bootstrap/config.js";
import type { ServiceContribution } from "../../bootstrap/service-contribution.js";
import {
  createSilentGatewayLogger,
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "../../infra/logger.js";
import {
  ScheduledJobExecutor,
  type ScheduledJobExecutionResult,
  type ScheduledJobPayload,
} from "./scheduled-job-executor.js";

/** Runs scheduled outbound jobs delivered by an external BunQueue server. */
@injectable()
export class BunQueueScheduledJobService implements ServiceContribution {
  private worker: Worker<ScheduledJobPayload, ScheduledJobExecutionResult> | null =
    null;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(ScheduledJobExecutor)
    private readonly executor: ScheduledJobExecutor,
    @inject(GatewayLogger)
    private readonly logger: GatewayLoggerPort = createSilentGatewayLogger(),
  ) {}

  async start(): Promise<void> {
    if (!this.config.bunQueueEnabled) {
      this.logger.info("bunqueue scheduled job worker disabled");
      return;
    }

    const { Worker } = await import("bunqueue/client");
    const worker = new Worker<ScheduledJobPayload, ScheduledJobExecutionResult>(
      this.config.bunQueueQueueName,
      (job) => this.process(job),
      {
        connection: this.connectionOptions(),
        concurrency: this.config.bunQueueWorkerConcurrency,
        prefixKey: this.config.bunQueuePrefix,
      },
    );

    worker.on("failed", (job, error) => {
      this.logger.error(
        { jobId: job.id, jobName: job.name, err: error },
        "bunqueue scheduled job failed",
      );
    });
    worker.on("error", (error) => {
      this.logger.error({ err: error }, "bunqueue scheduled job worker error");
    });

    await worker.waitUntilReady();
    this.worker = worker;
    this.logger.info(
      {
        queue: this.config.bunQueueQueueName,
        host: this.config.bunQueueHost,
        port: this.config.bunQueuePort,
      },
      "bunqueue scheduled job worker started",
    );
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      await worker.close();
      this.logger.info("bunqueue scheduled job worker stopped");
    }
  }

  private async process(
    job: Job<ScheduledJobPayload>,
  ): Promise<ScheduledJobExecutionResult> {
    return this.executor.execute(job.data, {
      jobId: job.id,
      jobName: job.name,
      queuedAt: new Date(job.timestamp).toISOString(),
    });
  }

  private connectionOptions(): ConnectionOptions {
    return {
      host: this.config.bunQueueHost,
      port: this.config.bunQueuePort,
      ...(this.config.bunQueueToken ? { token: this.config.bunQueueToken } : {}),
    };
  }
}
