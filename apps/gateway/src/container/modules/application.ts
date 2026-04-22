import { ContainerModule } from "inversify";

import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";

import { AgentService } from "../../application/agent-service.js";
import { ChannelBindingService } from "../../application/channel-binding-service.js";
import { AgentConfigStateRepository } from "../../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../../infra/channel-binding-repo.js";
import { InitializationService } from "../../services/initialization.js";

export function buildApplicationModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(ChannelBindingRepository).toService(ChannelBindingStateRepository);
    bind(AgentConfigRepository).toService(AgentConfigStateRepository);
    bind(ChannelBindingService).toSelf().inSingletonScope();
    bind(AgentService).toSelf().inSingletonScope();
    bind(InitializationService).toSelf().inSingletonScope();
  });
}
