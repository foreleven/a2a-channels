import type { AccountCredentials } from "../generated/prisma/index.js";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

export type AccountCredentialsRow = Pick<
  AccountCredentials,
  | "id"
  | "accountId"
  | "provider"
  | "providerAccountId"
  | "accessToken"
  | "refreshToken"
  | "expiresAt"
  | "createdAt"
>;

const CREDENTIALS_SELECT = {
  id: true,
  accountId: true,
  provider: true,
  providerAccountId: true,
  accessToken: true,
  refreshToken: true,
  expiresAt: true,
  createdAt: true,
} as const;

/** Prisma-backed persistence adapter for AccountCredentials records. */
@injectable()
export class AccountCredentialsStateRepository {
  async findByProviderAccount(
    provider: string,
    providerAccountId: string,
  ): Promise<AccountCredentialsRow | null> {
    return prisma.accountCredentials.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      select: CREDENTIALS_SELECT,
    });
  }

  async create(data: {
    id: string;
    accountId: string;
    provider: string;
    providerAccountId: string;
    accessToken?: string | null;
    refreshToken?: string | null;
    expiresAt?: Date | null;
  }): Promise<AccountCredentialsRow> {
    return prisma.accountCredentials.create({
      data: {
        id: data.id,
        accountId: data.accountId,
        provider: data.provider,
        providerAccountId: data.providerAccountId,
        accessToken: data.accessToken ?? null,
        refreshToken: data.refreshToken ?? null,
        expiresAt: data.expiresAt ?? null,
      },
      select: CREDENTIALS_SELECT,
    });
  }

  async upsertTokens(
    id: string,
    tokens: {
      accessToken?: string | null;
      refreshToken?: string | null;
      expiresAt?: Date | null;
    },
  ): Promise<void> {
    await prisma.accountCredentials.update({
      where: { id },
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
    });
  }
}
