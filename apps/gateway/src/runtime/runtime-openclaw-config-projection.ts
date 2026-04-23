import { inject, injectable } from "inversify";
import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { OpenClawConfigBuilder } from "./openclaw-config.js";
import { RuntimeAgentRegistry } from "./runtime-agent-registry.js";
import { RuntimeOwnedBindingManager } from "./runtime-owned-binding-manager.js";

@injectable()
export class RuntimeOpenClawConfigProjection {
  private openClawConfig: OpenClawConfig;

  constructor(
    @inject(OpenClawConfigBuilder)
    private readonly openClawConfigBuilder: OpenClawConfigBuilder,
    @inject(RuntimeAgentRegistry)
    private readonly agentRegistry: RuntimeAgentRegistry,
    @inject(RuntimeOwnedBindingManager)
    private readonly ownedBindingManager: RuntimeOwnedBindingManager,
  ) {
    this.openClawConfig = this.openClawConfigBuilder.build(
      this.ownedBindingManager.listBindings(),
      this.agentRegistry.snapshotAgentsById(),
    );
  }

  getConfig(): OpenClawConfig {
    return this.openClawConfig;
  }

  rebuild(): void {
    this.openClawConfig = this.openClawConfigBuilder.build(
      this.ownedBindingManager.listBindings(),
      this.agentRegistry.snapshotAgentsById(),
    );
  }
}
