-- Configurable rate limits for the public auth endpoints (signin, signup,
-- magic-link, …). Config lives in _dashboard.rate_limits (editable from
-- Admin → Rate limits); the per-key counters live in _dashboard.rate_limit_hits
-- and are taken atomically via _dashboard.rate_limit_take(), so a limit holds
-- across ALL dashboard replicas — not per-process (which round-robin balancing
-- would let an attacker multiply by the replica count).
--
-- Mirrors postgres/migrations/0019_rate_limits.sql for fresh installs.

CREATE TABLE _dashboard.rate_limits (
	area           text PRIMARY KEY,
	max_attempts   integer NOT NULL CHECK (max_attempts > 0),
	window_seconds integer NOT NULL CHECK (window_seconds > 0),
	enabled        boolean NOT NULL DEFAULT true,
	updated_at     timestamptz NOT NULL DEFAULT now(),
	updated_by     uuid REFERENCES _dashboard.users(id) ON DELETE SET NULL
);

-- Sensible per-IP defaults; admins tune them in the dashboard.
INSERT INTO _dashboard.rate_limits (area, max_attempts, window_seconds) VALUES
	('signin',    10, 300),   -- 10 attempts / 5 min
	('signup',     5, 3600),  -- 5 / hour
	('magiclink', 10, 600);   -- 10 / 10 min

-- Fixed-window counters, one row per "<area>:<identifier>" key.
CREATE TABLE _dashboard.rate_limit_hits (
	key          text PRIMARY KEY,
	window_start timestamptz NOT NULL,
	count        integer NOT NULL
);

-- Atomically record one hit against a key and report whether it's still within
-- the limit (true = allowed). Fixed window: the window resets once
-- window_seconds have elapsed since it started. One UPSERT, so it's race-free
-- under concurrency / across replicas.
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
