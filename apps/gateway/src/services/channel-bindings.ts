import type { ChannelBinding } from "@a2a-channels/core";

import { prisma } from "../store/prisma.js";

export class DuplicateEnabledBindingError extends Error {
  constructor(channelType: string, accountId: string) {
    super(`An enabled ${channelType} binding already exists for account ${accountId}`);
    this.name = "DuplicateEnabledBindingError";
  }
}

function mapBinding(
  b: Awaited<ReturnType<typeof prisma.channelBinding.findUniqueOrThrow>>,
): ChannelBinding {
  return {
    id: b.id,
    name: b.name,
    channelType: b.channelType,
    accountId: b.accountId,
    channelConfig: JSON.parse(b.channelConfig) as Record<string, unknown>,
    agentUrl: b.agentUrl,
    enabled: b.enabled,
    createdAt: b.createdAt.toISOString(),
  };
}

async function assertNoDuplicateEnabledBinding(
  candidate: Pick<ChannelBinding, "channelType" | "accountId" | "enabled">,
  excludeId?: string,
): Promise<void> {
  if (!candidate.enabled) return;

  const duplicate = await prisma.channelBinding.findFirst({
    where: {
      enabled: true,
      channelType: candidate.channelType,
      accountId: candidate.accountId,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });

  if (duplicate) {
    throw new DuplicateEnabledBindingError(
      candidate.channelType,
      candidate.accountId,
    );
  }
}

export async function listChannelBindings(): Promise<ChannelBinding[]> {
  const rows = await prisma.channelBinding.findMany({
    orderBy: { createdAt: "asc" },
  });
  return rows.map(mapBinding);
}

export async function getChannelBinding(
  id: string,
): Promise<ChannelBinding | null> {
  const row = await prisma.channelBinding.findUnique({ where: { id } });
  return row ? mapBinding(row) : null;
}

export async function createChannelBinding(
  data: Omit<ChannelBinding, "id" | "createdAt">,
): Promise<ChannelBinding> {
  await assertNoDuplicateEnabledBinding(data);

  const row = await prisma.channelBinding.create({
    data: {
      name: data.name,
      channelType: data.channelType,
      accountId: data.accountId,
      channelConfig: JSON.stringify(data.channelConfig),
      agentUrl: data.agentUrl,
      enabled: data.enabled,
    },
  });
  return mapBinding(row);
}

export async function updateChannelBinding(
  id: string,
  data: Partial<Omit<ChannelBinding, "id" | "createdAt">>,
): Promise<ChannelBinding | null> {
  const existing = await prisma.channelBinding.findUnique({ where: { id } });
  if (!existing) return null;

  await assertNoDuplicateEnabledBinding(
    {
      channelType: data.channelType ?? existing.channelType,
      accountId: data.accountId ?? existing.accountId,
      enabled: data.enabled ?? existing.enabled,
    },
    id,
  );

  const row = await prisma.channelBinding.update({
    where: { id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.channelType !== undefined && { channelType: data.channelType }),
      ...(data.accountId !== undefined && { accountId: data.accountId }),
      ...(data.channelConfig !== undefined && {
        channelConfig: JSON.stringify(data.channelConfig),
      }),
      ...(data.agentUrl !== undefined && { agentUrl: data.agentUrl }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
    },
  });
  return mapBinding(row);
}

export async function deleteChannelBinding(id: string): Promise<boolean> {
  try {
    await prisma.channelBinding.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}
