# Security posture

What each credential grants, what each boundary actually holds, and where the controls live.

| Concern | Code | Test |
| --- | --- | --- |
| Which routes need a credential; the two postures | `server/src/auth/plugin.ts`, `server/src/config.ts` | `server/test/auth.enforcement.test.ts`, `server/test/config.auth.test.ts` |
| Bind address, secret floors, App key resolution (`GITHUB_APP_PRIVATE_KEY_FILE`) | `server/src/config.ts`, `server/src/app.ts` | `server/test/config.github.test.ts`, `server/test/config.auth.test.ts` |
| Installation token minted per attempt, narrowed to the task's repo ([connections.md](connections.md)) | `server/src/github/app-token.ts`, `server/src/routes/github-credential.ts` | `server/test/github.app-token.test.ts`, `server/test/routes.github-credential.test.ts` |
| Runner `git`/`gh` helper: no token in the runner env, a Secret or the git config; same on both executors | `docker/claude-executor/github-credential.cjs`, `entrypoint.sh`, `driver/src/docker.ts`, `driver/src/k8s-podspec.ts` | `driver/test/github-credential.test.ts`, `driver/test/executor-images.test.ts` |
| Runner secrets: write-only at the API, 0600 env file at the spawn; per-member mount (`subPath` / `volume-subpath`) | `server/src/routes/env.ts`, `driver/src/docker.ts`, `driver/src/k8s-podspec.ts` | `server/test/routes.env.test.ts`, `driver/test/docker.test.ts`, `driver/test/k8s.test.ts`, `scripts/test-k8s.sh --cluster` |
| A rebound holder's token reaches the supervisor alone: a Secret volume item on kubernetes, a supervisor-only volume written over `docker exec` stdin on docker; never argv, a log or the board | `driver/src/k8s-binding.ts`, `driver/src/docker-group.ts`, `driver/src/scripts/binding-write.sh` | `driver/test/k8s.test.ts`, `driver/test/docker-group.test.ts`, `driver/test/scripts-binding-write.test.ts` |
| A supervised step's GitHub token is that step's own `env`, delivered over the authenticated control channel only; the agent container holds no token and no route to `/step`, `/report` | `driver/src/supervised-steps.ts`, `step-control.ts`, `control-channel.ts`, `k8s-podspec.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/supervised-steps.test.ts`, `driver/test/step-control.test.ts`, `driver/test/k8s-admission.test.ts` |
| The run-control channel's three per-attempt tokens open disjoint doors (supervisor, transcript exporter, agent), all held by the supervisor, which relays the agent's and the exporter's requests over sockets in their mailboxes (neither holds a token); any other route answers 403; same on both executors | `driver/src/control-channel.ts`, `loop-gates.ts`, `transcript-export.ts`, `docker-group.ts`, `k8s-podspec.ts`, `driver/src/scripts/supervisor.cjs` | `driver/test/export-control.test.ts`, `driver/test/step-control.test.ts`, `driver/test/k8s.test.ts`, `driver/test/docker-group.test.ts`, `driver/test/supervisor.test.ts` |
| Container hardening, and the admission policy that requires it | `driver/src/k8s-podfields.ts`, `driver/src/services.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/services.test.ts`, `driver/test/k8s-docs.test.ts`, `driver/test/k8s-admission.test.ts` |
| Tool uid isolation: agent commands run as uid 1001 through a root broker holding `CAP_SETUID`/`CAP_SETGID`; the CLI drops to uid 1000; `LD_*` refused as member env; same on both executors | `docker/claude-executor/factory-launch.sh`, `factory-tool.cjs`, `tool-bash.sh`, `driver/src/docker.ts`, `driver/src/k8s-podfields.ts`, `core/src/env.ts` | `driver/test/tool-broker.test.ts`, `driver/test/executor-images.test.ts`, `docker/claude-executor/test.sh`, `docker/opencode-executor/test.sh` |
| A tool reaches `POST /publish` and `/review` through the CLI uid's proxy; the proxy forwards to the supervisor's relay and no tool's env holds a run-control token | `docker/claude-executor/control-proxy.cjs`, `entrypoint.sh` | `driver/test/control-proxy.test.ts`, `driver/test/executor-images.test.ts` |
| Runner telemetry config, claude's managed settings and opencode's policy: root-owned, never written by the uid-1000 entrypoints | `driver/src/telemetry-config.ts`, `docker/claude-executor/managed-settings.json`, `docker/opencode-executor/Dockerfile` | `driver/test/telemetry-shipping.test.ts`, `docker/claude-executor/test.sh`, `docker/opencode-executor/test.sh` |
| Artifact store credentials live in the dashboard only; reads are scoped to the caller's org | `server/src/artifacts/artifact-store.ts`, `server/src/artifacts/s3-credentials.ts` | `server/test-db/artifact-store.test.ts`, `server/test/artifacts.unit.test.ts` |
| Metrics scrapes: board `GET /api/metrics` takes the worker credential (a session is 401); driver `GET /metrics` takes `Bearer $JOB_BOARD_TOKEN`, and the driver refuses a port with no token off loopback | `server/src/auth/plugin.ts`, `driver/src/metrics-server.ts`, `driver/src/config.ts` | `server/test/routes.prometheus.test.ts`, `driver/test/metrics-server.test.ts`, `driver/test/config.test.ts` |

## Operational facts

- **`POST /api/jobs` queues a shell command an agent runs**; under `AUTH_MODE=none` the `127.0.0.1` bind is the
  only control. The driver mounts `/var/run/docker.sock` (root on the host); the dashboard never does.
- **The App private key mints installation tokens indefinitely**; `chmod 600` it and every `*_SECRET`/`*_TOKEN`.
- **Required App permissions: `Metadata: read`, `Contents: read`**; committing runners and `automerge` add
  `Contents: write`, `Pull requests: write`; batch PR observation adds `Actions: read`, `Checks: read`,
  `Commit statuses: read` and the `check_run`, `check_suite`, `status` events. `RUNNER_TOKEN_PERMISSIONS` beyond
  the grant is a 422.
- **Keep `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS` at `0`**; the collector
  binds 4317/4318 to `127.0.0.1`, open unless `auth.ingest_token`.

## Container hardening

On kubernetes every control is **required by admission** (`charts/factory/templates/driver-admission.yaml`).

| Control | Kubernetes | Docker |
| --- | --- | --- |
| No capabilities | `capabilities.drop: [ALL]` on every container | `--cap-drop ALL` on every container |
| No escalation | `allowPrivilegeEscalation: false` | `--security-opt no-new-privileges` |
| Seccomp | `seccompProfile: RuntimeDefault` | the daemon's default profile |
| Agent launch, the `agent` container alone | `runAsUser: 0`, `capabilities.add: [SETUID, SETGID]`, admitted on a Job's `agent` only | `--user 0:0 --cap-add SETUID --cap-add SETGID` |

There is **no opt-out for a declared service or a GATE image**: one needing root at boot declares
`user: "uid:gid"` (numeric, uid never 0). `server/src/workspace/bellows-services.ts`,
`driver/test/k8s-admission.test.ts`.

## Stated limits

- **This is not kernel isolation and it is not VM isolation.** Every runner, gate, helper and service
  shares one host kernel; a kernel boundary means gVisor/Kata/Firecracker on a node group the chart does not provision.
- **The network controls are inert without an enforcing CNI** ([kubernetes.md](kubernetes.md)), and a
  NetworkPolicy cannot restrict HTTP routes.
- **The tool uid guards the CLI against accidents, not a hostile tool**: it still writes config the CLI later
  executes (`.git/config`, `.claude`, `.mcp.json`) and can exhaust memory, CPU or pids. Hooks and MCP servers
  run as the CLI's uid; context-mode cannot run as the tool uid and is not baked.
- **Pod Security `restricted` cannot admit the agent container** (the broker holds `CAP_SETUID`/`CAP_SETGID`);
  `baseline` can. There is no `readOnlyRootFilesystem`.
- **The EFS access point maps both uids to 1000** ([eks-runbook.md](eks-runbook.md)); **the mount is a member
  boundary, never a task boundary** ([workspace.md](workspace.md));
  **membership is not a sandbox** ([auth.md](auth.md)).
