# Security posture

What each credential grants, what each boundary actually holds, and where the controls live.

| Concern | Code | Test |
| --- | --- | --- |
| Which routes need a credential; the two postures | `server/src/auth/plugin.ts`, `server/src/config.ts` | `server/test/auth.enforcement.test.ts`, `server/test/config.auth.test.ts` |
| Bind address, secret floors, App key resolution (`GITHUB_APP_PRIVATE_KEY_FILE`) | `server/src/config.ts`, `server/src/app.ts` | `server/test/config.github.test.ts`, `server/test/config.auth.test.ts` |
| Installation token minted per attempt, narrowed to the task's repo ([connections.md](connections.md)) | `server/src/github/app-token.ts`, `server/src/routes/github-credential.ts` | `server/test/github.app-token.test.ts`, `server/test/routes.github-credential.test.ts` |
| Runner `git`/`gh` helper: no token in the runner env, a Secret or the git config; same on both executors | `docker/claude-executor/github-credential.cjs`, `credential-broker.cjs`, `entrypoint.sh`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podspec.ts` | `driver/test/github-credential.test.ts`, `driver/test/executor-images.test.ts` |
| Driver-side `git` over the tool-writable checkout runs none of its execution-capable config (hooks, fsmonitor, filter/diff/merge drivers, ssh/askpass/gpg/credential helpers, editors, pagers, remote commands): every supervised step resolves `git` to a hardened wrapper, same supervisor on both executors | `driver/src/scripts/git-harden.cjs`, `driver/src/scripts/supervisor.cjs` (`gitShimOf`), `driver/src/supervisor-plan.ts` | `driver/test/git-harden.test.ts`, `driver/test/supervisor-plan-hardening.test.ts`, `driver/test/publish-hooks.test.ts` |
| Runner secrets: write-only at the API, 0600 env file at the spawn; per-member mount (`subPath` / `volume-subpath`) | `server/src/routes/env.ts`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podspec.ts` | `server/test/routes.env.test.ts`, `driver/test/docker/`, `driver/test/k8s/`, `scripts/test-k8s.sh --cluster` |
| A rebound holder's token reaches the supervisor alone: a Secret volume item on kubernetes, a supervisor-only volume written over `docker exec` stdin on docker; never argv, a log or the board | `driver/src/k8s/k8s-binding.ts`, `driver/src/docker/docker-group.ts`, `driver/src/scripts/binding-write.sh` | `driver/test/k8s/`, `driver/test/docker-group.test.ts`, `driver/test/scripts-binding-write.test.ts` |
| A supervised step's GitHub token is that step's own `env`, delivered over the authenticated control channel only; the agent container holds no token and no route to `/step`, `/report` | `driver/src/supervised-steps.ts`, `step-control.ts`, `control-channel.ts`, `k8s-podspec.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/supervised-steps.test.ts`, `driver/test/step-control.test.ts`, `driver/test/k8s-admission.test.ts` |
| The run-control channel's three per-attempt tokens open disjoint doors (supervisor, transcript exporter, agent), all held by the supervisor, which relays the agent's and the exporter's requests over sockets in their mailboxes (neither holds a token); any other route answers 403; same on both executors | `driver/src/control-channel.ts`, `loop-gates.ts`, `transcript-export.ts`, `docker-group.ts`, `k8s-podspec.ts`, `driver/src/scripts/supervisor.cjs` | `driver/test/export-control.test.ts`, `driver/test/step-control.test.ts`, `driver/test/k8s/`, `driver/test/docker-group.test.ts`, `driver/test/supervisor.test.ts` |
| Container hardening, and the admission policy that requires it | `driver/src/k8s/k8s-podfields.ts`, `driver/src/services.ts`, `charts/factory/templates/driver-admission.yaml` | `driver/test/services.test.ts`, `driver/test/k8s-docs.test.ts`, `driver/test/k8s-admission.test.ts` |
| Tool uid isolation: agent commands run as uid 1001 through a root broker holding `CAP_SETUID`/`CAP_SETGID`; the CLI drops to uid 1000; `LD_*` refused as member env; same on both executors | `docker/claude-executor/factory-launch.sh`, `factory-tool.cjs`, `tool-bash.sh`, `driver/src/docker/docker.ts`, `driver/src/k8s/k8s-podfields.ts`, `core/src/env.ts` | `driver/test/tool-broker.test.ts`, `driver/test/executor-images.test.ts`, `docker/claude-executor/test.sh`, `docker/opencode-executor/test.sh` |
| Skill helper scripts live at `/usr/local/share/factory-skills` (root-owned, world-readable), never in the private config dir the tool uid cannot traverse; both images, each `SKILL.md` names the fixed path | `docker/claude-executor/Dockerfile`, `docker/opencode-executor/Dockerfile`, `docker/skills/pr-land/SKILL.md` | `driver/test/skill-helper-paths.test.ts` |
| Cross-uid sharing contract (the CLI's config dir, credentials and mailboxes stay closed to the tool): the tool's `TMPDIR` `/tmp/factory-tmp` is swept to group access after every command (a file a background process writes later waits for the next sweep); the tool's own node compile cache; the tool's own `safe.directory = *` (the CLI's uid never trusts a repository the tool wrote: its `core.fsmonitor` would run as the CLI); baked skills are managed skills at one path; the same on kubernetes, where only the managed-settings file is mounted, never its directory | `docker/claude-executor/factory-tool.cjs`, `docker/claude-executor/Dockerfile`, `docker/claude-executor/entrypoint.sh`, `docker/opencode-executor/Dockerfile`, `driver/src/telemetry-config.ts` | `driver/test/tool-broker.test.ts`, `driver/test/executor-images.test.ts`, `driver/test/k8s/pod-spec.test.ts`, `driver/test/tool-seam-lane.test.ts`, the `tool-isolation` phase of `scripts/test-jobs.sh` |
| The agent's commit identity: `/etc/gitconfig` in both images (system scope, so both uids read it on either backend; a repository's, a member's or a `GIT_AUTHOR_*` identity wins), the same `factory-ai` identity the publisher and checkout sync fall back to | `docker/claude-executor/Dockerfile`, `docker/opencode-executor/Dockerfile`, `driver/src/publish/publish.ts` | `driver/test/executor-images.test.ts`, `driver/test/tool-seam-lane.test.ts`, `scripts/test-jobs.sh` (`tool-isolation`) |
| A tool reaches `POST /publish`, `POST /review`, `GET /review/<key>` and `GET /attempt` (the lease this attempt holds now; a 200 with a valid token or no answer) through the CLI uid's proxy; the proxy forwards to the supervisor's relay and no tool's env holds a run-control token | `docker/claude-executor/control-proxy.cjs`, `entrypoint.sh` | `driver/test/control-proxy.test.ts`, `driver/test/executor-images.test.ts` |
| The skills reach the gate server and the run-control socket through `factory-gate` and `factory-control`: fixed destinations, JSON built by an encoder, root-owned; the claude managed allowlist names exactly them, never a `curl` (its `*` would admit any URL) | `docker/claude-executor/factory-gate.cjs`, `docker/claude-executor/factory-control.cjs`, `docker/claude-executor/managed-settings.json` | `driver/test/factory-wrappers.test.ts`, `driver/test/executor-images.test.ts` |
| The claude runner runs in auto mode, pinned twice: `permissions.defaultMode` in managed settings and `--permission-mode auto` on the CLI (a resume otherwise restores its recorded mode); a session left in default mode has every unlisted command denied by the bridge | `docker/claude-executor/managed-settings.json`, `driver/src/telemetry-config.ts`, `driver/src/runner-plan.ts` | `driver/test/runner-plan.test.ts`, `driver/test/telemetry-shipping.test.ts` |
| Runner telemetry config, claude's managed settings and opencode's policy: root-owned, never written by the uid-1000 entrypoints | `driver/src/telemetry-config.ts`, `docker/claude-executor/managed-settings.json`, `docker/opencode-executor/Dockerfile` | `driver/test/telemetry-shipping.test.ts`, `docker/claude-executor/test.sh`, `docker/opencode-executor/test.sh` |
| Artifact store credentials live in the dashboard only; reads are scoped to the caller's org | `server/src/artifacts/artifact-store.ts`, `server/src/artifacts/s3-credentials.ts` | `server/test-db/artifact-store.test.ts`, `server/test/artifacts.unit.test.ts` |
| An upload's type comes from its bytes (signature, ZIP central directory, UTF-8), never from a declaration; SVG, HTML and macro documents are refused; downloads are sandboxed `attachment`s (`inline` for the three image types only), and a draft is readable by its uploader alone | `server/src/attachments/sniff.ts`, `server/src/routes/attachments.ts` | `server/test/attachments.sniff.test.ts`, `server/test/routes.attachments.test.ts` |
| Attachment text extraction runs in the runner with no board credentials (the child never sees the control bearer): `pdftotext` under a timeout and an output cap, a DOCX inflate under `maxOutputLength`, macro parts never opened, derived files 0444 in the sealed directory | `driver/src/scripts/attachment-extract.cjs`, `driver/src/scripts/attachment-fetch.cjs` | `driver/test/scripts-attachment-extract.test.ts`, `driver/test/scripts-attachment-fetch.test.ts` |
| Metrics scrapes: board `GET /api/metrics` takes the worker credential (a session is 401); driver `GET /metrics` takes `Bearer $JOB_BOARD_TOKEN`, and the driver refuses a port with no token off loopback | `server/src/auth/plugin.ts`, `driver/src/metrics-server.ts`, `driver/src/config.ts` | `server/test/routes.prometheus.test.ts`, `driver/test/metrics-server.test.ts`, `driver/test/config.test.ts` |
| Secret-store keys decrypt every stored credential, and the aws and vault backends' settings and workload identity reach their provider: dashboard process only (`secrets.env`, compose `env_file` on the dashboard, a `-secret-store` Secret and the provider env on the dashboard container alone, IRSA on the dashboard ServiceAccount, the Vault-audience projected token mounted into that container and never `wait-for-database`); the driver strips `SECRETS_*`. Docker development bind-mounts the tree, so the file is visible inside the driver container (a docker-only limit) | `docker-compose.yml`, `charts/factory/templates/deployment.yaml`, `driver/src/strip-secret-store-env.ts` | `server/test/secrets.environment.test.ts`, `driver/test/strip-secret-store-env.test.ts`, `scripts/test-k8s.sh` |

## Operational facts

- **`POST /api/jobs` queues a shell command an agent runs**; under `AUTH_MODE=none` the `127.0.0.1` bind is the
  only control. The driver mounts `/var/run/docker.sock` (root on the host); the dashboard never does.
- **The App private key mints installation tokens indefinitely**; `chmod 600` it and every `*_SECRET`/`*_TOKEN`.
- **Required App permissions: `Metadata: read`, `Contents: read`, `Actions: read`**; committing runners and
  `automerge` add `Contents: write`, `Pull requests: write`; batch PR observation adds `Checks: read`,
  `Commit statuses: read` and the `check_run`, `check_suite`, `status` events. `RUNNER_TOKEN_PERMISSIONS` beyond
  the grant is a 422, which `server/src/github/app-token.ts` reports naming each permission.
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
  run as the CLI's uid (the driver's own `git` runs no checkout config, above; a driver the TRUSTED config defines,
  git-lfs, still runs, and a config write landing inside one call is unseen); context-mode cannot run as the tool uid and is not baked.
- **Pod Security `restricted` cannot admit the agent container** (the broker holds `CAP_SETUID`/`CAP_SETGID`);
  `baseline` can. There is no `readOnlyRootFilesystem`.
- **A task volume is a thread boundary** ([workspace.md](workspace.md));
  **membership is not a sandbox** ([auth.md](auth.md)).
- **`attrs.series` is an unsalted one-way digest** (`server/src/telemetry/otlp.ts`): it covers raw values such as
  `user.email` and `organization.id`, so a dictionary guess of the other attributes can confirm a value.
