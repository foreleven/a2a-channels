import type {
  ChannelBindingRepository,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";

export async function listChannelBindings(
  repo: ChannelBindingRepository,
): Promise<ChannelBindingSnapshot[]> {
  return repo.findAll();
}
