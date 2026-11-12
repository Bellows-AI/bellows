if selected_phase compose-driver; then
begin_phase compose-driver
# --- The compose driver -----------------------------------------------------------------------
#
# Issue #174: this service used to build the baked `runtime` stage, so an `up` or restart without
# `--build` served whatever publisher code was baked last — `/fix N` PRs went out without a
# closing keyword and merged with the issue still open. Every phase above runs the driver from the
# host, which is why the bug was invisible here; this phase runs the COMPOSE service against the
# same board. The service bind-mounts the working tree (docker/driver.Dockerfile's `dev` stage),
# so the container must see the checkout's driver source — under the old compose file there is no
# source in the image at all and this phase fails — and a job must settle exactly as the
# host-driven ones did.

echo
echo '# compose driver'

compose -p "$COMPOSE_PROJECT" build driver >/dev/null 2>&1 || {
    echo 'test-jobs: could not build the compose driver image'
    exit 1
}
ok 'the compose driver image builds'

# RUNNER_SERVICES=0 like every host-driven phase above: the services phase seeded a malformed
# .bellows.yaml into the stand-in author's tree, and the services readout failing is a verdict of
# "failed" — the lifecycle here must be settled by the driver itself, not by that leftover.
# The supervisor pulls its steps from the advertised `http://driver`: it runs on the project network,
# where `--use-aliases` gives this one-off container the service's name.
compose -p "$COMPOSE_PROJECT" run --rm --use-aliases --name "$COMPOSE_DRIVER" --no-deps \
    -e JOB_BOARD_URL="http://host.docker.internal:$PORT" \
    -e CLAUDE_EXECUTOR_IMAGE="$IMAGE_OK" \
    -e OPENCODE_EXECUTOR_IMAGE="$IMAGE_OK" \
    -e REPO_CLONE_BASE="$CLONE_BASE" \
    -e RUNNER_NETWORK="${COMPOSE_PROJECT}_default" \
    -e RUNNER_SERVICES=0 \
    -e JOB_BOARD_TOKEN= \
    driver >>"$work/compose-driver.log" 2>&1 &
compose_pid=$!

# The anti-stale discriminator: the running container must hold the checkout's driver SOURCE. The
# source is a bind mount, so it is readable the moment the container exists; the slow part is
# compose creating its volumes, network and container, which a busy daemon stretches past any count
# of polls. Poll against a deadline while `compose run` is alive, and give up only when it exits.
# The grep target is the current parser, so a container running a baked dist has nothing to grep.
mounted=""
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
    if docker exec "$COMPOSE_DRIVER" grep -q '/fix' /app/driver/src/publish/publish.ts 2>/dev/null; then
        mounted=1
        break
    fi
    # The container does not exist yet while compose is still creating volumes and the network, so
    # "no such container" is not an exit.
    kill -0 "$compose_pid" 2>/dev/null || break
    sleep 1
done
if [ -n "$mounted" ]; then
    ok 'the compose driver runs the checkout source'
else
    bad 'the compose driver runs the checkout source' "$(tail -3 "$work/compose-driver.log")"
fi

# The runners of this phase join the project network, so the origin joins it too (its name resolves there).
if docker network connect "${COMPOSE_PROJECT}_default" "$ORIGIN_NAME" >/dev/null 2>&1; then
    compose_job="$(create_job '/fix 987 compose driver lifecycle check')"
    expect_contains 'the compose driver runs its job' "$(await_settled "$compose_job" 180)" succeeded
    ran="$(body "$(api GET "/api/jobs/$compose_job")")"
    expect_contains 'the compose driver names itself' "$(field "$ran" claimedBy)" 'driver-'
else
    # Without the origin on the network the job could only wait out its whole settle deadline.
    bad 'the smoke origin joins the compose network' "$(tail -3 "$work/compose-driver.log")"
fi

docker rm -f "$COMPOSE_DRIVER" >/dev/null 2>&1
docker network disconnect "${COMPOSE_PROJECT}_default" "$ORIGIN_NAME" >/dev/null 2>&1
compose -p "$COMPOSE_PROJECT" down --volumes --remove-orphans >/dev/null 2>&1
wait "$compose_pid" 2>/dev/null
compose_pid=""
supervisor_log_pid=""

fi
