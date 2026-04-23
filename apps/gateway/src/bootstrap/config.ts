import { inject, injectable, optional } from "inversify";

/**
 * Immutable runtime configuration resolved once at process boot.
 *
 * Downstream services consume this snapshot instead of reading environment
 * variables directly so tests and alternate boot modes can override values in
 * one place.
 */
export interface GatewayConfigSnapshot {
  port: number;
  corsOrigin: string;
  clusterMode: boolean;
  redisUrl?: string;
  nodeId: string;
  nodeDisplayName: string;
  runtimeAddress: string;
}

export const GatewayConfigOverrides = Symbol.for(
  "system.GatewayConfigOverrides",
);

/**
 * Small wrapper around the resolved config snapshot.
 *
 * Using a class here keeps configuration injectable inside the container while
 * still exposing a plain-object view when code needs to serialize/debug it.
 */
@injectable()
export class GatewayConfigService {
  private readonly snapshot: GatewayConfigSnapshot;

  constructor(
    @inject(GatewayConfigOverrides)
    @optional()
    overrides: Partial<GatewayConfigSnapshot> = {},
  ) {
    this.snapshot = buildGatewayConfig(overrides);
  }

  get port(): number {
    return this.snapshot.port;
  }

  get corsOrigin(): string {
    return this.snapshot.corsOrigin;
  }

  get clusterMode(): boolean {
    return this.snapshot.clusterMode;
  }

  get redisUrl(): string | undefined {
    return this.snapshot.redisUrl;
  }

  get nodeId(): string {
    return this.snapshot.nodeId;
  }

  get nodeDisplayName(): string {
    return this.snapshot.nodeDisplayName;
  }

  get runtimeAddress(): string {
    return this.snapshot.runtimeAddress;
  }

  toSnapshot(): GatewayConfigSnapshot {
    return { ...this.snapshot };
  }
}

export function buildGatewayConfig(
  overrides: Partial<GatewayConfigSnapshot> = {},
): GatewayConfigSnapshot {
  // Prefer explicit overrides in tests/bootstrap code, then fall back to env.
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
