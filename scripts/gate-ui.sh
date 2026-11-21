#!/bin/sh
# The `ui` gate: npm run verify:ui (Playwright, real chromium) against the gate's declared `postgres`
# service. The agent's own image has no browser libraries and no root, so this gate is how it sees the
# SPA. `.bellows.yaml` marks it on_demand and filtered: the agent runs the specs its change touches
# (GATE_FILTER, e.g. `e2e/task-detail.spec.ts`) inside its 10-minute ad-hoc budget; with no filter it
# runs the whole suite. CI's verify:ui after merge stays the full check.
set -eu
set -f
export E2E_DB_HOST=postgres
url=postgres://factory:factory@$E2E_DB_HOST:5432/postgres
# The two databases playwright.config.ts names; e2e/reset-db.mjs truncates but never creates.
for db in factory_e2e factory_auth_e2e; do
    exists=$(psql "$url" -v ON_ERROR_STOP=1 -qAt -c "select 1 from pg_database where datname = '$db'")
    [ "$exists" = 1 ] || psql "$url" -v ON_ERROR_STOP=1 -q -c "create database $db"
done
# The dev runner image ships the browser at PLAYWRIGHT_BROWSERS_PATH, so this is a check; an image
# without it (or a Playwright bump ahead of the image) downloads one, which needs no root.
npx playwright install chromium
# Both webServers build in the same tree and race over web/dist: one build first, so a build failure
# reports as itself rather than as a webServer that never came up (as CI does).
npm run build
# GATE_FILTER is word-split into spec arguments; `set -f` passes a glob through to playwright as is.
# shellcheck disable=SC2086
exec npx playwright test ${GATE_FILTER:-}
