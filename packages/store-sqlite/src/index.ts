import type { ChannelStore, AgentStore } from "@a2a-channels/core";
import { openDatabase } from "./db.js";
import { createChannelStore } from "./channel-store.js";
import { createAgentStore } from "./agent-store.js";

export interface SQLiteStores {
  channels: ChannelStore;
  agents: AgentStore;
}

/**
 * Open (or create) a SQLite database at `dbPath` and return typed store
 * instances for channel bindings and agent configs.
 *
 * Migrations are applied automatically on first open.
 */
export function createSQLiteStores(dbPath: string): SQLiteStores {
  const db = openDatabase(dbPath);
  return {
    channels: createChannelStore(db),
    agents: createAgentStore(db),
  };
}
