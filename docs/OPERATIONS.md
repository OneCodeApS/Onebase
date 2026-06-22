# Operating Onebase (day-2)

Everything after the stack is up and serving: updating, backups & restore, Postgres
major upgrades, rollback, high-availability, and a consolidated troubleshooting
section. For first-time install and topology, see [`DEPLOY.md`](./DEPLOY.md).

All commands run as the deploy user from `/opt/onebase` on the **backend box** (the box
running the Docker stack) unless stated otherwise. The public front (Caddy) is unaffected
by Onebase upgrades — none of the steps below touch it.

## Contents

- [Updating to a new version](#updating-to-a-new-version)
- [The Caddyfile `skip-worktree` workflow](#the-caddyfile-skip-worktree-workflow)
- [When an upgrade changes the bundled Caddyfile](#when-an-upgrade-changes-the-bundled-caddyfile)
- [Manual update (fallback)](#manual-update-fallback)
- [Backing up the database](#backing-up-the-database)
- [Upgrading PostgreSQL (major version)](#upgrading-postgresql-major-version)
- [Rolling back to a previous version](#rolling-back-to-a-previous-version)
- [Running multiple dashboard replicas (HA)](#running-multiple-dashboard-replicas-ha)
- [Troubleshooting](#troubleshooting)
- [Notes](#notes)

---

## Updating to a new version

Postgres, MinIO, and Caddy keep running during an update — only the dashboard container is
replaced, so your data is untouched. `scripts/deploy.sh` does this in one shot. There are
**two flavours**, and the [`CHANGELOG.md`](../CHANGELOG.md) entry for the target version is
the source of truth for which one you're in:

- A `### Database` section listing new migrations → **major upgrade** (apply migrations).
- A `### Breaking` section → read it carefully before continuing.
- Env-var changes mentioned in `### Added` → set them **before** pulling the new image, or
  the new container won't boot.

If the CHANGELOG entry has **no Database section and no new required env vars**, you're in
the patch/minor path. Going from one major version to another (e.g. `0.1.0` → `1.0.0`) is
always the major path.

### Before you start (any upgrade)

1. **Find the new version.** Open [Releases](https://github.com/OneCodeApS/Onebase/releases)
   and note the version, e.g. `1.0.0`.
2. **Read the release notes.** `CHANGELOG.md` → the section for the target version. Flag
   anything under **Breaking** or **Database**.
3. **SSH to the backend box.**
   ```bash
   ssh <DEPLOY_USER>@<BACKEND_IP>
   cd /opt/onebase
   ```

### Patch / minor upgrade

Use this path when the CHANGELOG entry has **no Database section and no new required env
vars**.

```bash
./scripts/deploy.sh 1.2.3
```

What the script does:

1. `git pull --ff-only` — pulls updated compose / Caddy / init files (your local
   `caddy/Caddyfile` is left alone thanks to `skip-worktree`, *unless this release changed
   it* — then the pull aborts; see
   [When an upgrade changes the bundled Caddyfile](#when-an-upgrade-changes-the-bundled-caddyfile)).
2. Pins `DASHBOARD_IMAGE_TAG=1.2.3` in `.env`.
3. Pulls `ghcr.io/onecodeaps/onebase-dashboard:1.2.3` from GHCR.
4. Recreates **only** the dashboard container (`--no-deps`) and waits until it's healthy
   (`--wait`).
5. Prunes dangling images.

If the new image fails its health check the script exits non-zero and the previous
container keeps serving traffic.

If `scripts/deploy.sh` errors with `Permission denied`, run via bash:
`bash scripts/deploy.sh 1.2.3`.

### Major upgrade

Use this path when the CHANGELOG mentions **new migrations, new required env vars, or
anything under Breaking**.

#### 1. Back up the database

Migrations are non-destructive but always insure first. The easy way is the backup script
(full cluster dump, gzipped, into `./backups/`):

```bash
./scripts/pg-backup.sh
```

Or do it by hand if you prefer a single-database plain dump:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres \
  pg_dump -U postgres postgres > ~/backup-before-<version>-$(date +%Y%m%d-%H%M%S).sql
ls -lh ~/backup-before-<version>-*.sql   # confirm it's not 0 bytes
```

Keep the dump somewhere outside the server too (your laptop, S3 bucket, etc.) before
continuing. See [Backing up the database](#backing-up-the-database) for the full reference.

> This upgrades the **Onebase app** version. Upgrading the **Postgres engine** itself
> across a major (e.g. 18 → 19) is a separate, deliberate operation — see
> [Upgrading PostgreSQL (major version)](#upgrading-postgresql-major-version).

#### 2. Pull the new config

```bash
git pull origin master --ff-only
```

This brings in the new migration files under `postgres/migrations/` and any updated
`docker-compose.yml`.

> If this aborts complaining about `caddy/Caddyfile`, you've hit the `skip-worktree`
> conflict — resolve it per
> [When an upgrade changes the bundled Caddyfile](#when-an-upgrade-changes-the-bundled-caddyfile),
> then continue here.

#### 3. Add new env vars

Open `.env`, add anything the CHANGELOG calls out. Generate fresh values for anything
labelled "secret" or "key" with `openssl rand -hex 32`. For example, v1.0.0 added:

```bash
echo "FUNCTION_ENV_KEY=$(openssl rand -hex 32)" >> .env
```

**Back up these new secrets somewhere safe (password manager, secret store).** Losing
`FUNCTION_ENV_KEY` makes every encrypted env var unrecoverable; losing other secrets has
similar consequences.

Optional env vars (only set if you'll use the feature):

| Var | Used by | When to set |
| --- | --- | --- |
| `AUTH_REDIRECT_BASE_URL` | End-user auth | Only if OAuth callbacks must use a different host than `API_PUBLIC_URL` (the default) — rare |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT` | End-user auth | Fallback if not set via the Auth providers UI |

#### 4. Apply the migrations

All migrations in `postgres/migrations/` are wrapped in `BEGIN; … COMMIT;` and use
`IF NOT EXISTS` patterns, so it's safe to run **all** of them — already-applied migrations
are no-ops.

Pipe each file straight from the host into `psql` over stdin. This iterates the host's
`postgres/migrations/` (the files `git pull` just updated), in lexical order:

```bash
cd /opt/onebase
for f in postgres/migrations/*.sql; do
  echo "==> $f"
  docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 < "$f" \
    || { echo "FAILED on $f"; break; }
done
```

Confirm every file scrolls past — in particular the **new** ones this release adds (check
the CHANGELOG's Database section). If a migration errors, the loop stops (`break`); fix the
cause and re-run — earlier successful migrations are skipped because they're idempotent.

> **Do NOT use `docker compose cp postgres/migrations postgres:/tmp/migrations` + a
> container-side loop.** `docker cp` into an **existing** directory copies the source
> *inside* it (`/tmp/migrations/migrations/…`) instead of replacing it, so a second upgrade
> re-globs the **stale** `/tmp/migrations/*.sql` from the first run and silently skips every
> migration the new release added — with no error. The stdin-pipe loop above reads host
> files directly, so it can't happen. (If you must copy into the container, `rm -rf` the
> target first or copy to a fresh path.)

#### 5. Deploy the new image

```bash
./scripts/deploy.sh 1.0.0
```

Or manually if the script misbehaves — see [Manual update (fallback)](#manual-update-fallback).

#### 6. Verify

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs dashboard --tail 30
```

All containers `Up`, dashboard `(healthy)`. Logs should not have env-var errors.

Open the dashboard in your browser, sign in, walk through the new features the CHANGELOG
mentions. Features that send email (e.g. the magic-link auth provider) need SMTP configured
under **Admin → Auth providers** — per install, no env vars involved.

---

## The Caddyfile `skip-worktree` workflow

The backend's `caddy/Caddyfile` is patched locally to serve plain HTTP only (the front
terminates TLS — see [`DEPLOY.md`](./DEPLOY.md)). To stop `scripts/deploy.sh`'s `git pull`
from conflicting with that local edit, tell git to ignore the file. Do this once per server
(skip if already done):

```bash
git checkout master
git update-index --skip-worktree caddy/Caddyfile
```

> `skip-worktree` only helps while upstream leaves `caddy/Caddyfile` alone. The moment a
> release **changes** it (the v1.3.0 storage-routing rework did), the next `git pull`
> aborts — see the next section.

---

## When an upgrade changes the bundled Caddyfile

Most upgrades don't touch `caddy/Caddyfile`, so `skip-worktree` quietly keeps your local
HTTP-only copy and the pull just works. But when a release **does** change it, the pull
aborts:

```
error: Your local changes to the following files would be overwritten by merge:
        caddy/Caddyfile
Aborting
```

The tell-tale trio that this is a `skip-worktree` conflict (not an ordinary modified-file
conflict): the pull aborts on `caddy/Caddyfile`, yet `git diff -- caddy/Caddyfile` prints
**nothing** and `git checkout -- caddy/Caddyfile` says
`pathspec ... did not match any file(s) known to git`. Confirm it:

```bash
git ls-files -v caddy/Caddyfile   # a leading "S" means skip-worktree is set
```

Resolve it by un-hiding the file, taking the upstream change, then re-applying your
HTTP-only patch:

```bash
# 1. Let git manage the file again
git update-index --no-skip-worktree caddy/Caddyfile

# 2. Inspect your local patch (now visible) — confirm it's only the http:// +
#    dropped-tls edits, nothing custom you'd lose
git diff -- caddy/Caddyfile

# 3. Discard it (you regenerate deterministically) and pull
git checkout -- caddy/Caddyfile
git pull --ff-only

# 4. Re-derive the HTTP-only Caddyfile for the NEW routing by copying the
#    "HTTP-only internal Caddyfile" block in DEPLOY.md (it tracks the current
#    bundled routes), then re-hide the file from future pulls
git update-index --skip-worktree caddy/Caddyfile
```

Then run the upgrade as normal. **After deploying, restart Caddy explicitly** —
`scripts/deploy.sh` runs `up -d --no-deps dashboard`, which never touches Caddy, so the new
routing won't load until you do:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml restart caddy
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps caddy   # want "Up", not "Restarting"
```

---

## Manual update (fallback)

If `scripts/deploy.sh` misbehaves for any reason, the steps it runs by hand:

```bash
cd /opt/onebase

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

## Backing up the database

Take a full backup before any risky operation — especially a Postgres major upgrade.
`scripts/pg-backup.sh` dumps the **entire cluster** (every database plus all roles and their
passwords) to a gzipped file:

```bash
cd /opt/onebase
./scripts/pg-backup.sh
# → ./backups/onebase-pg18-20260527-141230.sql.gz
```

- Dumps land in `./backups/` (git-ignored). Pass a directory to write elsewhere:
  `./scripts/pg-backup.sh /mnt/backups`.
- The filename records the Postgres major (`pg18`) so it's obvious what a dump can restore
  into.
- The `postgres` service must be running. Copy the dump off the server (laptop, S3, …) for
  anything you can't afford to lose.

**Restoring** a dump into a running cluster:

```bash
gunzip -c backups/onebase-pg18-*.sql.gz \
  | docker compose -f docker-compose.yml exec -T postgres psql -U postgres -d postgres
```

> Restoring into a cluster that already has the schema will produce "already exists" errors.
> Restore into a **fresh** cluster (the upgrade script below does exactly that), or restore a
> single table with a targeted `pg_dump` instead.

---

## Upgrading PostgreSQL (major version)

Postgres major upgrades (e.g. **18 → 19**) are deliberately a separate, manual step — they
never happen during a normal `deploy.sh` run:

- `deploy.sh` only recreates the **dashboard** container (`up -d --no-deps dashboard`); it
  never touches Postgres.
- The official `postgres` image **refuses to start** on a data directory created by a
  different major (it logs `database files are incompatible with server` and exits). This
  protects your data — nothing is corrupted, the service just won't come up until you
  migrate.

**Minor / patch upgrades** (e.g. `18.1 → 18.4`, same major) need none of this — the on-disk
format is compatible. Just bump the tag and recreate the one service:

```bash
# edit docker-compose.yml → image: postgres:18.4-alpine
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d postgres
```

**Major upgrades** use `scripts/pg-major-upgrade.sh`, which does a safe dump & restore with
the stock image (no extra tooling). It backs up first, recreates the data volume on the new
major, and restores into it.

### Step 1 — Read the release notes

Skim the [PostgreSQL release notes](https://www.postgresql.org/docs/release/) for the target
major. Don't jump several majors at once without checking each.

### Step 2 — Bump the image tag

Edit `docker-compose.yml`:

```yaml
  postgres:
    image: postgres:19-alpine    # was postgres:18-alpine
```

> Leave the `PGDATA: /var/lib/postgresql/data` line in place — it pins the data directory to
> the mount path across majors, which is what keeps the upgrade tooling version-independent.
> (Postgres 18+ otherwise defaults `PGDATA` to a version-specific path.)

### Step 3 — Run the upgrade script

```bash
cd /opt/onebase
./scripts/pg-major-upgrade.sh
```

It will:

1. Take a full backup (`pg-backup.sh`) into `./backups/`.
2. Show the current vs target major and **wait for you to type `yes`** before anything
   destructive.
3. Stop the stack, drop the old data volume, initialise a fresh cluster on the new major,
   and restore the backup into it (in a throwaway container, so the bundled
   `postgres/init/*` scripts don't double-seed). A few "already exists" notices for the
   bootstrap superuser are expected.
4. Bring the whole stack back up with `--wait`.

The stack is **down for the duration** (typically seconds to a few minutes depending on data
size).

### Step 4 — Verify

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres psql -U postgres -c 'SELECT version();'
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

The version should report the new major and all services should be `Up` / `(healthy)`.

> **If something goes wrong:** revert the tag in `docker-compose.yml` to the old major and
> restore the backup the script left in `./backups/` (see
> [Backing up the database](#backing-up-the-database)). The old image reads the old-major
> dump cleanly.

---

## Rolling back to a previous version

Every released version is an immutable image tag. To revert the **dashboard** to an older
version:

```bash
ssh <DEPLOY_USER>@<BACKEND_IP>
cd /opt/onebase
./scripts/deploy.sh 0.1.0
```

The dashboard container is replaced with the older image. The database, MinIO storage, and
Caddy certs are untouched.

> **Important — schema incompatibility:** if the release you're rolling back from added
> migrations / changed the database schema, the older dashboard code may not work against the
> newer schema. Check the CHANGELOG's Database / Breaking sections for the version you're
> leaving, then either:
>
> - Restore the DB from the `pg_dump` you took before the upgrade, OR
> - Accept that some features in the older dashboard might be broken until you re-upgrade.

To restore the DB from a dump:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres \
  psql -U postgres -d postgres < ~/backup-before-<version>-<timestamp>.sql
```

---

## Running multiple dashboard replicas (HA)

The dashboard is stateless apart from two background jobs — the cron scheduler and the
audit-log retention sweeper — which are **leader-elected** via a Postgres advisory lock
(`dashboard/lib/scheduler.ts`). So you can run any number of replicas: exactly one holds the
lock and runs the jobs, and if it dies another takes over within ~15s. Sessions are
iron-session cookies (signed, stateless), so **no sticky sessions** are needed; Caddy
round-robins freely.

`docker-compose.prod.yml` ships `deploy.replicas: 2`, and the HTTP-only Caddyfile (see
[`DEPLOY.md`](./DEPLOY.md)) already load-balances across them via the `dashboard_lb`
snippet (dynamic DNS upstreams — a plain `reverse_proxy dashboard:3000` would **not** spread
load across replicas, it pins to one). A normal `up -d --wait` brings up both:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps   # 2 dashboard containers, both healthy
```

Change the count with `--scale` (overrides the compose default):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --scale dashboard=3
```

If you only want **one** replica (small server), set `deploy.replicas: 1` in
`docker-compose.prod.yml` — everything behaves exactly as the single-process setup did.

### Connection budget

Realtime fans out over a **single shared `LISTEN` connection per replica**
(`dashboard/lib/realtime-listener.ts`): a thousand open chat/SSE streams cost **one**
Postgres connection, not one each. So each replica's direct-to-Postgres footprint (the
connections that must bypass PgBouncer) is tiny and constant:

- 1 realtime fan-out connection, plus
- 1 leader-election connection (on the leader replica only), plus
- a small pool (≤10) of `authenticator` connections **only if** any table uses realtime
  **authorized mode** — these run the per-subscriber RLS check
  (`REALTIME_RLS_DATABASE_URL`, `dashboard/lib/realtime-rls.ts`). The pool stays empty when no
  authorized-mode table is streaming.

> **Realtime confidentiality (basic vs authorized).** A table's realtime mode (Admin →
> Realtime) decides whether RLS filters the stream. **Basic** broadcasts every change to all
> subscribers — RLS does *not* apply, so only use it for tables every subscriber may read.
> **Authorized** re-evaluates the table's RLS SELECT policy for each changed row in each
> subscriber's auth context before delivery (the same predicate REST uses), and requires RLS
> enabled on the table. INSERT/UPDATE are checked against the new row, DELETE against the old;
> anything unverifiable (oversize DELETEs, expired tokens, RLS errors) fails closed. The
> `authenticator` connection above must never be pointed at a BYPASSRLS role.

That's ~1–2 direct connections per replica, so you can scale `dashboard` well past 2 without
approaching Postgres `max_connections` (**150**, in `docker-compose.yml`). PgBouncer-routed
traffic (PostgREST + the dashboard's general queries, pooled at 30 each) is separate and
multiplexed.

> Earlier versions held one Postgres connection *per* SSE subscriber, which capped concurrent
> realtime users at ~50/replica and made this the scaling ceiling. The fan-out hub removed
> that — realtime concurrency is now bounded by memory, not DB connections.

### Verify leadership after scaling

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs dashboard | grep -E '\[scheduler\]|\[leader\]'
```

Expect **exactly one** `[scheduler] acquired leadership` line; the other replicas log
`[leader] another replica holds the scheduler lock — standing by`. Cron edits made through
any replica reach the leader over `NOTIFY cron_reload`, so they still take effect
immediately.

---

## Troubleshooting

### `docker pull` fails: `unauthorized`

The GHCR image must be **Public**, or you must authenticate. Two-step fix to make it public
(org owner needed):

1. **https://github.com/organizations/OneCodeApS/settings/packages** — enable "Public" for
   container packages org-wide.
2. **https://github.com/orgs/OneCodeApS/packages/container/onebase-dashboard/settings** —
   Danger Zone → Change visibility → Public.

After that, anyone (any server) can pull anonymously. Alternatively, `docker login ghcr.io`
on the server with a PAT that has `read:packages` scope.

### Caddy says "tls: no certificates available" or browser shows "not secure"

Caddy is still trying to acquire a Let's Encrypt cert and the ACME challenge is failing.
Common causes:

- DNS isn't resolving yet. Wait, then `docker compose logs caddy` (or
  `journalctl -u caddy`) to confirm.
- Port 80 isn't reachable from the public internet (firewall, cloud security group). The
  HTTP-01 challenge requires inbound port 80.
- A typo in `API_HOST` / `DASHBOARD_HOST`. Check the values match your DNS records exactly.

### `tls: internal error` during Let's Encrypt, citing a public IP

Inbound 80/443 for that IP are reaching the **wrong box** (not this front). This is a
NAT/port-forward problem (see [`DEPLOY.md`](./DEPLOY.md) Part 1), not a Caddy problem. Prove
it: stop Caddy on the front and curl the public hostname on port 80 from outside — if
something still answers, you're routed to another box (e.g. two servers behind one public
IP).

### "GHCR_OWNER must be set" or "repository name must be lowercase"

Open `.env`. `GHCR_OWNER` must be present and entirely lowercase. For OneCodeApS, the correct
value is `onecodeaps`.

### `./scripts/deploy.sh: Permission denied`

The executable bit didn't survive the clone (common on Windows-authored repos). Either
`chmod +x scripts/deploy.sh`, or invoke it via bash:

```bash
bash scripts/deploy.sh 0.1.0
```

### Dashboard container won't become healthy

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs dashboard --tail 100
```

Common causes:

- `SESSION_SECRET` is missing or shorter than 32 chars → fails at module load.
- `DATABASE_URL` resolution fails → check `DASHBOARD_ADMIN_PASSWORD` in `.env` matches what
  Postgres was initialized with (set on first boot, not changeable without re-initializing
  the data volume).
- Postgres isn't healthy yet → check `docker compose ps`.

### "No `## [x.y.z]` section in CHANGELOG.md" when releasing

This is a release-time error, not a deploy-time one. The Build & Release workflow's
version-bump (`patch`/`minor`/`major`) computes the next version from git tags. With no tags
present, `patch` produces `0.0.1` — which won't match the existing `## [0.1.0]` section.

Fix: edit `CHANGELOG.md`, add the `## [x.y.z]` section with at least one bullet, commit,
push, then re-run the workflow. For the very first release, pick `minor` (gives `0.1.0`,
matching the changelog entry); use `patch` for subsequent releases as normal.

### I forgot the admin password

Create a new admin (the old one stays unless you delete it from the DB):

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  run --rm dashboard npm run create-admin
```

To remove the old admin:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec postgres \
  psql -U postgres -c "DELETE FROM _dashboard.admins WHERE email = 'old@example.com';"
```

### Image pull fails with `no space left on device`

Symptom — `deploy.sh` downloads the image but dies during extraction:

```
failed to extract layer ... no space left on device
  write /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots/.../fs/...
```

The deploy did **not** complete — your old dashboard container keeps running (no downtime),
and the dashboard header still shows the old version.

**Cause.** When Docker uses the **containerd image store** (`docker info` shows
`driver-type: io.containerd.snapshotter.v1`), image layers live under `/var/lib/containerd`
— and the `data-root: /data/docker` setting does **not** move that. On these servers `/var`
is a small partition, so layer extraction runs it out of space while `/data` sits nearly
empty.

Confirm it:

```bash
df -h                                                       # /var near 100%, /data mostly free
docker info | grep -iE "root dir|storage driver|driver-type"
docker system df                                            # if RECLAIMABLE is ~0B, pruning won't help
```

**Fix — relocate the containerd store to the big disk** (preserves existing images, no
re-pull). This stops Docker, so the whole stack is down ~1–2 min; data is safe (volumes are
on `/data/docker`):

```bash
sudo systemctl stop docker docker.socket
sudo systemctl stop containerd

# Copy the store to /data, keeping the original as a safety net
sudo cp -a /var/lib/containerd /data/containerd
sudo mv /var/lib/containerd /var/lib/containerd.old
sudo ln -s /data/containerd /var/lib/containerd

sudo systemctl start containerd
sudo systemctl start docker

# Verify, then re-run the upgrade
ls -ld /var/lib/containerd          # -> /data/containerd
docker ps                           # stack back up, all healthy
./scripts/deploy.sh <version>       # extraction now lands on /data

# Once confirmed healthy, reclaim /var:
sudo rm -rf /var/lib/containerd.old
```

To **prevent** this on a fresh install, disable the containerd snapshotter in `daemon.json`
from the start (`"features": { "containerd-snapshotter": false }`) so layers use overlay2
under `data-root` — see [`DEPLOY.md`](./DEPLOY.md) → "Install Docker and relocate the
data-root".

### PostgREST returns `PGRST002` then `PGRST000` with `could not look up local user ID 1000`

The connection URI got mangled. Cause: a password generated with `openssl rand -base64 24`
contains `/`, `+`, or `=`, which break URI parsing. libpq falls back to "current OS user,"
can't find UID 1000 in the slim image's `/etc/passwd`, and throws.

Fix: regenerate the password with `openssl rand -hex 24` (URL-safe), then wipe the postgres
volume so init scripts re-run with the new value:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down -v
# edit .env, replace the bad password
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait
```

The `-v` flag is critical — without it the postgres volume persists and the old broken
passwords stay on the roles.

### `scripts/deploy.sh` fails with `You are not currently on a branch`

The script does `git pull --ff-only`, which requires being on a branch. Checking out a
release tag (`git checkout v0.1.0`) puts you in detached HEAD, breaking the script.

Fix for first deploy: skip the script, bring the stack up directly (see [`DEPLOY.md`](./DEPLOY.md)
Part 2).

Fix for future deploys: stay on `master`, use `DASHBOARD_IMAGE_TAG` in `.env` to pin the
version, and tell git to ignore the local Caddyfile mod so the script's `git pull` doesn't
conflict:

```bash
git checkout master
git update-index --skip-worktree caddy/Caddyfile
./scripts/deploy.sh 0.2.0
```

### `systemctl reload caddy` fails with `connection refused` on localhost:2019

The running Caddy (e.g. on the front) was started with `admin off` in the global block,
which disables the localhost admin API. `caddy reload` uses that API to hot-swap config.

Fix: use `restart` instead of `reload`. Brief downtime (~1 second), invisible to anything
except active WebSockets.

```bash
sudo systemctl restart caddy
```

### Heredoc (`cat > file << EOF`) hangs with terminal auto-indent

Some Windows SSH clients auto-indent pasted content, including the closing `EOF` line.
Heredoc requires the terminator at column 0 (or `<<-EOF` with leading tabs only — not
spaces).

Symptom: bash sits at the `>` continuation prompt and the file is never written.

Fix: use an `echo` loop with a single redirect at the end. Leading whitespace on each line is
just passed to echo as part of the command:

```bash
{
echo "line one"
echo "line two"
} > file
```

### `docker ps` says "permission denied" but doesn't error visibly

If your earlier check was `docker ps -a 2>/dev/null || echo "docker not installed"`, the
stderr redirect hides the permission-denied message and the `||` runs, producing a
false-negative "docker not installed."

Fix: add the user to the docker group and verify:

```bash
sudo usermod -aG docker <DEPLOY_USER>
newgrp docker
docker ps
```

### `docker compose down` without `-v` leaves stale Postgres data

Postgres init scripts only run when the data directory is empty. Without `-v`, the volume
persists between `down`/`up` cycles, so changes to passwords in `.env` are ignored — the
roles still have whatever password was set the first time the volume was created.

Always use `down -v` when you want a true reset (this destroys all data).

---

## Notes

- **Migrations don't run automatically.** They're SQL files in `postgres/migrations/` that
  the operator applies (step 4 of the major-upgrade path). The dashboard container expects
  the schema to already match.
- **Updates are dashboard-only.** Postgres / MinIO / Caddy version bumps are separate — those
  require explicit version bumps in `docker-compose.yml` and a full `up -d` for the affected
  service. Not part of a normal Onebase release.
- **The public front doesn't need to change** for an Onebase upgrade. Its site file proxies
  by hostname, regardless of which dashboard version is behind it.
- **The `postgres/init/*.sql` scripts only run on a fresh DB** (first ever boot of the
  Postgres volume). They contain the **complete schema** — every migration is folded back
  into them — so a fresh deploy comes up fully initialised with **no migration step needed**.
  Step 4 (Apply the migrations) is only for upgrading an **existing** install to a release
  that adds new migrations. The init scripts and `postgres/migrations/*.sql` are kept in
  lockstep and reach the identical end state, so running the migrations against a fresh DB is
  a harmless no-op.
- **Heredoc with auto-indenting terminals:** if you're SSH'd from a client that auto-indents
  pasted content, multi-line `cat > file << EOF … EOF` blocks will hang because the `EOF`
  line gets indented. Use the `{ echo …; echo …; } > file` pattern instead — leading
  whitespace on `echo` lines is just bash syntax and doesn't end up in the file.
</content>
</invoke>
