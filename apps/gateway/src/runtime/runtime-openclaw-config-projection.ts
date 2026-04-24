import { inject, injectable } from "inversify";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { OpenClawConfigBuilder } from "./openclaw-config.js";
import {
  RuntimeOwnershipState as RuntimeOwnershipStateToken,
  type RuntimeOwnershipState,
} from "./ownership-state.js";

@injectable()
export class RuntimeOpenClawConfigProjection {
  private openClawConfig: OpenClawConfig;

  constructor(
    @inject(OpenClawConfigBuilder)
    private readonly openClawConfigBuilder: OpenClawConfigBuilder,
    @inject(RuntimeOwnershipStateToken)
    private readonly ownershipState: RuntimeOwnershipState,
  ) {
    this.openClawConfig = this.openClawConfigBuilder.build(this.listBindings());
  }

  getConfig(): OpenClawConfig {
    return this.openClawConfig;
  }

  rebuild(): void {
    this.openClawConfig = this.openClawConfigBuilder.build(this.listBindings());
  }

  private listBindings() {
    return this.ownershipState
      .listOwnedBindings()
      .map(({ binding }) => binding)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
}
