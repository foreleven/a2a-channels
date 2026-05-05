import type { Account } from "../generated/prisma/index.js";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

export type AccountRow = Pick<
  Account,
  "id" | "username" | "passwordHash" | "externalId" | "createdAt"
>;

const ACCOUNT_SELECT = {
  id: true,
  username: true,
  passwordHash: true,
  externalId: true,
  createdAt: true,
} as const;

/** Prisma-backed persistence adapter for Account records. */
@injectable()
export class AccountStateRepository {
  async findById(id: string): Promise<AccountRow | null> {
    return prisma.account.findUnique({
      where: { id },
      select: ACCOUNT_SELECT,
    });
  }

  async findByUsername(username: string): Promise<AccountRow | null> {
    return prisma.account.findUnique({
      where: { username },
      select: ACCOUNT_SELECT,
    });
  }

  async findByExternalId(externalId: string): Promise<AccountRow | null> {
    return prisma.account.findUnique({
      where: { externalId },
      select: ACCOUNT_SELECT,
    });
  }

  async create(data: {
    id: string;
    username: string;
    passwordHash: string;
    externalId?: string | null;
  }): Promise<AccountRow> {
    return prisma.account.create({
      data: {
        id: data.id,
        username: data.username,
        passwordHash: data.passwordHash,
        externalId: data.externalId ?? null,
      },
      select: ACCOUNT_SELECT,
    });
  }

  async existsByUsername(username: string): Promise<boolean> {
    const row = await prisma.account.findUnique({
      where: { username },
      select: { id: true },
    });
    return row !== null;
  }
}
