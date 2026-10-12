# Security posture

What each credential grants, what each boundary actually holds, and where the controls live.

| Concern | Code | Test |
| --- | --- | --- |
| Which routes need a credential; the two postures | `server/src/auth/plugin.ts`, `server/src/config.ts` | `server/test/auth.enforcement.test.ts`, `server/test/config.auth.test.ts` |
| Bind address, CSP, `X-Content-Type-Options`, `Referrer-Policy` | `server/src/app.ts` | *(response headers are unpinned)* |
| Secret floors, App key resolution (`GITHUB_APP_PRIVATE_KEY_FILE`) | `server/src/config.ts` | `server/test/config.github.test.ts`, `server/test/config.auth.test.ts` |
| Webhook signature as the credential | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Installation token minted onto a claim, narrowed to the task's repo and `RUNNER_TOKEN_PERMISSIONS` | `server/src/github/app-token.ts` | `server/test/github.app-token.test.ts` |
| Runner `git` over https answers github.com from the env's `GITHUB_TOKEN` at call time, never stored in the git config; same entrypoint on both executors | `docker/claude-executor/entrypoint.sh`, `docker/opencode-executor/entrypoint.sh` | `driver/test/executor-images.test.ts` |
| Runner secrets: write-only at the API, 0600 env file at the spawn; per-member mount (`subPath` / `volume-subpath`) | `server/src/routes/env.ts`, `driver/src/docker.ts`, `driver/src/k8s-podspec.ts` | `server/test/routes.env.test.ts`, `driver/test/docker.test.ts`, `driver/test/k8s.test.ts`, `scripts/test-k8s.sh --cluster` |
| Managed connections: the Jira credential stays on the board; the runner holds only the attempt pair | `server/src/routes/connector-jira.ts`, `server/src/db/connection-store.ts` | `server/test/routes.connector-jira.test.ts`, `server/test-db/connection-store.test.ts` |
| Container hardening, and the admission policy that requires it | `driver/src/k8s-podfields.ts`, `driver/src/services.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/services.test.ts`, `driver/test/k8s-docs.test.ts`, `driver/test/k8s-admission.test.ts` |
| A service's `user: "uid:gid"` (numeric, uid never 0) tightens, capabilities still dropped | `driver/src/k8s-auxspec.ts`, `driver/src/services.ts` | `driver/test/k8s.test.ts`, `driver/test/docker.test.ts` |
| Runner telemetry config, claude's managed settings (incl. `autoMode` rules) and opencode's policy (global and `/etc/opencode` copies): root-owned, never written by the uid-1000 entrypoints | `driver/src/telemetry-config.ts`, `docker/claude-executor/managed-settings.json`, `docker/opencode-executor/Dockerfile` | `driver/test/telemetry-shipping.test.ts`, `driver/test/docker.test.ts`, `driver/test/k8s.test.ts`, `docker/claude-executor/test.sh`, `docker/opencode-executor/test.sh` |
| Run artifacts built from the runner's own stream, never a claim env value | `driver/src/artifacts.ts` | `driver/test/artifacts.test.ts`, `driver/test/docker.test.ts` |

Credentials: [auth.md](auth.md) · cluster: [kubernetes.md](kubernetes.md) · mount: [workspace.md](workspace.md).

## Operational facts

- **`POST /api/jobs` queues a shell command an agent runs.** Under `AUTH_MODE=none` the `127.0.0.1` bind is the
  only control. The driver mounts `/var/run/docker.sock`, root on the host; the dashboard never gets it.
- **The App private key mints installation tokens indefinitely and cannot be revoked from a list.** `chmod 600`
  it (a mode-600 host file bind-mounted into a `node` container is the usual unreadable-key fatal); same care for
  `GITHUB_OAUTH_CLIENT_SECRET`, `SESSION_SECRET`, `INGEST_TOKEN`, `GITHUB_WEBHOOK_SECRET`, `JOB_BOARD_TOKEN`.
- **Required App installation permissions: `Metadata: read`, `Contents: read`**; committing runners need
  `Contents: write`, `Pull requests: write`, `Actions: read`, and `RUNNER_TOKEN_PERMISSIONS` beyond the grant is a 422.
  Batch PR observation also reads `Checks: read` and `Commit statuses: read`, and subscribes to `check_run`,
  `check_suite` and `status`; without them a PR's checks read as missing or unknown, never as passing.
  An `automerge` batch stage merges through the same installation, so the App also needs `Pull requests: write`
  and `Contents: write` on the target; without them GitHub refuses and the task is parked, never merged around.
- **Keep `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS` at `0`**: that content
  arrives as the log record *body*. The collector binds 4317/4318 to `127.0.0.1`, open unless `auth.ingest_token`.
- Runner env values are plaintext at rest ([env.md](env.md)).

## Container hardening

Set by `driver/src/k8s-podfields.ts` and `driver/src/docker.ts`; on kubernetes **required by admission**
(`charts/factory/templates/driver-admission.yaml`), so a pod missing one is rejected.

| Control | Kubernetes | Docker |
| --- | --- | --- |
| No capabilities | `capabilities.drop: [ALL]` unless `unhardened: true` | `--cap-drop ALL` unless `unhardened: true` |
| No escalation | `allowPrivilegeEscalation: false` | `--security-opt no-new-privileges` |
| Seccomp | `seccompProfile: RuntimeDefault` | the daemon's default profile |
| Non-root | `runAsNonRoot`, uid 1000 | `--user 1000` |

`unhardened: true` on a declared `.bellows.yaml` service restores the image's default capability set (`CAP_NET_RAW`
included) and nothing else — the **escalation bit stays off**, seccomp stays on, the uid is unchanged. There is
**no opt-out for a GATE image**. `driver/src/services.ts`, `driver/test/services.test.ts`.

## Stated limits

- **This is not kernel isolation and it is not VM isolation.** Every runner, gate, helper and service
  shares one host kernel; a kernel boundary means gVisor/Kata/Firecracker on a node group the chart does not provision.
- **The network controls are inert without an enforcing CNI** ([kubernetes.md](kubernetes.md)), and a
  NetworkPolicy cannot restrict HTTP routes — every endpoint a runner reaches authorizes the caller itself.
- **Membership is not a sandbox**: `github` mode narrows the board to any member ([auth.md](auth.md)).
- **No `readOnlyRootFilesystem`**: an agent run writes its caches, `HOME` and worktree.
- **The mount is a member boundary, never a task boundary** ([workspace.md](workspace.md)); the dashboard mounts the
  whole volume read-write as the provisioning and org-analysis plane.
