# Bellows

**Standardize and monitor your agentic coding workflows across the organization.**

Bellows runs your coding agent somewhere else. The same task you would type into a terminal —
Claude Code or OpenCode, your repository, your test commands — runs on a cluster instead, against
your own checkout, under a process the organization defines rather than whatever each developer
pasted into a prompt.

- **One definition of how work gets done.** A workflow is a graph the board walks —
  implement → review → fix → publish — identically for every task and every member.
- **The same environment for everyone.** `.bellows.yaml` in the repository declares the gates and
  service containers, so a task runs the organization's checks, not the ones a laptop happens to have.
- **One dashboard for the whole organization.** Delivery measured from the agents' own telemetry,
  org-wide by default and narrowable to one member, beside every task's thread, logs and spend.
- **Organization-scoped by construction.** An organization is a GitHub App installation; it
  partitions every stored row, and membership is re-checked per request.
- **Vendor-agnostic.** Claude Code and OpenCode each run as a first-class executor, chosen per task
  and carrying your own settings, plugins and permissions.
- **Close the laptop.** Tasks keep running; `DRIVER_CONCURRENCY` and cluster size set how many go
  at once, not your CPU.

| Surface | What it is | Docs |
| --- | --- | --- |
| Tasks | A prompt plus a repo, run by the executor profile it names (`claude-code` or `opencode`). | [jobs](docs/jobs.md) |
| Workflows | A graph of agent nodes the board walks between verdicts, instead of a prompt. | [workflows](docs/workflows.md) |
| `.bellows.yaml` | A repository's own gates and service containers; grammar, errors and limits. | [jobs](docs/jobs.md) |
| Workspaces | Per-member checkouts at `/workspaces/<org>/<user>/<repo>`. | [workspace](docs/workspace.md) |
| Stats | Delivery measured from agent telemetry: sessions, tokens, lines, active time, coverage. | [metrics](docs/metrics.md) |

## Quickstart

Needs PostgreSQL and a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`); either missing
refuses to boot.

```bash
npm install
docker compose up -d postgres
cp .env.example .env          # set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY
npm run dev                   # API on 127.0.0.1:8080, Vite on 5173 with /api proxied
```

No credential? Seed a disposable database and browse it offline:

```bash
docker compose exec postgres psql -U factory -d postgres -c 'create database factory_seed'
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed
npm run verify:ui
```

`docker compose up` runs the same `npm run dev` against the bind-mounted tree, plus the database,
the S3 store, the collector and the driver. `docker build -f docker/Dockerfile --target runtime -t factory-ai .`
is what deploys.

## Running tasks

```bash
make runners                 # build the executor images
docker compose up -d driver  # development: containers on the local docker socket
npm run dev -w cli -- job create "fix the flaky test" --repo owner/name
npm run dev -w cli -- job list --limit 5
```

`EXECUTOR=kubernetes` makes each task a pod; `charts/factory/` is what deploys
([kubernetes](docs/kubernetes.md), [EKS runbook](docs/eks-runbook.md)). The driver mounts the
docker socket, which is root on the host — read [security](docs/security.md) before running it
anywhere shared.

## Configuration

Everything lives in `.env`; the full list is `.env.example`, what each setting decides is
[configuration](docs/configuration.md). There is no repo list to configure — the GitHub App
installation is the list ([repos](docs/repos.md)); sign-in is a separate OAuth App ([auth](docs/auth.md)).

## Layout

| Package | Purpose |
| --- | --- |
| `core/` | Telemetry aggregation and shared types. No I/O. |
| `server/` | Fastify API: ingest and store, the GitHub App credential and repo list, SPA hosting. |
| `web/` | Vite + React SPA. |
| `driver/` | Claims jobs from the board and runs a runner per job. Depends on nothing. |
| `cli/` | Board CLI over HTTP (`npm run dev -w cli -- job …`); released as `@bellows-ai/bellows-cli` (`npm i -g @bellows-ai/bellows-cli`, then `bellows`). |
| `docker/` | The deploy image and the executor images: [claude-executor](docker/claude-executor/README.md), [opencode-executor](docker/opencode-executor/README.md). |

Every command, the build coupling and the test suites: [AGENTS.md](AGENTS.md).

## Docs

[architecture](docs/architecture.md) · [jobs](docs/jobs.md) · [workflows](docs/workflows.md) ·
[kubernetes](docs/kubernetes.md) · [auth](docs/auth.md) · [workspace](docs/workspace.md) ·
[configuration](docs/configuration.md) · [persistence](docs/persistence.md) ·
[telemetry](docs/telemetry.md) · [security](docs/security.md) · [api](docs/api.md) ·
[executor testing](docs/executor-testing.md) · [design system](docs/design-system.md)

Metric definitions are specified in `../factory-stats/SPEC.md`, outside this repo.
