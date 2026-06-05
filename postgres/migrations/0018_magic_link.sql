-- 0018_magic_link.sql
-- Single-use email magic-link tokens + the 'magiclink' auth provider. Idempotent.
--
-- Tokens are stored hashed (sha256 hex) — the raw token only ever exists in
-- the emailed link. redirect_to is validated against the CORS origin
-- allowlist at request time and pinned here, so a token can only ever land
-- the user back on the origin it was issued for.

BEGIN;

CREATE TABLE IF NOT EXISTS auth.magic_link_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- sha256 hex of the raw token; the plaintext is never stored.
  token_hash   text UNIQUE NOT NULL,
  -- Validated + pinned at request time; replayed verbatim at verify time.
  redirect_to  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz,
  request_ip   inet
);

-- (user_id, created_at) backs the per-user rate-limit count;
-- (expires_at) backs the opportunistic cleanup delete.
CREATE INDEX IF NOT EXISTS magic_link_tokens_user_created_idx
  ON auth.magic_link_tokens (user_id, created_at);
CREATE INDEX IF NOT EXISTS magic_link_tokens_expires_idx
  ON auth.magic_link_tokens (expires_at);

-- Disabled by default — admin must configure SMTP first.
INSERT INTO auth.providers (name, enabled, config)
VALUES ('magiclink', false, '{}'::jsonb)
ON CONFLICT (name) DO NOTHING;

-- 0003/0004's grants were point-in-time; re-grant so they cover the new table.
GRANT ALL ON ALL TABLES    IN SCHEMA auth TO dashboard_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO dashboard_admin;

COMMIT;
