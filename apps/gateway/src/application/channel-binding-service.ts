/**
 * ChannelBindingService – thin application facade over channel binding use-cases.
 */

import type {
  AgentConfigRepository,
  ChannelBindingRepository,
  ChannelBindingSnapshot,
} from "@a2a-channels/domain";
import { inject, injectable } from "inversify";
import { PORT_TOKENS } from "@a2a-channels/di";

import {
  createChannelBinding,
  type CreateChannelBindingData,
} from "./use-cases/create-channel-binding.js";
import { deleteChannelBinding } from "./use-cases/delete-channel-binding.js";
import { getChannelBindingById } from "./use-cases/get-channel-binding-by-id.js";
import { listChannelBindings } from "./use-cases/list-channel-bindings.js";
import {
  updateChannelBinding,
  type UpdateChannelBindingData,
} from "./use-cases/update-channel-binding.js";
import {
  AgentNotFoundError,
  DuplicateEnabledBindingError,
} from "./errors.js";

export { AgentNotFoundError, DuplicateEnabledBindingError };
export type { ChannelBindingSnapshot, CreateChannelBindingData, UpdateChannelBindingData };

@injectable()
export class ChannelBindingService {
  constructor(
    @inject(PORT_TOKENS.ChannelBindingRepository)
    private readonly repo: ChannelBindingRepository,
    @inject(PORT_TOKENS.AgentConfigRepository)
    private readonly agentRepo: AgentConfigRepository,
  ) {}

  async list(): Promise<ChannelBindingSnapshot[]> {
    return listChannelBindings(this.repo);
  }

  async getById(id: string): Promise<ChannelBindingSnapshot | null> {
    return getChannelBindingById(this.repo, id);
  }

  async create(data: CreateChannelBindingData): Promise<ChannelBindingSnapshot> {
    return createChannelBinding(this.repo, this.agentRepo, data);
  }

  async update(
    id: string,
    changes: UpdateChannelBindingData,
  ): Promise<ChannelBindingSnapshot | null> {
    return updateChannelBinding(this.repo, this.agentRepo, id, changes);
  }

  async delete(id: string): Promise<boolean> {
    return deleteChannelBinding(this.repo, id);
  }
}
