#!/bin/sh
# gh, behind the runner's GitHub helper (docs/connections.md): the real binary is
# /usr/local/libexec/gh, and this wrapper stands at /usr/local/bin/gh so every `gh …` the agent
# runs — and every allowlist and guard that matches it — is unchanged. With no token in the
# environment it asks github-credential.cjs, which renews ahead of expiry, and hands gh the answer
# as GH_TOKEN for this one call. A token already set (a supervised step's own) is gh's to use.
# Kept byte-identical in both executor images (driver/test/executor-images.test.ts).
if [ -z "${GH_TOKEN:-}" ] && [ -z "${GITHUB_TOKEN:-}" ]; then
    if GH_TOKEN="$(node /usr/local/bin/github-credential.cjs token)"; then
        export GH_TOKEN
    else
        unset GH_TOKEN
    fi
fi
exec /usr/local/libexec/gh "$@"
