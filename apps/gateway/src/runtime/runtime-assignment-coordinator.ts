import { inject, injectable } from "inversify";
import { RuntimeAssignmentService } from "./runtime-assignment-service.js";
import { RuntimeBindingPolicy } from "./runtime-binding-policy.js";
import { RuntimeDesiredStateQuery } from "./runtime-desired-state-query.js";

/**
 * Reconciles desired runtime state against bindings currently owned by this
 * process.
 *
 * Important boundary rule: this coordinator talks to RuntimeAssignmentService,
 * not RelayRuntime. It decides ownership changes; execution details stay below
 * that boundary.
 */
@injectable()
export class RuntimeAssignmentCoordinator {
  constructor(
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(RuntimeDesiredStateQuery)
    private readonly desiredStateQuery: RuntimeDesiredStateQuery,
    @inject(RuntimeBindingPolicy)
    private readonly runtimeBindingPolicy: RuntimeBindingPolicy,
  ) {}

  async reconcile(): Promise<void> {
    const snapshot = await this.desiredStateQuery.loadSnapshot();
    // Build lookup tables once so reconcile stays linear in the number of
    // desired bindings/agents.
    const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    const bindingsById = new Map(snapshot.bindings.map((binding) => [binding.id, binding]));
    const ownedBindingIds = this.assignments.listOwnedBindingIds();
    const staleBindingIds = ownedBindingIds.filter((bindingId) => {
      const binding = bindingsById.get(bindingId);
      if (!binding) {
        return true;
      }

      const agent = agentsById.get(binding.agentId);
      return (
        !binding.enabled ||
        !agent ||
        !this.runtimeBindingPolicy.isRunnableBinding(binding)
      );
    });

    for (const bindingId of staleBindingIds) {
      await this.assignments.releaseBinding(bindingId);
    }

    for (const binding of snapshot.bindings) {
      const agent = agentsById.get(binding.agentId);
      if (
        !binding.enabled ||
        !agent ||
        !this.runtimeBindingPolicy.isRunnableBinding(binding)
      ) {
        continue;
      }

      // AssignmentService owns the idempotent "already assigned?" behavior, so
      // the coordinator can stay focused on desired-state iteration.
      await this.assignments.assignBinding(binding, agent);
    }
  }
}
