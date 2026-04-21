import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { buildOpenClawConfigFromBindings } from "../runtime/openclaw-config.js";

export async function buildOpenClawConfig(): Promise<OpenClawConfig> {
  const [bindings, agents] = await Promise.all([
    new ChannelBindingStateRepository().findAll(),
    new AgentConfigStateRepository().findAll(),
  ]);

  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  return buildOpenClawConfigFromBindings(
    bindings.filter((binding) => binding.enabled && binding.channelType === "feishu"),
    agentsById,
  );
}
