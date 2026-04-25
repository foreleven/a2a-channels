import { inject, injectable } from "inversify";

import { RedisClientService } from "../../infra/redis-client.js";
import type {
  NodeRuntimeSnapshotReader,
  NodeRuntimeSnapshotWriter,
} from "../node-runtime-snapshot-store.js";
import type { LocalRuntimeSnapshot } from "../runtime-node-state.js";

const SNAPSHOT_KEY_PREFIX = "a2a:runtime:snapshot:";
const SNAPSHOT_TTL_SECONDS = 120;

/**
 * Redis-backed runtime snapshot store for cluster node status queries.
 *
 * Each node writes its own snapshot under a per-nodeId key with a TTL so
 * snapshots from dead nodes expire automatically. The reader fetches all
 * matching keys to build the cluster-wide view.
 */
@injectable()
export class RedisRuntimeSnapshotStore
  implements NodeRuntimeSnapshotWriter, NodeRuntimeSnapshotReader
{
  constructor(
    @inject(RedisClientService)
    private readonly redis: RedisClientService,
  ) {}

  async publishNodeSnapshot(snapshot: LocalRuntimeSnapshot): Promise<void> {
    const key = `${SNAPSHOT_KEY_PREFIX}${snapshot.nodeId}`;
    const value = JSON.stringify(snapshot);
    await this.redis
      .getClient()
      .set(key, value, "EX", SNAPSHOT_TTL_SECONDS);
  }

  async listNodeSnapshots(): Promise<LocalRuntimeSnapshot[]> {
    const client = this.redis.getClient();
    const snapshots: LocalRuntimeSnapshot[] = [];
    let cursor = "0";

    do {
      const [nextCursor, keys] = await client.scan(
        cursor,
        "MATCH",
        `${SNAPSHOT_KEY_PREFIX}*`,
        "COUNT",
        100,
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        const values = await client.mget(...keys);
        for (const raw of values) {
          if (!raw) continue;
          try {
            const snapshot = JSON.parse(raw) as LocalRuntimeSnapshot;
            snapshots.push(snapshot);
          } catch {
            // Skip corrupted entries
          }
        }
      }
    } while (cursor !== "0");

    return snapshots.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }
}
