import { inject, injectable, unmanaged } from "inversify";
import { RuntimeAssignmentService } from "./runtime-assignment-service.js";
import { RuntimeBindingPolicy } from "./runtime-binding-policy.js";
import {
  loadDesiredStateSnapshot,
  type RuntimeStateSnapshot,
} from "./state.js";

export interface RuntimeAssignmentCoordinatorOptions {
  readonly loadSnapshot?: () => Promise<RuntimeStateSnapshot>;
}

@injectable()
export class RuntimeAssignmentCoordinator {
  constructor(
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(RuntimeBindingPolicy)
    private readonly runtimeBindingPolicy: RuntimeBindingPolicy,
    @unmanaged()
    private readonly options: RuntimeAssignmentCoordinatorOptions = {},
  ) {}

  async reconcile(): Promise<void> {
    const snapshot = await (
      this.options.loadSnapshot ?? loadDesiredStateSnapshot
    )();
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

      await this.assignments.assignBinding(binding, agent);
    }
  }
}
