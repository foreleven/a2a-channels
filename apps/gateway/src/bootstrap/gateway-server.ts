import { serve as honoServe, type ServerType } from "@hono/node-server";
import { inject, injectable, multiInject, optional, unmanaged } from "inversify";

import { GatewayConfigService } from "./config.js";
import {
  ServiceContributionToken,
  type ServiceContribution,
} from "./service-contribution.js";
import { GatewayApp } from "../http/app.js";
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
  private startedServices: ServiceContribution[] = [];

  constructor(
    @inject(GatewayConfigService)
    private readonly config: GatewayConfigService,
    @inject(GatewayApp)
    private readonly app: GatewayApp,
    @inject(RelayRuntime)
    private readonly relayRuntime: Pick<RelayRuntime, "bootstrap" | "shutdown">,
    @unmanaged()
    private readonly defaultServe: typeof honoServe = honoServe,
    @multiInject(ServiceContributionToken)
    @optional()
    private readonly serviceContributions: ServiceContribution[] = [],
  ) {}

  async start(options: GatewayServerStartOptions = {}): Promise<void> {
    if (this.server) {
      throw new Error("GatewayServer is already started");
    }

    this.logger = options.logger ?? defaultLogger;
    this.shuttingDown = false;

    const serve = options.serve ?? this.defaultServe;

    this.logger.info(
      `🚀 A2A Channels Gateway starting on http://localhost:${this.config.port}`,
    );

    try {
      await this.startServiceContributions();
      await this.relayRuntime.bootstrap();
    } catch (error) {
      await this.stopStartedServicesAfterFailedStart();
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
      await this.relayRuntime.shutdown();
      await this.stopStartedServicesAfterFailedStart();
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    this.server?.close();
    this.server = null;

    await this.relayRuntime.shutdown();
    await this.stopStartedServices();
  }

  private async startServiceContributions(): Promise<void> {
    this.startedServices = [];
    for (const service of this.serviceContributions) {
      await service.start();
      this.startedServices.push(service);
    }
  }

  private async stopStartedServices(): Promise<void> {
    const services = [...this.startedServices].reverse();
    this.startedServices = [];
    for (const service of services) {
      await service.stop();
    }
  }

  private async stopStartedServicesAfterFailedStart(): Promise<void> {
    try {
      await this.stopStartedServices();
    } catch (error) {
      this.logger.error("[gateway] failed to stop service contribution", error);
    }
  }
}
