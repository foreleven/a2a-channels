import { randomUUID } from "node:crypto";
import { injectable } from "inversify";

@injectable()
export class AccountIdGenerator {
  generate(): string {
    return `account-${randomUUID()}`;
  }

  normalize(accountId: string | undefined): string | undefined {
    const trimmed = accountId?.trim();
    return trimmed ? trimmed : undefined;
  }

  resolve(accountId: string | undefined): string {
    return this.normalize(accountId) ?? this.generate();
  }
}
