import { inject, injectable } from "inversify";
import type { ChannelBindingSnapshot } from "@a2a-channels/domain";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { RuntimeOwnershipState } from "./ownership-state.js";

type ChannelBinding = ChannelBindingSnapshot;
type FeishuConfig = NonNullable<OpenClawConfig["channels"]>["feishu"];

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

  constructor(
    @inject(RuntimeOwnershipState)
    private readonly ownershipState: RuntimeOwnershipState,
  ) {
    this.openClawConfig = this.buildConfig(this.listBindings());
  }

  getConfig(): OpenClawConfig {
    return this.openClawConfig;
  }

  rebuild(): void {
    this.openClawConfig = this.buildConfig(this.listBindings());
  }

  private listBindings(): ChannelBinding[] {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

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
