import { inject, injectable } from "inversify";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import {
  GenericChannelConfigProjector,
  type ChannelConfigProjector,
  type ProjectedChannelConfig,
} from "./channel-config-projector.js";
import { RuntimeOwnershipState } from "./ownership-state.js";

type ChannelBinding = ChannelBindingSnapshot;
type OpenClawChannels = NonNullable<OpenClawConfig["channels"]>;

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
      agents: {},
    } as OpenClawConfig;
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
