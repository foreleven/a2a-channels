import { randomUUID } from "node:crypto";

import { AgentConfigAggregate } from "@a2a-channels/domain";
import type { AgentConfigRepository, AgentConfigSnapshot } from "@a2a-channels/domain";

export type RegisterAgentData = Omit<AgentConfigSnapshot, "id" | "createdAt">;

export async function registerAgent(
  repo: AgentConfigRepository,
  data: RegisterAgentData,
): Promise<AgentConfigSnapshot> {
  const aggregate = AgentConfigAggregate.register({ id: randomUUID(), ...data });
  await repo.save(aggregate);
  return aggregate.snapshot();
}
