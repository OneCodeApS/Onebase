# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Changelog — document every change

Every change to this project **must** be recorded in `CHANGELOG.md`.

- The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/).
- Add entries under the `## [Unreleased]` section as you make the change. Use the standard groupings already in use: `Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Breaking`, and `Database` (for migrations / init-script changes).
- Write entries the way existing ones read: lead with what changed in **bold**, then explain the *why* and any operator/upgrade impact (e.g. "on an existing install, apply migration `00XX` before deploying"). Be specific, not terse.
- Database changes get a `Database` note naming the migration file and what fresh-install init script it's mirrored into.

## Version — bump `dashboard/package.json` whenever it makes sense

The single source of truth for the project version is `dashboard/package.json` (`version` field). The dashboard surfaces it (sidebar version chip, Settings → Versions) and CI tags images from it.

Bump it whenever a change is significant enough to warrant a release, following SemVer:

- **patch** (`x.y.Z`) — bug fixes and small changes with no API/behaviour break.
- **minor** (`x.Y.0`) — new features, backward-compatible.
- **major** (`X.0.0`) — breaking changes to APIs, the database, or operator workflow.

When you bump the version, move the accumulated `## [Unreleased]` entries into a new dated `## [X.Y.Z] - YYYY-MM-DD` section, matching the existing changelog layout. Trivial, non-shipping changes (typos in comments, internal notes) don't need a bump — use judgement, and when in doubt prefer a patch bump with a changelog entry over silently shipping an undocumented change.
