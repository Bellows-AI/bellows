if selected_phase github-credential; then
begin_phase github-credential
# --- The runner's GitHub token (docs/connections.md) ------------------------------------------
#
# A second board on the same database boots the lanes' entry (server/dist/offline-mint.js): the
# offline board plus a stand-in mint whose tokens live just past the helper's renewal skew. The
# driver claims from the open board, which holds no App, so its own steps get no token and the
# plain file-origin sync stays as it is; RUNNER_STATS_URL points the runner at the mint board. The
# job runs the image helper itself in a container the driver built: it renews across the forced
# expiry, caches on the memory tmpfs at 0700, carries no token in its env, answers git's credential
# protocol, and clears the cache. The output carries markers, never a token.

echo
echo '# github credential'

env "${SECRET_STORE_ENV[@]}" AUTH_MODE=none DATABASE_URL="$DATABASE_URL" PORT="$MINT_PORT" HOST=127.0.0.1 \
    REPO_CLONE_BASE="$PLAN_BASE" \
    node server/dist/offline-mint.js >>"$work/mint-server.log" 2>&1 &
mint_pid=$!
mint_ready() { [ "$(status "$(BASE="http://127.0.0.1:$MINT_PORT" api GET /api/ready)")" = '200' ]; }
mint_up=""
acc_until 40 mint_ready && mint_up=1
[ -n "$mint_up" ] && ok 'the mint board comes up' || bad 'the mint board comes up' "$(tail -5 "$work/mint-server.log")"

mkdir -p "$work/github"
cp docker/executor-common/github-credential.cjs docker/executor-common/credential-broker.cjs docker/executor-common/attempt-pair.cjs "$work/github/"
# Through the tool shell: git and gh run as the tool uid, which owns the cache (issue #814).
printf '#!/bin/sh\nfor last in "$@"; do :; done\nexec "$SHELL" -c "$last"\n' >"$work/github/run.sh"
printf 'FROM %s\nCOPY github-credential.cjs /usr/local/bin/github-credential.cjs\nCOPY credential-broker.cjs /usr/local/bin/credential-broker.cjs\nCOPY attempt-pair.cjs /usr/local/bin/attempt-pair.cjs\nCOPY run.sh /run.sh\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","/run.sh"]\n' "$IMAGE_BASE" >"$work/github/Dockerfile"
docker build -q -t "$IMAGE_GH" "$work/github" >/dev/null || {
    echo 'test-jobs: could not build the github helper stub image'
    exit 1
}

env JOB_BOARD_URL="$BASE" RUNNER_STATS_URL="http://host.docker.internal:$MINT_PORT" \
    CLAUDE_EXECUTOR_IMAGE="$IMAGE_GH" OPENCODE_EXECUTOR_IMAGE="$IMAGE_GH" \
    RUNNER_SERVICES=0 REPO_CLONE_BASE="$CLONE_BASE" RUNNER_NETWORK="$NETWORK" \
    DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=60 \
    node driver/dist/index.js >>"$work/driver.log" 2>&1 &
driver_pid=$!

gh_job="$(create_job 'h=/usr/local/bin/github-credential.cjs
a="$(node $h token)" || exit 11
b="$(node $h token)" || exit 12
sleep 6
c="$(node $h token)" || exit 13
[ "$a" = "$b" ] && echo gh-cached
[ "$c" != "$a" ] && echo gh-renewed
echo "gh-mode-$(stat -c %a /run/factory-credentials)"
awk '"'"'$2 == "/run/factory-credentials" { print "gh-fs-" $3 }'"'"' /proc/mounts
env | grep -e "^GITHUB_TOKEN=" -e "^GH_TOKEN=" >/dev/null || echo gh-no-env-token
git config --global credential.https://github.com.helper "!node $h git"
printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep "^password=lane_" >/dev/null && echo gh-git-answers
node $h clear && [ -z "$(ls -A /run/factory-credentials)" ] && echo gh-cleared')"
expect_contains 'the github helper job succeeds' "$(await_settled "$gh_job" 120)" succeeded
gh_out="$(field "$(body "$(api GET "/api/jobs/$gh_job")")" output)"
expect_contains 'a token is served from the cache inside its life' "$gh_out" gh-cached
expect_contains 'a token past the renewal skew is renewed'       "$gh_out" gh-renewed
expect_contains 'the cache directory is 0700'                    "$gh_out" gh-mode-700
expect_contains 'the cache is a memory tmpfs'                    "$gh_out" gh-fs-tmpfs
expect_contains 'the runner env carries no GitHub token'         "$gh_out" gh-no-env-token
expect_contains "git's credential protocol answers github.com"   "$gh_out" gh-git-answers
expect_contains 'the cache is cleared'                           "$gh_out" gh-cleared
case "$gh_out" in
*lane_*) bad 'no token reaches the job output' "a lane token is in the output" ;;
*) ok 'no token reaches the job output' ;;
esac
expect_contains "the driver's own steps got no token from the App-less board" "$(cat "$work/driver.log")" \
    'the board issued no GitHub token for the checkout sync'

stop_driver
kill "$mint_pid" 2>/dev/null
wait "$mint_pid" 2>/dev/null
mint_pid=""

fi
