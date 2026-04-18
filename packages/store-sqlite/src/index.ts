import type { StoreProvider, ChannelRepository, AgentRepository } from "@a2a-channels/core";
import { openDatabase } from "./db.js";
import { createChannelStore } from "./channel-store.js";
import { createAgentStore } from "./agent-store.js";

/**
 * SQLite-backed implementation of {@link StoreProvider}.
 *
 * Construct once at the composition root and pass to `createGatewayStore`.
 * Swap for a different implementation (e.g. Postgres, in-memory) without
 * changing any gateway code.
 */
export class SQLiteStoreProvider implements StoreProvider {
  readonly channels: ChannelRepository;
  readonly agents: AgentRepository;

  constructor(dbPath: string) {
    const db = openDatabase(dbPath);
    this.channels = createChannelStore(db);
    this.agents = createAgentStore(db);
  }
}

/**
 * Convenience factory that opens (or creates) a SQLite database at `dbPath`
 * and returns a {@link StoreProvider} backed by it.
 *
 * Migrations are applied automatically on first open.
 */
export function createSQLiteStores(dbPath: string): StoreProvider {
  return new SQLiteStoreProvider(dbPath);
}
