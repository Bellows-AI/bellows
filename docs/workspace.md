# Workspace

A per-member tree at `<root>/<orgId>/<userId>/`, one clone per repository that member selected.

| Concern | Code | Test |
| --- | --- | --- |
| `ORG_WORKSPACE_ROOT`, its default and refusals | `server/src/config.ts` | `server/test/config.workspace.test.ts` |
| Creating a member's tree at sign-in, and its group-writable `.factory/reviewer` (the in-pod reviewer's home, a subPath the kubelet would otherwise make root-owned) — also made by every claim that declares reviewers, so no task waits on the dashboard being opened | `server/src/workspace/provision.ts` (`ensureReviewerHome`), `server/src/routes/job-handlers-worker.ts` (`handleClaimJob`) | `server/test/workspace.provision.test.ts`, `server/test/routes.jobs.test.ts` |
| Path construction (`workspaceDir`), cloning, git argv and credentials | `server/src/workspace/reconcile.ts` | `server/test/workspace.reconcile.test.ts` |
| The clone queue, claim, restart recovery | `server/src/workspace/queue.ts` | `server/test/workspace.queue.test.ts` |
| Branch / commit / size facts and their cache | `server/src/workspace/facts.ts` | `server/test/workspace.facts.test.ts` |
| Per-repo package cache: `environment.cache` names pointed at `/task/.cache/<owner>/<repo>/<NAME>` on the thread's task volume (`repoCacheEnv`), and its size on the payload | `driver/src/claim.ts`, `server/src/workspace/bellows-cache.ts`, `server/src/routes/workspace.ts` | `driver/test/runner-plan.test.ts`, `server/test/bellows.test.ts`, `server/test/routes.workspace.test.ts` |
| Manual purge of one orphaned checkout | `server/src/workspace/purge.ts`, `server/src/routes/workspace-purge.ts` | `server/test/workspace.purge.test.ts`, `server/test-db/user-repo-store.test.ts` |
| Routes and the payload the page polls | `server/src/routes/workspace.ts` | `server/test/routes.workspace.test.ts` |
| Repo selection rows and their constraints | `server/src/db/user-repo-store.ts`, `server/migrations/011_user_workspace.sql`, `044_user_repo_purge.sql` | `server/test-db/user-repo-store.test.ts` |
| Executor profiles: user and org scope, suspend and remove, refusal at submission | `server/src/db/user-executor-store.ts`, `server/src/routes/org-executors.ts`, `server/src/routes/job-handlers-worker.ts`, `server/migrations/047_executor_profile_scope.sql`, `server/migrations/049_executor_profile_suspended.sql` | `server/test-db/user-executor-store.test.ts`, `server/test/routes.org-executors.test.ts`, `server/test/routes.executor-lifecycle.test.ts` |
| Claim-time executor resolution in the stamped scope, shared by both executors | `server/src/db/job-store-claim-executor.ts`, `driver/src/loop-run.ts` | `server/test-db/job-store.executor-scope.test.ts`, `driver/test/loop.test.ts` |
| The executor dialog's client-side validation | `web/src/workspace/executors.ts`, `web/src/panels/WorkspaceExecutorsPanel.tsx` | `web/test/executors.test.ts`, `web/test/executor-dialog.dom.test.tsx`, `e2e/org-executors.spec.ts` |
| Real provisioning in a browser | `e2e/workspace.spec.ts` | the `chromium` Playwright project |

## Invariants

- **A runner never mounts the member subtree.** Each root thread has its own task volume
  (`factory-task-<root uuid>-<generation>`) at `/task`, so tasks of different threads share nothing and a thread's
  follow-ups share the one checkout; the subtree stays the board's. `driver/src/task-volume.ts`,
  `driver/test/k8s.test.ts`, `driver/test/docker-task-volume.test.ts`.
- **Every writer of the tree writes it group-writable**: CLI (uid 1000) and tools (uid 1001) share group 1000
  (`mkdirShared`, `core.sharedRepository=group`, `gate-shell.sh`); an older tree needs `chmod -R g+rwX <member>`
  once on real-uid storage. `server/test/workspace.reconcile.test.ts`, `driver/test/scripts-gate-shell.test.ts`.
- **The path segment is `app_user.id`, never the login**: `workspaceDir` and `driver/src/task-volume.ts` (the thread root) assert the uuid.
- **An existing checkout is never touched and nothing is pruned automatically** — `.git` present
  means skip. Clones land in `<name>.tmp-<pid>` and are renamed in; stale `.tmp-` trees are swept at
  boot. `server/test/workspace.reconcile.test.ts`.
- **The clone token reaches git through the child environment, never argv or `.git/config`**, after a leading
  empty `-c credential.helper=`. `server/test/workspace.reconcile.test.ts`.
- **By-id writes carry their owner into the WHERE clause** (`deleteOwnedRow`, `setSuspendedRow`).
  `server/test-db/user-executor-store.test.ts`.
- **A `cloning` or `purging` row is owned by a live in-process runner**: boot requeues or finishes
  interrupted rows before the queue starts or a route is served. `server/test/workspace.queue.test.ts`.
- **Every purge refusal is decided under the row's lock in one transaction** (`stampPurge`); the
  stamp is released only by an observed child exit. `server/test-db/user-repo-store.test.ts`.
- **The board reads member trees as hostile**: facts run only `rev-parse`/`cat-file` (no repo
  config execs), and facts refuse anything that really lies outside the member's own tree. The board
  never opens a `.bellows.yaml` from a tree: the plan comes through the GitHub API
  (`server/src/workspace/bellows-plan.ts`). `server/test/workspace.facts.test.ts`, `server/test/bellows.plan.test.ts`.
- **A pasted executor config reaches the runner stripped of `RUNNER_MANAGED_KEYS`**
  (`core/src/executors.ts`, the constant the dialog warns by) and of `permission`.
  `server/src/db/job-store-claim-executor.ts`, `server/test-db/job-store.attribution.test.ts`.
- **`config` never rides the poll**, only `GET /api/workspace/executors` and `configFor`.
  `server/test/routes.workspace.test.ts`.
- **A suspended profile launches nothing and is never a default**: submission answers `EXECUTOR_SUSPENDED`, the claim
  sends `executorRefusal`, and a task launches only against a `ready` clone in the member's own selection
  (`REPO_REQUIRED`, `REPO_NOT_READY`), for both executors. `server/test/routes.executor-lifecycle.test.ts`.
- **Stated limits:** unset `ORG_WORKSPACE_ROOT` clones nothing and `GET /api/workspace` answers `{root: null}`; the
  reconcile never fetches, and the runner clones its own checkout from the repository
  (`driver/src/scripts/task-checkout.cjs`); 20 repositories and 10 executor profiles per member, two clones at a
  time; a symlink raced into `.git/refs` between the facts check and git's read can point one read outside the
  tree (`CONTAINED_HEAD`).
- **The package cache is per thread and repo, on the task volume, never shared and never evicted.**
  `driver/src/claim.ts`, `driver/test/runner-plan.test.ts`.
