import type { AgentConfig } from "@a2a-channels/core";

import { prisma } from "../store/prisma.js";

function mapAgent(
  a: Awaited<ReturnType<typeof prisma.agent.findUniqueOrThrow>>,
): AgentConfig {
  return {
    id: a.id,
    name: a.name,
    url: a.url,
    protocol: a.protocol,
    description: a.description ?? undefined,
    createdAt: a.createdAt.toISOString(),
  };
}

export async function listAgentConfigs(): Promise<AgentConfig[]> {
  const rows = await prisma.agent.findMany({ orderBy: { createdAt: "asc" } });
  return rows.map(mapAgent);
}

export async function getAgentConfig(id: string): Promise<AgentConfig | null> {
  const row = await prisma.agent.findUnique({ where: { id } });
  return row ? mapAgent(row) : null;
}

export async function createAgentConfig(
  data: Omit<AgentConfig, "id" | "createdAt">,
): Promise<AgentConfig> {
  const row = await prisma.agent.create({
    data: {
      name: data.name,
      url: data.url,
      protocol: data.protocol ?? "a2a",
      description: data.description ?? null,
    },
  });
  return mapAgent(row);
}

export async function updateAgentConfig(
  id: string,
  data: Partial<Omit<AgentConfig, "id" | "createdAt">>,
): Promise<AgentConfig | null> {
  const existing = await prisma.agent.findUnique({ where: { id } });
  if (!existing) return null;

  const row = await prisma.agent.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.url !== undefined && { url: data.url }),
      ...(data.protocol !== undefined && { protocol: data.protocol }),
      ...(data.description !== undefined && {
        description: data.description ?? null,
      }),
    },
  });
  return mapAgent(row);
}

export async function deleteAgentConfig(id: string): Promise<boolean> {
  try {
    await prisma.agent.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}
