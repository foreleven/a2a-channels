import crypto from "node:crypto";
import type { ChannelBinding } from "@a2a-channels/core";
import type { ChannelRepository } from "@a2a-channels/core";
import type { Db } from "./db.js";

interface ChannelBindingRow {
  id: string;
  name: string;
  channel_type: string;
  account_id: string;
  channel_config: string;
  agent_url: string;
  enabled: number;
  created_at: string;
}

function rowToBinding(row: ChannelBindingRow): ChannelBinding {
  return {
    id: row.id,
    name: row.name,
    channelType: row.channel_type,
    accountId: row.account_id,
    channelConfig: JSON.parse(row.channel_config) as Record<string, unknown>,
    agentUrl: row.agent_url,
    enabled: row.enabled !== 0,
    createdAt: row.created_at,
  };
}

export function createChannelStore(db: Db): ChannelRepository {
  return {
    list(): ChannelBinding[] {
      const rows = db
        .prepare("SELECT * FROM channel_bindings ORDER BY created_at ASC")
        .all() as ChannelBindingRow[];
      return rows.map(rowToBinding);
    },

    get(id: string): ChannelBinding | undefined {
      const row = db
        .prepare("SELECT * FROM channel_bindings WHERE id = ?")
        .get(id) as ChannelBindingRow | undefined;
      return row ? rowToBinding(row) : undefined;
    },

    create(data: Omit<ChannelBinding, "id" | "createdAt">): ChannelBinding {
      const binding: ChannelBinding = {
        ...data,
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
      };
      db.prepare(`
        INSERT INTO channel_bindings
          (id, name, channel_type, account_id, channel_config, agent_url, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        binding.id,
        binding.name,
        binding.channelType,
        binding.accountId,
        JSON.stringify(binding.channelConfig),
        binding.agentUrl,
        binding.enabled ? 1 : 0,
        binding.createdAt,
      );
      return binding;
    },

    update(
      id: string,
      data: Partial<Omit<ChannelBinding, "id" | "createdAt">>,
    ): ChannelBinding | undefined {
      const existing = this.get(id);
      if (!existing) return undefined;

      const updated: ChannelBinding = { ...existing, ...data };
      db.prepare(`
        UPDATE channel_bindings
        SET name = ?, channel_type = ?, account_id = ?, channel_config = ?,
            agent_url = ?, enabled = ?
        WHERE id = ?
      `).run(
        updated.name,
        updated.channelType,
        updated.accountId,
        JSON.stringify(updated.channelConfig),
        updated.agentUrl,
        updated.enabled ? 1 : 0,
        id,
      );
      return updated;
    },

    delete(id: string): boolean {
      const result = db
        .prepare("DELETE FROM channel_bindings WHERE id = ?")
        .run(id);
      return result.changes > 0;
    },
  };
}
