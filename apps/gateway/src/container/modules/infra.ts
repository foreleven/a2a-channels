import { ContainerModule } from "inversify";

import { SERVICE_TOKENS } from "@a2a-channels/di";

import { AgentConfigStateRepository } from "../../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../../infra/channel-binding-repo.js";
import { DomainEventBus } from "../../infra/domain-event-bus.js";
import { OutboxWorker } from "../../infra/outbox-worker.js";

export function buildInfraModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(SERVICE_TOKENS.AgentConfigStateRepository)
      .to(AgentConfigStateRepository)
      .inSingletonScope();
    bind(SERVICE_TOKENS.ChannelBindingStateRepository)
      .to(ChannelBindingStateRepository)
      .inSingletonScope();
    bind(SERVICE_TOKENS.DomainEventBus).to(DomainEventBus).inSingletonScope();
    bind(SERVICE_TOKENS.OutboxWorker).to(OutboxWorker).inSingletonScope();
  });
}
