if selected_phase driver-kill; then
begin_phase driver-kill
# --- Driver killed at each step of a run ----------------------------------------
#
# A driver that vanishes at any step of a run costs the task an interruption, never the task: the
# next claim finishes it once. Each case kills a real driver at one step — before the agent starts
# (setup), while it runs (agent), during its gates, during the publish — starts the next one, and
# counts from outside what ran: barrier counters under the member tree, the origin's push log and
# the stub gh's PR list. The finalizing step is node-disruption's case a. A driver lost after the
# publish has nothing left to repeat, so no case stands there.

echo
echo '# driver kill'

DK_ORIGIN="$SMOKE_REPO.git" # under /origins on the origins volume

driver_kill() { # driver_kill -> the driver gone with no drain: its lease is left to expire
    kill -9 "$driver_pid" 2>/dev/null
    wait "$driver_pid" 2>/dev/null
    driver_pid=""
}

dk_plan() { # dk_plan <gate name> <gate command> [setup command] -> a .bellows.yaml with one gate on the stub image
    printf 'environment:\n    image: %s\n' "$IMAGE_BASE"
    [ -z "${3:-}" ] || printf "    setup: '%s'\n" "$3"
    printf "    gates:\n        - name: %s\n          command: '%s'\n" "$1" "$2"
}

dk_supervisor() { # dk_supervisor <job id> [docker ps filter] -> the job's supervisor container id
    docker ps -aq --filter "label=factory.job=$1" --filter 'label=factory.role=supervisor' ${2:+--filter "$2"}
}

dk_settled() { # dk_settled <name> <job id> -> the checks every case shares once the job ran to its end
    # The refunded attempt and the one interruption of claim 1 are board rows, asserted on the real store in
    # server/test-db/lane-rows.driver-kill.test.ts; here what the next claim leaves on the daemon.
    local left
    expect_contains "$1: the next claim finishes the task" "$(await_settled "$2" "$ADOPT_S")" succeeded
    left="$(dk_clean "$2")" && ok "$1: nothing of the job is left" ||
        bad "$1: nothing of the job is left" "$left"
}

# The origin's plan is restored at the end, and its push log is started here: the hook counts the ref
# updates the git daemon receives. The gh stand-in's own state is per task, in /task/.lane-gh.
dk_plan_saved="$work/driver-kill.plan"
lane_origin lane_run '
    if git -C "$1" cat-file -e main:.bellows.yaml 2>/dev/null; then git -C "$1" show main:.bellows.yaml; fi' \
    "$DK_ORIGIN" >"$dk_plan_saved" || {
    echo 'test-jobs: could not read the origin plan to restore'
    exit 1
}
lane_origin lane_run 'printf "%s\n" "#!/bin/sh" "while read old new ref; do echo \"\$ref\" >>lane-pushes.log; done" >"$1/hooks/post-receive" &&
    chmod 0755 "$1/hooks/post-receive"' "$DK_ORIGIN" ||
    {
        echo 'test-jobs: could not prepare the driver-kill barriers'
        exit 1
    }
D="$LANE_DIR"
MK="mkdir -p $D;" # every command that touches a barrier makes the directory first: the volume is born at the claim

# K1. Before the agent: setup blocks. Lost before `go`, the group has nothing to take over: its
#     supervisor ends lost (exit 75) and the next claim runs the whole attempt once.
n="$RUN_ID-k1"
write_bellows "$(dk_plan count "$MK echo x >>$D/$n.gate.count" "$MK echo x >>$D/$n.setup.count; $(lane_wait "$D/$n.go")")"
disruption_driver
k1="$(create_job "$MK echo x >>$D/$n.agent.count; echo \"ran in \$HOSTNAME\"")"
lane_use "$k1"
lane_await 90 "$LANE_DIR/$n.setup.count" 1 && ok 'k1: the setup is running' || bad 'k1: the setup is running' "$(lane_count "$LANE_DIR/$n.setup.count")"
dk_count 'k1: the agent has not started' "$LANE_DIR/$n.agent.count" 0
k1_sup="$(dk_supervisor "$k1")"
driver_kill
k1_supervisor_exited() { [ -n "$(dk_supervisor "$k1" status=exited)" ]; }
k1_ended=""
acc_until 150 k1_supervisor_exited && k1_ended=1
[ -n "$k1_ended" ] && [ "$(docker inspect -f '{{.State.ExitCode}}' "$k1_sup" 2>/dev/null)" = 75 ] &&
    ok 'k1: the supervisor of the lost driver ends lost (exit 75)' ||
    bad 'k1: the supervisor of the lost driver ends lost (exit 75)' "$(docker ps -a --filter "label=factory.job=$k1" --format '{{.Names}} {{.Status}}')"
disruption_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
lane_touch "$LANE_DIR/$n.go" || bad 'k1: the barrier is released' 'the touch failed'
# Claim 2's agent container is read while the job runs: the settled job leaves none of it.
k1_agent2=''
k1_host2=''
k1_until=$(($(date +%s) + ADOPT_S))
while [ -z "$k1_host2" ] && [ "$(date +%s)" -lt "$k1_until" ]; do
    k1_agent2="$(docker ps -aq --filter "label=factory.job=$k1" --filter 'label=factory.claim-seq=2' --filter 'label=factory.role=agent' | sed -n 1p)"
    [ -n "$k1_agent2" ] && k1_host2="$(runner_host "$k1_agent2")"
    [ -n "$k1_host2" ] || sleep 0.2
done
dk_settled k1 "$k1"
dk_count 'k1: the agent ran once' "$LANE_DIR/$n.agent.count" 1
k1_out="$(field "$(body "$(api GET "/api/jobs/$k1")")" output)"
if [ -n "$k1_agent2" ] && [ -n "$k1_host2" ]; then
    expect_contains 'k1: the agent ran in a container of claim 2' "$k1_out" "ran in $k1_host2"
else
    bad 'k1: the agent ran in a container of claim 2' "claim-2 agent '$k1_agent2', host '$k1_host2'"
fi
dk_log "$k1" "$TOOK_OVER" && bad 'k1: nothing was taken over' 'the driver logged a takeover' || ok 'k1: nothing was taken over'
dk_log "$k1" "$ADOPTED" && bad 'k1: nothing was adopted' 'the driver logged an adoption' || ok 'k1: nothing was adopted'
stop_driver

# K2. The agent runs, its driver dies: the next driver rebinds the supervisor and takes over the live
#     agent (no second one is ever started); the agent finishes once, in its own container.
n="$RUN_ID-k2"
write_bellows "$(dk_plan count "$MK echo x >>$D/$n.gate.count")"
disruption_driver
k2="$(create_job "$MK echo x >\"\$WORKDIR/lane-change\"; echo x >>$D/$n.agent.count; : >$D/$n.ready; $(lane_wait "$D/$n.go"); echo \"ran in \$HOSTNAME\"")"
lane_use "$k2"
k2_runner="$(await_first_runner "$k2" running)"
k2_host="$(runner_host "$k2_runner")"
[ -n "$k2_runner" ] && await_released "$k2_runner" && lane_await_file 90 "$LANE_DIR/$n.ready" &&
    ok 'k2: the agent is running' || bad 'k2: the agent is running' "runner '$k2_runner'"
driver_kill
disruption_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
dk_await_log "$k2" "$TOOK_OVER" "$ADOPT_S" && ok 'k2: the next driver takes over the running agent' ||
    bad 'k2: the next driver takes over the running agent' "$(grep -F "job $k2:" "$work/driver.log" | tail -5)"
k2_sup="$(dk_supervisor "$k2")"
k2_rebound() {
    # Captured first: under pipefail a grep -q that quits early would fail the pipe.
    k2_logs="$(docker logs "$k2_sup" 2>&1)"
    case "$k2_logs" in *'supervisor: rebound to claim 2'*) return 0 ;; esac
    return 1
}
rebound=""
acc_until 30 k2_rebound && rebound=1
[ -n "$rebound" ] && ok 'k2: the supervisor rebinds to claim 2' || bad 'k2: the supervisor rebinds to claim 2' "$(printf '%s' "$k2_logs" | tail -5)"
# A negative: nothing to poll for, so the observation window is fixed (a second agent would show within it).
sleep 5
# A failed docker ps is not an empty list: it fails the case with docker's own words.
k2_second="$(docker ps -aq --filter "label=factory.job=$k2" --filter 'label=factory.claim-seq=2' --filter 'label=factory.role=agent' 2>&1)" &&
    [ -z "$k2_second" ] && ok 'k2: no second agent is started' ||
    bad 'k2: no second agent is started' "a claim-2 agent container exists, or docker failed: $k2_second"
lane_touch "$LANE_DIR/$n.go" || bad 'k2: the barrier is released' 'the touch failed'
dk_settled k2 "$k2"
expect_contains 'k2: the output names the container of claim 1' "$(field "$(body "$(api GET "/api/jobs/$k2")")" output)" "ran in ${k2_host:-unknown}"
dk_count 'k2: the agent ran once' "$LANE_DIR/$n.agent.count" 1
dk_count 'k2: the gates ran once' "$LANE_DIR/$n.gate.count" 1
stop_driver

# K2d. The same, by a drain: SIGTERM past DRIVER_HANDOVER_MS hands the run back as an interruption
#      and the next driver, started at once, takes over the agent still running (the finished
#      runner's adoption is node-disruption case b).
n="$RUN_ID-k2d"
write_bellows "$(dk_plan count "$MK echo x >>$D/$n.gate.count")"
disruption_driver DRIVER_HANDOVER_MS=2000
k2d="$(create_job "$MK echo x >>$D/$n.agent.count; : >$D/$n.ready; $(lane_wait "$D/$n.go"); echo \"ran in \$HOSTNAME\"")"
lane_use "$k2d"
k2d_runner="$(await_first_runner "$k2d" running)"
k2d_host="$(runner_host "$k2d_runner")"
[ -n "$k2d_runner" ] && await_released "$k2d_runner" && lane_await_file 90 "$LANE_DIR/$n.ready" &&
    ok 'k2d: the agent is running' || bad 'k2d: the agent is running' "runner '$k2d_runner'"
kill -TERM "$driver_pid" 2>/dev/null
# A drained driver ends on its own; one that does not within the deadline is killed, never waited on forever.
driver_gone() { ! kill -0 "$driver_pid" 2>/dev/null; }
acc_until 60 driver_gone
if kill -0 "$driver_pid" 2>/dev/null; then
    bad 'k2d: the drained driver exits' 'still running 60s after SIGTERM'
    kill -KILL "$driver_pid" 2>/dev/null
fi
wait "$driver_pid" 2>/dev/null
driver_pid=""
disruption_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
dk_await_log "$k2d" "$TOOK_OVER" "$ADOPT_S" && ok 'k2d: the next driver takes over the running agent' ||
    bad 'k2d: the next driver takes over the running agent' "$(grep -F "job $k2d:" "$work/driver.log" | tail -5)"
lane_touch "$LANE_DIR/$n.go" || bad 'k2d: the barrier is released' 'the touch failed'
dk_settled k2d "$k2d"
expect_contains 'k2d: the output names the container of claim 1' "$(field "$(body "$(api GET "/api/jobs/$k2d")")" output)" "ran in ${k2d_host:-unknown}"
dk_count 'k2d: the agent ran once' "$LANE_DIR/$n.agent.count" 1
stop_driver

# K4. The gates: killed while a gate runs. The agent has exited but its supervisor still serves, so
#     the next claim takes the group over (it does not wait out the finished runner); the gate that
#     never finished has no checkpoint and is run again under its own step, the old answer fenced;
#     the agent is not repeated.
n="$RUN_ID-k4"
write_bellows "$(dk_plan hold "$MK echo x >>$D/$n.gate.count; $(lane_wait "$D/$n.go")")"
disruption_driver
k4="$(create_job "$MK echo x >\"\$WORKDIR/lane-change\"; echo x >>$D/$n.agent.count; echo \"ran in \$HOSTNAME\"")"
lane_use "$k4"
lane_await 120 "$LANE_DIR/$n.gate.count" 1 && ok 'k4: the gate is running' || bad 'k4: the gate is running' "$(lane_count "$LANE_DIR/$n.gate.count")"
driver_kill
disruption_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
lane_touch "$LANE_DIR/$n.go" || bad 'k4: the barrier is released' 'the touch failed'
dk_settled k4 "$k4"
dk_count 'k4: the gate ran again, once' "$LANE_DIR/$n.gate.count" 2
dk_count 'k4: the agent ran once' "$LANE_DIR/$n.agent.count" 1
dk_log "$k4" "$TOOK_OVER" && ok 'k4: the next driver takes over the group whose agent exited' ||
    bad 'k4: the next driver takes over the group whose agent exited' "$(grep -F "job $k4:" "$work/driver.log" | tail -5)"
dk_log "$k4" "$ADOPTED" && bad 'k4: the finished runner was not waited out' 'the driver logged an adoption' || ok 'k4: the finished runner was not waited out'
stop_driver

# K5. The publish: the agent commits, the gh stub holds `pr create`, the driver dies there. The next
#     claim resumes from the gates' checkpoint and publishes without a second push or a second PR.
n="$RUN_ID-k5"
write_bellows "$(dk_plan count "$MK echo x >>$D/$n.gate.count")"
k5_pushes="$(lane_origin lane_count "$DK_ORIGIN/lane-pushes.log")"
k5_prs=0 # the stand-in's PR list is the task's own, born with its volume
disruption_driver
k5="$(create_job "$MK mkdir -p $LANE_GH_DIR && : >$LANE_GH_DIR/lane-gh-hold && cd \"\$WORKDIR\" && echo x >lane-change && git add lane-change && git -c user.name=lane -c user.email=lane@localhost commit -q -m lane-commit && echo x >>$D/$n.agent.count && echo \"ran in \$HOSTNAME\"")"
lane_use "$k5"
lane_await_file 180 "$LANE_GH_DIR/lane-gh-hold.ready" && ok 'k5: the publish is at the PR' ||
    bad 'k5: the publish is at the PR' "job: $(field "$(body "$(api GET "/api/jobs/$k5")")" status), pushes '$(lane_origin lane_count "$DK_ORIGIN/lane-pushes.log")'"
driver_kill
lane_touch "$LANE_GH_DIR/lane-gh-hold.go" || bad 'k5: the hold is released' 'the touch failed'
disruption_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
dk_settled k5 "$k5"
k5_pushes_now="$(lane_origin lane_count "$DK_ORIGIN/lane-pushes.log")"
k5_prs_now="$(lane_count "$LANE_GH_DIR/lane-gh-prs")"
case "$k5_pushes$k5_pushes_now" in *'?'*) k5_pushed='?' ;; *) k5_pushed=$((k5_pushes_now - k5_pushes)) ;; esac
case "$k5_prs$k5_prs_now" in *'?'*) k5_opened='?' ;; *) k5_opened=$((k5_prs_now - k5_prs)) ;; esac
# The origin's post-receive hook logs ref updates: a no-op push of the same commit fires none, so this
# counts updates; the PR count below is the check against a duplicate publication.
[ "$k5_pushed" = 1 ] && ok 'k5: the branch ref is updated once' || bad 'k5: the branch ref is updated once' "ref updates added: $k5_pushed"
[ "$k5_opened" = 1 ] && ok 'k5: one PR is opened' || bad 'k5: one PR is opened' "PRs added: $k5_opened"
dk_count 'k5: the gates ran once' "$LANE_DIR/$n.gate.count" 1
dk_count 'k5: the agent ran once' "$LANE_DIR/$n.agent.count" 1
dk_log "$k5" "$TOOK_OVER" && ok 'k5: the next driver takes over the group whose agent exited' ||
    bad 'k5: the next driver takes over the group whose agent exited' "$(grep -F "job $k5:" "$work/driver.log" | tail -5)"
dk_log "$k5" "$ADOPTED" && bad 'k5: the finished runner was not waited out' 'the driver logged an adoption' || ok 'k5: the finished runner was not waited out'
dk_log "$k5" "resumed gates from claim 1's checkpoint" && ok 'k5: the gates are resumed from their checkpoint' ||
    bad 'k5: the gates are resumed from their checkpoint' "$(grep -F "job $k5:" "$work/driver.log" | tail -5)"
expect_contains 'k5: the verdict carries the stub PR' "$(field "$(body "$(api GET "/api/jobs/$k5")")" output)" 'factory-smoke/demo/pull/'
stop_driver

# Whatever a case left, by label, one id per rm; the origin's plan goes back to what it was.
for job in "$k1" "$k2" "$k2d" "$k4" "$k5"; do
    docker ps -aq --filter "label=factory.job=$job" |
        while IFS= read -r container_id; do
            [ -n "$container_id" ] && docker rm -f "$container_id" >/dev/null 2>&1
        done
done
write_bellows "$(cat "$dk_plan_saved")"

fi
