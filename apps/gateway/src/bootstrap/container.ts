import "reflect-metadata";

import { Container } from "inversify";
import { buildApplicationModule } from "../container/modules/application.js";
import { buildInfraModule } from "../container/modules/infra.js";
import type { GatewayConfig } from "./config.js";
import { GatewayConfigToken } from "./config.js";

export function buildGatewayContainer(config: GatewayConfig): Container {
  const container = new Container({ defaultScope: "Singleton" });
  container.bind(GatewayConfigToken).toConstantValue(config);
  container.load(buildInfraModule());
  container.load(buildApplicationModule());
  return container;
}
