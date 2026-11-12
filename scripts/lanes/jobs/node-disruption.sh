if selected_phase node-disruption; then
begin_phase node-disruption
# --- Node disruption (issue #796) -------------------------------------------------------------
#
# Infrastructure loss interrupts a task, it never loses one: a driver lost mid-run leaves its
# runner container running to the end, and the next claim adopts that finished runner's verdict
# instead of redoing the work. Two ways to lose the driver — kill -9 (the lease expires on its
# own), and SIGTERM past DRIVER_HANDOVER_MS (the drain hands the lease back as an interruption,
# claimable at once). Either way the job succeeds with the first runner's output, its attempt
# refunded, and exactly one interruption recorded for claim 1. The prompt-executing stub prints
# its own hostname — the container id — so the output names the container that ran it.

echo
echo '# node disruption'

# a. The hard kill: no drain, no handover, the lease left to expire. The runner runs to its end
#    while no driver watches it; the next driver's claim (2) records the expiry as claim 1's
#    interruption and adopts it — at max_attempts 1, where an expiry used to retire the job dead.
# The plan is this phase's own, whatever phase ran before it (services leaves a malformed one).
write_bellows "services:
  - name: stub-svc
    image: $IMAGE_SVC"
disruption_driver
killed="$(create_job 'sleep 8; echo "ran in $HOSTNAME"')"
capped="$(last_attempt "$killed")" && ok 'the hard-kill job runs at max_attempts 1' ||
    bad 'the hard-kill job runs at max_attempts 1' "job '$killed': $capped"
killed_runner="$(await_first_runner "$killed" running)"
killed_host="$(runner_host "$killed_runner")"
[ -n "$killed_runner" ] && ok 'the hard-kill runner is running' ||
    bad 'the hard-kill runner is running' "job: $(body "$(api GET "/api/jobs/$killed")")"
await_released "$killed_runner" && ok 'the hard-kill runner released its agent' ||
    bad 'the hard-kill runner released its agent' 'no /factory/in/agent/go within 60s'
kill -9 "$driver_pid" 2>/dev/null
wait "$driver_pid" 2>/dev/null
driver_pid=""
[ -n "$(await_first_runner "$killed" exited 30)" ] &&
    [ "$(docker inspect -f '{{.State.ExitCode}}' "$killed_runner" 2>/dev/null)" = '0' ] &&
    ok 'the runner of a killed driver runs to its end' ||
    bad 'the runner of a killed driver runs to its end' "$(docker ps -a --filter "label=factory.job=$killed" --format '{{.Names}} {{.Status}}')"
# Issues #824, #829: the next claim finds the group between its agent's exit and its supervisor's end —
# the orphaned supervisor serves on until its bound — and takes it over rather than sweeping it.
[ -n "$(docker ps -q --filter "label=factory.job=$killed" --filter 'label=factory.role=supervisor' --filter status=running)" ] &&
    ok 'its supervisor still finalizes when the next driver starts' ||
    bad 'its supervisor still finalizes when the next driver starts' "$(docker ps -a --filter "label=factory.job=$killed" --format '{{.Names}} {{.Status}}')"
# A fast reaper round: the adopted run is kept until its verdict lands (issue #821), then reaped.
disruption_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
expect_contains 'the next claim settles the killed run' "$(await_settled "$killed" "$ADOPT_S")" succeeded
killed_body="$(body "$(api GET "/api/jobs/$killed")")"
expect_contains 'the adopted output is the first runner output' "$(field "$killed_body" output)" "ran in ${killed_host:-unknown}"
# The board rows (attempts, interruptions, the kept session) are asserted on the real store in
# server/test-db/lane-rows.node-disruption.test.ts; this phase keeps what only a daemon shows.
grep -qF "job $killed: $TOOK_OVER" "$work/driver.log" && ok 'the driver logs the takeover' ||
    bad 'the driver logs the takeover' "$(grep -F "job $killed:" "$work/driver.log" | tail -5)"
adopted_runner_gone() { [ -z "$(first_runner "$killed")" ]; }
reaped=""
acc_until 30 adopted_runner_gone && reaped=1
[ -n "$reaped" ] && ok 'the adopted runner is kept until the verdict, then reaped' ||
    bad 'the adopted runner is kept until the verdict, then reaped' "$(first_runner "$killed")"
stop_driver

# b. The handover: SIGTERM, and a drain that outlasts DRIVER_HANDOVER_MS hands the run back as an
#    interruption — queued at once — and leaves its runner alive. The next driver is started only
#    once that runner exited AND its released supervisor stopped serving (past the takeover bound,
#    the lease plus SUPERVISOR_REBIND_GRACE_MS), which is what proves the adoption of a FINISHED
#    runner; a group whose supervisor still serves is taken over (case a, driver-kill K2/K4).
disruption_driver DRIVER_HANDOVER_MS=2000
drained="$(create_job 'sleep 12; echo "ran in $HOSTNAME"')"
drained_runner="$(await_first_runner "$drained" running)"
drained_host="$(runner_host "$drained_runner")"
[ -n "$drained_runner" ] && ok 'the handover runner is running' ||
    bad 'the handover runner is running' "job: $(body "$(api GET "/api/jobs/$drained")")"
kill -TERM "$driver_pid" 2>/dev/null
wait "$driver_pid" 2>/dev/null
driver_pid=""
[ -n "$(first_runner "$drained" status=running)" ] && ok 'the handed-over runner is left running' ||
    bad 'the handed-over runner is left running' "$(docker ps -a --filter "label=factory.job=$drained" --format '{{.Names}} {{.Status}}')"
[ -n "$(await_first_runner "$drained" exited 30)" ] &&
    [ "$(docker inspect -f '{{.State.ExitCode}}' "$drained_runner" 2>/dev/null)" = '0' ] &&
    ok 'the handed-over runner exits 0 on its own' ||
    bad 'the handed-over runner exits 0 on its own' "$(docker ps -a --filter "label=factory.job=$drained" --format '{{.Names}} {{.Status}}')"
supervisor_served "$drained" 60 && ok 'the released supervisor stopped serving the steps' ||
    bad 'the released supervisor stopped serving the steps' "$(docker ps -a --filter "label=factory.job=$drained" --format '{{.Names}} {{.Status}}')"
disruption_driver
expect_contains 'the next claim adopts the handed-over run' "$(await_settled "$drained" "$ADOPT_S")" succeeded
drained_body="$(body "$(api GET "/api/jobs/$drained")")"
expect_contains 'the handed-over output is the first runner output' "$(field "$drained_body" output)" "ran in ${drained_host:-unknown}"
grep -qF "job $drained: $ADOPTED" "$work/driver.log" && ok 'the driver logs the handed-over adoption' ||
    bad 'the driver logs the handed-over adoption' "$(grep -F "job $drained:" "$work/driver.log" | tail -5)"
stop_driver

# d. The driver and its runner lost together (issue #822): nothing survives to adopt, so the next
#    claim redoes the attempt in a replacement runner — in the lost attempt's session, on its tree.
#    The first runner leaves a mark in the worktree's git-ignored .factory/ and blocks; the second
#    finds it. Restored, not synced: the origin moves while no driver runs, and a sync would have
#    rebased the tree onto that commit. At max_attempts 1, so an expiry spending an attempt would
#    retire the job dead instead.
disruption_driver
lost="$(create_job 'cd "$WORKDIR" && mkdir -p .factory && if [ -f .factory/lane-lost.mark ]; then echo "resumed $BELLOWS_SESSION_ID from $(cat .factory/lane-lost.mark) upstream:$(grep -c lane-upstream .bellows.yaml)"; else echo "$BELLOWS_SESSION_ID" > .factory/lane-lost.mark; sleep 300; fi')"
capped="$(last_attempt "$lost")" && ok 'the lost-together job runs at max_attempts 1' ||
    bad 'the lost-together job runs at max_attempts 1' "job '$lost': $capped"
lost_runner="$(await_first_runner "$lost" running)"
[ -n "$lost_runner" ] && ok 'the lost-together runner is running' ||
    bad 'the lost-together runner is running' "job: $(body "$(api GET "/api/jobs/$lost")")"
await_released "$lost_runner" && ok 'the lost-together runner released its agent' ||
    bad 'the lost-together runner released its agent' 'no /factory/in/go within 60s'
runner_marked() { docker exec "$lost_runner" sh -c 'test -f "$WORKDIR/.factory/lane-lost.mark"' >/dev/null 2>&1; }
marked=""
acc_until 30 runner_marked && marked=1
[ -n "$marked" ] && ok 'the first runner marked its tree' || bad 'the first runner marked its tree' 'no mark within 30s'
lost_session="$(field "$(body "$(api GET "/api/jobs/$lost")")" sessionId)"
kill -9 "$driver_pid" 2>/dev/null
wait "$driver_pid" 2>/dev/null
driver_pid=""
docker ps -aq --filter "label=factory.job=$lost" |
    while IFS= read -r container_id; do
        [ -n "$container_id" ] && docker rm -f "$container_id" >/dev/null 2>&1
    done
write_bellows "services:
  - name: stub-svc
    image: $IMAGE_SVC
# lane-upstream"
disruption_driver
expect_contains 'the replacement runner settles the lost run' "$(await_settled "$lost" 120)" succeeded
lost_body="$(body "$(api GET "/api/jobs/$lost")")"
expect_contains 'the replacement resumes the lost session on the kept tree' "$(field "$lost_body" output)" \
    "resumed $lost_session from $lost_session"
expect_contains 'the replacement ran on the restored tree, not a synced one' "$(field "$lost_body" output)" upstream:0
grep -qF "job $lost: attempt 1 resuming session $lost_session" "$work/driver.log" &&
    ok 'the driver logs the resumed session' ||
    bad 'the driver logs the resumed session' "$(grep -F "job $lost:" "$work/driver.log" | tail -5)"
grep -qF "job $lost: $ADOPTED" "$work/driver.log" && bad 'nothing was adopted' 'the driver logged an adoption' ||
    ok 'nothing was adopted'
stop_driver

# Whatever any case left, by label, one id per rm — as the reaper phase does.
for job in "$killed" "$drained" "$lost"; do
    docker ps -aq --filter "label=factory.job=$job" |
        while IFS= read -r container_id; do
            [ -n "$container_id" ] && docker rm -f "$container_id" >/dev/null 2>&1
        done
done

fi
