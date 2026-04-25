import { inject, injectable } from "inversify";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { RuntimeOwnershipState } from "./ownership-state.js";

type ChannelBinding = ChannelBindingSnapshot;
type FeishuConfig = NonNullable<OpenClawConfig["channels"]>["feishu"];

/** Feishu channel credentials stored on a channel binding. */
interface FeishuChannelConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  allowFrom?: string[];
}

/** Projects currently owned channel bindings into OpenClaw plugin config. */
@injectable()
export class RuntimeOpenClawConfigProjection {
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

  /** Converts enabled Feishu bindings into the OpenClaw channel config shape. */
  private buildConfig(bindings: ChannelBinding[]): OpenClawConfig {
    const feishuAccounts: Record<string, FeishuConfig> = {};
    let defaultFeishuConfig: FeishuConfig | null = null;

    for (const binding of bindings) {
      if (!binding.enabled || binding.channelType !== "feishu") {
        continue;
      }

      const accountConfig = this.buildFeishuAccountConfig(binding);
      if (binding.accountId === "default") {
        defaultFeishuConfig = accountConfig;
      } else {
        feishuAccounts[binding.accountId] = accountConfig;
      }
    }

    return {
      channels: {
        feishu: {
          ...(defaultFeishuConfig ?? {}),
          ...(Object.keys(feishuAccounts).length > 0
            ? { accounts: feishuAccounts }
            : {}),
        },
        feishu_doc: {},
      },
      agents: {},
    } as OpenClawConfig;
  }

  /** Maps one gateway Feishu binding snapshot into one OpenClaw account config. */
  private buildFeishuAccountConfig(binding: ChannelBinding): FeishuConfig {
    const cfg = binding.channelConfig as unknown as FeishuChannelConfig;
    return {
      bindingId: binding.id,
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      encryptKey: cfg.encryptKey,
      verificationToken: cfg.verificationToken,
      enabled: true,
      allowFrom: cfg.allowFrom ?? ["*"],
      replyMode: "static",
      dmPolicy: "open",
      groupPolicy: "open",
    };
  }
}
