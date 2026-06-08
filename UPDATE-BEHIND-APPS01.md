# Updating Onecodebase (behind APPS01)

For servers deployed using [`DEPLOY-BEHIND-APPS01.md`](./DEPLOY-BEHIND-APPS01.md).

Two upgrade flavors:

- **Patch / minor upgrade** — dashboard image swap only. Postgres, MinIO, Caddy, and your data are untouched. Takes ~30 seconds, ~10s of dashboard downtime.
- **Major upgrade** — same plus: new database migrations, possibly new required env vars, possibly other infra changes. Takes a few minutes. Same dashboard-only downtime; data preserved.

The [`CHANGELOG.md`](./CHANGELOG.md) entry for the target version is the source of truth for **which flavor you're in**. Look for:

- A `### Database` section listing new migrations → major upgrade.
- A `### Breaking` section → read it carefully before continuing.
- Env-var changes mentioned in `### Added` → set them before pulling the new image, or the new container won't boot.

## Before you start (any upgrade)

1. **Find the new version.** Open [Releases](https://github.com/OneCodeApS/Onecodebase/releases) and note the version, e.g. `1.0.0`.
2. **Read the release notes.** `CHANGELOG.md` → the section for the target version. Flag anything under **Breaking** or **Database**.
3. **SSH to the app server.**
   ```bash
   ssh onecode@<app-server-ip>
   cd /opt/onecodebase
   ```

## One-time setup (skip if already done on this server)

If this server was first deployed manually (`docker compose ... up -d`, no `scripts/deploy.sh` yet), tell git to ignore the locally-modified `Caddyfile` so future `git pull`s don't conflict:

```bash
git checkout master
git update-index --skip-worktree caddy/Caddyfile
```

> `skip-worktree` only helps while upstream leaves `caddy/Caddyfile` alone. The moment a release **changes** it (the v1.3.0 storage-routing rework did), the next `git pull` aborts — see [When an upgrade changes the bundled Caddyfile](#when-an-upgrade-changes-the-bundled-caddyfile).

---

## When an upgrade changes the bundled Caddyfile

Most upgrades don't touch `caddy/Caddyfile`, so `skip-worktree` quietly keeps your local HTTP-only copy and the pull just works. But when a release **does** change it, the pull aborts:

```
error: Your local changes to the following files would be overwritten by merge:
        caddy/Caddyfile
Aborting
```

The tell-tale trio that this is a `skip-worktree` conflict (not an ordinary modified-file conflict): the pull aborts on `caddy/Caddyfile`, yet `git diff -- caddy/Caddyfile` prints **nothing** and `git checkout -- caddy/Caddyfile` says `pathspec ... did not match any file(s) known to git`. Confirm it:

```bash
git ls-files -v caddy/Caddyfile   # a leading "S" means skip-worktree is set
```

Resolve it by un-hiding the file, taking the upstream change, then re-applying your HTTP-only patch:

```bash
# 1. Let git manage the file again
git update-index --no-skip-worktree caddy/Caddyfile

# 2. Inspect your local patch (now visible) — confirm it's only the http:// +
#    dropped-tls edits, nothing custom you'd lose
git diff -- caddy/Caddyfile

# 3. Discard it (you regenerate deterministically) and pull
git checkout -- caddy/Caddyfile
git pull --ff-only

# 4. Re-derive the HTTP-only Caddyfile for the NEW routing by copying the block
#    in DEPLOY-BEHIND-APPS01.md step 2 (it tracks the current bundled routes),
#    then re-hide the file from future pulls
git update-index --skip-worktree caddy/Caddyfile
```

Then run the upgrade as normal. **After deploying, restart Caddy explicitly** — `scripts/deploy.sh` runs `up -d --no-deps dashboard`, which never touches Caddy, so the new routing won't load until you do:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart caddy
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps caddy   # want "Up", not "Restarting"
```

---

## Patch / minor upgrade

Use this path when the CHANGELOG entry has **no Database section and no new required env vars**.

```bash
./scripts/deploy.sh 1.2.3
```

What the script does:

1. `git pull --ff-only` — pulls updated compose / Caddy / init files (your `Caddyfile` is left alone thanks to `skip-worktree`, *unless this release changed it* — then the pull aborts; see [When an upgrade changes the bundled Caddyfile](#when-an-upgrade-changes-the-bundled-caddyfile)).
2. Pins `DASHBOARD_IMAGE_TAG=1.2.3` in `.env`.
3. Pulls `ghcr.io/onecodeaps/onecodebase-dashboard:1.2.3` from GHCR.
4. Recreates **only** the dashboard container (`--no-deps`) and waits until it's healthy (`--wait`).
5. Prunes dangling images.

If the new image fails its health check the script exits non-zero and the previous container keeps serving traffic.

If `scripts/deploy.sh` errors with `Permission denied`, run via bash: `bash scripts/deploy.sh 1.2.3`.

---

## Major upgrade

Use this path when the CHANGELOG mentions **new migrations, new required env vars, or anything under Breaking**. Going from one major version to another (e.g. `0.1.0` → `1.0.0`) is always this path.

### 1. Back up the database

Migrations are non-destructive but always insure first. The easy way is the backup script (full cluster dump, gzipped, into `./backups/`):

```bash
./scripts/pg-backup.sh
```

Or do it by hand if you prefer a single-database plain dump:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres \
  pg_dump -U postgres postgres > ~/backup-before-<version>-$(date +%Y%m%d-%H%M%S).sql
ls -lh ~/backup-before-<version>-*.sql   # confirm it's not 0 bytes
```

Keep the dump somewhere outside the server too (your laptop, S3 bucket, etc.) before continuing.

> This section upgrades the **Onecodebase app** version. Upgrading the **Postgres engine** itself across a major (e.g. 18 → 19) is a separate, deliberate operation — see [Upgrading PostgreSQL (major version)](DEPLOYMENT.md#upgrading-postgresql-major-version) and `scripts/pg-major-upgrade.sh`.

### 2. Pull the new config

```bash
git pull origin master --ff-only
```

This brings in the new migration files under `postgres/migrations/` and any updated `docker-compose.yml`.

> If this aborts complaining about `caddy/Caddyfile`, you've hit the `skip-worktree` conflict — resolve it per [When an upgrade changes the bundled Caddyfile](#when-an-upgrade-changes-the-bundled-caddyfile), then continue here.

### 3. Add new env vars

Open `.env`, add anything the CHANGELOG calls out. Generate fresh values for anything labelled "secret" or "key" with `openssl rand -hex 32`. For example, v1.0.0 added:

```bash
echo "FUNCTION_ENV_KEY=$(openssl rand -hex 32)" >> .env
```

**Back up these new secrets somewhere safe (password manager, secret store).** Losing `FUNCTION_ENV_KEY` makes every encrypted env var unrecoverable; losing other secrets has similar consequences.

Optional env vars (only set if you'll use the feature):

| Var | Used by | When to set |
| --- | --- | --- |
| `AUTH_REDIRECT_BASE_URL` | End-user auth | Only if OAuth callbacks must use a different host than `API_PUBLIC_URL` (the default) — rare |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT` | End-user auth | Fallback if not set via the Auth providers UI |

### 4. Apply the migrations

All migrations in `postgres/migrations/` are wrapped in `BEGIN; … COMMIT;` and use `IF NOT EXISTS` patterns, so it's safe to run **all** of them — already-applied migrations are no-ops.

```bash
# Copy every migration into the container in one shot
docker compose -f docker-compose.yml -f docker-compose.prod.yml cp \
  postgres/migrations postgres:/tmp/migrations

# Apply them in lexical order (0001, 0002, …)
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres bash -c '
  for f in /tmp/migrations/*.sql; do
    echo "==> $f"
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f "$f" || exit 1
  done
'
```

If a migration errors, the whole transaction rolls back and the loop stops. Fix the cause, then re-run the loop — earlier successful migrations are skipped because they're idempotent.

### 5. Deploy the new image

```bash
./scripts/deploy.sh 1.0.0
```

Or manually if the script misbehaves — see "Manual update" below.

### 6. Verify

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs dashboard --tail 30
```

All five containers `Up`, dashboard `(healthy)`. Logs should not have env-var errors.

Open the dashboard in your browser, sign in, walk through the new features the CHANGELOG mentions. Features that send email (e.g. the magic-link auth provider) need SMTP configured under **Admin → Auth providers** — per install, no env vars involved.

---

## Rollback

Every released version is an immutable image tag. To revert the **dashboard** to an older version:

```bash
./scripts/deploy.sh 0.1.0
```

Dashboard image is replaced; database, MinIO storage, and Caddy certs are untouched.

> **Important:** if the release you're rolling back from added migrations, the older dashboard code may not work against the newer schema. Either:
>
> - Restore the DB from the `pg_dump` you took before the upgrade, OR
> - Accept that some features in the older dashboard might be broken until you re-upgrade.
>
> Check the CHANGELOG's Database / Breaking sections for the version you're leaving before deciding.

To restore the DB from a dump:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres -d postgres < ~/backup-before-<version>-<timestamp>.sql
```

---

## Manual update (fallback)

If `scripts/deploy.sh` misbehaves for any reason, the steps it runs by hand:

```bash
cd /opt/onecodebase

# Pin the new version in .env
grep -v '^DASHBOARD_IMAGE_TAG=' .env > .env.tmp
echo "DASHBOARD_IMAGE_TAG=1.0.0" >> .env.tmp
mv .env.tmp .env

# Pull the new image
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull dashboard

# Recreate just the dashboard container and wait for healthy
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --no-deps --wait dashboard

# Clean up old images
docker image prune -f
```

---

## Notes

- **Migrations don't run automatically.** They're SQL files in `postgres/migrations/` that the operator applies (step 4 of the major-upgrade path). The dashboard container expects the schema to already match.
- **Updates are dashboard-only.** Postgres / MinIO / Caddy version bumps are separate — those require explicit version bumps in `docker-compose.yml` and a full `up -d` for the affected service. Not part of a normal Onecodebase release.
- **APPS01 doesn't need to change** for a Onecodebase upgrade. Its site file proxies by hostname, regardless of which dashboard version is behind it.
- **The `postgres/init/*.sql` scripts only run on a fresh DB** (first ever boot of the Postgres volume). They contain the **complete schema** — every migration is folded back into them — so a fresh deploy comes up fully initialised with **no migration step needed**. Step 4 (Apply the migrations) is only for upgrading an **existing** install to a release that adds new migrations. The init scripts and `postgres/migrations/*.sql` are kept in lockstep and reach the identical end state, so running the migrations against a fresh DB is a harmless no-op.
- **Heredoc with auto-indenting terminals**: if you're SSH'd from a client that auto-indents pasted content, multi-line `cat > file << EOF … EOF` blocks will hang because the `EOF` line gets indented. Use the `{ echo …; echo …; } > file` pattern instead — leading whitespace on `echo` lines is just bash syntax and doesn't end up in the file.
