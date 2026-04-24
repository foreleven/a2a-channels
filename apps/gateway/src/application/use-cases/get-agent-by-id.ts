import type { AgentConfigRepository, AgentConfigSnapshot } from "@a2a-channels/domain";

export async function getAgentById(
  repo: AgentConfigRepository,
  id: string,
): Promise<AgentConfigSnapshot | null> {
  const aggregate = await repo.findById(id);
  return aggregate ? aggregate.snapshot() : null;
}
