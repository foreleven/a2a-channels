import type { AgentConfigRepository, AgentConfigSnapshot } from "@a2a-channels/domain";

export async function listAgents(
  repo: AgentConfigRepository,
): Promise<AgentConfigSnapshot[]> {
  return repo.findAll();
}
