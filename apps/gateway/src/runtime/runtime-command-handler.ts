import { inject, injectable } from "inversify";
import {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";

import { RuntimeAssignmentService } from "./runtime-assignment-service.js";
import type { RuntimeDirectedCommand } from "./event-transport/types.js";

/**
 * RuntimeCommandHandler – executes directed runtime commands for this node.
 *
 * Receives AttachBinding / DetachBinding / RefreshBinding commands (sent by the
 * lead Scheduler via RuntimeEventBus.sendDirected) and translates them into
 * single-binding operations on RuntimeAssignmentService.
 *
 * This class is intentionally a narrow command boundary. It reloads one binding
 * and its referenced agent from durable state, then lets RuntimeAssignmentService
 * decide how to mutate local ownership and connections.
 */
@injectable()
export class RuntimeCommandHandler {
  /** Receives repositories for durable state reloads plus the assignment service. */
  constructor(
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(ChannelBindingRepository)
    private readonly bindingRepo: ChannelBindingRepository,
    @inject(AgentConfigRepository)
    private readonly agentRepo: AgentConfigRepository,
  ) {}

  /** Executes one directed command for this node. */
  async handle(command: RuntimeDirectedCommand): Promise<void> {
    switch (command.type) {
      case "AttachBinding":
      case "RefreshBinding":
        return this.attach(command.bindingId);
      case "DetachBinding":
        return this.assignments.releaseBinding(command.bindingId);
    }
  }

  /** Reloads a binding and agent from durable state before assigning ownership locally. */
  private async attach(bindingId: string): Promise<void> {
    const bindingAggregate = await this.bindingRepo.findById(bindingId);
    if (!bindingAggregate) {
      await this.assignments.releaseBinding(bindingId);
      return;
    }

    const binding = bindingAggregate.snapshot();
    if (!binding.enabled) {
      await this.assignments.releaseBinding(bindingId);
      return;
    }

    const agentAggregate = await this.agentRepo.findById(binding.agentId);
    if (!agentAggregate) {
      await this.assignments.releaseBinding(bindingId);
      return;
    }

    await this.assignments.assignBinding(binding, agentAggregate.snapshot());
  }
}
