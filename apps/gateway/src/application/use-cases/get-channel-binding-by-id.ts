import type {
  ChannelBindingRepository,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";

export async function getChannelBindingById(
  repo: ChannelBindingRepository,
  id: string,
): Promise<ChannelBindingSnapshot | null> {
  const aggregate = await repo.findById(id);
  return aggregate ? aggregate.snapshot() : null;
}
