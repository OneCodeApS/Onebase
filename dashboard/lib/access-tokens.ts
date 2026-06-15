import crypto from "node:crypto";
import { pool } from "./db";
import type { UserRole } from "./session";

// Personal access tokens — revocable machine credentials for the MCP server
// (and future machine clients). The plaintext is `ob_pat_<64 hex chars>`,
// shown once at creation; only its SHA-256 is stored. Verification re-reads
// the owner's current role and disabled state on every use, so demoting or
// disabling a dashboard user immediately downgrades or kills their tokens.

const TOKEN_PREFIX = "ob_pat_";
const TOKEN_BYTES = 32;

// ─── Scopes ──────────────────────────────────────────────────────────────────

// Every capability the MCP server exposes maps to exactly one scope. A token
// holds a subset; what it can DO is the intersection of three gates:
//   1. the scope is on the token,
//   2. the owner's CURRENT dashboard role is ≥ the scope's minimum role,
//   3. write scopes additionally require read_only = false on the token.
export const SCOPES = [
  "db:read",
  "db:write",
  "db:ddl",
  "functions:read",
  "functions:write",
  "functions:invoke",
  "storage:read",
  "storage:write",
  "cron:read",
  "cron:write",
  "logs:read",
] as const;

export type Scope = (typeof SCOPES)[number];

const ROLE_RANK: Record<UserRole, number> = {
  read_only: 0,
  read_write: 1,
  admin: 2,
};

// Minimum dashboard role the token OWNER must hold for the scope to be live.
// Mirrors what the dashboard UI lets each role do: read_write users can write
// data but not DDL; only admins touch function code (it runs with full DB
// access), storage policy, cron, and the audit log.
const SCOPE_MIN_ROLE: Record<Scope, UserRole> = {
  "db:read": "read_only",
  "db:write": "read_write",
  "db:ddl": "admin",
  "functions:read": "read_only",
  "functions:write": "admin",
  "functions:invoke": "read_write",
  "storage:read": "read_only",
  "storage:write": "admin",
  "cron:read": "read_only",
  "cron:write": "admin",
  "logs:read": "admin",
};

// Scopes that can mutate state — inert while the token's read_only flag is on.
const WRITE_SCOPES: ReadonlySet<Scope> = new Set([
  "db:write",
  "db:ddl",
  "functions:write",
  "functions:invoke",
  "storage:write",
  "cron:write",
]);

export function isWriteScope(scope: Scope): boolean {
  return WRITE_SCOPES.has(scope);
}

export function isScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type AccessTokenRow = {
  id: string;
  name: string;
  user_id: string;
  scopes: Scope[];
  read_only: boolean;
  expires_at: Date;
  revoked_at: Date | null;
  last_used_at: Date | null;
  created_at: Date;
  // Joined from _dashboard.users for display.
  owner_email: string;
};

// The authenticated context a verified token grants to one MCP request.
export type TokenAuth = {
  tokenId: string;
  tokenName: string;
  userId: string;
  email: string;
  role: UserRole;
  scopes: Scope[];
  readOnly: boolean;
};

// All three gates (held + role floor + read_only) in one place. Tool listing
// and tool dispatch both go through this, so a token never even sees a tool
// it couldn't call.
export function scopeAllowed(auth: TokenAuth, scope: Scope): boolean {
  if (!auth.scopes.includes(scope)) return false;
  if (ROLE_RANK[auth.role] < ROLE_RANK[SCOPE_MIN_ROLE[scope]]) return false;
  if (auth.readOnly && WRITE_SCOPES.has(scope)) return false;
  return true;
}

// ─── Mint / verify / revoke ──────────────────────────────────────────────────

function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("hex");
}

export const TOKEN_NAME = /^[\x20-\x7E]{1,64}$/; // printable ASCII, ≤64 chars

export async function mintToken(input: {
  name: string;
  userId: string;
  scopes: Scope[];
  readOnly: boolean;
  expiresInDays: number;
}): Promise<{ plaintext: string; id: string }> {
  if (!TOKEN_NAME.test(input.name)) {
    throw new Error("Token name must be 1-64 printable characters");
  }
  if (!Number.isInteger(input.expiresInDays) || input.expiresInDays < 1 || input.expiresInDays > 365) {
    throw new Error("Expiry must be between 1 and 365 days");
  }
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || !scopes.every(isScope)) {
    throw new Error("At least one valid scope is required");
  }

  const plaintext = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString("hex");
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO _dashboard.access_tokens
       (name, token_hash, user_id, scopes, read_only, expires_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, now() + make_interval(days => $6))
     RETURNING id`,
    [input.name, hashToken(plaintext), input.userId, JSON.stringify(scopes), input.readOnly, input.expiresInDays],
  );
  return { plaintext, id: rows[0].id };
}

// Verifies a presented bearer token. Returns null (never throws) on any
// failure — missing, malformed, revoked, expired, owner disabled/deleted —
// so the route can answer a uniform 401.
export async function verifyToken(plaintext: string): Promise<TokenAuth | null> {
  if (!plaintext.startsWith(TOKEN_PREFIX)) return null;
  const { rows } = await pool().query<{
    id: string;
    name: string;
    user_id: string;
    scopes: unknown;
    read_only: boolean;
    email: string;
    role: UserRole;
  }>(
    `SELECT t.id, t.name, t.user_id, t.scopes, t.read_only, u.email, u.role
       FROM _dashboard.access_tokens t
       JOIN _dashboard.users u ON u.id = t.user_id
      WHERE t.token_hash = $1
        AND t.revoked_at IS NULL
        AND t.expires_at > now()
        AND u.disabled_at IS NULL`,
    [hashToken(plaintext)],
  );
  const row = rows[0];
  if (!row) return null;

  const scopes = Array.isArray(row.scopes)
    ? (row.scopes as string[]).filter(isScope)
    : [];

  return {
    tokenId: row.id,
    tokenName: row.name,
    userId: row.user_id,
    email: row.email,
    role: row.role,
    scopes,
    readOnly: row.read_only,
  };
}

// Fire-and-forget freshness marker so the admin page can show which tokens
// are actually in use. Best-effort: a failed update must not fail the request.
export function touchLastUsed(tokenId: string): void {
  pool()
    .query(`UPDATE _dashboard.access_tokens SET last_used_at = now() WHERE id = $1`, [tokenId])
    .catch(() => {});
}

export async function listTokens(): Promise<AccessTokenRow[]> {
  const { rows } = await pool().query<AccessTokenRow>(
    `SELECT t.id, t.name, t.user_id, t.scopes, t.read_only,
            t.expires_at, t.revoked_at, t.last_used_at, t.created_at,
            u.email AS owner_email
       FROM _dashboard.access_tokens t
       JOIN _dashboard.users u ON u.id = t.user_id
      ORDER BY t.created_at DESC`,
  );
  return rows;
}

// Edits a live token's rights in place. The token string is unchanged, so any
// client (a project's committed .mcp.json) keeps working — verifyToken re-reads
// scopes and read_only on every request, so the new rights apply on the next
// MCP call. Returns the previous values for the audit row, or null if the id
// didn't match a live (non-revoked) token. Scopes are stored as-is; what the
// token can actually DO is still gated by scopeAllowed at use time (owner role
// floor + read_only override), so any combination is safe to persist.
export async function updateTokenScopes(input: {
  id: string;
  scopes: Scope[];
  readOnly: boolean;
}): Promise<{ name: string; previousScopes: Scope[]; previousReadOnly: boolean } | null> {
  const scopes = [...new Set(input.scopes)];
  if (scopes.length === 0 || !scopes.every(isScope)) {
    throw new Error("At least one valid scope is required");
  }

  // The CTE snapshots the pre-update row so we can report what changed; the
  // UPDATE then writes the new values to that same row.
  const { rows } = await pool().query<{
    name: string;
    old_scopes: unknown;
    old_read_only: boolean;
  }>(
    `WITH prev AS (
       SELECT id, scopes AS old_scopes, read_only AS old_read_only
         FROM _dashboard.access_tokens
        WHERE id = $1 AND revoked_at IS NULL
     )
     UPDATE _dashboard.access_tokens t
        SET scopes = $2::jsonb, read_only = $3
       FROM prev
      WHERE t.id = prev.id
      RETURNING t.name, prev.old_scopes, prev.old_read_only`,
    [input.id, JSON.stringify(scopes), input.readOnly],
  );
  const row = rows[0];
  if (!row) return null;

  return {
    name: row.name,
    previousScopes: Array.isArray(row.old_scopes)
      ? (row.old_scopes as string[]).filter(isScope)
      : [],
    previousReadOnly: row.old_read_only,
  };
}

// Soft revoke (keeps the row for the admin page's history). Returns the token
// name for the audit row, or null if the id didn't match anything.
export async function revokeToken(id: string): Promise<string | null> {
  const { rows } = await pool().query<{ name: string }>(
    `UPDATE _dashboard.access_tokens
        SET revoked_at = now()
      WHERE id = $1 AND revoked_at IS NULL
      RETURNING name`,
    [id],
  );
  return rows[0]?.name ?? null;
}
