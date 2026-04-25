import { serve as honoServe, type ServerType } from "@hono/node-server";
import { inject, injectable, unmanaged } from "inversify";

import { GatewayConfigService } from "./config.js";
import { GatewayApp } from "../http/app.js";
import { OutboxWorker } from "../infra/outbox-worker.js";
import { RelayRuntime } from "../runtime/relay-runtime.js";

interface GatewayLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface GatewayServerStartOptions {
  logger?: GatewayLogger;
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

/**
 * Owns the outer process lifecycle once initialization has completed.
 *
 * Responsibilities are intentionally narrow:
 * - start/stop the Hono HTTP server
 * - start/stop background workers that must follow process lifetime
 * - bootstrap runtime orchestration before opening the HTTP listener
 *
 * Domain behavior stays outside this class; this is a system boundary, not an
 * application service.
 */
@injectable()
export class GatewayServer {
  private server: ServerType | null = null;
  private logger: GatewayLogger = defaultLogger;
  private shuttingDown = false;

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(GatewayApp)
    private readonly app: GatewayApp,
    @inject(OutboxWorker)
    private readonly outboxWorker: Pick<OutboxWorker, "start" | "stop">,
    @inject(RelayRuntime)
    private readonly relayRuntime: Pick<RelayRuntime, "bootstrap" | "shutdown">,
    @unmanaged()
    private readonly defaultServe: typeof honoServe = honoServe,
  ) {}

  async start(options: GatewayServerStartOptions = {}): Promise<void> {
    if (this.server) {
      throw new Error("GatewayServer is already started");
    }

    this.logger = options.logger ?? defaultLogger;
    this.shuttingDown = false;

    const serve = options.serve ?? this.defaultServe;

    this.outboxWorker.start();
    this.logger.info(
      `🚀 A2A Channels Gateway starting on http://localhost:${this.config.port}`,
    );

    try {
      await this.relayRuntime.bootstrap();
    } catch (error) {
      await this.outboxWorker.stop();
      throw error;
    }

    try {
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
    } catch (error) {
      await this.outboxWorker.stop();
      await this.relayRuntime.shutdown();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    this.server?.close();
    this.server = null;

    await this.outboxWorker.stop();
    await this.relayRuntime.shutdown();
  }
}
