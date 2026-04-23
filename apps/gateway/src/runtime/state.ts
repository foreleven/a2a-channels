import type { AgentConfig, ChannelBinding } from "@a2a-channels/core";

export interface RuntimeStateSnapshot {
  bindings: ChannelBinding[];
  agents: AgentConfig[];
}

export function buildInMemoryIndexes(
  bindings: ChannelBinding[],
  agents: AgentConfig[],
): RuntimeStateSnapshot {
  return {
    bindings,
    agents,
  };
}
