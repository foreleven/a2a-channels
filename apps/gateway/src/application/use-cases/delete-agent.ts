import type {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";

export class ReferencedAgentError extends Error {
  constructor(
    readonly agentId: string,
    readonly bindingIds: string[],
  ) {
    super(`Agent ${agentId} is referenced by ${bindingIds.length} channel binding(s)`);
  }
}

export async function deleteAgent(
  repo: AgentConfigRepository,
  id: string,
  bindingRepo?: ChannelBindingRepository,
): Promise<boolean> {
  const aggregate = await repo.findById(id);
  if (!aggregate) return false;

  const bindings = await bindingRepo?.findByAgentId(id);
  if (bindings?.length) {
    throw new ReferencedAgentError(
      id,
      bindings.map((binding) => binding.id),
    );
  }

  aggregate.delete();
  await repo.save(aggregate);
  return true;
}
