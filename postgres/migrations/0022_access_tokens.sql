-- 0022_access_tokens.sql
-- Personal access tokens for the MCP server (and future machine clients), plus
-- a ledger for named DDL migrations applied through the MCP `apply_migration`
-- tool. Idempotent. (Mirrored into postgres/init/14_access_tokens.sql for
-- fresh installs.)

BEGIN;

-- Revocable machine credentials, owned by a dashboard user. Unlike the
-- anon / service_role JWTs (deterministic, year-2100 expiry, revocable only by
-- rotating PGRST_JWT_SECRET), these are hashed at rest, expire, and can be
-- revoked one at a time. The plaintext (`ob_pat_<hex>`) is shown once at
-- creation and never stored — only its SHA-256 lands here.
CREATE TABLE IF NOT EXISTS _dashboard.access_tokens (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	name         text NOT NULL,
	token_hash   text NOT NULL UNIQUE,
	-- CASCADE: deleting a dashboard user revokes their tokens outright. A token
	-- must never outlive (or out-privilege) its owner; lib/access-tokens.ts also
	-- re-reads the owner's role + disabled_at on every use.
	user_id      uuid NOT NULL REFERENCES _dashboard.users(id) ON DELETE CASCADE,
	-- e.g. ["db:read", "functions:read"]. Validated in lib/access-tokens.ts.
	scopes       jsonb NOT NULL DEFAULT '[]'::jsonb,
	-- Hard override: when true, every write scope is inert no matter what
	-- `scopes` says. Default-on so a carelessly created token is still safe.
	read_only    boolean NOT NULL DEFAULT true,
	expires_at   timestamptz NOT NULL,
	revoked_at   timestamptz,
	last_used_at timestamptz,
	created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS access_tokens_user_id_idx
	ON _dashboard.access_tokens (user_id, created_at DESC);

-- Named DDL applied through the MCP `apply_migration` tool. Init scripts and
-- release migrations (postgres/migrations/*.sql) are tracked in git; schema
-- changes made by an AI agent need their own ordered, reviewable trail.
CREATE TABLE IF NOT EXISTS _dashboard.migrations (
	id         bigserial PRIMARY KEY,
	name       text NOT NULL UNIQUE,
	sql        text NOT NULL,
	applied_at timestamptz NOT NULL DEFAULT now(),
	-- Email of the token owner at apply time (immutable copy, like audit.actor).
	applied_by text,
	token_id   uuid REFERENCES _dashboard.access_tokens(id) ON DELETE SET NULL
);

-- Per-token throttle for MCP tool calls (lib/rate-limit.ts area "mcp").
INSERT INTO _dashboard.rate_limits (area, max_attempts, window_seconds) VALUES
	('mcp', 120, 60)
ON CONFLICT (area) DO NOTHING;

GRANT ALL ON _dashboard.access_tokens TO dashboard_admin;
GRANT ALL ON _dashboard.migrations    TO dashboard_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA _dashboard TO dashboard_admin;

COMMIT;
