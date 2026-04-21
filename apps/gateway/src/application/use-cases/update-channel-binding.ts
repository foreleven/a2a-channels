import type {
  AgentConfigRepository,
  ChannelBindingRepository,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";

import {
  AgentNotFoundError,
  DuplicateEnabledBindingError,
} from "../errors.js";

export type UpdateChannelBindingData = Partial<Omit<ChannelBindingSnapshot, "id" | "createdAt">>;

export async function updateChannelBinding(
  repo: ChannelBindingRepository,
  agentRepo: AgentConfigRepository,
  id: string,
  changes: UpdateChannelBindingData,
): Promise<ChannelBindingSnapshot | null> {
  const aggregate = await repo.findById(id);
  if (!aggregate) return null;

  const effectiveEnabled = changes.enabled ?? aggregate.enabled;
  const effectiveChannelType = changes.channelType ?? aggregate.channelType;
  const effectiveAccountId = changes.accountId ?? aggregate.accountId;
  const effectiveAgentId = changes.agentId ?? aggregate.agentId;

  await assertAgentExists(agentRepo, effectiveAgentId);
  await assertNoDuplicateEnabled(
    repo,
    effectiveChannelType,
    effectiveAccountId,
    effectiveEnabled,
    id,
  );

  aggregate.update(changes);
  await repo.save(aggregate);
  return aggregate.snapshot();
}

async function assertAgentExists(
  agentRepo: AgentConfigRepository,
  agentId: string,
): Promise<void> {
  const agent = await agentRepo.findById(agentId);
  if (!agent) {
    throw new AgentNotFoundError(agentId);
  }
}

async function assertNoDuplicateEnabled(
  repo: ChannelBindingRepository,
  channelType: string,
  accountId: string,
  enabled: boolean,
  excludeId?: string,
): Promise<void> {
  if (!enabled) return;
  const existing = await repo.findEnabled(channelType, accountId, excludeId);
  if (existing) {
    throw new DuplicateEnabledBindingError(channelType, accountId);
  }
}
