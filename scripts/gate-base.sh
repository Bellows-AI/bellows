# Sourced by this repository's gate script (scripts/gate-test-changed.sh)
# from the repo root, after the caller sets gate=<its name>. Sets branch and base=origin/$branch for the
# claim's base (BELLOWS_BASE_BRANCH, in the gate env), fetching it when the checkout lacks it. A base that
# cannot be fetched fails the gate with exit 2, never reads as "nothing changed".

branch=${BELLOWS_BASE_BRANCH:-main}
base=origin/$branch

# The task checkout fetches every branch, so this is the fallback; a full fetch, not a shallow one,
# keeps the merge base the selectors diff from.
if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
    git fetch --quiet origin "+refs/heads/$branch:refs/remotes/$base" ||
        { echo "$gate: could not fetch $base" >&2; exit 2; }
fi
