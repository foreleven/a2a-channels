import { injectable } from "inversify";

import type {
  NodeRuntimeSnapshotReader,
  NodeRuntimeSnapshotWriter,
} from "../node-runtime-snapshot-store.js";
import type { LocalRuntimeSnapshot } from "../runtime-node-state.js";

/** In-memory runtime snapshot store for local admin status queries. */
@injectable()
export class LocalRuntimeSnapshotStore
  implements NodeRuntimeSnapshotWriter, NodeRuntimeSnapshotReader
{
  private readonly snapshots: LocalRuntimeSnapshot[] = [];

  async publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void> {
    this.snapshots.unshift(cloneSnapshot(snapshot));
  }

  listNodeSnapshots(): LocalRuntimeSnapshot[] {
    return this.snapshots.map(cloneSnapshot);
  }
}

function cloneSnapshot(snapshot: LocalRuntimeSnapshot): LocalRuntimeSnapshot {
  return {
    ...snapshot,
    bindingStatuses: snapshot.bindingStatuses.map((status) => ({ ...status })),
  };
}
