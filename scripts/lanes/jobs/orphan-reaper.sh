if selected_phase orphan-reaper; then
begin_phase orphan-reaper
# --- The orphan reaper (issue #301) -----------------------------------------------------------
#
# The exact shape the issue describes: a service fleet is up, the driver is kill -9ed before its
# teardown can run, and the job goes terminal WITHOUT any driver alive to sweep it — the stop
# route's in-place landing on a row whose lease has already expired (#152) is what settles it.
# A restarted driver's reaper (one fast round of DRIVER_REAP_INTERVAL_MS/GRACE) then removes the
# service container; no network is the attempt's (issue #773). The runner container is NOT the reaper's to reap
# (its scope is the service label; the fence owns the rest), so it is hand-removed at the end,
# by label, exactly as an operator would.

echo
echo '# orphan reaper'

write_bellows "services:
  - name: stub-svc
    image: $IMAGE_SVC"

# A 10s lease keeps the expired-lease wait short; the reaper driver after the kill gets a fast
# cadence and a grace the fleet has long outlived.
env JOB_BOARD_URL="$BASE" CLAUDE_EXECUTOR_IMAGE="$IMAGE_RUN" OPENCODE_EXECUTOR_IMAGE="$IMAGE_RUN" \
    RUNNER_SERVICES=1 REPO_CLONE_BASE="$CLONE_BASE" RUNNER_NETWORK="$NETWORK" \
    DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=10 \
    node driver/dist/index.js >>"$work/driver.log" 2>&1 &
driver_pid=$!

orphan="$(create_job 'sleep 60')"

orphan_fleet_up() {
    orphan_fleet="$(docker ps -aq --filter "label=factory.job=$orphan" --filter "label=factory.service")"
    [ -n "$orphan_fleet" ]
}
orphan_fleet=""
acc_until 60 orphan_fleet_up
if [ -n "$orphan_fleet" ]; then
    ok 'the service fleet is up'
else
    bad 'the service fleet is up' "no factory.service container appeared; job: $(field "$(body "$(api GET "/api/jobs/$orphan")")" output 2>/dev/null); driver: $(tail -3 "$work/driver.log")"
fi

# The crash: no teardown, no verdict, no heartbeat. kill -9 takes the DRIVER only — the spawned
# `docker run` client is orphaned, not killed, and the container runs on detached, which is
# exactly the state the reaper exists to clean up: a fleet whose owner is gone.
kill -9 "$driver_pid" 2>/dev/null
wait "$driver_pid" 2>/dev/null
driver_pid=""

# The lease has 10 seconds on it; the stop is only an in-place landing once it has expired
# (#152), so poll the stop until the row says stopped.
orphan_stop_landed() { [ "$(status "$(api POST "/api/jobs/$orphan/stop" '{}')")" = 200 ]; }
orphan_stopped=""
acc_until 45 orphan_stop_landed && orphan_stopped=1
if [ -n "$orphan_stopped" ] && [ "$(field "$(body "$(api GET "/api/jobs/$orphan")")" status)" = 'stopped' ]; then
    ok 'the crashed job settles stopped with no driver alive'
else
    bad 'the crashed job settles stopped with no driver alive' "$(field "$(body "$(api GET "/api/jobs/$orphan")")" status)"
fi

# The leak the issue exists for: terminal job, fleet still on the daemon.
orphan_fleet="$(docker ps -aq --filter "label=factory.job=$orphan" --filter "label=factory.service")"
if [ -n "$orphan_fleet" ]; then
    ok 'the terminal job keeps its fleet on the daemon'
else
    bad 'the terminal job keeps its fleet on the daemon' 'the fleet vanished before the reaper ran'
fi

# The reaper, at a fast cadence: first sweep fires at startup, the fleet is minutes old by now,
# so one round is all it takes.
env JOB_BOARD_URL="$BASE" CLAUDE_EXECUTOR_IMAGE="$IMAGE_OK" OPENCODE_EXECUTOR_IMAGE="$IMAGE_OK" \
    RUNNER_SERVICES=0 REPO_CLONE_BASE="$CLONE_BASE" RUNNER_NETWORK="$NETWORK" \
    DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=60 \
    DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000 \
    node driver/dist/index.js >>"$work/driver.log" 2>&1 &
driver_pid=$!

orphan_swept() { [ -z "$(docker ps -aq --filter "label=factory.job=$orphan" --filter "label=factory.service")" ]; }
orphan_reaped=""
acc_until 30 orphan_swept && orphan_reaped=1
if [ -n "$orphan_reaped" ]; then
    ok "the reaper removes the crashed attempt's service container"
else
    bad "the reaper removes the crashed attempt's service container" 'the service container survived the reaper'
fi

if [ -z "$(docker network ls --filter "name=factory-job-$orphan-" --format '{{.Name}}')" ]; then
    ok 'the crashed attempt made no network of its own'
else
    bad 'the crashed attempt made no network of its own' 'a factory-job network exists for it'
fi

# The runner container is the fence's territory, not the reaper's — cleaned up by label, the
# way an operator would, so the daemon is left as the script found it. One id per rm: a quoted
# command substitution would hand docker the whole match list as ONE newline-joined argument and
# nothing would be removed.
docker ps -aq --filter "label=factory.job=$orphan" |
    while IFS= read -r container_id; do
        [ -n "$container_id" ] && docker rm -f "$container_id" >/dev/null 2>&1
    done

stop_driver

fi
