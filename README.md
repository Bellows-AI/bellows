# Bellows

**Product teams drive change. Engineers define the guardrails. Bellows does the work.**

Bellows lets engineering teams encode how AI-assisted changes should happen: repository workflows, checks and human review. Product teams can initiate scoped changes while engineers retain architecture and release control. The planned MCP chat bridge is intended to be open source, not restricted to Cloud.

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

## Who does what

- **Product** defines the desired change and acceptance criteria in an existing application.
- **Engineering** owns architecture, versioned workflow gates, approvals and release. Advanced architecture policy checks, risk-aware review routing and golden paths are future product ideas.
- **Bellows** orchestrates Claude Code/OpenCode execution against the real repository, with repeatable checks, telemetry and a human review path.

**Open source remains a complete self-hosting choice.** The MCP chat-to-PR flow is planned for Community too. Teams seeking managed hosting, maintenance, updates and support can discuss [Bellows Cloud](https://bellows.cloud/); Enterprise SSO and advanced audit are roadmap capabilities, not shipping features.

## Quickstart

Needs PostgreSQL and a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`); either missing
refuses to boot. Every setting is in `.env.example`; what each decides is
[configuration](docs/configuration.md).

```bash
git clone https://github.com/Bellows-AI/bellows.git
cd bellows
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
