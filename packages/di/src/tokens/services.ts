export const SERVICE_TOKENS = {
  ChannelBindingService: Symbol.for("services.ChannelBindingService"),
  AgentService: Symbol.for("services.AgentService"),
  ChannelBindingStateRepository: Symbol.for(
    "services.ChannelBindingStateRepository",
  ),
  AgentConfigStateRepository: Symbol.for(
    "services.AgentConfigStateRepository",
  ),
  DomainEventBus: Symbol.for("services.DomainEventBus"),
  OutboxWorker: Symbol.for("services.OutboxWorker"),
} as const;
