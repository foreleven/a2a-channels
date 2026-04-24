import { inject, injectable } from "inversify";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";
import { RuntimeAssignmentService } from "./runtime-assignment-service.js";

/**
 * Reconciles desired runtime state against bindings currently owned by this
 * process.
 *
 * Important boundary rule: this coordinator talks to RuntimeAssignmentService,
 * not RelayRuntime. It decides ownership changes; execution details stay below
 * that boundary.
 *
 * In the current single-instance runtime, this is allowed to scan all desired
 * bindings because every runnable binding belongs to the local node. A future
 * cluster scheduler should not reuse this as-is for cross-node balancing.
 */
@injectable()
export class RuntimeAssignmentCoordinator {
  constructor(
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(ChannelBindingRepository)
    private readonly bindingRepo: ChannelBindingRepository,
    @inject(AgentConfigRepository)
    private readonly agentRepo: AgentConfigRepository,
  ) {}

  async reconcile(): Promise<void> {
    const [bindings, agents] = await Promise.all([
      this.bindingRepo.findAll(),
      this.agentRepo.findAll(),
    ]);
    // Build lookup tables once so reconcile stays linear in the number of
    // desired bindings/agents.
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const bindingsById = new Map(
      bindings.map((binding) => [binding.id, binding]),
    );
    const ownedBindingIds = this.assignments.listOwnedBindingIds();
    const staleBindingIds = ownedBindingIds.filter((bindingId) => {
      const binding = bindingsById.get(bindingId);
      if (!binding) {
        return true;
      }

      const agent = agentsById.get(binding.agentId);
      return !binding.enabled || !agent;
    });

    for (const bindingId of staleBindingIds) {
      await this.assignments.releaseBinding(bindingId);
    }

    for (const binding of bindings) {
      const agent = agentsById.get(binding.agentId);
      if (!binding.enabled || !agent) {
        continue;
      }

      // AssignmentService owns the idempotent "already assigned?" behavior, so
      // the coordinator can stay focused on desired-state iteration.
      await this.assignments.assignBinding(binding, agent);
    }
  }
}
