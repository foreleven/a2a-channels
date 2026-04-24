import type { ChannelBindingRepository } from "@a2a-channels/domain";

export async function deleteChannelBinding(
  repo: ChannelBindingRepository,
  id: string,
): Promise<boolean> {
  const aggregate = await repo.findById(id);
  if (!aggregate) return false;

  aggregate.delete();
  await repo.save(aggregate);
  return true;
}
