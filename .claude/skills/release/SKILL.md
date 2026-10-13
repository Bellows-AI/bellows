---
name: release
description: Cut a Factory release end to end — analyze everything since the last tag, decide with the user what else goes in, fix it through the fix skill, verify quality and correctness (suites, the migration upgrade path from the last release, a live batch on kind), merge in order, then run `npm run release`, watch the publish workflow and create the GitHub release with grouped notes. Use when the user says "release", "cut a release", "bump the version", "prepare vX.Y.Z", "what's left before release", or "/release".
---

# Cut a release

A release is a tag. `npm run release` (`scripts/release.sh`) patch-bumps `VERSION`, commits only
that, tags `vX.Y.Z` and pushes branch and tag atomically; the tag starts
`.github/workflows/release-image.yml`, which re-runs CI, builds and scans the images, and publishes
them and the chart — the chart's version is the tag, never `charts/*/Chart.yaml`'s. Nothing in the
workflow writes release notes: this skill does, with `gh release create`.

Run the phases in order. Stop and ask at every **Confirm**; everything else runs on its own.

## 1. Analyze

```bash
git fetch --tags origin && git checkout main && git pull --ff-only
LAST=$(git describe --tags --abbrev=0)                       # the last release
git log --oneline "$LAST"..origin/main
git diff --stat "$LAST"..origin/main | tail -1
git diff --stat "$LAST"..origin/main -- server/migrations charts .env.example server/src/config.ts docker/
gh pr list --state open
gh issue list --state open --limit 60
gh run list --branch main --limit 5
```

Group the commits by area (features, CLI, driver/runner, gates, web, tests). Pull out what an
operator must know: new migrations, new chart values, new or renamed env vars, removed images. Then
list **release candidates** — open bugs and small issues a release should not ship without, flaky
tests seen on main, follow-ups the merged work left open — each with its size and risk. Recommend
a cut; big or unrelated work waits for the next release.

**Confirm** the scope with the user: which candidates go in, which wait.

## 2. Fix

Each candidate in scope is one PR through the `fix` skill, run as a background agent per issue in
its own worktree. Group issues that touch the same files into one agent, or they conflict. Tell
every agent: do not merge, write its report to a file and return a short summary, and **never run
induced CPU-load tests (CPU burners, parallel full-suite loops) while a live batch runs on this
machine** — load fails the batch's gates, and a vitest worker timeout reads as a real failure.

A defect found later in this skill (phases 3–4) gets the same treatment: `gh issue create` with
the evidence (job ids, batch id, the failing output), then a `fix` agent. Small and obvious ones
you may fix directly in a worktree — test first, then the fix, then the owning `docs/` row.

## 3. Verify

Run on `main` once the in-scope PRs are merged (phase 4), and again after any late fix. Keep each
log on disk; read the summary, then the failures.

**Suites** — on an idle machine; a red under load is re-run before it is trusted:

```bash
npm run typecheck
npm run lint
npm test
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_release_test npm run test:db   # create it first
npm run test:k8s
npm run test:jobs                 # needs a docker daemon
npm run verify:ui                 # when anything under web/src changed since $LAST
```

**Migration upgrade path** — every new migration has to run against data the last release wrote,
not only an empty schema:

```bash
export DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_upgrade_seed
docker compose exec postgres psql -U factory -d postgres -c 'create database factory_upgrade_seed'
git worktree add /tmp/factory-last "$LAST"
(cd /tmp/factory-last && npm ci && npm run build -w core && npm run build -w server \
  && node server/dist/seed/cli.js)                            # the last release's schema, with rows
npm run build -w core && npm run build -w server
node --input-type=module -e "
import postgres from 'postgres';
import { migrate } from './server/dist/db/migrate.js';
const sql = postgres(process.env.DATABASE_URL, { onnotice: () => {} });
await migrate(sql, { localUser: false, log: console.log });
await sql.end();"                                           # this tree's migrations on top
git worktree remove --force /tmp/factory-last
```

Every new migration applies, the row counts survive, and the ledger ends at the newest file. Then
read each migration that alters an existing table: a new `check`, `not null` or unique index must
hold for rows the last release could have written. Drop `factory_upgrade_seed` afterwards.

**Live batch on kind** — the board, driver and runner images exactly as they will ship. `make build`
rebuilds and rolls out from the current tree (`make start` installs a fresh cluster). Then drive
a small batch through the `batch-control` skill against the kind board, never the production URL
`.env` may carry: one stage, two parallel tasks that both add the same scratch file outside
`docs/`, `automerge`. That exercises dispatch, gates, automerge, a conflicting PR, conflict repair
and stage verification in one run. It opens and merges real PRs: **Confirm** with the user first,
and remove the scratch file from `main` afterwards. Audit the outcome — the merged file holds both
tasks' lines, the batch reads `completed`, its stage verification `passed` — and read every
`waitReason`, question and repair prompt on the way: wrong guidance to the agent is a defect even
when the batch ends green.

## 4. Merge

Merge the green PRs one at a time with `gh pr merge <n> --squash`, re-reading `mergeable` after
each — `UNKNOWN` settles in seconds, `CONFLICTING` goes back to its agent: merge `origin/main`
into the branch (never rebase or force-push), keep both sides' behavior, re-run its tests, push,
wait for `validate`. Every review comment is answered on its thread with what changed, before the
merge. Then run phase 3 on the merged `main`.

## 5. Release

Preconditions `scripts/release.sh` enforces anyway — on `main`, clean tree, level with
`origin/main`, HEAD untagged — plus the ones it cannot: CI green on HEAD
(`gh run list --branch main --limit 1`), no in-scope PR left open, phase 3 green on this HEAD.

Write the notes to a file outside the repo: **Highlights**, **Fixes** (issue numbers), **Upgrade
notes** (migrations, chart values, env vars, removed images — what an operator must do),
**Validation** (what ran live), **Known limits** (what was deferred, with its issue). No commit
list; the tag carries that.

**Confirm** with the user: name the tag, the HEAD sha and the notes. A pushed tag publishes images
and a chart that deployments resolve by version; it is not taken back.

```bash
npm run release                                   # prints "released vX.Y.Z"
TAG=$(git describe --tags --abbrev=0)
gh run list --workflow release-image.yml --limit 1
gh run watch <run-id> --exit-status              # validate, build, scan, manifest, chart
gh release create "$TAG" --verify-tag --title "$TAG" --notes-file <notes.md>
```

A failed workflow leaves the tag without published images: read the failing job
(`gh run view <run-id> --log-failed`), fix forward in a PR, and cut the next patch — never move or
delete a pushed tag. Create the GitHub release only after the workflow succeeds.

## Reporting back

The tag and its sha, the workflow run's result, the release URL, every PR merged for it, what was
verified live, and what was deferred with its issue number.
