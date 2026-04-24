import type { AgentConfigRepository, AgentConfigSnapshot } from "@a2a-channels/domain";

export type UpdateAgentData = Partial<Omit<AgentConfigSnapshot, "id" | "createdAt">>;

export async function updateAgent(
  repo: AgentConfigRepository,
  id: string,
  changes: UpdateAgentData,
): Promise<AgentConfigSnapshot | null> {
  const aggregate = await repo.findById(id);
  if (!aggregate) return null;

  aggregate.update(changes);
  await repo.save(aggregate);
  return aggregate.snapshot();
}
