import { Hono } from "hono";
import { inject, injectable } from "inversify";

import {
  AccountService,
  InvalidCredentialsError,
  InvalidTokenError,
  UsernameTakenError,
} from "../../application/account-service.js";
import { parseJsonBody, z } from "../utils/schema.js";

const registerBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(6),
  externalId: z.string().min(1).optional(),
});

const loginBodySchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/**
 * HTTP adapter for account registration and login.
 *
 * Routes are intentionally public (no auth middleware) so that first-time
 * users can register and existing users can obtain a token.
 */
@injectable()
export class AccountRoutes {
  constructor(
    @inject(AccountService)
    private readonly accountService: AccountService,
  ) {}

  register(app: Hono): void {
    app.post("/api/auth/register", async (c) => {
      const parsed = await parseJsonBody(c, registerBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      try {
        const account = await this.accountService.register(
          parsed.data.username,
          parsed.data.password,
          parsed.data.externalId,
        );
        return c.json(account, 201);
      } catch (err) {
        if (err instanceof UsernameTakenError) {
          return c.json({ error: err.message }, 409);
        }
        if (err instanceof Error) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }
    });

    app.post("/api/auth/login", async (c) => {
      const parsed = await parseJsonBody(c, loginBodySchema);
      if (!parsed.success) {
        return parsed.response;
      }

      try {
        const result = await this.accountService.login(
          parsed.data.username,
          parsed.data.password,
        );
        return c.json({ account: result.account, token: result.token });
      } catch (err) {
        if (err instanceof InvalidCredentialsError) {
          return c.json({ error: err.message }, 401);
        }
        throw err;
      }
    });

    app.get("/api/auth/me", async (c) => {
      const token = extractBearerToken(c.req.header("Authorization"));
      if (!token) {
        return c.json({ error: "Unauthorized" }, 401);
      }

      try {
        const account = await this.accountService.verifyToken(token);
        if (!account) {
          return c.json({ error: "Unauthorized" }, 401);
        }
        return c.json(account);
      } catch (err) {
        if (err instanceof InvalidTokenError) {
          return c.json({ error: err.message }, 401);
        }
        throw err;
      }
    });
  }
}

/** Extracts the bearer token from an Authorization header value. */
export function extractBearerToken(
  authHeader: string | undefined,
): string | null {
  if (!authHeader) return null;
  const prefix = "Bearer ";
  if (!authHeader.startsWith(prefix)) return null;
  const token = authHeader.slice(prefix.length).trim();
  return token || null;
}
