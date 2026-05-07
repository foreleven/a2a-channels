import pino, { type Logger, type LoggerOptions } from "pino";

export const GatewayLogger = Symbol.for("infra.GatewayLogger");
export type GatewayLogger = Logger;

export function createGatewayLogger(): GatewayLogger {
  const options: LoggerOptions = {
    name: "agent-relay-gateway",
    level: process.env["LOG_LEVEL"] ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  };

  if (!shouldUsePrettyLogger()) {
    return pino(options);
  }

  return pino({
    ...options,
    transport: {
      target: "pino-pretty",
      options: {
        colorize: Boolean(process.stdout.isTTY),
        ignore: "pid,hostname",
        translateTime: "SYS:standard",
      },
    },
  });
}

export function createSilentGatewayLogger(): GatewayLogger {
  return pino({ enabled: false });
}

function shouldUsePrettyLogger(): boolean {
  const configured = process.env["LOG_PRETTY"];
  if (configured) {
    return ["1", "true", "yes", "on"].includes(configured.toLowerCase());
  }

  return process.env["NODE_ENV"] !== "production" && Boolean(process.stdout.isTTY);
}
