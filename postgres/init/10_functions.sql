-- Edge functions: server-side JavaScript stored in the DB, executed when
-- /functions/v1/<name> is hit. Admins edit the code in the dashboard.
--
-- NOT a security sandbox — code runs with the same trust as the dashboard
-- process. Only admins can create/edit functions.
--
-- Mirrors postgres/migrations/0007_functions.sql for fresh installs, with the
-- verify_jwt flag (postgres/migrations/0014_function_verify_jwt.sql) folded
-- into the table. verify_jwt defaults to true: the /functions/v1/<name>
-- handler then requires a valid JWT (signed with PGRST_JWT_SECRET) unless an
-- admin opts a specific function back to public.

CREATE TABLE _dashboard.functions (
	name          text PRIMARY KEY
	              CHECK (name ~ '^[a-z][a-z0-9_-]{0,62}$'),
	description   text,
	enabled       boolean NOT NULL DEFAULT true,
	code          text NOT NULL DEFAULT '',
	env           jsonb NOT NULL DEFAULT '{}'::jsonb,
	timeout_ms    integer NOT NULL DEFAULT 5000
	              CHECK (timeout_ms > 0 AND timeout_ms <= 60000),
	verify_jwt    boolean NOT NULL DEFAULT true,
	created_at    timestamptz NOT NULL DEFAULT now(),
	updated_at    timestamptz NOT NULL DEFAULT now(),
	updated_by    uuid REFERENCES _dashboard.users(id) ON DELETE SET NULL
);

GRANT ALL ON _dashboard.functions TO dashboard_admin;
