import type {
  AgentConfigSnapshot,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";
import { inject, injectable } from "inversify";

export interface RuntimeStateSnapshot {
  bindings: ChannelBindingSnapshot[];
  agents: AgentConfigSnapshot[];
}

/**
 * Narrow query boundary for the desired runtime state.
 *
 * Reconciliation only needs a consistent snapshot of current bindings and
 * agents. It should not know where that data came from.
 */
@injectable()
export class RuntimeDesiredStateQuery {
  constructor(
    @inject(ChannelBindingRepository)
    private readonly bindingRepo: ChannelBindingRepository,
    @inject(AgentConfigRepository)
    private readonly agentRepo: AgentConfigRepository,
  ) {}

  async loadSnapshot(): Promise<RuntimeStateSnapshot> {
    const [bindings, agents] = await Promise.all([
      this.bindingRepo.findAll(),
      this.agentRepo.findAll(),
    ]);

    return {
      bindings,
      agents,
    };
  }
}
