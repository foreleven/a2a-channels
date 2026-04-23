import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { OpenClawConfigBuilder } from "../runtime/openclaw-config.js";

export async function buildOpenClawConfig(): Promise<OpenClawConfig> {
  const [bindings, agents] = await Promise.all([
    new ChannelBindingStateRepository().findAll(),
    new AgentConfigStateRepository().findAll(),
  ]);

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
  const builder = new OpenClawConfigBuilder();

  return builder.build(
    bindings.filter((binding) => binding.enabled && binding.channelType === "feishu"),
    agentsById,
  );
}
