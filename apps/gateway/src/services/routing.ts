import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";

export async function getAgentUrlForBinding(
  bindingId: string,
  defaultUrl: string,
): Promise<string> {
  const binding = await new ChannelBindingStateRepository().findById(bindingId);
  if (!binding || !binding.enabled) return defaultUrl;

  const agent = await new AgentConfigStateRepository().findById(binding.agentId);
  return agent?.url ?? defaultUrl;
}

export async function getAgentUrlForChannelAccount(
  channelType: string | undefined,
  accountId: string | undefined,
  defaultUrl: string,
): Promise<string> {
  const binding = await new ChannelBindingStateRepository().findEnabled(
    channelType ?? "feishu",
    accountId ?? "default",
  );
  if (!binding) return defaultUrl;

  const agent = await new AgentConfigStateRepository().findById(binding.agentId);
  return agent?.url ?? defaultUrl;
}

export async function getAgentProtocolForUrl(agentUrl: string): Promise<string> {
  const agent = await new AgentConfigStateRepository().findByUrl(agentUrl);
  return agent?.protocol ?? "a2a";
}
