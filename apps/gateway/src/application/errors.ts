export class DuplicateEnabledBindingError extends Error {
  constructor(channelType: string, accountId: string) {
    super(`An enabled ${channelType} binding already exists for account ${accountId}`);
    this.name = "DuplicateEnabledBindingError";
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} not found`);
    this.name = "AgentNotFoundError";
  }
}
