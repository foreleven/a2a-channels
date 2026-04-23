import { inject, injectable } from "inversify";

import {
  RuntimeOwnershipState as RuntimeOwnershipStateToken,
  type RuntimeOwnershipState,
} from "./ownership-state.js";
import {
  NodeRuntimeStateStore as NodeRuntimeStateStoreToken,
  type NodeRuntimeStateStore,
} from "./node-runtime-state-store.js";
import {
  RuntimeNodeState,
  type LocalRuntimeSnapshot,
} from "./runtime-node-state.js";

@injectable()
export class RuntimeSnapshotPublisher {
  private publishQueue: Promise<void> = Promise.resolve();

  constructor(
    @inject(RuntimeNodeState)
    private readonly nodeState: RuntimeNodeState,
    @inject(NodeRuntimeStateStoreToken)
    private readonly stateStore: NodeRuntimeStateStore,
    @inject(RuntimeOwnershipStateToken)
    private readonly ownershipState: RuntimeOwnershipState,
  ) {}

  async publishBootstrapping(): Promise<void> {
    await this.publishNodeSnapshot(this.nodeState.markBootstrapping());
  }

  async publishReady(): Promise<void> {
    await this.publishNodeSnapshot(
      this.nodeState.markReady(this.ownershipState.listConnectionStatuses()),
    );
  }

  async publishStopping(): Promise<void> {
    await this.publishNodeSnapshot(
      this.nodeState.markStopping(this.ownershipState.listConnectionStatuses()),
    );
  }

  async publishStopped(): Promise<void> {
    await this.publishNodeSnapshot(this.nodeState.markStopped());
  }

  async publishStoppingSafely(): Promise<void> {
    await this.publishSafely("stopping", () => this.publishStopping());
  }

  async publishStoppedSafely(): Promise<void> {
    await this.publishSafely("stopped", () => this.publishStopped());
  }

  async publishNodeSnapshot(
    snapshot: LocalRuntimeSnapshot = this.nodeState.snapshot(
      this.ownershipState.listConnectionStatuses(),
    ),
  ): Promise<void> {
    const publish = this.publishQueue.then(() =>
      this.stateStore.publishNodeSnapshot(snapshot),
    );
    this.publishQueue = publish.catch(() => {});
    await publish;
  }

  publishNodeSnapshotInBackground(
    snapshot: LocalRuntimeSnapshot = this.nodeState.snapshot(
      this.ownershipState.listConnectionStatuses(),
    ),
  ): void {
    void this.publishNodeSnapshot(snapshot).catch((error) => {
      console.error("[runtime] failed to publish node snapshot:", error);
    });
  }

  private async publishSafely(
    reason: string,
    publish: () => Promise<void>,
  ): Promise<void> {
    try {
      await publish();
    } catch (error) {
      console.error(
        `[runtime] failed to publish ${reason} node snapshot:`,
        error,
      );
    }
  }
}
