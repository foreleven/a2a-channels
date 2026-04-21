import { serve as honoServe, type ServerType } from "@hono/node-server";

import type { OutboxWorker } from "../infra/outbox-worker.js";
import type { RuntimeBootstrapper } from "../runtime/runtime-bootstrapper.js";

interface GatewayApp {
  fetch: (request: Request, env: unknown) => Promise<unknown> | unknown;
}

interface GatewayLogger {
  info(message: string): void;
  error(message: string, error?: unknown): void;
}

export interface StartGatewayOptions {
  app: GatewayApp;
  port: number;
  outboxWorker: Pick<OutboxWorker, "start" | "stop">;
  runtimeBootstrapper: Pick<RuntimeBootstrapper, "bootstrap" | "shutdown">;
  logger?: GatewayLogger;
  runtimeBootstrapRetryDelayMs?: number;
  serve?: typeof honoServe;
}

export interface StartedGateway {
  server: ServerType;
  runtimeBootstrap: Promise<void>;
  shutdown(): Promise<void>;
}

const defaultLogger: GatewayLogger = {
  info(message) {
    console.log(message);
  },
  error(message, error) {
    console.error(message, error);
  },
};

export function startGateway(options: StartGatewayOptions): StartedGateway {
  const logger = options.logger ?? defaultLogger;
  const serve = options.serve ?? honoServe;
  const runtimeBootstrapRetryDelayMs = options.runtimeBootstrapRetryDelayMs ?? 5_000;
  let shuttingDown = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let currentBootstrapAttempt: Promise<void> | null = null;

  options.outboxWorker.start();
  logger.info(`🚀 A2A Channels Gateway starting on http://localhost:${options.port}`);

  const server = serve({ fetch: options.app.fetch, port: options.port }, () => {
    logger.info(`✅ Gateway listening on http://localhost:${options.port}`);
    logger.info(`   Web UI: http://localhost:${options.port}/`);
    logger.info(`   API:    http://localhost:${options.port}/api/channels`);
  });

  const handleBootstrapFailure = (error: unknown): void => {
    logger.error("[gateway] runtime bootstrap failed", error);
    if (shuttingDown || retryTimer) {
      return;
    }

    retryTimer = setTimeout(() => {
      retryTimer = null;
      void beginBootstrapAttempt().catch(handleBootstrapFailure);
    }, runtimeBootstrapRetryDelayMs);
  };

  const beginBootstrapAttempt = (): Promise<void> => {
    if (currentBootstrapAttempt) {
      return currentBootstrapAttempt;
    }

    const attempt = Promise.resolve()
      .then(() => options.runtimeBootstrapper.bootstrap())
      .finally(() => {
        if (currentBootstrapAttempt === attempt) {
          currentBootstrapAttempt = null;
        }
      });

    currentBootstrapAttempt = attempt;
    return attempt;
  };

  const runtimeBootstrap = beginBootstrapAttempt();
  void runtimeBootstrap.catch(handleBootstrapFailure);

  return {
    server,
    runtimeBootstrap,
    async shutdown(): Promise<void> {
      shuttingDown = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }

      server.close();
      await options.outboxWorker.stop();
      await currentBootstrapAttempt?.catch(() => {});
      await options.runtimeBootstrapper.shutdown();
    },
  };
}
