# Workspace

Executor profiles, `.bellows.yaml` plans and per-thread task volumes. The board keeps no checkout.

| Concern | Code | Test |
| --- | --- | --- |
| Per-repo package cache: `environment.cache` names pointed at `/task/.cache/<owner>/<repo>/<NAME>` on the thread's task volume (`repoCacheEnv`), and its size on the payload; task inputs at `/task/.factory/attachments/<root>/<id><ext>` plus `manifest.json`, outside the checkout (never staged by a publish), rewritten by the `inputs` step of every claim that gets a group, whatever the generation | `driver/src/claim.ts`, `server/src/workspace/bellows-cache.ts`, `server/src/routes/workspace.ts`, `driver/src/task-volume.ts` (`attachmentsDir`), `driver/src/task-inputs.ts` | `driver/test/runner-plan.test.ts`, `server/test/bellows.test.ts`, `server/test/routes.workspace.test.ts`, `driver/test/docker/reads-and-volume.test.ts`, `driver/test/publish-checkout.test.ts` |
| Deletion of a task volume: only the reaper, a whole thread's generations together, when no job is live and the last attempt finalized; `TASK_VOLUME_TTL_MS` when artifacts are terminal and the checkpoint complete, `TASK_VOLUME_BOUND_MS` otherwise; unknown facts keep it; only a volume stamped with this driver's board identity (`factory.task-board`, a digest of `JOB_BOARD_URL`) is listed; a thread that is not whole is exported first, and only the relay's proof of a drain or `TASK_VOLUME_EXPORT_ATTEMPTS` failed tries spread over `EXPORT_GIVE_UP_MIN_SPAN_MS` (15 min) license the delete | `driver/src/reaper.ts` (`volumeDecision`), `driver/src/reaper-export.ts`, `driver/src/loop/loop-export.ts` (`createVolumeExportOpener`), `driver/src/docker/docker-volume-export.ts`, `driver/src/k8s/k8s-volume-export.ts`, `server/src/db/jobs/job-store-reads.ts` (`leasesOf`) | `driver/test/reaper.test.ts`, `driver/test/reaper-export.test.ts`, `driver/test/docker-reaper-export.test.ts`, `driver/test/k8s-reaper-export.test.ts`, `driver/test/k8s-read-faults.test.ts`, `driver/test/docker-read-faults.test.ts`, `server/test-db/job-store.thread-facts.test.ts` |
| Restore of a lost task volume: a continuing claim with no volume gets generation n+1, rebuilt from the board's checkpoint (and the raw Claude transcript streams, OpenCode snapshot) by a supervised `restore` step (an OpenCode snapshot installed by temp file and rename), the older generation deleted only after it reports ok; a step that times out or answers anything but a verdict is unconfirmed and hands the claim back, never refusing; none, gone, truncated or corrupt (422) fails `checkpoint_unrestorable`, except a kubernetes volume labelled unschedulable is adopted again | `driver/src/task-restore.ts`, `driver/src/scripts/checkpoint-restore.cjs`, `driver/src/docker/docker-task-volume.ts`, `driver/src/k8s/k8s-task-volume.ts` | `driver/test/task-restore.test.ts`, `driver/test/k8s-task-volume.test.ts`, `driver/test/k8s-restore.test.ts`, `driver/test/scripts-checkpoint-restore.test.ts`, `driver/test/docker-task-volume.test.ts` |
| Routes and the page's payload | `server/src/routes/workspace.ts` | `server/test/routes.workspace.test.ts` |
| Executor profiles: user and org scope, suspend and remove, refusal at submission (`UNKNOWN_EXECUTOR` / `EXECUTOR_SUSPENDED`, one check for `POST /api/jobs` and a batch launch); a selection naming none takes the caller's resolved default, or `NO_EXECUTOR` | `server/src/db/user-executor-store.ts`, `server/src/routes/org-executors.ts`, `server/src/routes/jobs/executor-usable.ts`, `server/src/routes/jobs/job-handlers-worker.ts`, `server/src/routes/batches/batch-launch.ts`, `server/migrations/047_executor_profile_scope.sql`, `server/migrations/049_executor_profile_suspended.sql` | `server/test-db/user-executor-store.test.ts`, `server/test/routes.org-executors.test.ts`, `server/test/routes.executor-lifecycle.test.ts` |
| Claim-time executor resolution in the stamped scope, shared by both executors | `server/src/db/jobs/job-store-claim-executor.ts`, `driver/src/loop/loop-run.ts` | `server/test-db/job-store.executor-scope.test.ts`, `driver/test/loop/` |
| The executor dialog's client-side validation | `web/src/workspace/executors.ts`, `web/src/panels/WorkspaceExecutorsPanel.tsx` | `web/test/executors.test.ts`, `web/test/executor-dialog.dom.test.tsx`, `e2e/org-executors.spec.ts` |
| The Workspace and Repositories pages in a browser | `e2e/workspace.spec.ts` | the `chromium` Playwright project |

## Invariants

- **A runner never mounts the member subtree.** Each root thread has its own task volume
  (`factory-task-<root uuid>-<generation>`) at `/task`, so tasks of different threads share nothing and a thread's
  follow-ups share the one checkout. `driver/src/task-volume.ts`,
  `driver/test/k8s/`, `driver/test/docker-task-volume.test.ts`.
- **The task tree is built whole or not at all, and the agent cannot fetch history.** `task-checkout.cjs` clones
  partially (`--filter=blob:none`) into a build directory beside the path and renames it in; its checkout and rebase
  run under the credential helper. The tool uid holds no token, so on a private repository a command that needs a blob
  the checkout did not (history before the base) cannot lazily fetch it — a stated limit.
  `driver/test/scripts-task-checkout-atomic.test.ts`.
- **By-id writes carry their owner into the WHERE clause** (`deleteOwnedRow`, `setSuspendedRow`).
  `server/test-db/user-executor-store.test.ts`.
- **The board never opens a `.bellows.yaml` from a tree**: the plan comes through the GitHub API or, offline, over git
  from `REPO_CLONE_BASE` (`server/src/workspace/bellows-plan.ts`, `server/src/github/local-origin-plan.ts`).
  `server/test/bellows.plan.test.ts`, `server/test/local-origin-plan.test.ts`.
- **A pasted executor config reaches the runner stripped of `RUNNER_MANAGED_KEYS`**
  (`core/src/executors.ts`, the constant the dialog warns by) and of `permission`.
  `server/src/db/jobs/job-store-claim-executor.ts`, `server/test-db/job-store.attribution.test.ts`.
- **`config` never rides the poll**, only `GET /api/workspace/executors` and `configFor`.
  `server/test/routes.workspace.test.ts`.
- **A suspended profile launches nothing and is never a default**: submission answers `EXECUTOR_SUSPENDED` (a name its
  scope does not hold answers `UNKNOWN_EXECUTOR`; follow-up and retry inherit the parent's executor and are left to the claim), the claim
  sends `executorRefusal`. `server/test/routes.executor-lifecycle.test.ts`.
- **Stated limits:** the runner clones its own checkout from the repository (`driver/src/scripts/task-checkout.cjs`);
  10 executor profiles per member.
- **The attempt checkpoint carries no submodule or nested repository** (a gitlink is committed as a pointer, never its
  contents), and its cap is 256 MiB. `driver/src/scripts/checkpoint.cjs`, `driver/test/scripts-checkpoint.test.ts`.
- **The package cache is per thread and repo, on the task volume, never shared and never evicted.**
  `driver/src/claim.ts`, `driver/test/runner-plan.test.ts`.
- **A repository-free continuing Claude claim on a lost volume is not unrestorable**: with the checkpoint confirmed `none` it gets
  the next generation and a sessions-only `restore` step (no `CHECKOUT`, no tree; a session file already there is kept). A repository-free OpenCode thread checkpoints its session database at finalize (`tip: null`, no bundle) and gets it back on the next generation; an adopted generation keeps a database already there and refuses `checkpoint_unrestorable` only once the step confirms it absent with no complete checkpoint. `driver/src/scripts/checkpoint.cjs`,
  `driver/test/task-restore-opencode.test.ts`, `driver/test/scripts-checkpoint-treeless.test.ts`.
- **Restore leaves every uncommitted change unstaged**: the index is reset at the checkpoint's tip, so a staged change
  comes back as a working-tree change. A subagent transcript is restored as a session file of its own
  (`<session>/subagents/<name>.jsonl`), and a resumed session's streams run on without a gap.
  `driver/src/scripts/checkpoint-restore.cjs`, `driver/test/scripts-checkpoint-restore.test.ts`.
- **Stated limit: a task volume can still be reaped in one narrow window, and a docker race can leave one empty volume
  behind.** A claim landing between the reaper's last re-read and the `volume rm` finds its volume gone (a transient
  refusal; on kubernetes the pod stays Pending). If the `rm` lands before the mount, docker auto-creates an empty
  unlabelled `factory-task-<root>-N`: the guard refuses it and the next claim counts its generation as taken, but it
  carries no board identity, so no reaper deletes it; remove it by hand.
  `driver/test/docker-task-volume.test.ts`, `driver/test/reaper.test.ts`, `driver/test/docker-group.test.ts`.
