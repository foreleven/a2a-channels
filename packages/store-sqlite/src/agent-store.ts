import crypto from "node:crypto";
import type { AgentConfig } from "@a2a-channels/core";
import type { AgentStore } from "@a2a-channels/core";
import type { Db } from "./db.js";

interface AgentRow {
  id: string;
  name: string;
  url: string;
  description: string | null;
  created_at: string;
}

function rowToAgent(row: AgentRow): AgentConfig {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    description: row.description ?? undefined,
    createdAt: row.created_at,
  };
}

export function createAgentStore(db: Db): AgentStore {
  return {
    list(): AgentConfig[] {
      const rows = db
        .prepare("SELECT * FROM agents ORDER BY created_at ASC")
        .all() as AgentRow[];
      return rows.map(rowToAgent);
    },

    get(id: string): AgentConfig | undefined {
      const row = db
        .prepare("SELECT * FROM agents WHERE id = ?")
        .get(id) as AgentRow | undefined;
      return row ? rowToAgent(row) : undefined;
    },

    create(data: Omit<AgentConfig, "id" | "createdAt">): AgentConfig {
      const agent: AgentConfig = {
        ...data,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      db.prepare(`
        INSERT INTO agents (id, name, url, description, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        agent.id,
        agent.name,
        agent.url,
        agent.description ?? null,
        agent.createdAt,
      );
      return agent;
    },

    update(
      id: string,
      data: Partial<Omit<AgentConfig, "id" | "createdAt">>,
    ): AgentConfig | undefined {
      const existing = this.get(id);
      if (!existing) return undefined;

      const updated: AgentConfig = { ...existing, ...data };
      db.prepare(`
        UPDATE agents SET name = ?, url = ?, description = ? WHERE id = ?
      `).run(updated.name, updated.url, updated.description ?? null, id);
      return updated;
    },

    delete(id: string): boolean {
      const result = db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      return result.changes > 0;
    },
  };
}
