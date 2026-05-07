import { inject, injectable, optional } from "inversify";
import type {
  AgentConfigSnapshot,
  ChannelBindingSnapshot,
} from "@agent-relay/domain";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import {
  GenericChannelConfigProjector,
  type ChannelConfigProjector,
  type ProjectedChannelConfig,
} from "./channel-config-projector.js";
import { channelTypeRegistry } from "./channel-type-registry.js";
import { RuntimeOwnershipState } from "./ownership-state.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";

type ChannelBinding = ChannelBindingSnapshot;
type OpenClawChannels = NonNullable<OpenClawConfig["channels"]>;
type OpenClawAgents = NonNullable<OpenClawConfig["agents"]>;
type OpenClawAgent = NonNullable<OpenClawAgents["list"]>[number];
type OpenClawBinding = NonNullable<OpenClawConfig["bindings"]>[number];
type OpenClawSession = NonNullable<OpenClawConfig["session"]>;

const DIRECT_MESSAGE_SESSION_SCOPE: NonNullable<OpenClawSession["dmScope"]> =
  "per-account-channel-peer";

/** Projects currently owned channel bindings into OpenClaw plugin config. */
@injectable()
export class RuntimeOpenClawConfigProjection {
  private readonly channelConfigProjectors: ChannelConfigProjector[] = [
    new GenericChannelConfigProjector(),
  ];
  private openClawConfig: OpenClawConfig;

  /** Builds the initial projection from currently owned binding state. */
  constructor(
    @inject(RuntimeOwnershipState)
    private readonly ownershipState: RuntimeOwnershipState,
    @inject(RuntimeAgentRegistry)
    @optional()
    private readonly agentRegistry?: RuntimeAgentRegistry,
  ) {
    this.openClawConfig = this.buildConfig(this.listBindings());
  }

  /** Returns the latest OpenClaw-compatible config snapshot. */
  getConfig(): OpenClawConfig {
    return this.openClawConfig;
  }

  /** Rebuilds projected config after ownership, binding, or agent routing changes. */
  rebuild(): void {
    this.openClawConfig = this.buildConfig(this.listBindings());
  }

  /** Lists owned bindings in stable creation order for deterministic config output. */
  private listBindings(): ChannelBinding[] {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  /** Converts enabled bindings into the OpenClaw channel config shape. */
  private buildConfig(bindings: ChannelBinding[]): OpenClawConfig {
    const channels: Partial<OpenClawChannels> = {};

    for (const binding of bindings) {
      for (const projector of this.channelConfigProjectors) {
        const projected = projector.project(binding);
        if (!projected) {
          continue;
        }

        this.mergeChannelConfig(channels, projected);
      }
    }

    return {
      channels,
      agents: {
        list: this.buildAgents(bindings),
      },
      bindings: this.buildRouteBindings(bindings),
      session: {
        dmScope: DIRECT_MESSAGE_SESSION_SCOPE,
      },
    } as OpenClawConfig;
  }

  /** Projects runtime agents so OpenClaw route resolution does not fall back to main. */
  private buildAgents(bindings: ChannelBinding[]): OpenClawAgent[] {
    const agentsById = new Map<string, OpenClawAgent>();

    for (const agent of this.agentRegistry?.listAgents() ?? []) {
      agentsById.set(agent.id, this.projectAgent(agent));
    }

    for (const binding of bindings) {
      if (!binding.enabled || agentsById.has(binding.agentId)) {
        continue;
      }
      agentsById.set(binding.agentId, {
        id: binding.agentId,
        name: binding.agentId,
      });
    }

    return Array.from(agentsById.values());
  }

  /** Projects gateway channel bindings into OpenClaw route bindings. */
  private buildRouteBindings(bindings: ChannelBinding[]): OpenClawBinding[] {
    return bindings
      .filter((binding) => binding.enabled)
      .map((binding) => ({
        type: "route" as const,
        agentId: binding.agentId,
        comment: `gateway binding ${binding.id}`,
        match: {
          channel: channelTypeRegistry.canonicalize(binding.channelType),
          accountId: binding.accountId,
        },
        session: {
          dmScope: DIRECT_MESSAGE_SESSION_SCOPE,
        },
      }));
  }

  /** Keeps only OpenClaw routing-facing agent metadata from a gateway agent. */
  private projectAgent(agent: AgentConfigSnapshot): OpenClawAgent {
    return {
      id: agent.id,
      name: agent.name,
    };
  }

  /** Merges one projected account config into the proper OpenClaw channel entry. */
  private mergeChannelConfig(
    channels: Partial<OpenClawChannels>,
    projected: ProjectedChannelConfig,
  ): void {
    const existing = (channels[projected.channelKey] ?? {}) as Record<
      string,
      unknown
    >;

    if (projected.accountId === "default") {
      channels[projected.channelKey] = {
        ...existing,
        ...projected.config,
      };
      return;
    }

    const accounts = {
      ...((existing["accounts"] as Record<string, unknown> | undefined) ?? {}),
      [projected.accountId]: projected.config,
    };
    channels[projected.channelKey] = {
      ...existing,
      accounts,
    };
  }
}
