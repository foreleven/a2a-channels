import type { Account } from "../generated/prisma/index.js";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

export type AccountRow = Pick<Account, "id" | "username" | "passwordHash" | "createdAt">;

/** Prisma-backed persistence adapter for Account records. */
@injectable()
export class AccountStateRepository {
  async findById(id: string): Promise<AccountRow | null> {
    return prisma.account.findUnique({
      where: { id },
      select: { id: true, username: true, passwordHash: true, createdAt: true },
    });
  }

  async findByUsername(username: string): Promise<AccountRow | null> {
    return prisma.account.findUnique({
      where: { username },
      select: { id: true, username: true, passwordHash: true, createdAt: true },
    });
  }

  async create(data: {
    id: string;
    username: string;
    passwordHash: string;
  }): Promise<AccountRow> {
    return prisma.account.create({
      data: {
        id: data.id,
        username: data.username,
        passwordHash: data.passwordHash,
      },
      select: { id: true, username: true, passwordHash: true, createdAt: true },
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
