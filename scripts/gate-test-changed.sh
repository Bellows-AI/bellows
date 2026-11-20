#!/bin/sh
# This repository's test and test:db gates (.bellows.yaml): run only the suites scripts/test-changed.mjs
# selects from the change since origin/${BELLOWS_BASE_BRANCH:-main} (the claim's base, in the gate env).
#   (no argument)  the unit suites (test:changed); core is built first, since test:changed has no pretest
#                  and a fresh checkout has no core/dist for server and web to resolve.
#   --db           the server/test-db suites; npm run test:db builds core itself (pretest:db).
# A change the selector reaches nothing with passes, with the selector's own line saying so; a selector
# that cannot answer fails the gate, never skips it. CI's npm test stays the merge gate.
# Pinned by server/test/gate-test-changed.test.ts.
set -eu
case $#:${1-} in
0: | 1:--db) ;;
*)
    echo 'usage: scripts/gate-test-changed.sh [--db]' >&2
    exit 2
    ;;
esac
cd "$(dirname -- "$0")/.."
gate=gate-test-changed
. scripts/gate-base.sh

if [ $# -eq 0 ]; then
    npm run build -w core
    exec node scripts/test-changed.mjs "$base"
fi
exec node scripts/test-changed.mjs "$base" --db
