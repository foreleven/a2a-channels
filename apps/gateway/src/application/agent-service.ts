/**
 * AgentService – thin application facade over agent use-cases.
 */

import type {
  AgentConfigRepository,
  AgentConfigSnapshot,
  ChannelBindingRepository,
} from "@a2a-channels/domain";
import { inject, injectable, optional } from "inversify";
import { PORT_TOKENS } from "@a2a-channels/di";

import { deleteAgent, ReferencedAgentError } from "./use-cases/delete-agent.js";
import { getAgentById } from "./use-cases/get-agent-by-id.js";
import { listAgents } from "./use-cases/list-agents.js";
import { registerAgent } from "./use-cases/register-agent.js";
import { updateAgent } from "./use-cases/update-agent.js";

export type { AgentConfigSnapshot };
export type { RegisterAgentData } from "./use-cases/register-agent.js";
export type { UpdateAgentData } from "./use-cases/update-agent.js";
export { ReferencedAgentError };

@injectable()
export class AgentService {
  constructor(
    @inject(PORT_TOKENS.AgentConfigRepository)
    private readonly repo: AgentConfigRepository,
    @inject(PORT_TOKENS.ChannelBindingRepository)
    @optional()
    private readonly bindingRepo?: ChannelBindingRepository,
  ) {}

  async list(): Promise<AgentConfigSnapshot[]> {
    return listAgents(this.repo);
  }

  async getById(id: string): Promise<AgentConfigSnapshot | null> {
    return getAgentById(this.repo, id);
  }

  async register(data: import("./use-cases/register-agent.js").RegisterAgentData): Promise<AgentConfigSnapshot> {
    return registerAgent(this.repo, data);
  }

  async update(
    id: string,
    changes: import("./use-cases/update-agent.js").UpdateAgentData,
  ): Promise<AgentConfigSnapshot | null> {
    return updateAgent(this.repo, id, changes);
  }

  async delete(id: string): Promise<boolean> {
    return deleteAgent(this.repo, id, this.bindingRepo);
  }
}
