import type { AgentConfig, ChannelBinding } from "@a2a-channels/core";

import { listAgentConfigs, listChannelBindings } from "../store/index.js";

export interface RuntimeStateSnapshot {
  bindings: ChannelBinding[];
  agents: AgentConfig[];
}

export async function loadBindingsSnapshot(): Promise<ChannelBinding[]> {
  return listChannelBindings();
}

export async function loadAgentsSnapshot(): Promise<AgentConfig[]> {
  return listAgentConfigs();
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

export async function loadRuntimeStateSnapshot(): Promise<RuntimeStateSnapshot> {
  const [bindings, agents] = await Promise.all([
    loadBindingsSnapshot(),
    loadAgentsSnapshot(),
  ]);

  return buildInMemoryIndexes(bindings, agents);
}
