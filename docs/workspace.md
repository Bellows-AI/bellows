# Workspace

A per-member tree at `<root>/<orgId>/<userId>/`, one clone per repository that member selected.

| Concern | Code | Test |
| --- | --- | --- |
| `ORG_WORKSPACE_ROOT`, its default and refusals | `server/src/config.ts` | `server/test/config.workspace.test.ts` |
| Creating a member's tree at sign-in | `server/src/workspace/provision.ts` | `server/test/workspace.provision.test.ts` |
| Path construction (`workspaceDir`), cloning, git argv and credentials | `server/src/workspace/reconcile.ts` | `server/test/workspace.reconcile.test.ts` |
| The clone queue, claim, restart recovery | `server/src/workspace/queue.ts` | `server/test/workspace.queue.test.ts` |
| Branch / commit / size facts and their cache | `server/src/workspace/facts.ts` | `server/test/workspace.facts.test.ts` |
| Per-repo package cache: `environment.cache` names pointed at `<member>/.cache/<owner>/<repo>/<NAME>` (`repoCacheEnv`), and its size on the payload | `driver/src/claim.ts`, `server/src/workspace/bellows-cache.ts`, `server/src/routes/workspace.ts` | `driver/test/runner-plan.test.ts`, `server/test/bellows.test.ts`, `server/test/routes.workspace.test.ts` |
| Manual purge of one orphaned checkout | `server/src/workspace/purge.ts`, `server/src/routes/workspace-purge.ts` | `server/test/workspace.purge.test.ts`, `server/test-db/user-repo-store.test.ts` |
| Routes and the payload the page polls | `server/src/routes/workspace.ts` | `server/test/routes.workspace.test.ts` |
| Repo selection rows and their constraints | `server/src/db/user-repo-store.ts`, `server/migrations/011_user_workspace.sql`, `044_user_repo_purge.sql` | `server/test-db/user-repo-store.test.ts` |
| Executor profiles (user and org scope) | `server/src/db/user-executor-store.ts`, `server/src/routes/org-executors.ts`, `server/migrations/047_executor_profile_scope.sql` | `server/test-db/user-executor-store.test.ts`, `server/test/routes.org-executors.test.ts` |
| Removing and suspending a profile; the refusal at submission | `server/src/routes/workspace.ts`, `server/src/routes/org-executors.ts`, `server/src/routes/job-handlers-worker.ts`, `server/migrations/049_executor_profile_suspended.sql` | `server/test/routes.executor-lifecycle.test.ts` |
| Claim-time executor resolution in the stamped scope, and refusal, shared by both executors | `server/src/db/job-store-claim-executor.ts`, `driver/src/loop-run.ts` | `server/test-db/job-store.executor-scope.test.ts`, `driver/test/loop.test.ts` |
| The executor dialog's client-side validation | `web/src/workspace/executors.ts`, `web/src/panels/WorkspaceExecutorsPanel.tsx` | `web/test/executors.test.ts`, `web/test/executor-dialog.dom.test.tsx`, `e2e/org-executors.spec.ts` |
| The composer's repo readiness (`repoReadiness`) | `web/src/task-composer.ts` | `web/test/task-composer-logic.test.ts` |
| Real provisioning in a browser | `e2e/workspace.spec.ts` | the `chromium` Playwright project |

Mount shape and its boundary: [security.md](security.md). Task worktrees: [jobs.md](jobs.md).

## Invariants

- **The subtree is a member boundary, not a task boundary.** Every task of the
  same member shares that subtree and one uid 1000; the per-member `subPath`
  deliberately does not touch mount code beyond that segment. `driver/src/k8s-podspec.ts`, `driver/test/k8s.test.ts`.
- **The path segment is `app_user.id`, never the login.** `workspaceDir` asserts the uuid before
  joining; `driver/src/docker.ts` re-asserts `<org>/<uuid>` before putting it in an argv.
- **An existing checkout is never touched and nothing is pruned automatically** — `.git` present
  means skip. Clones land in `<name>.tmp-<pid>` and are renamed in; stale `.tmp-` trees are swept at
  boot. `server/test/workspace.reconcile.test.ts`.
- **The clone token reaches git through the child environment, never argv or `.git/config`**, after
  a leading empty `-c credential.helper=`. `server/test/workspace.reconcile.test.ts`.
- **A `cloning` or `purging` row is owned by a live in-process runner**: boot requeues or finishes
  interrupted rows before the queue starts or a route is served. `server/test/workspace.queue.test.ts`.
- **Every purge refusal is decided under the row's lock in one transaction** (`stampPurge`); the
  stamp is released only by an observed child exit. `server/test-db/user-repo-store.test.ts`.
- **`null` size means "not measured", never zero**; only the purge invalidates the facts cache.
  `server/src/workspace/facts.ts`.
- **The board reads member trees as hostile**: facts run only `rev-parse`/`cat-file` (no repo
  config execs), and facts and `.bellows.yaml` refuse anything that really lies outside the member's
  own tree. `server/test/workspace.facts.test.ts`, `server/test/bellows.test.ts`.
- **Stated limit:** a symlink raced into `.git/refs` between the facts check and git's read can point
  one read at a tree whose absolute path the agent knows (`CONTAINED_HEAD`).
- **A pasted executor config reaches the runner stripped of `RUNNER_MANAGED_KEYS`**
  (`core/src/executors.ts`, the constant the dialog warns by) and of `permission`.
  `server/src/db/job-store-claim-executor.ts`, `server/test-db/job-store.attribution.test.ts`.
- **`config` never rides the poll** — only `GET /api/workspace/executors` and the claim-time
  `configFor` select it. `server/test/routes.workspace.test.ts`.
- **A suspended profile launches nothing and is never a default**, but its stored preference is
  kept; submission answers `EXECUTOR_SUSPENDED` and the claim sends `executorRefusal`, failed by the
  shared loop before any runner starts — docker and kubernetes alike. `server/test/routes.executor-lifecycle.test.ts`.
- **A member's task launches only against a `ready` clone in their own selection**, revalidated at
  submission (`REPO_REQUIRED`, `REPO_NOT_READY`) for both executors. `server/test/routes.executor-lifecycle.test.ts`.
- **By-id writes carry their owner into the WHERE clause** (`deleteOwnedRow`, `setSuspendedRow`).
  `server/test-db/user-executor-store.test.ts`.
- **`node:24-alpine` ships no git**; `docker/Dockerfile` installs it, or every clone fails with
  ENOENT in the container only.
- **Stated limit:** unset `ORG_WORKSPACE_ROOT` clones nothing and `GET /api/workspace` answers `{root: null}`.
- **Stated limit:** the reconcile never fetches; the starting sync fast-forwards a clean, checked-out default branch
  only (`driver/src/scripts/git-worktree.cjs`).
- **Stated limit:** 20 repositories and 10 executor profiles per member; two clones at a time.
- **Stated limit:** the package cache is per member and repo, never shared across members, and never
  evicted; its size is the repo's `Package cache` reading, measured only where the path really
  lies inside the member tree (`sizeOf`, `server/test/workspace.facts.test.ts`), and the purge
  is deleting `<member>/.cache/<owner>/<repo>`. Concurrent tasks share it: npm's cache is safe for
  that, a tool whose cache is not (yarn classic) is the repo's risk. `driver/src/claim.ts`.
