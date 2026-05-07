import { inject, injectable } from "inversify";
import { AgentConfigRepository } from "@agent-relay/domain";

import type { ServiceContribution } from "../bootstrap/service-contribution.js";
import {
  createSilentGatewayLogger,
  GatewayLogger,
  type GatewayLogger as GatewayLoggerPort,
} from "../infra/logger.js";
import {
  RuntimeEventBus as RuntimeEventBusToken,
  type RuntimeEventBus,
} from "./event-transport/runtime-event-bus.js";
import type { RuntimeBroadcastEvent } from "./event-transport/types.js";
import { RuntimeAssignmentService } from "./runtime-assignment-service.js";

/** Applies AgentChanged broadcasts to this node's runtime agent clients. */
@injectable()
export class RuntimeAgentChangeSubscriber implements ServiceContribution {
  private unsubscribeBroadcast: (() => void) | null = null;

  constructor(
    @inject(RuntimeEventBusToken)
    private readonly runtimeBus: RuntimeEventBus,
    @inject(AgentConfigRepository)
    private readonly agentRepo: AgentConfigRepository,
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(GatewayLogger)
    private readonly logger: GatewayLoggerPort = createSilentGatewayLogger(),
  ) {}

  async start(): Promise<void> {
    this.unsubscribeBroadcast = this.runtimeBus.onBroadcast((event) => {
      void this.handleBroadcast(event);
    });
  }

  async stop(): Promise<void> {
    this.unsubscribeBroadcast?.();
    this.unsubscribeBroadcast = null;
  }

  private async handleBroadcast(event: RuntimeBroadcastEvent): Promise<void> {
    if (event.type !== "AgentChanged") {
      return;
    }

    const aggregate = await this.agentRepo.findById(event.agentId);
    if (!aggregate) {
      this.logger.warn(
        { agentId: event.agentId },
        "agent change broadcast referenced a missing agent",
      );
      return;
    }

    await this.assignments.applyAgentUpsert(aggregate.snapshot());
  }
}
