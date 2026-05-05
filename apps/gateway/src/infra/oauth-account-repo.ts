import type { OAuthAccount } from "../generated/prisma/index.js";
import { injectable } from "inversify";

import { prisma } from "../store/prisma.js";

export type OAuthAccountRow = Pick<
  OAuthAccount,
  | "id"
  | "accountId"
  | "provider"
  | "providerAccountId"
  | "accessToken"
  | "refreshToken"
  | "expiresAt"
  | "createdAt"
>;

const OAUTH_SELECT = {
  id: true,
  accountId: true,
  provider: true,
  providerAccountId: true,
  accessToken: true,
  refreshToken: true,
  expiresAt: true,
  createdAt: true,
} as const;

/** Prisma-backed persistence adapter for OAuthAccount records. */
@injectable()
export class OAuthAccountStateRepository {
  async findByProviderAccount(
    provider: string,
    providerAccountId: string,
  ): Promise<OAuthAccountRow | null> {
    return prisma.oAuthAccount.findUnique({
      where: { provider_providerAccountId: { provider, providerAccountId } },
      select: OAUTH_SELECT,
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
  }): Promise<OAuthAccountRow> {
    return prisma.oAuthAccount.create({
      data: {
        id: data.id,
        accountId: data.accountId,
        provider: data.provider,
        providerAccountId: data.providerAccountId,
        accessToken: data.accessToken ?? null,
        refreshToken: data.refreshToken ?? null,
        expiresAt: data.expiresAt ?? null,
      },
      select: OAUTH_SELECT,
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
    await prisma.oAuthAccount.update({
      where: { id },
      data: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
    });
  }
}
