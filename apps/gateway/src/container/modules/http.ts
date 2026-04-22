import { ContainerModule } from "inversify";
import { fileURLToPath } from "node:url";

import { GatewayApp, GatewayWebDir, HonoGatewayApp } from "../../http/app.js";
import { AgentRoutes } from "../../http/routes/agents.js";
import { ChannelRoutes } from "../../http/routes/channels.js";
import {
  RuntimeRoutes,
  RuntimeStatusSourceToken,
} from "../../http/routes/runtime.js";
import { RuntimeClusterStateReader } from "../../runtime/runtime-cluster-state-reader.js";

const DEFAULT_GATEWAY_WEB_DIR = fileURLToPath(
  new URL("../../../web", import.meta.url),
);

export function buildHttpModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(GatewayWebDir).toConstantValue(DEFAULT_GATEWAY_WEB_DIR);
    bind(ChannelRoutes).toSelf().inSingletonScope();
    bind(AgentRoutes).toSelf().inSingletonScope();
    bind(RuntimeRoutes).toSelf().inSingletonScope();
    bind(HonoGatewayApp).toSelf().inSingletonScope();
    bind(GatewayApp).toService(HonoGatewayApp);
    bind(RuntimeStatusSourceToken).toService(RuntimeClusterStateReader);
  });
}
