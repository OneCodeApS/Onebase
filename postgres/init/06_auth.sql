-- Application end-user authentication. Strictly separate from _dashboard
-- which is for OneCode operators.
--
-- - auth.users        — one row per end user, regardless of provider
-- - auth.identities   — links a user to one or more providers (email, microsoft, …)
-- - auth.sessions     — refresh-token bearer records, one row per active session

CREATE SCHEMA IF NOT EXISTS auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO dashboard_admin;

CREATE TABLE auth.users (
	id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	email               text UNIQUE NOT NULL,
	-- NULL when the user signed up via SSO only and never set a password.
	encrypted_password  text,
	email_verified_at   timestamptz,
	created_at          timestamptz NOT NULL DEFAULT now(),
	updated_at          timestamptz NOT NULL DEFAULT now(),
	last_sign_in_at     timestamptz,
	disabled_at         timestamptz,
	raw_user_metadata   jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX users_email_idx ON auth.users (lower(email));

CREATE TABLE auth.identities (
	id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	-- 'email', 'microsoft', 'google', etc.
	provider            text NOT NULL,
	-- Provider's own user identifier — Microsoft oid, etc.
	provider_user_id    text NOT NULL,
	-- Last-seen provider profile, for display name etc.
	identity_data       jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at          timestamptz NOT NULL DEFAULT now(),
	updated_at          timestamptz NOT NULL DEFAULT now(),
	UNIQUE (provider, provider_user_id)
);

CREATE INDEX identities_user_id_idx ON auth.identities (user_id);

CREATE TABLE auth.sessions (
	id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	-- Refresh tokens are stored hashed; the plaintext is only returned to the
	-- client at issue time.
	refresh_token_hash  text UNIQUE NOT NULL,
	created_at          timestamptz NOT NULL DEFAULT now(),
	expires_at          timestamptz NOT NULL,
	revoked_at          timestamptz,
	user_agent          text,
	ip                  inet
);

CREATE INDEX sessions_user_id_idx ON auth.sessions (user_id);

CREATE TABLE auth.magic_link_tokens (
	id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
	-- sha256 hex of the raw token; the plaintext only exists in the emailed link.
	token_hash   text UNIQUE NOT NULL,
	-- Validated against the CORS origin allowlist + pinned at request time.
	redirect_to  text NOT NULL,
	created_at   timestamptz NOT NULL DEFAULT now(),
	expires_at   timestamptz NOT NULL,
	consumed_at  timestamptz,
	request_ip   inet
);

-- (user_id, created_at) backs the per-user rate-limit count;
-- (expires_at) backs the opportunistic cleanup delete.
CREATE INDEX magic_link_tokens_user_created_idx ON auth.magic_link_tokens (user_id, created_at);
CREATE INDEX magic_link_tokens_expires_idx ON auth.magic_link_tokens (expires_at);

GRANT ALL ON ALL TABLES    IN SCHEMA auth TO dashboard_admin;
GRANT ALL ON ALL SEQUENCES IN SCHEMA auth TO dashboard_admin;
