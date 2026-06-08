-- 0021_function_min_role.sql
-- verify_jwt previously accepted ANY validly-signed token, including the public
-- anon key — so a "JWT-protected" function was reachable by anyone holding that
-- key. min_role turns verify_jwt into a real authorization floor: the caller's
-- token role must be >= min_role. Defaults to 'authenticated', so the anon key
-- alone no longer reaches a JWT-gated function. Idempotent.
-- (Mirrored into postgres/init/10_functions.sql for fresh installs.)

BEGIN;

ALTER TABLE _dashboard.functions
	ADD COLUMN IF NOT EXISTS min_role text NOT NULL DEFAULT 'authenticated'
		CHECK (min_role IN ('anon', 'authenticated', 'service_role'));

COMMIT;
