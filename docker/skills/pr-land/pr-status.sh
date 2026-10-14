#!/bin/sh
# Reports what still blocks a pushed pull request, waiting first for its CI checks to settle.
#
#   sh pr-status.sh [<pr-number> | <pr-url>] [--timeout SECONDS] [--interval SECONDS] [--no-wait]
#
# Prints key=value lines and exits 0:
#   pr, state, head, review_decision, ci (green | red | pending | none),
#   one "failing=<check> <link>" line per failed or cancelled check, and unanswered_threads:
#   unresolved review threads whose last comment is not yours
# Exits 2 on a usage error, an unresolvable pull request, or a gh failure.
#
# POSIX sh, because the runner images ship dash; gh alone, with every filter its own --jq.
set -eu

# Below the 600s cap on a foreground tool call: a longer wait is a second call, not a longer one.
TIMEOUT=540
# A head pushed moments ago reports no checks until CI registers them; give it this long.
NONE_GRACE=90
INTERVAL=30
WAIT=1
TARGET=''

die() {
    echo "pr-status: $*" >&2
    exit 2
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --timeout)
            [ "$#" -ge 2 ] || die '--timeout needs a value'
            TIMEOUT=$2
            shift 2
            ;;
        --interval)
            [ "$#" -ge 2 ] || die '--interval needs a value'
            INTERVAL=$2
            shift 2
            ;;
        --no-wait)
            WAIT=0
            shift
            ;;
        -*) die "unknown flag: $1" ;;
        *)
            TARGET=$1
            shift
            ;;
    esac
done

for value in "$TIMEOUT" "$INTERVAL"; do
    case "$value" in
        '' | *[!0-9]*) die "--timeout and --interval take whole seconds, got: $value" ;;
    esac
done

case "$TARGET" in
    '') PR=$(gh pr view --json number --jq .number) || die 'no pull request for the current branch' ;;
    */pull/*) PR=$(printf '%s\n' "$TARGET" | sed 's#.*/pull/\([0-9][0-9]*\).*#\1#') ;;
    *) PR=$TARGET ;;
esac
case "$PR" in
    '' | *[!0-9]*) die "cannot resolve a pull request from: ${TARGET:-the current branch}" ;;
esac

ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

# One "<bucket> <name> <link>" line per check; gh keeps only the newest run of each. gh's exit code
# says nothing reliable here, so only empty output with an unexpected error means trouble.
checks() {
    CHECKS=$(gh pr checks "$PR" --json bucket,name,link --jq '.[] | "\(.bucket) \(.name) \(.link)"' 2>"$ERR") || true
    if [ -z "$CHECKS" ] && [ -s "$ERR" ] && ! grep -q 'no checks reported' "$ERR"; then
        die "gh pr checks failed: $(cat "$ERR")"
    fi
}

START=$(date +%s)
DEADLINE=$((START + TIMEOUT))
while :; do
    checks
    PENDING=$(printf '%s\n' "$CHECKS" | grep -c '^pending ' || true)
    NOW=$(date +%s)
    [ "$WAIT" -eq 1 ] && [ "$NOW" -lt "$DEADLINE" ] || break
    if [ -z "$CHECKS" ]; then
        [ "$NOW" -lt $((START + NONE_GRACE)) ] || break
    else
        [ "$PENDING" -gt 0 ] || break
    fi
    LEFT=$((DEADLINE - NOW))
    if [ "$INTERVAL" -lt "$LEFT" ]; then sleep "$INTERVAL"; else sleep "$LEFT"; fi
done
FAILED=$(printf '%s\n' "$CHECKS" | grep -c -e '^fail ' -e '^cancel ' || true)

if [ -z "$CHECKS" ]; then
    CI=none
elif [ "$PENDING" -gt 0 ]; then
    CI=pending
elif [ "$FAILED" -gt 0 ]; then
    CI=red
else
    CI=green
fi

VIEW=$(gh pr view "$PR" --json number,state,headRefOid,reviewDecision \
    --jq '"pr=\(.number)\nstate=\(.state)\nhead=\(.headRefOid)\nreview_decision=\(if (.reviewDecision // "") == "" then "NONE" else .reviewDecision end)"' \
    2>"$ERR") || die "gh pr view failed: $(cat "$ERR")"

# Review threads are GraphQL-only, and a page holds 100: paginate, one line per unresolved thread
# whose last comment is someone else's. A reply does not resolve a thread, so "unresolved" alone
# would never reach zero.
THREADS=$(gh api graphql --paginate -F owner='{owner}' -F name='{repo}' -F pr="$PR" -f query='
  query($owner: String!, $name: String!, $pr: Int!, $endCursor: String) {
    viewer { login }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { isResolved comments(last: 1) { nodes { author { login } } } }
        }
      }
    }
  }' --jq '.data.viewer.login as $me | .data.repository.pullRequest.reviewThreads.nodes[]
    | select(.isResolved == false and .comments.nodes[0].author.login != $me) | "open"' \
    2>"$ERR") || die "gh api graphql failed: $(cat "$ERR")"
UNANSWERED=$(printf '%s' "$THREADS" | grep -c . || true)

printf '%s\n' "$VIEW" "ci=$CI"
printf '%s\n' "$CHECKS" | sed -n -e 's/^fail /failing=/p' -e 's/^cancel /failing=/p'
printf 'unanswered_threads=%s\n' "$UNANSWERED"
