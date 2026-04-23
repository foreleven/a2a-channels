import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";
import type { AgentConfig, ChannelBinding } from "@a2a-channels/core";
import { inject, injectable } from "inversify";

import { buildInMemoryIndexes, type RuntimeStateSnapshot } from "./state.js";

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

    return buildInMemoryIndexes(
      bindings as ChannelBinding[],
      agents as AgentConfig[],
    );
  }
}
