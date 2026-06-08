-- Global env vars available to every edge function as ctx.env.<KEY>.
--
-- Mirrors postgres/migrations/0008_function_env.sql for fresh installs, with
-- the later column changes folded in:
--   0009 — value_encrypted holds AES-256-GCM ciphertext for new writes.
--   0010 — the legacy plaintext `value` column is nullable with no default;
--          encrypted rows leave it NULL and store data in value_encrypted.

CREATE TABLE _dashboard.function_env (
	key             text PRIMARY KEY
	                CHECK (key ~ '^[A-Z_][A-Z0-9_]*$'),
	value           text,
	value_encrypted text,
	description     text,
	updated_at      timestamptz NOT NULL DEFAULT now(),
	updated_by      uuid REFERENCES _dashboard.users(id) ON DELETE SET NULL
);

GRANT ALL ON _dashboard.function_env TO dashboard_admin;
