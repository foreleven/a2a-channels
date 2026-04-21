import { ContainerModule } from "inversify";

import { PORT_TOKENS, SERVICE_TOKENS } from "@a2a-channels/di";

import { AgentService } from "../../application/agent-service.js";
import { ChannelBindingService } from "../../application/channel-binding-service.js";

export function buildApplicationModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(PORT_TOKENS.ChannelBindingRepository).toService(
      SERVICE_TOKENS.ChannelBindingStateRepository,
    );
    bind(PORT_TOKENS.AgentConfigRepository).toService(
      SERVICE_TOKENS.AgentConfigStateRepository,
    );

    bind(SERVICE_TOKENS.ChannelBindingService)
      .to(ChannelBindingService)
      .inSingletonScope();
    bind(SERVICE_TOKENS.AgentService).to(AgentService).inSingletonScope();
  });
}
