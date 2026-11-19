#!/bin/sh
# Turns durability off on the gate's throwaway `postgres` service before test:db. In a microVM its data
# directory sits on virtiofs, where every WAL sync is slow; a crash loses nothing the gate needs.
# All three settings reload without a restart. `.bellows.yaml`'s test:db gate runs this first, as the
# service's superuser (POSTGRES_USER). Never point it at a server that holds data you keep.
set -eu
url=${1:?usage: gate-pg-fast.sh <postgres url>}
psql "$url" -v ON_ERROR_STOP=1 -qAt \
    -c 'alter system set fsync = off' \
    -c 'alter system set synchronous_commit = off' \
    -c 'alter system set full_page_writes = off' \
    -c 'select pg_reload_conf()' >/dev/null
