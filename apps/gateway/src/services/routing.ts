import { prisma } from "../store/prisma.js";

export async function getAgentUrlForBinding(
  bindingId: string,
  defaultUrl: string,
): Promise<string> {
  const binding = await prisma.channelBinding.findFirst({
    where: { id: bindingId, enabled: true },
    select: { agentUrl: true },
  });
  return binding?.agentUrl ?? defaultUrl;
}

export async function getAgentUrlForChannelAccount(
  channelType: string | undefined,
  accountId: string | undefined,
  defaultUrl: string,
): Promise<string> {
  const binding = await prisma.channelBinding.findFirst({
    where: {
      channelType: channelType ?? "feishu",
      accountId: accountId ?? "default",
      enabled: true,
    },
    select: { agentUrl: true },
  });
  return binding?.agentUrl ?? defaultUrl;
}

export async function getAgentProtocolForUrl(agentUrl: string): Promise<string> {
  const agent = await prisma.agent.findFirst({
    where: { url: agentUrl },
    select: { protocol: true },
  });
  return agent?.protocol ?? "a2a";
}
