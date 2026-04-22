import { inject, injectable } from "inversify";
import { RuntimeAgentCatalog } from "./runtime-agent-catalog.js";
import { RuntimeAssignmentService } from "./runtime-assignment-service.js";
import { RuntimeSnapshotPublisher } from "./runtime-snapshot-publisher.js";
import { RelayRuntimeAssemblyHandle } from "./relay-runtime-assembly-handle.js";

@injectable()
export class RelayRuntime {
  constructor(
    @inject(RuntimeAssignmentService)
    private readonly assignments: RuntimeAssignmentService,
    @inject(RuntimeAgentCatalog)
    private readonly agentCatalog: RuntimeAgentCatalog,
    @inject(RelayRuntimeAssemblyHandle)
    private readonly assembly: RelayRuntimeAssemblyHandle,
    @inject(RuntimeSnapshotPublisher)
    private readonly snapshotPublisher: RuntimeSnapshotPublisher,
  ) {}

  async bootstrap(): Promise<void> {
    await this.snapshotPublisher.publishBootstrapping();
    await this.snapshotPublisher.publishReady();
  }

  async shutdown(): Promise<void> {
    await this.snapshotPublisher.publishStoppingSafely();
    this.assignments.clearReconnectsForOwnedBindings();
    await this.assembly.connectionManager.stopAllConnections();
    await this.agentCatalog.stopAllClients();
    await this.snapshotPublisher.publishStoppedSafely();
  }
}
