# Bellows

**Product teams drive change. Engineers define the guardrails. Bellows does the work.**

**[See the docs](https://docs.bellows.cloud)** — using Bellows, self-hosting, and reference.

## Development

Needs Node 22+, Docker, and a GitHub App (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`); either
missing refuses to boot. Every setting is in `.env.example`.

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

Run tasks locally:

```bash
make runners                 # build the executor images
docker compose up -d driver  # containers on the local docker socket
npm run dev -w cli -- job create "fix the flaky test" --repo owner/name
```

The full stack on a local kind cluster:

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

Every command, the build coupling and the map to the code: [AGENTS.md](AGENTS.md).
