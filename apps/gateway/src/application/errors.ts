/** Raised when a command would enable two bindings for one channel account. */
export class DuplicateEnabledBindingError extends Error {
  constructor(channelType: string, accountId: string) {
    super(`An enabled ${channelType} binding already exists for account ${accountId}`);
    this.name = "DuplicateEnabledBindingError";
  }
}

/** Raised when a binding command references an unknown Agent aggregate. */
export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent ${agentId} not found`);
    this.name = "AgentNotFoundError";
  }
}
