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
  beside every task's thread, logs and spend.
- **Organization-scoped by construction.** An organization is a GitHub App installation; it
  partitions every stored row.
- **Vendor-agnostic.** Claude Code and OpenCode each run as a first-class executor, chosen per task.
- **Close the laptop.** Tasks keep running; cluster size sets how many go at once, not your CPU.

## Quickstart

Needs PostgreSQL and a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`); either missing
refuses to boot. Every setting is in `.env.example`; what each decides is
[configuration](docs/configuration.md).

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
```

## Running tasks

```bash
make runners                 # build the executor images
docker compose up -d driver  # development: containers on the local docker socket
npm run dev -w cli -- job create "fix the flaky test" --repo owner/name
```

`EXECUTOR=kubernetes` makes each task a pod; `charts/factory/` is what deploys
([kubernetes](docs/kubernetes.md), [EKS runbook](docs/eks-runbook.md)). The driver mounts the
docker socket, which is root on the host — read [security](docs/security.md) before running it
anywhere shared.

## Layout

| Package | Purpose |
| --- | --- |
| `core/` | Telemetry aggregation and shared types. No I/O. |
| `server/` | Fastify API: ingest and store, the GitHub App credential and repo list, SPA hosting. |
| `web/` | Vite + React SPA. |
| `driver/` | Claims jobs from the board and runs a runner per job. Depends on nothing. |
| `cli/` | Board CLI over HTTP, released as `@bellows-ai/bellows-cli` ([README](cli/README.md)). |
| `docker/` | The deploy image and the executor images: [claude-executor](docker/claude-executor/README.md), [opencode-executor](docker/opencode-executor/README.md). |
| `plugins/` | [agent-telemetry](plugins/agent-telemetry/README.md), a Claude Code plugin reporting session → repo. |

Every command, the build coupling and the map to [docs/](docs/architecture.md): [AGENTS.md](AGENTS.md).
