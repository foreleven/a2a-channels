import "reflect-metadata";

import { Container } from "inversify";
import { buildApplicationModule } from "../container/modules/application.js";
import { buildHttpModule } from "../container/modules/http.js";
import { buildInfraModule } from "../container/modules/infra.js";
import { buildRuntimeModule } from "../container/modules/runtime.js";
import type { GatewayConfigSnapshot } from "./config.js";
import {
  GatewayConfigOverrides,
  GatewayConfigService,
} from "./config.js";

export function buildGatewayContainer(
  overrides: Partial<GatewayConfigSnapshot> = {},
): Container {
  const container = new Container({ defaultScope: "Singleton" });
  container.bind(GatewayConfigOverrides).toConstantValue(overrides);
  container.bind(GatewayConfigService).toSelf().inSingletonScope();
  container.load(buildInfraModule());
  container.load(buildApplicationModule());
  container.load(buildRuntimeModule());
  container.load(buildHttpModule());
  return container;
}
