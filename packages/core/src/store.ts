import type { AgentConfig, ChannelBinding } from './types.js';

/** CRUD contract for channel bindings. */
export interface ChannelStore {
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
export interface AgentStore {
  list(): AgentConfig[];
  get(id: string): AgentConfig | undefined;
  create(data: Omit<AgentConfig, 'id' | 'createdAt'>): AgentConfig;
  update(
    id: string,
    data: Partial<Omit<AgentConfig, 'id' | 'createdAt'>>,
  ): AgentConfig | undefined;
  delete(id: string): boolean;
}
