# The repo list

Which repositories an organization sees, where that list comes from, and what it scopes.

| Concern | Code | Test |
| --- | --- | --- |
| The list itself: fetch, cache, `list()` / `snapshot()` | `server/src/github/repo-source.ts` | `server/test/repo-source.test.ts` |
| Installation listing | `server/src/github/app-client.ts` | `server/test/github.app-client.test.ts` |
| Per-org tracked-repo allowlist (`tracked_repo`) | `server/src/db/tracked-repos.ts`, `server/migrations/030_signin_selection.sql`, `server/migrations/168_repo_ref.sql`, `core/src/repo-ref.ts` | `server/test/repo-source.test.ts`, `server/test-db/repo-source.replicas.test.ts`, `core/test/repo-ref.test.ts` |
| The forge boundary: `ForgeClient`, resolved per complete repo ref and acting credential (`resolveForgeClient`); the GitHub adapter over the installation reads and the PR writer | `server/src/forge/forge-client.ts`, `server/src/forge/github-client.ts`, `server/src/orgs.ts` (`OrgRuntime.forge`) | `server/test/forge-client.test.ts`, `server/test/skill-catalog.forge.test.ts` |
| Credential-less fallback to `session_branch` | `server/src/db/stored-repos.ts` | `server/test/routes.repos.test.ts` |
| Branch list and prefix search through the installation (a search is one unpaginated `matching-refs` response sliced into 100s) | `server/src/github/app-client.ts` (`listBranches`), `server/src/routes/repos.ts` | `server/test/github.app-client.test.ts`, `server/test/routes.repos.test.ts` |
| Picker route; `/api/repos/:id/*` ref parsing | `server/src/routes/repos.ts`, `server/src/routes/helpers.ts` | `server/test/routes.repos.test.ts`, `server/test/route-helpers.repo-ref.test.ts` |
| Settings → Repositories page: the tracked list and each repo's env config | `web/src/pages/SettingsRepositoriesPage.tsx`, `web/src/components/repository-setup.ts` | `web/test/repository-setup.test.ts`, `web/test/repository-setup.render.test.tsx`, `web/test/repository-selection.dom.test.tsx` |
| Scoping of stored reads | `server/src/stats-service.ts`, `core/src/telemetry.ts` | `core/test/telemetry.stats.test.ts` |

## Invariants

- **One list, no second roster.** The installation's report intersected with the org's
  `tracked_repo` allowlist, computed inside `RepoSource` (`snapshotNames()`), is what scopes stats,
  `otherRepoSessions`, the picker, and the repo validation of task, batch and env writes. An empty allowlist
  means every reported repo, which is why the onboarding screen's all-checked confirm writes
  nothing. `server/test/repo-source.test.ts`.
- **Only the listing is cached; the allowlist is read on every `list()`**, so a selection written
  through one dashboard replica narrows every replica at once, and a failed allowlist read serves the
  last narrowed list, never the full listing. `server/test-db/repo-source.replicas.test.ts`.
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
  Underneath, a repo's identity is `(forge, host, path)` (`RepoRef`): GitHub folds path case, no other forge does,
  and one path on two hosts is two repos. The tracked allowlist stores and returns refs; a malformed row throws,
  because dropping it could read as "track everything". The wire names a repo by `id` = `formatRepoRef(ref)` (bare `owner/name` on github.com): `GET /api/repos` carries it, and `/api/repos/:id/{branches,skills}` take it URL-encoded (`REPO_ID_PARAM_LIMIT`, `server/src/routes/helpers.ts`). Job and task responses carry `repo` (and `publication.repo`) as `{forge, host, path}` or null, read by `refOfNullableRow`, and the `?repo=` filters of `/api/jobs` and `/api/tasks` take the text form and match the whole triple; the CLI and MCP print the text form (`server/test-db/job-store.repo-ref.test.ts`).
  Stored rows carry the triple and a derived row copies its parent's (`server/src/db/repo-ref-row.ts`, `server/test-db/job-store.repo-ref.test.ts`); until the contract migration a narrow key makes one path on two forges or hosts collide (23505), never a silent skip, except the follow and merge-slot sweeps (`on conflict do nothing`).
- **Forge reads and writes go through `resolveForgeClient(source, ref, credential)`, never a path string.** Reads are the
  installation's; a write or merge is sent with the acting token. A ref on another forge or host (GitLab until its
  client lands) resolves to `unsupported` with no network call, and a board with nothing to reach the forge `unconfigured`;
  every caller treats either as unconfirmed (503, `unverified`, skipped), never an empty list, a 404 or "no skills".
  `server/test/forge-client.test.ts`, `server/test/skill-catalog.forge.test.ts`, `server/test/routes.repos.test.ts`.
- **Installation access is the whole boundary.** Any member sees every repo the org tracks; GitHub
  repo permissions are not projected into Factory ([organizations.md](organizations.md)). A write that
  names a repo (`POST /api/jobs`, a batch, env) validates it against the tracked list: `400 UNKNOWN_REPO`,
  and `503 UNAVAILABLE` when the list cannot be read. `server/test/routes.jobs.test.ts`,
  `server/test/routes.batches.test.ts`, `server/test/routes.env.test.ts`.
