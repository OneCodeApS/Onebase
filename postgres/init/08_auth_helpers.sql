-- Supabase-style RLS helper functions, in the `auth` schema.
--
-- OneCodebase mirrors Supabase's shape (Postgres + PostgREST + auth), and apps
-- ported from Supabase expect to write RLS policies like:
--
--   USING (owner_id = auth.uid())
--
-- PostgREST already exposes the verified JWT's claims through the
-- `request.jwt.claims` GUC (see the SQL-editor "owner-only access" snippet),
-- but without these wrappers every policy has to repeat the verbose
-- `(current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid`. These
-- functions give that expression the familiar Supabase names so policies stay
-- short and portable.
--
-- The claim shape is fixed by the token signer (dashboard/lib/auth-jwt.ts):
--   sub   — end-user id (auth.users.id); absent on anon / service_role keys
--   email — end-user email; absent on anon / service_role keys
--   role  — 'anon' | 'authenticated' | 'service_role'
--
-- They live in `auth` (created in 06_auth.sql) rather than `public` so the names
-- don't collide with application tables and match Supabase exactly. The `auth`
-- schema is REVOKE'd from PUBLIC, so we explicitly grant USAGE + EXECUTE to the
-- three PostgREST API roles. USAGE on the schema alone exposes no data — the
-- auth tables carry no grants for these roles, so only these functions are
-- reachable.
--
-- SECURITY INVOKER (the default): the functions read only request GUCs, never
-- table data, so they need no elevated rights. STABLE: the claims are constant
-- within a single request.
--
-- Runs on first boot as the `postgres` superuser, after 06_auth.sql creates the
-- schema and 04_sample_schema.sql creates the `authenticated` role. The matching
-- migration for existing installs is postgres/migrations/0017_auth_helpers.sql.

-- Full set of verified JWT claims as jsonb ('{}' when the request is unsigned).
CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
$$;

-- Current end-user id (the `sub` claim), or NULL when unauthenticated.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid;
$$;

-- Current request role claim ('anon' | 'authenticated' | 'service_role').
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
$$;

-- Current end-user email (the `email` claim), or NULL when unauthenticated.
CREATE OR REPLACE FUNCTION auth.email()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email';
$$;

-- Let the PostgREST API roles resolve and call the helpers from RLS policies.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt()   TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid()   TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.role()  TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
