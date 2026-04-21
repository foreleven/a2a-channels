import { ContainerModule } from "inversify";

import { AgentConfigStateRepository } from "../../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../../infra/channel-binding-repo.js";
import { DomainEventBus } from "../../infra/domain-event-bus.js";
import { OutboxWorker } from "../../infra/outbox-worker.js";

export function buildInfraModule(): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(AgentConfigStateRepository).toSelf().inSingletonScope();
    bind(ChannelBindingStateRepository).toSelf().inSingletonScope();
    bind(DomainEventBus).toSelf().inSingletonScope();
    bind(OutboxWorker).toSelf().inSingletonScope();
  });
}
