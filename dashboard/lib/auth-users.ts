import crypto from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { pool } from "./db";

export type AuthUser = {
  id: string;
  email: string;
  encrypted_password: string | null;
  email_verified_at: Date | null;
  disabled_at: Date | null;
  raw_user_metadata: Record<string, unknown>;
};

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain);
}

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const { rows } = await pool().query<AuthUser>(
    `SELECT id, email, encrypted_password, email_verified_at,
            disabled_at, raw_user_metadata
       FROM auth.users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

export async function createUser(input: {
  email: string;
  encrypted_password?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<AuthUser> {
  const { rows } = await pool().query<AuthUser>(
    `INSERT INTO auth.users (email, encrypted_password, raw_user_metadata)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, email, encrypted_password, email_verified_at,
               disabled_at, raw_user_metadata`,
    [input.email, input.encrypted_password ?? null, JSON.stringify(input.metadata ?? {})],
  );
  return rows[0];
}

export async function touchLastSignIn(userId: string): Promise<void> {
  await pool().query(
    "UPDATE auth.users SET last_sign_in_at = now() WHERE id = $1",
    [userId],
  );
}

export async function upsertIdentity(input: {
  user_id: string;
  provider: string;
  provider_user_id: string;
  identity_data: Record<string, unknown>;
}): Promise<void> {
  await pool().query(
    `INSERT INTO auth.identities
       (user_id, provider, provider_user_id, identity_data, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (provider, provider_user_id) DO UPDATE
       SET identity_data = EXCLUDED.identity_data,
           updated_at    = now()`,
    [
      input.user_id,
      input.provider,
      input.provider_user_id,
      JSON.stringify(input.identity_data),
    ],
  );
}

export async function findUserByIdentity(
  provider: string,
  providerUserId: string,
): Promise<AuthUser | null> {
  const { rows } = await pool().query<AuthUser>(
    `SELECT u.id, u.email, u.encrypted_password, u.email_verified_at,
            u.disabled_at, u.raw_user_metadata
       FROM auth.users u
       JOIN auth.identities i ON i.user_id = u.id
      WHERE i.provider = $1 AND i.provider_user_id = $2`,
    [provider, providerUserId],
  );
  return rows[0] ?? null;
}

// Sessions / refresh tokens

const REFRESH_TOKEN_TTL_DAYS = 30;

function hashRefreshToken(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

export async function createSession(input: {
  user_id: string;
  user_agent?: string | null;
  ip?: string | null;
  // Optional override of the 30-day default — magic-link sessions can be
  // configured shorter per provider (auth.providers.magiclink config).
  ttlDays?: number;
}): Promise<{ refreshToken: string; sessionId: string; expiresAt: Date }> {
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const ttlDays = input.ttlDays ?? REFRESH_TOKEN_TTL_DAYS;
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 3600 * 1000);
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO auth.sessions
       (user_id, refresh_token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [input.user_id, hashRefreshToken(refreshToken), expiresAt, input.user_agent ?? null, input.ip ?? null],
  );
  return { refreshToken, sessionId: rows[0].id, expiresAt };
}

export async function rotateSession(currentRefreshToken: string, input: {
  user_agent?: string | null;
  ip?: string | null;
}): Promise<{ user: AuthUser; refreshToken: string; sessionId: string; expiresAt: Date } | null> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    const oldHash = hashRefreshToken(currentRefreshToken);
    const { rows } = await client.query<{
      id: string;
      user_id: string;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT id, user_id, expires_at, revoked_at
         FROM auth.sessions
        WHERE refresh_token_hash = $1
        FOR UPDATE`,
      [oldHash],
    );
    const session = rows[0];
    if (!session || session.revoked_at || session.expires_at < new Date()) {
      await client.query("ROLLBACK");
      return null;
    }
    // Revoke the presented token immediately, issue a new one.
    await client.query(
      "UPDATE auth.sessions SET revoked_at = now() WHERE id = $1",
      [session.id],
    );
    const newToken = crypto.randomBytes(48).toString("base64url");
    const newExpires = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 3600 * 1000);
    const { rows: newRows } = await client.query<{ id: string }>(
      `INSERT INTO auth.sessions
         (user_id, refresh_token_hash, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [session.user_id, hashRefreshToken(newToken), newExpires, input.user_agent ?? null, input.ip ?? null],
    );
    const { rows: userRows } = await client.query<AuthUser>(
      `SELECT id, email, encrypted_password, email_verified_at,
              disabled_at, raw_user_metadata
         FROM auth.users WHERE id = $1`,
      [session.user_id],
    );
    await client.query("COMMIT");
    return {
      user: userRows[0],
      refreshToken: newToken,
      sessionId: newRows[0].id,
      expiresAt: newExpires,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function revokeSession(refreshToken: string): Promise<boolean> {
  const { rowCount } = await pool().query(
    `UPDATE auth.sessions SET revoked_at = now()
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL`,
    [hashRefreshToken(refreshToken)],
  );
  return (rowCount ?? 0) > 0;
}
