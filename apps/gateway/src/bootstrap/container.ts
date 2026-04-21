import "reflect-metadata";

import { Container } from "inversify";

import { SYSTEM_TOKENS } from "@a2a-channels/di";

import type { GatewayConfig } from "./config.js";

export function buildGatewayContainer(config: GatewayConfig): Container {
  const container = new Container({ defaultScope: "Singleton" });
  container.bind(SYSTEM_TOKENS.GatewayConfig).toConstantValue(config);
  return container;
}
