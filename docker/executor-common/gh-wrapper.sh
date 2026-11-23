#!/bin/sh
# gh, behind the runner's GitHub helper (docs/connections.md): the real binary is
# /usr/local/libexec/gh, and this wrapper stands at /usr/local/bin/gh so every `gh …` the agent
# runs — and every allowlist and guard that matches it — is unchanged. With no token in the
# environment it asks github-credential.cjs, which renews ahead of expiry, and hands gh the answer
# as GH_TOKEN for this one call. A token already set (a supervised step's own) is gh's to use.
# The board opens and edits the task's pull request as the member who started it, so `pr create`, `pr new` and `pr edit`
# are refused here, before any token is asked: a guard against the habit, not a fence (`gh api` and the libexec binary
# still reach GitHub with the installation token).
# One file, built into both executor images (driver/test/executor-images.test.ts).
case "${1:-} ${2:-}" in
'pr create' | 'pr new' | 'pr edit')
    printf '%s\n' 'the board opens and edits this task’s pull request as the member who started it: ask it with `factory-control publish`; do not run gh pr create or gh pr edit' >&2
    exit 2
    ;;
esac
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    if GH_TOKEN="$(node /usr/local/bin/github-credential.cjs token)"; then
        export GH_TOKEN
    else
        unset GH_TOKEN
    fi
fi
exec /usr/local/libexec/gh "$@"
