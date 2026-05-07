import pino, { type Logger } from "pino";

export const GatewayLogger = Symbol.for("infra.GatewayLogger");
export type GatewayLogger = Logger;

export function createGatewayLogger(): GatewayLogger {
  return pino({
    name: "agent-relay-gateway",
    level: process.env["LOG_LEVEL"] ?? "info",
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export function createSilentGatewayLogger(): GatewayLogger {
  return pino({ enabled: false });
}
