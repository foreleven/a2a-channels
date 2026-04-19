import type { OpenClawConfig } from "openclaw/plugin-sdk";

import { buildOpenClawConfigFromBindings } from "../runtime/openclaw-config.js";
import { prisma } from "../store/prisma.js";

export async function buildOpenClawConfig(): Promise<OpenClawConfig> {
  const bindings = await prisma.channelBinding.findMany({
    where: { enabled: true, channelType: "feishu" },
    orderBy: { createdAt: "asc" },
  });

  return buildOpenClawConfigFromBindings(
    bindings.map((binding) => ({
      id: binding.id,
      name: binding.name,
      channelType: binding.channelType,
      channelConfig: JSON.parse(binding.channelConfig) as Record<string, unknown>,
      accountId: binding.accountId,
      agentUrl: binding.agentUrl,
      enabled: binding.enabled,
      createdAt: binding.createdAt.toISOString(),
    })),
  );
}
