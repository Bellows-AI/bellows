# Bellows

**Remote Agentic Engineering Platform**

Bellows gives your team a shared place to work with coding agents. Describe a change, let an
agent work on it in a remote environment, and review the resulting pull request. You can follow
the work, answer questions and ask for changes as the task progresses.

Getting an agent to write code is one part of the job. As more people on a team use agents,
the surrounding work matters too: setting up environments, providing access to tools, agreeing
on checks, and understanding what happened. Bellows brings that work into a shared process
that your team can configure, repeat and improve.

## A shared way of working

**Set up the process once.** Your repository defines the environment and checks, while shared
skills give agents instructions for recurring work. Whether someone starts a task from the
web app, CLI or an MCP client, it follows the same process. The team's expectations travel
with the repository.

**Give agents the access they need.** Configure shared model credentials, environment variables
and connections to tools such as Jira and Linear in your organization. Teammates can use that
setup when they start work, with personal profiles and credentials available where needed.
You choose the coding agent and model; Bellows supports Claude Code and OpenCode.

**See how the work is going.** Built-in telemetry shows sessions and token usage across your
organization, with usage and activity available for each task. You can look at an individual
run or understand how agents are being used across the team.

**Keep a history you can follow.** Each task brings together the conversation, runs, checks,
logs, agent transcripts and pull request operations. When you review a change or investigate
a failure, you have the record of how the work unfolded. An organization audit log records
administrative changes, and admins can export the organization's data.

## From a task to a pull request

Start with a repository and a description of the work. Bellows prepares a remote runner using
the container image, setup commands and services in your repository's `.bellows.yaml`, then
starts the agent. Follow-ups and retries stay with the task, so you can continue the work
without creating a new thread.

Build, test and lint checks run at the end of each job. These checks are called **gates**.
By default, a failing gate leaves the work in a draft pull request for inspection. Set
`policy.gates: required` to block publication until every gate passes. Your team reviews
the resulting pull request and decides what to merge.

If a runner or node is lost, Bellows can resume surviving state or restore a saved checkpoint
when one is available.

Use Bellows Cloud or host it on your own infrastructure.
Read the [documentation](https://docs.bellows.cloud) to get started, configure your workflow
or set up self-hosting.

## Development

To run Bellows locally, you'll need Node 22+, Docker, and a GitHub App. The server requires
PostgreSQL and the app credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) to start.
See `.env.example` for the available settings.

```bash
npm install
docker compose up -d postgres
cp .env.example .env          # set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY
npm run dev                   # API on 127.0.0.1:8080, Vite on 5173 with /api proxied
```

To explore sample data without GitHub credentials, seed a disposable database for offline browsing:

```bash
docker compose exec postgres psql -U factory -d postgres -c 'create database factory_seed'
DATABASE_URL=postgres://factory:factory@127.0.0.1:5432/factory_seed npm run seed
```

Run tasks locally:

```bash
make runners                 # build the executor images
docker compose up -d driver  # containers on the local docker socket
npm run dev -w cli -- job create "fix the flaky test" --repo owner/name
```

To run the full stack on a local kind cluster:

```bash
make start    # build images, create the cluster, install the chart, port-forward on 8081
make build    # rebuild and restart against a running stack, data kept
make stop     # uninstall the release
make reset    # stop, and delete the database
make cleanup  # delete the kind cluster
```

## Checks

```bash
npm run lint && npm run typecheck && npm test
npm run test:db      # needs DATABASE_URL
npm run test:jobs    # needs docker
npm run test:k8s
npm run verify:ui
```

See [AGENTS.md](AGENTS.md) for development commands, build dependencies and a guide to the code.
