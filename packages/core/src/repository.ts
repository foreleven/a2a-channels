import type { AgentConfig, ChannelBinding } from './types.js';

/** CRUD contract for channel bindings. */
export interface ChannelRepository {
  list(): ChannelBinding[];
  get(id: string): ChannelBinding | undefined;
  create(data: Omit<ChannelBinding, 'id' | 'createdAt'>): ChannelBinding;
  update(
    id: string,
    data: Partial<Omit<ChannelBinding, 'id' | 'createdAt'>>,
  ): ChannelBinding | undefined;
  delete(id: string): boolean;
}

/** CRUD contract for agent configurations. */
export interface AgentRepository {
  list(): AgentConfig[];
  get(id: string): AgentConfig | undefined;
  create(data: Omit<AgentConfig, 'id' | 'createdAt'>): AgentConfig;
  update(
    id: string,
    data: Partial<Omit<AgentConfig, 'id' | 'createdAt'>>,
  ): AgentConfig | undefined;
  delete(id: string): boolean;
}

/**
 * Bundles the two repositories into a single unit.
 * Implement this interface to add support for a new database back-end
 * (e.g. PostgreSQL, MySQL, in-memory) without touching gateway code.
 */
export interface StoreProvider {
  readonly channels: ChannelRepository;
  readonly agents: AgentRepository;
}

// ---------------------------------------------------------------------------
// Backward-compatibility aliases (deprecated – prefer the *Repository names)
// ---------------------------------------------------------------------------

/** @deprecated Use {@link ChannelRepository} instead. */
export type ChannelStore = ChannelRepository;

/** @deprecated Use {@link AgentRepository} instead. */
export type AgentStore = AgentRepository;
