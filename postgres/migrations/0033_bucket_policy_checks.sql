-- 0033_bucket_policy_checks.sql
-- Per-object authorization for private buckets, delegated to the app's own RLS.
--
-- Until now a private bucket could only be reached with service_role: an
-- authenticated end-user was refused every sign / upload, so an app had to put
-- a backend in front of its own files. read_check / write_check name a SQL
-- function in the public schema that the dashboard calls through PostgREST
-- *with the end-user's own JWT*, so the function runs as that user and every
-- RLS policy on the tables it reads applies. It answers which of the requested
-- keys the user may read (or write); everything else is refused.
--
-- Both columns are optional. NULL keeps today's behaviour exactly: a private
-- bucket without a check is service_role only. The dashboard validates the
-- function (public schema, (text, text[]) returns setof text, NOT security
-- definer) when the policy is saved, and again before it trusts the answer.
--
-- Idempotent: safe on fresh installs and existing deployments.

BEGIN;

ALTER TABLE _dashboard.bucket_policies
  ADD COLUMN IF NOT EXISTS read_check  text,
  ADD COLUMN IF NOT EXISTS write_check text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bucket_policies_read_check_name'
  ) THEN
    ALTER TABLE _dashboard.bucket_policies
      ADD CONSTRAINT bucket_policies_read_check_name
      CHECK (read_check IS NULL OR read_check ~ '^[a-z_][a-z0-9_]{0,62}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bucket_policies_write_check_name'
  ) THEN
    ALTER TABLE _dashboard.bucket_policies
      ADD CONSTRAINT bucket_policies_write_check_name
      CHECK (write_check IS NULL OR write_check ~ '^[a-z_][a-z0-9_]{0,62}$');
  END IF;
END
$$;

COMMENT ON COLUMN _dashboard.bucket_policies.read_check IS
  'Private buckets: public.<fn>(p_bucket text, p_keys text[]) returns setof text, called as the end-user via PostgREST; returns the keys that user may read. NULL = service_role only.';
COMMENT ON COLUMN _dashboard.bucket_policies.write_check IS
  'Private buckets: same contract as read_check, consulted before issuing an upload URL. NULL = service_role only.';

COMMIT;
