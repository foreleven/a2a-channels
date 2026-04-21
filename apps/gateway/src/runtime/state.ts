import type { AgentConfig, ChannelBinding } from "@a2a-channels/core";

import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";

export interface RuntimeStateSnapshot {
  bindings: ChannelBinding[];
  agents: AgentConfig[];
}

export async function loadBindingsSnapshot(): Promise<ChannelBinding[]> {
  const repo = new ChannelBindingStateRepository();
  return repo.findAll();
}

export async function loadAgentsSnapshot(): Promise<AgentConfig[]> {
  const repo = new AgentConfigStateRepository();
  return repo.findAll();
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

export async function loadDesiredStateSnapshot(): Promise<RuntimeStateSnapshot> {
  const [bindings, agents] = await Promise.all([
    loadBindingsSnapshot(),
    loadAgentsSnapshot(),
  ]);

  return buildInMemoryIndexes(bindings, agents);
}

export async function loadRuntimeStateSnapshot(): Promise<RuntimeStateSnapshot> {
  return loadDesiredStateSnapshot();
}
