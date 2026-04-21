import "reflect-metadata";

import { Container } from "inversify";

import { SYSTEM_TOKENS } from "@a2a-channels/di";

import type { GatewayConfig } from "./config.js";
import { buildApplicationModule } from "../container/modules/application.js";
import { buildInfraModule } from "../container/modules/infra.js";

export function buildGatewayContainer(config: GatewayConfig): Container {
  const container = new Container({ defaultScope: "Singleton" });
  container.bind(SYSTEM_TOKENS.GatewayConfig).toConstantValue(config);
  container.load(buildInfraModule());
  container.load(buildApplicationModule());
  return container;
}
