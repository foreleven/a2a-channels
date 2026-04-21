import type { RelayRuntime } from "./relay-runtime.js";
import {
  loadDesiredStateSnapshot,
  type RuntimeStateSnapshot,
} from "./state.js";

export interface RuntimeAssignmentCoordinatorOptions {
  readonly loadSnapshot?: () => Promise<RuntimeStateSnapshot>;
}

export class RuntimeAssignmentCoordinator {
  constructor(
    private readonly runtime: RelayRuntime,
    private readonly options: RuntimeAssignmentCoordinatorOptions = {},
  ) {}

  async reconcile(): Promise<void> {
    const snapshot = await (
      this.options.loadSnapshot ?? loadDesiredStateSnapshot
    )();
    const agentsById = new Map(snapshot.agents.map((agent) => [agent.id, agent]));
    const bindingsById = new Map(snapshot.bindings.map((binding) => [binding.id, binding]));
    const ownedBindingIds = this.runtime.listOwnedBindingIds();
    const staleBindingIds = ownedBindingIds.filter((bindingId) => {
      const binding = bindingsById.get(bindingId);
      if (!binding) {
        return true;
      }

      const agent = agentsById.get(binding.agentId);
      return !binding.enabled || !agent || !this.isRunnableBinding(binding);
    });

    for (const bindingId of staleBindingIds) {
      await this.runtime.releaseBinding(bindingId);
    }

    for (const binding of snapshot.bindings) {
      const agent = agentsById.get(binding.agentId);
      if (!binding.enabled || !agent || !this.isRunnableBinding(binding)) {
        continue;
      }

      await this.runtime.assignBinding(binding, agent);
    }
  }

  private isRunnableBinding(binding: { channelType: string; channelConfig: unknown }): boolean {
    if (binding.channelType !== "feishu" && binding.channelType !== "lark") {
      return true;
    }

    const config = binding.channelConfig as {
      appId?: unknown;
      appSecret?: unknown;
    };
    return (
      typeof config.appId === "string" &&
      config.appId.trim().length > 0 &&
      typeof config.appSecret === "string" &&
      config.appSecret.trim().length > 0
    );
  }
}
