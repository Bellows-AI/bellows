# Security posture

What each credential grants, what each boundary actually holds, and where the controls live.

| Concern | Code | Test |
| --- | --- | --- |
| Route credentials and the two postures; bind address, secret floors, App key resolution | `server/src/auth/plugin.ts`, `server/src/config.ts`, `server/src/app.ts` | `server/test/auth.enforcement.test.ts`, `server/test/config.auth.test.ts`, `server/test/config.github.test.ts` |
| Installation token minted per attempt, narrowed to the task's repo ([connections.md](connections.md)) | `server/src/github/app-token.ts`, `server/src/routes/github-credential.ts` | `server/test/github.app-token.test.ts`, `server/test/routes.github-credential.test.ts` |
| Runner `git`/`gh` helper: no token in the runner env, a Secret or the git config | `docker/executor-common/github-credential.cjs`, `credential-broker.cjs`, `entrypoint.sh`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/github-credential.test.ts`, `driver/test/executor-images.test.ts` |
| Driver-side `git` over the tool-writable checkout runs none of its execution-capable config: every supervised step resolves `git` to a hardened wrapper; the publish probe hardens its own calls in-process with the same module (`runCall`), config re-read per call | `driver/src/scripts/git-harden.cjs`, `driver/src/scripts/supervisor.cjs` (`gitShimOf`), `driver/src/scripts/git-probe.cjs` (`runGit`), `driver/src/supervisor-plan.ts` | `driver/test/git-harden.test.ts`, `driver/test/supervisor-plan-hardening.test.ts`, `driver/test/publish-hooks.test.ts`, `driver/test/scripts-publish-probe.test.ts` |
| Outbound client-metadata fetch (CIMD) at authorize: https only (http loopback on a dev board), every resolved address checked against private/link-local/loopback/metadata/CGNAT ranges incl. IPv4-mapped IPv6, the connection pinned to the checked address, no redirect, 16 KiB cap, one 5 s deadline, concurrency and per-host caps | `server/src/oauth/cimd-fetch.ts` | `server/test/oauth.cimd-fetch.test.ts` |
| Runner secrets: write-only at the API, 0600 env file at the spawn | `server/src/routes/env.ts`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podspec.ts` | `server/test/routes.env.test.ts`, `driver/test/docker/`, `driver/test/k8s/`, `scripts/test-k8s.sh --cluster` |
| A rebound holder's token reaches the supervisor alone; never argv, a log or the board | `driver/src/k8s/k8s-binding.ts`, `driver/src/docker/docker-group.ts`, `driver/src/scripts/binding-write.sh` | `driver/test/k8s/`, `driver/test/docker-group.test.ts`, `driver/test/scripts-binding-write.test.ts` |
| A supervised step's GitHub token is that step's own `env`, over the authenticated control channel only | `driver/src/supervised-steps.ts`, `step-control.ts`, `control-channel.ts`, `k8s-podspec.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/supervised-steps.test.ts`, `driver/test/step-control.test.ts`, `driver/test/k8s-admission.test.ts` |
| The run-control channel's three per-attempt tokens open disjoint doors and are all held by the supervisor; any other route answers 403 | `driver/src/control-channel.ts`, `loop-gates.ts`, `transcript-export.ts`, `docker-group.ts`, `k8s-podspec.ts`, `driver/src/scripts/supervisor.cjs` | `driver/test/export-control.test.ts`, `driver/test/step-control.test.ts`, `driver/test/k8s/`, `driver/test/docker-group.test.ts`, `driver/test/supervisor.test.ts` |
| Container hardening and the admission policy that requires it | `driver/src/k8s/k8s-podfields.ts`, `driver/src/services.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/services.test.ts`, `driver/test/k8s-docs.test.ts`, `driver/test/k8s-admission.test.ts` |
| Tool uid isolation: agent commands run as uid 1001 through a root broker holding `CAP_SETUID`/`CAP_SETGID`; `LD_*` refused as member env | `docker/executor-common/factory-launch.sh`, `factory-tool.cjs`, `tool-bash.sh`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podfields.ts`, `core/src/env.ts` | `driver/test/tool-broker.test.ts`, `driver/test/executor-images.test.ts`, `docker/claude-executor/test.sh`, `docker/opencode-executor/test.sh` |
| Cross-uid sharing contract: the CLI's config dir, credentials and mailboxes stay closed to the tool; the CLI's uid never trusts a repository the tool wrote (`safe.directory`, `core.fsmonitor`); skill helpers live root-owned at one fixed path; telemetry config and managed settings are root-owned | `docker/executor-common/factory-tool.cjs`, `docker/claude-executor/Dockerfile`, `docker/opencode-executor/Dockerfile`, `driver/src/telemetry-config.ts`, `docker/claude-executor/managed-settings.json`, `docker/skills/factory-pr-land/SKILL.md` | `driver/test/tool-broker.test.ts`, `driver/test/skill-helper-paths.test.ts`, `driver/test/telemetry-shipping.test.ts`, `driver/test/tool-seam-lane.test.ts`, the `tool-isolation` phase of `scripts/test-jobs.sh` |
| A tool reaches publish, review and `GET /attempt` only through the CLI uid's proxy to the supervisor's relay; no tool's env holds a run-control token | `docker/executor-common/control-proxy.cjs`, `entrypoint.sh` | `driver/test/control-proxy.test.ts`, `driver/test/executor-images.test.ts` |
| The claude runner's auto mode is pinned twice: managed settings `permissions.defaultMode` and `--permission-mode auto` on the CLI | `docker/claude-executor/managed-settings.json`, `driver/src/telemetry-config.ts`, `driver/src/runner-plan.ts` | `driver/test/runner-plan.test.ts`, `driver/test/telemetry-shipping.test.ts` |
| Artifact store credentials live in the dashboard only (the gcs backend holds none: Workload Identity on the dashboard's ServiceAccount, `charts/factory/templates/dashboard-serviceaccount.yaml`). Attachments: an upload's type comes from its bytes (signature, ZIP central directory, UTF-8), never a declaration; SVG, HTML and macro documents are refused; downloads are sandboxed `attachment`s (`inline` for the three image types only); a draft is readable by its uploader alone. The sweep deletes only keys under `<prefix>_attachments/` that a row it moved to `deleting` names, never lists the store, re-deletes the keys of tombstones it finalized, and treats an unconfirmed read as no verdict. Text extraction runs in the runner with no board credentials (the child never sees the control bearer): `pdftotext` under a timeout and an output cap, a DOCX inflate under `maxOutputLength`, macro parts never opened, derived files 0444 in the sealed directory | `server/src/artifacts/artifact-store.ts`, `server/src/artifacts/s3-credentials.ts`, `server/src/attachments/sniff.ts`, `server/src/routes/attachments.ts`, `server/src/attachments/attachment-collector.ts`, `driver/src/scripts/attachment-extract.cjs`, `driver/src/scripts/attachment-fetch.cjs` | `server/test-db/artifact-store.test.ts`, `server/test/artifacts.unit.test.ts`, `server/test/attachments.sniff.test.ts`, `server/test/routes.attachments.test.ts`, `server/test-db/attachment-collector.test.ts`, `driver/test/scripts-attachment-extract.test.ts`, `driver/test/scripts-attachment-fetch.test.ts` |
| Metrics scrapes need the worker credential; the driver refuses a metrics port with no token off loopback | `server/src/auth/plugin.ts`, `driver/src/metrics-server.ts`, `driver/src/config.ts` | `server/test/routes.prometheus.test.ts`, `driver/test/metrics-server.test.ts`, `driver/test/config.test.ts` |
| Secret-store keys and provider identity reach the dashboard process alone; the driver strips `SECRETS_*` ([secrets.md](secrets.md)) | `docker-compose.yml`, `charts/factory/templates/deployment.yaml`, `driver/src/strip-secret-store-env.ts` | `server/test/secrets.environment.test.ts`, `driver/test/strip-secret-store-env.test.ts`, `scripts/test-k8s.sh` |

## Operational facts

- **`POST /api/jobs` queues a shell command an agent runs**; under `AUTH_MODE=none` the `127.0.0.1` bind is the
  only control. The driver mounts `/var/run/docker.sock` (root on the host); the dashboard never does.
- **The App private key mints installation tokens indefinitely**; `chmod 600` it and every secret.
- **Required App permissions: `Metadata: read`, `Contents: read`, `Actions: read`**; committing runners and
  `automerge` add `Contents: write`, `Pull requests: write`; batch PR observation adds `Checks: read`,
  `Commit statuses: read`. `RUNNER_TOKEN_PERMISSIONS` beyond the grant is a 422 (`server/src/github/app-token.ts`).
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

There is **no opt-out for a declared service or a GATE image**: one needing root at boot declares `user: "uid:gid"`
(numeric, uid never 0). `server/src/workspace/bellows-services.ts`, `driver/test/k8s-admission.test.ts`.

## Stated limits

- **This is not kernel isolation and it is not VM isolation.** Every runner, gate, helper and service
  shares one host kernel; a kernel boundary means gVisor/Kata/Firecracker on a node group the chart does not provision.
- **The network controls are inert without an enforcing CNI** ([kubernetes.md](kubernetes.md)), and a
  NetworkPolicy cannot restrict HTTP routes.
- **The tool uid guards the CLI against accidents, not a hostile tool**: it still writes config the CLI later
  executes (`.git/config`, `.claude`, `.mcp.json`) and can exhaust memory, CPU or pids; hooks and MCP servers
  run as the CLI's uid.
- **Pod Security `restricted` cannot admit the agent container** (`CAP_SETUID`/`CAP_SETGID`); `baseline` can.
- **A task volume is a thread boundary** ([workspace.md](workspace.md)); **membership is not a sandbox** ([auth.md](auth.md)).
- **`attrs.series` is an unsalted one-way digest** (`server/src/telemetry/otlp.ts`): a dictionary guess can confirm a value.
