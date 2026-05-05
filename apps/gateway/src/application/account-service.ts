/**
 * AccountService – application service for user registration and login.
 *
 * Uses Node's built-in `crypto` module for password hashing (scrypt) and
 * HMAC-signed tokens – no extra dependencies required.
 */

import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { inject, injectable } from "inversify";

import { AccountStateRepository } from "../infra/account-repo.js";

export interface AccountSnapshot {
  id: string;
  username: string;
  externalId: string | null;
  createdAt: string;
}

export interface LoginResult {
  account: AccountSnapshot;
  token: string;
}

/** Raised when the requested username is already taken. */
export class UsernameTakenError extends Error {
  constructor(username: string) {
    super(`Username "${username}" is already taken`);
    this.name = "UsernameTakenError";
  }
}

/** Raised when credentials do not match any account. */
export class InvalidCredentialsError extends Error {
  constructor() {
    super("Invalid username or password");
    this.name = "InvalidCredentialsError";
  }
}

/** Raised when an auth token cannot be verified. */
export class InvalidTokenError extends Error {
  constructor() {
    super("Invalid or expired token");
    this.name = "InvalidTokenError";
  }
}

const scryptAsync = promisify(scrypt);
const SCRYPT_KEYLEN = 64;
const TOKEN_ALGO = "sha256";
/** Tokens are valid for 30 days by default. */
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

interface TokenPayload {
  accountId: string;
  iat: number;
  /** Expiry timestamp (ms since epoch). */
  exp: number;
}

function buildTokenSecret(): string {
  // Prefer an explicit secret so tokens survive process restarts.
  // Falls back to a per-process random value (tokens become single-session).
  const secret = process.env["JWT_SECRET"];
  if (!secret) {
    console.warn(
      "[auth] JWT_SECRET is not set. Auth tokens will be invalidated on process restart. " +
        "Set JWT_SECRET to a stable secret for production use.",
    );
    return randomBytes(32).toString("hex");
  }
  return secret;
}

// Single-process singleton so the fallback stays stable within a process.
let _tokenSecret: string | undefined;
function getTokenSecret(): string {
  _tokenSecret ??= buildTokenSecret();
  return _tokenSecret;
}

function signToken(payload: TokenPayload, secret: string): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac(TOKEN_ALGO, secret).update(encoded).digest("base64url");
  return `${encoded}.${sig}`;
}

function verifyTokenString(
  token: string,
  secret: string,
): TokenPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;

  const encoded = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = createHmac(TOKEN_ALGO, secret)
    .update(encoded)
    .digest("base64url");

  // Constant-time comparison to resist timing attacks.
  const sigBuf = Buffer.from(sig, "base64url");
  const expectedBuf = Buffer.from(expectedSig, "base64url");
  if (sigBuf.length !== expectedBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expectedBuf)) return null;

  let payload: TokenPayload;
  try {
    payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString(),
    ) as TokenPayload;
  } catch {
    return null;
  }

  // Reject expired tokens.
  if (typeof payload.exp === "number" && Date.now() > payload.exp) {
    return null;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// AccountService
// ---------------------------------------------------------------------------

@injectable()
export class AccountService {
  constructor(
    @inject(AccountStateRepository)
    private readonly repo: AccountStateRepository,
  ) {}

  async register(
    username: string,
    password: string,
    externalId?: string | null,
  ): Promise<AccountSnapshot> {
    const trimmed = username.trim();
    if (!trimmed) {
      throw new Error("Username must not be empty");
    }
    if (password.length < 6) {
      throw new Error("Password must be at least 6 characters");
    }

    if (await this.repo.existsByUsername(trimmed)) {
      throw new UsernameTakenError(trimmed);
    }

    const passwordHash = await this.hashPassword(password);
    const row = await this.repo.create({
      id: randomUUID(),
      username: trimmed,
      passwordHash,
      externalId: externalId ?? null,
    });

    return this.toSnapshot(row);
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const row = await this.repo.findByUsername(username.trim());
    if (!row) {
      throw new InvalidCredentialsError();
    }

    const valid = await this.verifyPassword(password, row.passwordHash);
    if (!valid) {
      throw new InvalidCredentialsError();
    }

    const token = signToken(
      { accountId: row.id, iat: Date.now(), exp: Date.now() + TOKEN_TTL_MS },
      getTokenSecret(),
    );

    return { account: this.toSnapshot(row), token };
  }

  async verifyToken(token: string): Promise<AccountSnapshot | null> {
    const payload = verifyTokenString(token, getTokenSecret());
    if (!payload) return null;

    const row = await this.repo.findById(payload.accountId);
    if (!row) return null;

    return this.toSnapshot(row);
  }

  async getByExternalId(externalId: string): Promise<AccountSnapshot | null> {
    const row = await this.repo.findByExternalId(externalId);
    return row ? this.toSnapshot(row) : null;
  }

  async getById(id: string): Promise<AccountSnapshot | null> {
    const row = await this.repo.findById(id);
    return row ? this.toSnapshot(row) : null;
  }

  private toSnapshot(row: {
    id: string;
    username: string;
    externalId: string | null;
    createdAt: Date;
  }): AccountSnapshot {
    return {
      id: row.id,
      username: row.username,
      externalId: row.externalId,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16).toString("hex");
    const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
    return `${salt}:${derived.toString("hex")}`;
  }

  private async verifyPassword(
    password: string,
    stored: string,
  ): Promise<boolean> {
    const colonIdx = stored.indexOf(":");
    if (colonIdx < 0) return false;

    const salt = stored.slice(0, colonIdx);
    const hash = stored.slice(colonIdx + 1);
    if (!salt || !hash) return false;

    try {
      const derived = (await scryptAsync(password, salt, SCRYPT_KEYLEN)) as Buffer;
      const storedBuf = Buffer.from(hash, "hex");
      if (derived.length !== storedBuf.length) return false;
      return timingSafeEqual(derived, storedBuf);
    } catch {
      return false;
    }
  }
}
