-- 0019_rate_limits.sql
-- Configurable, DB-backed rate limits for the public auth endpoints. Counters
-- are taken atomically so limits hold across all dashboard replicas. Idempotent.
-- (Mirrored into postgres/init/13_rate_limits.sql for fresh installs.)

BEGIN;

CREATE TABLE IF NOT EXISTS _dashboard.rate_limits (
	area           text PRIMARY KEY,
	max_attempts   integer NOT NULL CHECK (max_attempts > 0),
	window_seconds integer NOT NULL CHECK (window_seconds > 0),
	enabled        boolean NOT NULL DEFAULT true,
	updated_at     timestamptz NOT NULL DEFAULT now(),
	updated_by     uuid REFERENCES _dashboard.users(id) ON DELETE SET NULL
);

INSERT INTO _dashboard.rate_limits (area, max_attempts, window_seconds) VALUES
	('signin',    10, 300),
	('signup',     5, 3600),
	('magiclink', 10, 600)
ON CONFLICT (area) DO NOTHING;

CREATE TABLE IF NOT EXISTS _dashboard.rate_limit_hits (
	key          text PRIMARY KEY,
	window_start timestamptz NOT NULL,
	count        integer NOT NULL
);

CREATE OR REPLACE FUNCTION _dashboard.rate_limit_take(
	p_key text, p_max integer, p_window integer
) RETURNS boolean
LANGUAGE sql
AS $$
	WITH up AS (
		INSERT INTO _dashboard.rate_limit_hits AS h (key, window_start, count)
		VALUES (p_key, now(), 1)
		ON CONFLICT (key) DO UPDATE
			SET window_start = CASE
			      WHEN h.window_start < now() - make_interval(secs => p_window)
			      THEN now() ELSE h.window_start END,
			    count = CASE
			      WHEN h.window_start < now() - make_interval(secs => p_window)
			      THEN 1 ELSE h.count + 1 END
		RETURNING count
	)
	SELECT count <= p_max FROM up;
$$;

GRANT ALL ON _dashboard.rate_limits     TO dashboard_admin;
GRANT ALL ON _dashboard.rate_limit_hits TO dashboard_admin;
GRANT EXECUTE ON FUNCTION _dashboard.rate_limit_take(text, integer, integer) TO dashboard_admin;

COMMIT;
