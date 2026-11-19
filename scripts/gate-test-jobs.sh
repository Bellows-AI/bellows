#!/bin/sh
# This repository's test:jobs gate (.bellows.yaml): runs only the phases scripts/test-jobs-changed.mjs
# maps from the change since origin/${BELLOWS_BASE_BRANCH:-main} (the claim's base, in the gate env).
# The map runs first, so a change no phase executes passes without building the runner images; a map
# that cannot answer fails the gate, never skips it. Pinned by server/test/gate-test-jobs.test.ts.
set -eu
cd "$(dirname -- "$0")/.."
gate=gate-test-jobs
. scripts/gate-base.sh

selection=$(node scripts/test-jobs-changed.mjs "$base") ||
    { echo "gate-test-jobs: could not map the changes since $base" >&2; exit 2; }
case $selection in
'')
    echo "gate-test-jobs: $base selected no phase; nothing to run"
    exit 0
    ;;
full)
    echo "gate-test-jobs: $base runs the full lane"
    make runners
    exec npm run test:jobs
    ;;
*[!a-z,-]* | ,* | *, | *,,*)
    echo "gate-test-jobs: the map printed no phase list: $selection" >&2
    exit 2
    ;;
esac
echo "gate-test-jobs: $base runs: $selection"
make runners
exec npm run test:jobs -- --phase "$selection"
