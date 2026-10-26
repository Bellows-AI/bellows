# Workspace

Executor profiles, `.bellows.yaml` plans and per-thread task volumes. The board keeps no checkout.

| Concern | Code | Test |
| --- | --- | --- |
| Per-repo package cache: `environment.cache` names pointed at `/task/.cache/<owner>/<repo>/<NAME>` on the thread's task volume (`repoCacheEnv`), and its size on the payload | `driver/src/claim.ts`, `server/src/workspace/bellows-cache.ts`, `server/src/routes/workspace.ts` | `driver/test/runner-plan.test.ts`, `server/test/bellows.test.ts`, `server/test/routes.workspace.test.ts` |
| Deletion of a task volume: only the reaper, every generation of a thread together, when no job of the thread is live and its last attempt finalized, `TASK_VOLUME_TTL_MS` ago when its artifacts are terminal and its checkpoint complete, `TASK_VOLUME_BOUND_MS` ago (never sooner than the ttl) when a checkpoint is truncated or absent or an artifact is pending; unknown facts keep it, a root the board no longer holds (a removed task) goes once every volume is `TASK_VOLUME_TTL_MS` old, only a volume stamped with this driver's board identity (`factory.task-board`, a digest of `JOB_BOARD_URL`, so boards sharing a daemon or namespace need distinct URLs) is ever listed, so another board's volumes are never reaped on a root this board does not hold, and the facts are re-read right before each delete; a thread that is not whole (artifacts pending or checkpoint not complete) is exported first by a one-shot exporter over its newest volume, and only the relay's proof of a drain (never an exit code) licenses the delete, or `TASK_VOLUME_EXPORT_ATTEMPTS` failed tries (default 3, counted in memory, newest generation only; a held export workload that is stale but unreadable or unremovable counts as a failed try, a live one is `contended` and uncounted; a 409 on a chunk that is not a prefix of the held bytes ends the stream `LOST`; the exporter mounts the volume itself, so a ReadWriteOnce claim still mounted by a live pod on another node stalls it) delete it with a `LOST` log | `driver/src/reaper.ts` (`volumeDecision`), `driver/src/reaper-export.ts`, `driver/src/loop/loop-export.ts` (`createVolumeExportOpener`), `driver/src/docker/docker-volume-export.ts`, `driver/src/k8s/k8s-volume-export.ts`, `server/src/db/jobs/job-store-reads.ts` (`leasesOf`) | `driver/test/reaper.test.ts`, `driver/test/reaper-export.test.ts`, `driver/test/docker-reaper-export.test.ts`, `driver/test/k8s-reaper-export.test.ts`, `driver/test/k8s-read-faults.test.ts`, `driver/test/docker-read-faults.test.ts`, `server/test-db/job-store.thread-facts.test.ts` |
| Restore of a lost task volume: a continuing claim with no volume gets generation n+1, rebuilt from the board's checkpoint by a supervised `restore` step, the older generation deleted only after it reports ok; none, gone, truncated or corrupt (the board answers 422) fails `checkpoint_unrestorable`, except that a kubernetes volume labelled unschedulable is adopted again; the same step rebuilds the thread's Claude session files byte for byte from the raw transcript streams (`/checkpoint/transcripts*` on the control channel, sha256 and length checked) and installs the OpenCode snapshot by temp file and rename | `driver/src/task-restore.ts`, `driver/src/scripts/checkpoint-restore.cjs`, `driver/src/docker/docker-task-volume.ts`, `driver/src/k8s/k8s-task-volume.ts` | `driver/test/task-restore.test.ts`, `driver/test/k8s-task-volume.test.ts`, `driver/test/k8s-restore.test.ts`, `driver/test/scripts-checkpoint-restore.test.ts`, `driver/test/docker-task-volume.test.ts` |
| Routes and the page's payload | `server/src/routes/workspace.ts` | `server/test/routes.workspace.test.ts` |
| Executor profiles: user and org scope, suspend and remove, refusal at submission (`UNKNOWN_EXECUTOR` / `EXECUTOR_SUSPENDED`, one check for `POST /api/jobs` and a batch launch) | `server/src/db/user-executor-store.ts`, `server/src/routes/org-executors.ts`, `server/src/routes/jobs/executor-usable.ts`, `server/src/routes/jobs/job-handlers-worker.ts`, `server/src/routes/batches/batch-launch.ts`, `server/migrations/047_executor_profile_scope.sql`, `server/migrations/049_executor_profile_suspended.sql` | `server/test-db/user-executor-store.test.ts`, `server/test/routes.org-executors.test.ts`, `server/test/routes.executor-lifecycle.test.ts` |
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
  run under the credential helper. The tool uid holds no token (#814), so on a private repository a command that needs a
  blob the checkout did not (history before the base) cannot lazily fetch it — a stated limit.
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
- **Restore leaves every uncommitted change unstaged**: the tree is rebuilt at the checkpoint's tip and the index reset, so
  a change that was staged comes back as a working-tree change. `driver/src/scripts/checkpoint-restore.cjs`,
  `driver/test/scripts-checkpoint-restore.test.ts`.
- **A subagent transcript is restored as a session file of its own**: the stream identity carries the file's name and not
  its parent session, so `<session>/subagents/<name>.jsonl` comes back beside the sessions. A resumed session's streams
  keep the exporter's byte offsets and must run on without a gap. `driver/src/scripts/checkpoint-restore.cjs`,
  `driver/test/scripts-checkpoint-restore.test.ts`.
- **Stated limit: a task volume can still be reaped in one narrow window, and a docker race can leave one empty
  volume behind.** The reaper re-reads a thread's facts immediately before each delete, and every docker container
  that mounts the volume after `ensureTaskVolume` is created only once `taskVolumeIsOurs` holds (a gone volume is a
  transient startup refusal, an interruption), but a claim that lands between that last re-read and the `volume rm`
  still finds its volume gone at the next check, never recreated empty (on kubernetes a pod naming a missing claim
  stays Pending). If the `rm` lands after that check and before the mount, the mount auto-creates an EMPTY
  unlabelled `factory-task-<root>-N`: the guard refuses it, the next claim counts that name's generation as taken
  (`listTaskVolumes` also lists by name prefix) and a create is checked to be labelled ours afterwards (`docker
  volume create` of an existing name answers ok and labels nothing), but the leftover carries no board identity, so
  no reaper deletes it: one empty volume leaks per such race, removed by hand. `driver/test/docker-task-volume.test.ts`,
  `driver/test/reaper.test.ts`, `driver/test/docker-group.test.ts`.
