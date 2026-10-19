# Security posture

What each credential grants, what each boundary actually holds, and where the controls live.

| Concern | Code | Test |
| --- | --- | --- |
| Which routes need a credential; the two postures | `server/src/auth/plugin.ts`, `server/src/config.ts` | `server/test/auth.enforcement.test.ts`, `server/test/config.auth.test.ts` |
| Bind address, CSP, `X-Content-Type-Options`, `Referrer-Policy` | `server/src/app.ts` | *(response headers are unpinned)* |
| Secret floors, App key resolution (`GITHUB_APP_PRIVATE_KEY_FILE`) | `server/src/config.ts` | `server/test/config.github.test.ts`, `server/test/config.auth.test.ts` |
| Webhook signature as the credential | `server/src/routes/webhook.ts` | `server/test/webhook.test.ts` |
| Installation token minted per attempt by the runner credential route, narrowed to the task's repo and `RUNNER_TOKEN_PERMISSIONS`; the route takes the attempt pair only and answers `no-store` ([connections.md](connections.md)) | `server/src/github/app-token.ts`, `server/src/routes/github-credential.ts` | `server/test/github.app-token.test.ts`, `server/test/routes.github-credential.test.ts` |
| Runner `git` and `gh` answer github.com through the image's helper, which asks the board and caches on memory-backed storage in the agent container only; no token in the runner env, a Secret or the git config; same on both executors | `docker/claude-executor/github-credential.cjs`, `entrypoint.sh`, `driver/src/docker.ts`, `driver/src/k8s-podspec.ts` | `driver/test/github-credential.test.ts`, `driver/test/executor-images.test.ts` |
| Runner secrets: write-only at the API, 0600 env file at the spawn; per-member mount (`subPath` / `volume-subpath`) | `server/src/routes/env.ts`, `driver/src/docker.ts`, `driver/src/k8s-podspec.ts` | `server/test/routes.env.test.ts`, `driver/test/docker.test.ts`, `driver/test/k8s.test.ts`, `scripts/test-k8s.sh --cluster` |
| The board's GitHub token for a sync, a publish or a github-writing helper is that supervised step's own `env`, delivered to the supervisor over its authenticated control channel and nowhere else: the agent container's env and spec hold no GitHub token and no route to the step channel (`/step`, `/report` answer 403 to its token), and the supervisor mounts no Secret of them; no `factory-{sync,publish,helper}-…-env` Secret exists | `driver/src/supervised-steps.ts`, `step-control.ts`, `control-channel.ts`, `k8s-podspec.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/supervised-steps.test.ts`, `driver/test/step-control.test.ts`, `driver/test/k8s-admission.test.ts` |
| The run-control channel's three per-attempt tokens open disjoint doors: the supervisor's `/control`, `/question`, `/step` and `/report`; the transcript exporter's `/export` alone; the agent's `/publish` and `/review`; any other route answers 403, and closing the attempt revokes all three; same on both executors | `driver/src/control-channel.ts`, `loop-gates.ts`, `transcript-export.ts`, `docker-group.ts`, `k8s-podspec.ts` | `driver/test/export-control.test.ts`, `driver/test/step-control.test.ts`, `driver/test/k8s.test.ts`, `driver/test/docker-group.test.ts` |
| Managed connections: the Jira credential stays on the board; the runner holds only the attempt pair | `server/src/routes/connector-jira.ts`, `server/src/db/connection-store.ts` | `server/test/routes.connector-jira.test.ts`, `server/test-db/connection-store.test.ts` |
| Container hardening, and the admission policy that requires it | `driver/src/k8s-podfields.ts`, `driver/src/services.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/services.test.ts`, `driver/test/k8s-docs.test.ts`, `driver/test/k8s-admission.test.ts` |
| A service's `user: "uid:gid"` (numeric, uid never 0) tightens, capabilities still dropped | `driver/src/k8s-auxspec.ts`, `driver/src/services.ts` | `driver/test/k8s.test.ts`, `driver/test/docker.test.ts` |
| The agent's commands run as uid 1001 in group 1000, through a root broker that keeps `CAP_SETUID`/`CAP_SETGID` for the run; the CLI and its helpers drop to uid 1000 with none, and a tool cannot signal them, open the broker's socket, the agent's mailbox directories or its config dir; `LD_*` and the glibc loader names are refused as member env; same on both executors | `docker/claude-executor/factory-launch.sh`, `factory-tool.cjs`, `tool-bash.sh`, `driver/src/docker.ts`, `driver/src/k8s-podfields.ts`, `core/src/env.ts` | `driver/test/tool-broker.test.ts`, `driver/test/executor-images.test.ts`, `docker/claude-executor/test.sh`, `docker/opencode-executor/test.sh`, `scripts/test-jobs.sh`, `scripts/test-k8s.sh --cluster` |
| A tool reaches `POST /publish` and `/review` through the CLI uid's proxy, which adds `BELLOWS_CONTROL_TOKEN`; no tool's env holds it | `docker/claude-executor/control-proxy.cjs`, `entrypoint.sh`, `docker/skills/github/SKILL.md`, `docker/skills/review/SKILL.md` | `driver/test/control-proxy.test.ts`, `driver/test/executor-images.test.ts` |
| Runner telemetry config, claude's managed settings (incl. the `permissions` allow-list and `autoMode` rules) and opencode's policy (global and `/etc/opencode` copies): root-owned, never written by the uid-1000 entrypoints | `driver/src/telemetry-config.ts`, `docker/claude-executor/managed-settings.json`, `docker/opencode-executor/Dockerfile` | `driver/test/telemetry-shipping.test.ts`, `driver/test/docker.test.ts`, `driver/test/k8s.test.ts`, `docker/claude-executor/test.sh`, `docker/opencode-executor/test.sh` |
| Artifact store credentials live in the dashboard only; reads are scoped to the caller's org | `server/src/artifacts/artifact-store.ts`, `server/src/artifacts/s3-credentials.ts` | `server/test-db/artifact-store.test.ts`, `server/test/artifacts.unit.test.ts` |

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
| No capabilities | `capabilities.drop: [ALL]` on every container | `--cap-drop ALL` on every container |
| No escalation | `allowPrivilegeEscalation: false` | `--security-opt no-new-privileges` |
| Seccomp | `seccompProfile: RuntimeDefault` | the daemon's default profile |
| Non-root | uid 1000, the image's `USER node` | uid 1000, the image's `USER node` |
| Agent launch, the `agent` container alone | `runAsUser: 0`, `capabilities.add: [SETUID, SETGID]`, admitted on a Job's `agent` only | `--user 0:0 --cap-add SETUID --cap-add SETGID` |

There is **no opt-out for a declared service or a GATE image**: a stock service image that needs root at boot
declares `user: "uid:gid"`. `server/src/workspace/bellows-services.ts`, `driver/test/k8s-admission.test.ts`.

## Stated limits

- **This is not kernel isolation and it is not VM isolation.** Every runner, gate, helper and service
  shares one host kernel; a kernel boundary means gVisor/Kata/Firecracker on a node group the chart does not provision.
- **The network controls are inert without an enforcing CNI** ([kubernetes.md](kubernetes.md)), and a
  NetworkPolicy cannot restrict HTTP routes — every endpoint a runner reaches authorizes the caller itself.
- **Membership is not a sandbox**: `github` mode narrows the board to any member ([auth.md](auth.md)).
- **No `readOnlyRootFilesystem`**: an agent run writes its caches, `HOME` and worktree.
- **The tool uid guards the CLI against its own commands' accidents, not against a hostile tool.** A tool
  still writes config the CLI later executes (`.git/config`, a project `.claude`, `.mcp.json`), sees the
  CLI's processes and command lines, kills other tools, and can exhaust memory, CPU or pids — which the
  pod limits govern. Hooks and MCP servers run as the CLI's uid; context-mode, whose shell runtime
  cannot run as the tool uid, is not baked.
- **The broker holds `CAP_SETUID`/`CAP_SETGID` as root for the run**, so Pod Security `restricted` cannot
  admit the agent container; `baseline` can.
- **The EFS access point maps both uids to 1000** ([eks-runbook.md](eks-runbook.md)): on EKS a tool
  reads the CLI's transcripts and the exporter's state.
- **The mount is a member boundary, never a task boundary** ([workspace.md](workspace.md)); the dashboard mounts the
  whole volume read-write as the provisioning and org-analysis plane.
