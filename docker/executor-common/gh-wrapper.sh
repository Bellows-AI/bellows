#!/bin/sh
# gh, behind the runner's forge helper (docs/connections.md): the real binary is
# /usr/local/libexec/gh, and this wrapper stands at /usr/local/bin/gh so every `gh …` the agent
# runs — and every allowlist and guard that matches it — is unchanged. With no token in the
# environment it asks forge-credential.cjs for github.com's token, renewed ahead of expiry, and hands gh the answer
# as GH_TOKEN for this one call. A token already set (a supervised step's own) is gh's to use.
# The board opens and edits the task's pull request as the member who started it, so `pr create`, `pr new` and `pr edit`
# are refused here, before any token is asked: a guard against the habit, not a fence (`gh api` and the libexec binary
# still reach GitHub with the installation token).
# One file, built into both executor images (driver/test/executor-images.test.ts).
# True when an argument exactly `pr` is followed, anywhere later, by an argument exactly `create`, `new` or `edit`. It
# knows nothing of gh's flag grammar, so no flag, value-taking or not, can hide the command. The trade-off is chosen: a
# rare false refusal (a flag value that is exactly `edit`, after a `pr`) is acceptable, a bypass is not. POSIX sh: dash.
opens_or_edits_pr() {
    seen_pr=
    for word in "$@"; do
        if [ -n "$seen_pr" ]; then
            case "$word" in
            create | new | edit) return 0 ;;
            esac
        elif [ "$word" = pr ]; then
            seen_pr=1
        fi
    done
    return 1
}
if opens_or_edits_pr "$@"; then
    printf '%s\n' 'the board opens and edits this task’s pull request as the member who started it: ask it with `factory-control publish`; do not run gh pr create or gh pr edit' >&2
    exit 2
fi
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    if GH_TOKEN="$(node /usr/local/bin/forge-credential.cjs token)"; then
        export GH_TOKEN
    else
        unset GH_TOKEN
    fi
fi
exec /usr/local/libexec/gh "$@"
