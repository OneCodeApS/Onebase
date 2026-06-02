-- 0017_auth_helpers.sql
-- Adds Supabase-style RLS helper functions to the `auth` schema so apps can
-- write `USING (owner_id = auth.uid())` instead of repeating the verbose
-- `(current_setting('request.jwt.claims', true)::json ->> 'sub')::uuid`.
--
-- PostgREST exposes the verified JWT's claims via the `request.jwt.claims` GUC;
-- these wrappers just give that the familiar Supabase names. The claim shape is
-- fixed by the token signer (dashboard/lib/auth-jwt.ts): `sub` (end-user id),
-- `email`, and `role` ('anon' | 'authenticated' | 'service_role').
--
-- They live in `auth` to match Supabase and avoid colliding with app tables.
-- Because `auth` is REVOKE'd from PUBLIC, USAGE + EXECUTE are granted to the
-- three PostgREST API roles; USAGE on the schema exposes no data (the auth
-- tables carry no grants for these roles). SECURITY INVOKER + STABLE: the
-- functions read only request GUCs, never table data.
--
-- New install: postgres/init/08_auth_helpers.sql.
-- MUST be run as the `postgres` superuser (creating objects in the restricted
-- `auth` schema requires it):
--
--   docker compose exec -T postgres \
--     psql -U postgres -d "$POSTGRES_DB" < postgres/migrations/0017_auth_helpers.sql
--
-- Idempotent: safe to run more than once.

BEGIN;

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

COMMIT;
