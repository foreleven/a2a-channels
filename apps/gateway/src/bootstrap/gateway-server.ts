import { serve as honoServe, type ServerType } from "@hono/node-server";
import { inject, injectable, unmanaged } from "inversify";

import { GatewayConfigService } from "./config.js";
import {
  GatewayApp as GatewayAppService,
  type GatewayApp,
} from "../http/app.js";
import { OutboxWorker } from "../infra/outbox-worker.js";
import { RuntimeBootstrapper } from "../runtime/runtime-bootstrapper.js";

interface GatewayLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface GatewayServerStartOptions {
  logger?: GatewayLogger;
  runtimeBootstrapRetryDelayMs?: number;
  serve?: typeof honoServe;
}

const defaultLogger: GatewayLogger = {
  info(message) {
    console.log(message);
  },
  error(message, error) {
    console.error(message, error);
  },
};

@injectable()
export class GatewayServer {
  private server: ServerType | null = null;
  private logger: GatewayLogger = defaultLogger;
  private retryDelayMs = 5_000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private currentBootstrapAttempt: Promise<void> | null = null;
  private runtimeBootstrapPromise: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(GatewayAppService)
    private readonly app: GatewayApp,
    @inject(OutboxWorker)
    private readonly outboxWorker: Pick<OutboxWorker, "start" | "stop">,
    @inject(RuntimeBootstrapper)
    private readonly runtimeBootstrapper: Pick<
      RuntimeBootstrapper,
      "bootstrap" | "shutdown"
    >,
    @unmanaged()
    private readonly defaultServe: typeof honoServe = honoServe,
  ) {}

  get runtimeBootstrap(): Promise<void> {
    if (!this.runtimeBootstrapPromise) {
      return Promise.reject(new Error("GatewayServer has not been started"));
    }

    return this.runtimeBootstrapPromise;
  }

  start(options: GatewayServerStartOptions = {}): void {
    if (this.server) {
      throw new Error("GatewayServer is already started");
    }

    this.logger = options.logger ?? defaultLogger;
    this.retryDelayMs = options.runtimeBootstrapRetryDelayMs ?? 5_000;
    this.shuttingDown = false;

    const serve = options.serve ?? this.defaultServe;

    this.outboxWorker.start();
    this.logger.info(
      `🚀 A2A Channels Gateway starting on http://localhost:${this.config.port}`,
    );

    this.server = serve(
      { fetch: this.app.fetch.bind(this.app), port: this.config.port },
      () => {
        this.logger.info(
          `✅ Gateway listening on http://localhost:${this.config.port}`,
        );
        this.logger.info(`   Web UI: http://localhost:${this.config.port}/`);
        this.logger.info(
          `   API:    http://localhost:${this.config.port}/api/channels`,
        );
      },
    );

    this.runtimeBootstrapPromise = this.beginBootstrapAttempt();
    void this.runtimeBootstrapPromise.catch((error) =>
      this.handleBootstrapFailure(error),
    );
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    this.server?.close();
    this.server = null;

    await this.outboxWorker.stop();
    await this.currentBootstrapAttempt?.catch(() => {});
    await this.runtimeBootstrapper.shutdown();

    this.currentBootstrapAttempt = null;
    this.runtimeBootstrapPromise = null;
  }

  private beginBootstrapAttempt(): Promise<void> {
    if (this.currentBootstrapAttempt) {
      return this.currentBootstrapAttempt;
    }

    const attempt = Promise.resolve()
      .then(() => this.runtimeBootstrapper.bootstrap())
      .finally(() => {
        if (this.currentBootstrapAttempt === attempt) {
          this.currentBootstrapAttempt = null;
        }
      });

    this.currentBootstrapAttempt = attempt;
    return attempt;
  }

  private handleBootstrapFailure(error: unknown): void {
    this.logger.error("[gateway] runtime bootstrap failed", error);

    if (this.shuttingDown || this.retryTimer) {
      return;
    }

    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.beginBootstrapAttempt().catch((bootstrapError) =>
        this.handleBootstrapFailure(bootstrapError),
      );
    }, this.retryDelayMs);
  }
}
