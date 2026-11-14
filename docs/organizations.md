# Organizations

An organization is one GitHub App installation: it owns the repo list and partitions every stored row.

| Concern | Code | Test |
| --- | --- | --- |
| Partitioning of the stored tables | `server/migrations/005_organizations.sql` | `core/test/migrations.sql.test.ts` |
| Per-org runtimes, keyed by org id | `server/src/orgs.ts` | `server/test/orgs.test.ts` |
| Materializing orgs and memberships at sign-in | `server/src/auth/store.ts`, `server/src/routes/auth.ts` | `server/test/auth.oauth.sign-in.test.ts` |
| Choosing installations on a first sign-in | `server/src/routes/auth-onboarding.ts`, `web/src/components/OnboardingOrganization.tsx` | `server/test/auth.completion.test.ts`, `web/test/onboarding.render.test.tsx` |
| Resolving the caller's org per request, `POST /api/auth/org` | `server/src/auth/plugin.ts`, `server/src/routes/auth.ts` | `server/test/auth.session.test.ts` |
| Org selector in the app bar | `web/src/components/OrgSelector.tsx` | `web/test/org-selector.test.tsx` |
| Refusal of retired org variables | `server/src/config.ts` | `server/test/config.org.test.ts` |
| Org status (`active`, `suspended`, `refused`): create refusal (403 `ORG_INACTIVE`) and the claim's org filter, cloud only | `server/src/db/org-status.ts`, `server/migrations/140_organization_status.sql`, `server/src/db/jobs/job-store-claim.ts` | `server/test-db/org-status.test.ts` |
| The operator (`OPERATOR_GITHUB_IDS`): `GET /api/operator/orgs`, `POST /api/operator/orgs/:id/(suspend\|refuse\|activate\|delete)`, `bellows operator …` | `server/src/routes/operator.ts`, `server/src/auth/route-class.ts`, `server/src/auth/plugin.ts`, `cli/src/operator.ts` | `server/test-db/operator-routes.test.ts`, `server/test/config.operator.test.ts`, `cli/test/operator.test.ts` |
| Suspension hands running attempts back (heartbeat `release`, interrupt `orgSuspended`); `installation` deleted/suspend/unsuspend | `server/src/db/org-status.ts`, `server/src/db/jobs/job-store-worker.ts`, `server/src/routes/webhook.ts`, `server/migrations/142_organization_delete_after.sql`, `driver/src/loop/loop-attempt.ts` | `server/test-db/org-suspend-interrupt.test.ts`, `server/test/webhook.test.ts`, `driver/test/loop/org-suspended.test.ts` |
| Delete with purge (`org_purge`): secrets by owner; objects once fenced writes drained; the org row's cascade | `server/src/db/org-purge.ts`, `server/src/db/object-write-fence.ts`, `server/migrations/143_org_purge.sql`, `server/src/artifacts/object-store.ts` (`list`) | `server/test-db/org-purge{,.fence}.test.ts`, `server/test/artifacts.list-answers.test.ts` |
| Export (`GET /api/org/export`, admin, audited `org.export`): a tar of NDJSON pages per registered table, then the org's object bodies | `server/src/db/org-export.ts`, `server/src/routes/org-export.ts`, `server/src/tar.ts`, `server/src/artifacts/object-store.ts` (`list` `after`) | `server/test-db/org-export.test.ts`, `server/test/artifacts.object-store.test.ts` |

## Invariants

- **The org id IS the installation id** (a decimal string) and the name is the installation account's login,
  rewritten on every sign-in — nothing keys on the label. The id passes 010's `organization_id_ck` (`^[a-z0-9][a-z0-9_-]{0,38}$`).
- **The org is a property of the caller, not of the process.** A session row and a personal token each carry one,
  re-checked through the `org_membership` join on every request, so a GitHub-side removal ends a credential's reach
  ([auth.md](auth.md)). A driver credential names a process and the orgs (or the pool) it may claim for; the org a call operates on comes from the job row.
- **`org_id` leads every org-owned primary key** — a query always knows its organization, so the
  key is a prefix scan rather than a filter. Org-owned-but-user-less rows (an org executor profile,
  an org workflow) are a NULL `user_id` in the same table as the personal ones.
- **`metric_point.org_id` is the writing credential's org; its `repo` still resolves by joining `session_branch`**,
  the only table a re-attribution rewrites ([telemetry.md](telemetry.md)). `server/test-db/telemetry.org-binding.test.ts`.
- **Ingest attribution is the credential's, never the report's.** A branch report's `repo` field is caller-controlled
  payload; the org is the runner's attempt credential or the plugin's personal token. `server/test/routes.ingest.test.ts`.
- **`session_branch_slice` partitions its `lead()` window by `org_id`** (`server/migrations/002_views.repeatable.sql`),
  or one org's slice is truncated by another's start. Guarded by `server/test-db/telemetry.sql.test.ts`.
- **`ORG_ID`, `ORG_NAME`, `GITHUB_REPOS`, `ORG_REPOS` and the auto-join variables are fatal, not
  ignored** — see [configuration.md](configuration.md).
- **`createAuthStore` and `createCommercePlanWriter` are the stores that take an organization per call** — the first
  decides whether a caller belongs to an org, the second whether the org a push names exists, so neither can start
  from `orgs.for()` (null on a database failure too). Every other store binds `orgId` at construction in `orgs.ts`.
- **A cloud org is active from its first sign-in, on the Free plan**: no pending state, and never unlimited
  (`plan-limits.ts`, `PLAN_DEFAULT_MAX_*`). Only the operator and the App's `installation` webhook move its status; a
  sign-in never does, and a refusal is lifted only by an activate. `server/test-db/org-status.test.ts`.
- **A suspension interrupts resumably, never fails**: creates are refused and the claim offers none of the org's rows,
  a takeover included; each running attempt's next heartbeat answers `release: 'org-suspended'` and the driver hands
  it back as an interruption flagged `orgSuspended` — no budget, not a node loss — keeping its session and checkout,
  so a reactivation resumes it under a new claim sequence. A missing org row is not active but asks no release; a
  self-hosted board reads no status, refusing to boot with `OPERATOR_GITHUB_IDS`. `org-suspend-interrupt.test.ts`.
- **An uninstall deletes nothing, and no source lifts another's hold**: `operator_status` is the operator's, a set
  `delete_after` is GitHub's (`installation.deleted`/`suspend`, `UNINSTALL_DELETE_WINDOW_DAYS` out); `status` is active
  only when neither holds. `unsuspend` clears GitHub's alone, the operator's activate the operator's alone. Each change
  is one audit row; a replay writes none.
- **The operator is a deployment role, not an org role**: an `operator` row in `ROUTE_CLASSES` admits only a
  GitHub id `OPERATOR_GITHUB_IDS` names, an org admin included in the refusal, and each change writes one
  `actor_kind = 'operator'` audit row in the target org. `server/test-db/operator-routes.test.ts`.
- **A purge is never reported done and never touches an active org**: only a `suspended`/`refused` org is queued (an
  operator delete; `delete_after` passing, cloud only) and re-checked under lock; an unconfirmed list, delete or collect
  retries from its step (`last_error`). The org row and `org_purge` go together; one `org.purged` log line remains.
- **An export holds one org, no secret and no held connection**: every `ORG_TABLES` table in short `org_id` key pages; credential
  columns (`EXPORT_OMITTED_COLUMNS`) and nested credential values dropped, converted or not; secrets as refs; a failed read ends it unclosed; the response's close aborts a pending list or get.
