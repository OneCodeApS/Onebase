-- 0035_magic_link_reusable_until_password.sql
-- A per-token opt-in: the link stays usable until its user sets a password.
--
-- WHY: an invitation link is single-use, and in a browser "opening" it IS using
-- it (the verify page auto-submits). Invitations get forwarded and land in
-- shared mailboxes, so a colleague's curious click burned the link before the
-- person it was meant for ever reached "choose a password" — who then needed a
-- new one from an administrator. A flagged token is not consumed by a sign-in
-- while its user has no password; it is consumed the moment one is set (PUT
-- /auth/v1/user). Expiry is unchanged, and a user who already has a password
-- gets ordinary single-use behaviour even from a flagged token.
--
-- Off by default and never set by /auth/v1/magiclink: only code that mints
-- tokens itself (an app's own invitation function) opts in, so emailed sign-in
-- links and passwordless portals keep the single-use guarantee.
--
-- Idempotent. Mirrored into postgres/init/06_auth.sql for fresh installs.

BEGIN;

ALTER TABLE auth.magic_link_tokens
  ADD COLUMN IF NOT EXISTS reusable_until_password boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN auth.magic_link_tokens.reusable_until_password IS
  'Invitation tokens: not consumed by a sign-in while the user has no password; consumed when one is set. Default false = single-use.';

COMMIT;
