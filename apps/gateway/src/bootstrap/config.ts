export const GatewayConfigToken = Symbol.for("system.GatewayConfig");

export interface GatewayConfig {
  port: number;
  corsOrigin: string;
  clusterMode: boolean;
  redisUrl?: string;
  nodeId: string;
  nodeDisplayName: string;
  runtimeAddress: string;
}

export function buildGatewayConfig(
  overrides: Partial<GatewayConfig> = {},
): GatewayConfig {
  const port = overrides.port ?? Number(process.env["PORT"] ?? 7890);
  const runtimeAddress =
    overrides.runtimeAddress ??
    process.env["RUNTIME_ADDRESS"] ??
    `http://localhost:${port}`;
  const nodeId = overrides.nodeId ?? process.env["NODE_ID"] ?? runtimeAddress;

  return {
    port,
    corsOrigin:
      overrides.corsOrigin ??
      process.env["CORS_ORIGIN"] ??
      "http://localhost:3000",
    clusterMode:
      overrides.clusterMode ?? process.env["CLUSTER_MODE"] === "true",
    redisUrl: overrides.redisUrl ?? process.env["REDIS_URL"],
    nodeId,
    nodeDisplayName:
      overrides.nodeDisplayName ??
      process.env["NODE_DISPLAY_NAME"] ??
      "Gateway Node",
    runtimeAddress,
  };
}
