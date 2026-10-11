#!/bin/sh
# The `.bellows.yaml` ui gate: the Playwright suite against the gate's declared postgres service.
#
# Runs in ghcr.io/bellows-ai/factory-ui-runner (docker/ui-runner.Dockerfile). Services carry no
# health check, so it waits for postgres, creates both disposable databases if missing (a gate
# re-runs in the same worktree), builds once, then runs verify:ui. Traces land in artifacts/ui/.
set -eu

export PGHOST=postgres PGUSER=factory PGPASSWORD=factory

tries=0
until pg_isready -q; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
        echo "postgres did not come up in 60s" >&2
        exit 1
    fi
    sleep 1
done

for db in factory_e2e factory_auth_e2e; do
    if [ "$(psql -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$db'")" != 1 ]; then
        createdb "$db"
    fi
done

npm run build
E2E_DB_HOST=postgres npm run verify:ui
