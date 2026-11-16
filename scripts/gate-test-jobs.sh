#!/bin/sh
# This repository's test:jobs gate (.bellows.yaml): runs only the phases scripts/test-jobs-changed.mjs
# maps from the change since origin/${BELLOWS_BASE_BRANCH:-main} (the claim's base, in the gate env).
# The map runs first, so a change no phase executes passes without building the runner images; a map
# that cannot answer fails the gate, never skips it. Pinned by server/test/gate-test-jobs.test.ts.
set -eu
cd "$(dirname -- "$0")/.."
branch=${BELLOWS_BASE_BRANCH:-main}
base=origin/$branch

# The task checkout fetches every branch, so this is the fallback; a full fetch, not a shallow one,
# keeps the merge base the map diffs from.
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    git fetch --quiet origin "+refs/heads/$branch:refs/remotes/$base" ||
        { echo "gate-test-jobs: could not fetch $base" >&2; exit 2; }
fi

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
