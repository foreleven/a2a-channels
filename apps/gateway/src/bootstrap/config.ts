export const GatewayConfigToken = Symbol.for("system.GatewayConfig");

export interface GatewayConfig {
  port: number;
  corsOrigin: string;
}

export function buildGatewayConfig(
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  return {
    port: overrides.port ?? Number(process.env["PORT"] ?? 7890),
    corsOrigin:
      overrides.corsOrigin ??
      process.env["CORS_ORIGIN"] ??
      "http://localhost:3000",
  };
}
