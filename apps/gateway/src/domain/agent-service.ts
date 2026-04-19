/**
 * AgentService – application service (command handler) for agent configurations.
 *
 * Orchestrates aggregate creation / mutation via the repository.
 * Replaces the previous direct-Prisma service functions in
 * `apps/gateway/src/services/agents.ts`.
 */

import { randomUUID } from "node:crypto";

import { AgentConfigAggregate } from "@a2a-channels/domain";
import type { AgentConfigSnapshot } from "@a2a-channels/domain";
import type { AgentConfigRepository } from "@a2a-channels/domain";

export type { AgentConfigSnapshot };

export type RegisterAgentData = Omit<AgentConfigSnapshot, "id" | "createdAt">;
export type UpdateAgentData = Partial<Omit<AgentConfigSnapshot, "id" | "createdAt">>;

export class AgentService {
  constructor(private readonly repo: AgentConfigRepository) {}

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  async list(): Promise<AgentConfigSnapshot[]> {
    const all = await this.repo.findAll();
    return all.map((a) => a.snapshot());
  }

  async getById(id: string): Promise<AgentConfigSnapshot | null> {
    const agg = await this.repo.findById(id);
    return agg ? agg.snapshot() : null;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  async register(data: RegisterAgentData): Promise<AgentConfigSnapshot> {
    const agg = AgentConfigAggregate.register({ id: randomUUID(), ...data });
    await this.repo.save(agg);
    return agg.snapshot();
  }

  async update(
    id: string,
    changes: UpdateAgentData,
  ): Promise<AgentConfigSnapshot | null> {
    const agg = await this.repo.findById(id);
    if (!agg) return null;

    agg.update(changes);
    await this.repo.save(agg);
    return agg.snapshot();
  }

  async delete(id: string): Promise<boolean> {
    const agg = await this.repo.findById(id);
    if (!agg) return false;

    agg.delete();
    await this.repo.save(agg);
    return true;
  }
}
