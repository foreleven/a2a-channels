import { randomUUID } from "node:crypto";

import { ChannelBindingAggregate } from "@a2a-channels/domain";
import type {
  AgentConfigRepository,
  ChannelBindingRepository,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";

import {
  AgentNotFoundError,
  DuplicateEnabledBindingError,
} from "../errors.js";

export type CreateChannelBindingData = Omit<ChannelBindingSnapshot, "id" | "createdAt">;

export async function createChannelBinding(
  repo: ChannelBindingRepository,
  agentRepo: AgentConfigRepository,
  data: CreateChannelBindingData,
): Promise<ChannelBindingSnapshot> {
  await assertAgentExists(agentRepo, data.agentId);
  await assertNoDuplicateEnabled(
    repo,
    data.channelType,
    data.accountId,
    data.enabled,
  );

  const aggregate = ChannelBindingAggregate.create({ id: randomUUID(), ...data });
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
