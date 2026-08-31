-- Rate-limit budget for PUT /auth/v1/user (set / change your own password).
--
-- WHY: the endpoint is new, and without a row here it falls back to the generic
-- 30-attempts-per-minute default baked into lib/rate-limit.ts. That is far too
-- generous for a password endpoint: with "require current password" enabled it
-- is an oracle for guessing the current one. 5 attempts per 15 minutes is
-- roughly the signin budget, tightened because a legitimate user submits this
-- form once, not repeatedly.
--
-- The counter key is the user id, not the IP — the caller is authenticated, so
-- the account is the meaningful subject, and a subcontractor office behind a
-- single egress IP must not exhaust each other's budget.
--
-- Mirrored into postgres/init/13_rate_limits.sql for fresh installs.

INSERT INTO _dashboard.rate_limits (area, max_attempts, window_seconds)
VALUES ('password_update', 5, 900)
ON CONFLICT (area) DO NOTHING;
