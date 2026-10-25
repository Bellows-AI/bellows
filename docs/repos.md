# The repo list

Which repositories an organization sees, where that list comes from, and what it scopes.

| Concern | Code | Test |
| --- | --- | --- |
| The list itself: fetch, cache, `list()` / `snapshot()` | `server/src/github/repo-source.ts` | `server/test/repo-source.test.ts` |
| Installation listing | `server/src/github/app-client.ts` | `server/test/github.app-client.test.ts` |
| Per-org tracked-repo allowlist (`tracked_repo`) | `server/src/db/tracked-repos.ts`, `server/migrations/030_signin_selection.sql` | `server/test/repo-source.test.ts` |
| Credential-less fallback to `session_branch` | `server/src/db/stored-repos.ts` | `server/test/routes.repos.test.ts` |
| Picker route | `server/src/routes/repos.ts` | `server/test/routes.repos.test.ts` |
| Settings → Repositories page: the tracked list and each repo's env config | `web/src/pages/SettingsRepositoriesPage.tsx`, `web/src/components/repository-setup.ts` | `web/test/repository-setup.test.ts`, `web/test/repository-setup.render.test.tsx`, `web/test/repository-selection.dom.test.tsx` |
| Scoping of stored reads | `server/src/stats-service.ts`, `core/src/telemetry.ts` | `core/test/telemetry.stats.test.ts` |

## Invariants

- **One list, no second roster.** The installation's report intersected with the org's
  `tracked_repo` allowlist, computed inside `RepoSource` (`snapshotNames()`), is what scopes stats,
  `otherRepoSessions`, the picker, and the repo validation of task, batch and env writes. An empty allowlist
  means every reported repo, which is why the onboarding screen's all-checked confirm writes
  nothing. `server/test/repo-source.test.ts`.
- **It is a network read, so it cannot be a config field** — it changes under the running process
  on the `RepoSource` TTL. `snapshot()` never blocks, because `StatsService.current()` aggregates
  an already-fetched payload and must not become a fetch.
- **Without an App client the source is `storedRepoNames()`** — the distinct repos already in
  `session_branch`. Every stored read is scoped by the repo list, so without the fallback a seeded
  database renders empty, which is exactly `npm run seed` followed by `npm run verify:ui`.
- **Scoping is three buckets and only one is "in".** A session on a repo outside the tracked list
  lands in `otherRepoSessions`, one with telemetry but no hook report in `sessionsWithoutHook` (a board-owned one also stays in the totals).
  Silent drops would make a repo leaving the installation read as an idle week.
  `core/test/telemetry.stats.test.ts`.
- **`owner/name` is the one spelling**, shared by the plugin, the branch reporter and the
  installation listing: the comparison is string inclusion, there are no ids to join on. It travels
  in the `/api/stats` payload as `meta.repos`, not behind a second request.
- **Installation access is the whole boundary.** Any member sees every repo the org tracks; GitHub
  repo permissions are not projected into Factory ([organizations.md](organizations.md)). A write that
  names a repo (`POST /api/jobs`, a batch, env) validates it against the tracked list: `400 UNKNOWN_REPO`,
  and `503 UNAVAILABLE` when the list cannot be read. `server/test/routes.jobs.test.ts`,
  `server/test/routes.batches.test.ts`, `server/test/routes.env.test.ts`.
