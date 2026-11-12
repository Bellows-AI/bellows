if selected_phase run-deadline; then
begin_phase run-deadline
# --- The run deadline through the task supervisor (issue #770) --------------------------------
#
# A run past its budget is ended by its supervisor, never by the docker backstop: the job fails
# with the driver's timeout note well inside the backstop, and the supervisor's logged report
# says the attempt timed out, claims no verify or publish of its own, and the driver acknowledged it.
# The group is removed on `finish`, so its log is streamed while it lives.

echo
echo '# run deadline'

DEADLINE_MS=20000
env JOB_BOARD_URL="$BASE" CLAUDE_EXECUTOR_IMAGE="$IMAGE_RUN" OPENCODE_EXECUTOR_IMAGE="$IMAGE_RUN" \
    RUNNER_SERVICES=0 REPO_CLONE_BASE="$CLONE_BASE" RUNNER_NETWORK="$NETWORK" DRIVER_JOB_TIMEOUT_MS="$DEADLINE_MS" \
    DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=60 \
    node driver/dist/index.js >>"$work/driver.log" 2>&1 &
driver_pid=$!

overdue="$(create_job 'sleep 300')"
supervisor=''
until=$(($(date +%s) + 60))
while [ -z "$supervisor" ] && [ "$(date +%s)" -lt "$until" ]; do
    supervisor="$(docker ps -q --filter "name=factory-supervisor-$overdue-")"
    [ -n "$supervisor" ] || sleep 0.5
done
if [ -n "$supervisor" ]; then
    ok 'the overdue run has a supervisor'
    docker logs -f "$supervisor" >"$work/run-deadline.supervisor.log" 2>&1 &
    supervisor_log_pid=$!
else
    bad 'the overdue run has a supervisor' "$(tail -5 "$work/driver.log")"
fi
started=$SECONDS
expect_contains 'a run past its budget fails' "$(await_settled "$overdue" 120)" failed
# The docker backstop allows the drain and a minute to report on top of the budget: inside it,
# the supervisor ended the run.
[ $((SECONDS - started)) -lt 75 ] && ok 'the supervisor ended it, not the backstop' ||
    bad 'the supervisor ended it, not the backstop' "settled after $((SECONDS - started))s"
overdue_out="$(field "$(body "$(api GET "/api/jobs/$overdue")")" output)"
expect_contains 'the output carries the timeout note' "$overdue_out" "[driver] killed after ${DEADLINE_MS}ms"
case "$overdue_out" in
*'[driver] published'*) bad 'a timed-out run publishes nothing' "$overdue_out" ;;
*) ok 'a timed-out run publishes nothing' ;;
esac
# The board settles before `finish`: the report is the supervisor's last line, written after it.
report_written() {
    report="$(grep -F 'FACTORY_SUPERVISOR_REPORT ' "$work/run-deadline.supervisor.log" 2>/dev/null | tail -1)"
    [ -n "$report" ]
}
report=''
acc_until 60 report_written
for want in '"outcome":"timed_out"' '"cause":"timeout"' '"delegated":["setup"]' '"acknowledged":true'; do
    expect_contains "the supervisor reports $want" "${report:-no report line}" "$want"
done
[ -n "$supervisor_log_pid" ] && kill "$supervisor_log_pid" 2>/dev/null
wait "$supervisor_log_pid" 2>/dev/null
supervisor_log_pid=''
stop_driver
docker ps -aq --filter "label=factory.job=$overdue" |
    while IFS= read -r container_id; do
        [ -n "$container_id" ] && docker rm -f "$container_id" >/dev/null 2>&1
    done

fi
