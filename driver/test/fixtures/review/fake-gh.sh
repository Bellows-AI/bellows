#!/bin/sh

# A stub `gh` for the review helper suites: records every argv (the spawn-shape pins), runs only
# with a credential env present (the same net the scripts cast), answers bounded canned payloads
# from the per-key files in $GH_RESP_DIR (prebuilt by review-script-support.ts from the fixture
# JSON, so this stub never parses JSON), and, when $GH_HTTP_STATUS is set, fails the way `gh`
# fails a non-2xx call: `gh: HTTP <code>: ...` on stderr, exit 1, which is exactly the text the
# scripts' status classification parses. A request that matches no fixture exits 127 like a real
# unknown path. The token is never echoed or written; the tests assert that.
#
# A POSIX sh stub, not a node one: every gh call is a fresh process, and a node start-up per call
# was the dominant cost of these suites under load. The argv log is NUL after each argument and
# \001 after each call, so an argument may hold any text a body can.

if [ -n "$GH_ARGV_LOG" ]; then
    {
        for a in "$@"; do printf '%s\000' "$a"; done
        printf '\001'
    } >>"$GH_ARGV_LOG"
fi

if [ -z "$GH_TOKEN" ] && [ -z "$GITHUB_TOKEN" ]; then
    echo 'gh: no credential env' >&2
    exit 3
fi

if [ -n "$GH_HTTP_STATUS" ]; then
    case $GH_HTTP_STATUS in
        404) reason='Not Found' ;;
        401) reason='Bad credentials' ;;
        403) reason='Forbidden' ;;
        429) reason='rate limit exceeded' ;;
        *) reason='error' ;;
    esac
    echo "gh: HTTP $GH_HTTP_STATUS: $reason (stub)" >&2
    exit 1
fi

# The old stub's regexes, kept as strict: numeric ids only, a 40-hex sha, and `/reviews` or a
# comments path ending at whitespace/end. Newlines (graphql queries) count as whitespace.
# Later matches win: requested < general < reviews < reply < inline < checks.
key=
joined="$*"
query=
for a in "$@"; do
    case $a in query=*)
        query=$a
        break
        ;;
    esac
done
case $joined in *graphql*)
    case $query in
        *resolveReviewThread*) key=resolve ;;
        *) key=threads ;;
    esac
    ;;
esac
case $joined in *requested_reviewers*) key=requested ;; esac
hits=$(printf '%s' "$joined" | tr '\n' ' ' |
    grep -Eo 'issues/[0-9]+/comments|/reviews( |$)|comments/[0-9]+/replies|pulls/[0-9]+/comments( |$)|commits/[0-9a-f]{40}/check-runs')
for rank in general reviews reply inline checks; do
    case $rank in
        general) pat='issues/[0-9]*/comments' ;;
        reviews) pat='/reviews*' ;;
        reply) pat='comments/[0-9]*/replies' ;;
        inline) pat='pulls/[0-9]*/comments*' ;;
        checks) pat='commits/*/check-runs' ;;
    esac
    # shellcheck disable=SC2254
    case $hits in *$pat*) key=$rank ;; esac
done

if [ -z "$key" ]; then
    echo "gh: no fixture for $joined" >&2
    exit 127
fi
if [ ! -f "$GH_RESP_DIR/$key.json" ]; then
    echo "gh: no payload for $key" >&2
    exit 1
fi
cat "$GH_RESP_DIR/$key.json"
