import { inject, injectable } from "inversify";

import { RuntimeOwnershipState } from "./ownership-state.js";
import {
  NodeRuntimeSnapshotWriter,
  type NodeRuntimeSnapshotWriter as NodeRuntimeSnapshotWriterPort,
} from "./node-runtime-snapshot-store.js";
import {
  RuntimeNodeState,
  type LocalRuntimeSnapshot,
} from "./runtime-node-state.js";

/** Serializes local runtime snapshot publication through the writer port. */
@injectable()
export class RuntimeSnapshotPublisher {
  private publishQueue: Promise<void> = Promise.resolve();

  constructor(
    @inject(RuntimeNodeState)
    private readonly nodeState: RuntimeNodeState,
    @inject(NodeRuntimeSnapshotWriter)
    private readonly snapshotWriter: NodeRuntimeSnapshotWriterPort,
    @inject(RuntimeOwnershipState)
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
      this.snapshotWriter.publishNodeSnapshot(snapshot),
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
