if selected_phase control; then
#
# The supervisor's control routes on a real apiserver (issue #770). a: a cooperative Stop — the
# supervisor relays it to the agent, which ends on its own; the run is cancelled, never verified or
# published. b: a question, then the run budget — the budget pauses while the question waits (the
# runner Job's deadline lifted and saved), resumes on the answer with what was left of it, and the
# supervisor ends the run at the budget. Each case reads the supervisor's own final report, logged
# after the board settles, and its acknowledgement, streamed beside the timings so a failure keeps
# its evidence. Only this release's objects are touched.

echo
echo '# supervisor control'

stream_supervisor() { # stream_supervisor <pod> <file> -> streams the supervisor's log under control_log_pid
    kubectl logs -f "$1" -c supervisor -n "$NAMESPACE" >"$2" 2>&1 &
    control_log_pid=$!
}

end_stream() {
    [ -n "${control_log_pid:-}" ] || return 0
    kill "$control_log_pid" 2>/dev/null
    wait "$control_log_pid" 2>/dev/null
    control_log_pid=''
}

await_report() { # await_report <log file> -> the supervisor's final report line, empty after 60s
    # The board settles before `finish`: the report is the supervisor's last line, written after it.
    local until=$(($(date +%s) + 60)) line=''
    while [ "$(date +%s)" -lt "$until" ]; do
        line="$(grep -F 'FACTORY_SUPERVISOR_REPORT ' "$1" 2>/dev/null | tail -1)"
        [ -n "$line" ] && break
        sleep 1
    done
    printf '%s' "$line"
}

expect_report() { # expect_report <case> <report line> <field>...
    local name="$1" line="${2:-no report line}" want
    shift 2
    for want in "$@"; do expect_contains "$name: the supervisor reports $want" "$line" "$want"; done
}

expect_unpublished() { # expect_unpublished <case> <job id>
    local out
    out="$(job_output "$2")"
    case "$out" in
    '') bad "$1: publishes nothing" 'the output could not be read' ;;
    *'[driver] published'*) bad "$1: publishes nothing" "$out" ;;
    *) ok "$1: publishes nothing" ;;
    esac
}

runner_deadline() { # runner_deadline <pod> -> "<activeDeadlineSeconds>|<paused annotation>" of its Job
    kubectl get "job/${1%-*}" -n "$NAMESPACE" --request-timeout=10s \
        -o jsonpath='{.spec.activeDeadlineSeconds}|{.metadata.annotations.bellows\.ai/paused-deadline}' 2>/dev/null
}

await_deadline() { # await_deadline <pod> <case pattern> -> the last reading; 0 once it matched within 30s
    local until=$(($(date +%s) + 30)) d=''
    while [ "$(date +%s)" -lt "$until" ]; do
        d="$(runner_deadline "$1")"
        # shellcheck disable=SC2254 # the pattern is the point
        case "$d" in $2) printf '%s' "$d"; return 0 ;; esac
        sleep 1
    done
    printf '%s' "$d"
    return 1
}

pending_question() { # pending_question <job id> -> the board's pending question id, empty when none
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const q = ((await r.json()).questions ?? []).find((x) => x.status === "pending"); process.stdout.write(q ? String(q.id) : ""); })
    .catch(() => {});
' "$BASE/api/jobs/$1"
}

# a. The cooperative Stop: the agent waits behind a barrier nobody releases, and ends on the Stop.
begin_phase control-stop
stop_release="/task/.lane-control-stop"
stopping="$(queue_job "factory-stub-stop factory-stub-wait-$stop_release stop")"
stop_pod=''
[ -n "$stopping" ] && stop_pod="$(await_runner_pod "$stopping")"
if [ -z "$stop_pod" ]; then
    bad 'the stop job runs' "job '$stopping' has no running runner pod"
else
    stream_supervisor "$stop_pod" "${TIMINGS_FILE%.tsv}.control-stop.supervisor.log"
    if await_blocked "$stop_pod" "$stop_release"; then
        # Past the supervisor's first /control poll (RUN_CONTROL_POLL_MS, 5s): before it, the
        # driver kills the runner instead of asking.
        sleep 6
        stop_status="$(http_status POST "$BASE/api/jobs/$stopping/stop" '{}')"
        [ "$stop_status" = 202 ] && ok 'the running job accepts the stop' ||
            bad 'the running job accepts the stop' "HTTP $stop_status"
        stop_end="$(await_brief "$stopping" 'stopped*' 120)" && ok 'the stopped run settles stopped' ||
            bad 'the stopped run settles stopped' "status|attempts|count|claimSeq|reason: $stop_end"
        expect_contains 'the agent ended itself on the stop' "$(job_output "$stopping")" "stopped in $stop_pod"
        expect_unpublished 'the stopped run' "$stopping"
        stop_driver_log="$(driver_logs | grep -F "job $stopping: stop requested")"
        expect_contains 'the driver asked the supervisor, never killed the runner' "$stop_driver_log" \
            'letting the agent finish its current step'
        case "$stop_driver_log" in
        *'killing the runner'*) bad 'the runner was not killed' "$stop_driver_log" ;;
        *) ok 'the runner was not killed' ;;
        esac
        expect_report 'the stop' "$(await_report "${TIMINGS_FILE%.tsv}.control-stop.supervisor.log")" \
            '"outcome":"cancelled"' '"agentEnd":"exit"' '"delegated":["setup"]' '"acknowledged":true'
    fi
    end_stream
fi

# b. The question, then the budget. A 60s budget; the agent asks after 40s of it and then waits
#    behind a barrier nobody releases. The question is held 30s, longer than the 20s left: a budget
#    that did not pause ends the run while it waits. After the answer the run must end within what
#    was left — not at once (no pause taken), not a whole budget later (the budget reset).
begin_phase control-question-deadline
BUDGET_MS=60000
HOLD=30
timeout_was="$(kubectl get "$DRIVER_DEPLOY" -n "$NAMESPACE" --request-timeout=10s \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DRIVER_JOB_TIMEOUT_MS")].value}')"
kubectl set env "$DRIVER_DEPLOY" -n "$NAMESPACE" "DRIVER_JOB_TIMEOUT_MS=$BUDGET_MS" >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
ask_release="/task/.lane-control-ask"
asking="$(queue_job "factory-stub-ask-40 factory-stub-wait-$ask_release ask")"
ask_pod=''
[ -n "$asking" ] && ask_pod="$(await_runner_pod "$asking")"
if [ -z "$ask_pod" ]; then
    bad 'the asking job runs' "job '$asking' has no running runner pod"
else
    stream_supervisor "$ask_pod" "${TIMINGS_FILE%.tsv}.control-question.supervisor.log"
    qid=''
    until=$(($(date +%s) + 120))
    while [ -z "$qid" ] && [ "$(date +%s)" -lt "$until" ]; do
        qid="$(pending_question "$asking")"
        [ -n "$qid" ] || sleep 1
    done
    if [ -z "$qid" ]; then
        bad 'the board shows the question as pending' "job '$asking': $(job_brief "$asking")"
    else
        ok 'the board shows the question as pending'
        held_at=$SECONDS
        paused="$(await_deadline "$ask_pod" '|{*')" && ok 'a waiting question lifts the runner deadline and saves it' ||
            bad 'a waiting question lifts the runner deadline and saves it' "activeDeadlineSeconds|annotation: $paused"
        sleep $((HOLD - (SECONDS - held_at)))
        held_brief="$(job_brief "$asking")"
        case "$held_brief" in
        running*) ok 'the run outlives what was left of its budget while the question waits' ;;
        *) bad 'the run outlives what was left of its budget while the question waits' "$held_brief" ;;
        esac
        held=$((SECONDS - held_at))
        answer_status="$(http_status POST "$BASE/api/jobs/$asking/questions/$qid/answer" \
            '{"answers":{"Which colour should the report use?":"Blue"}}')"
        answered_at=$SECONDS
        [ "$answer_status" = 200 ] && ok 'a member answers the question' ||
            bad 'a member answers the question' "HTTP $answer_status"
        resumed="$(await_deadline "$ask_pod" '[0-9]*|')" && ok 'the answer restores the runner deadline' ||
            bad 'the answer restores the runner deadline' "activeDeadlineSeconds|annotation: $resumed"
        ask_end="$(await_brief "$asking" 'failed*' 120)" && ok 'the run fails at its resumed budget' ||
            bad 'the run fails at its resumed budget' "status|attempts|count|claimSeq|reason: $ask_end"
        after=$((SECONDS - answered_at))
        # 20s were left; the answer's way back to the supervisor and the settle add some.
        [ "$after" -ge 10 ] && [ "$after" -lt 45 ] && ok 'the budget resumed with what was left of it' ||
            bad 'the budget resumed with what was left of it' "settled ${after}s after the answer, 20s were left"
        ask_out="$(job_output "$asking")"
        expect_contains 'the agent read the answer' "$ask_out" 'Blue'
        killed_ms="$(printf '%s' "$ask_out" | sed -n 's/.*\[driver\] killed after \([0-9]*\)ms.*/\1/p' | tail -1)"
        # The note's budget is the run's plus the time the question held it.
        [ -n "$killed_ms" ] && [ "$killed_ms" -ge $((BUDGET_MS + held * 1000 - 2000)) ] &&
            [ "$killed_ms" -le $((BUDGET_MS + held * 1000 + 15000)) ] &&
            ok 'the timeout note counts the paused wait' ||
            bad 'the timeout note counts the paused wait' "killed after ${killed_ms:-?}ms; held ${held}s on ${BUDGET_MS}ms"
        expect_unpublished 'the timed-out run' "$asking"
        expect_report 'the deadline' "$(await_report "${TIMINGS_FILE%.tsv}.control-question.supervisor.log")" \
            '"outcome":"timed_out"' '"cause":"timeout"' '"agentEnd":"exit"' '"delegated":["setup"]' \
            '"acknowledged":true'
    fi
    end_stream
fi
kubectl set env "$DRIVER_DEPLOY" -n "$NAMESPACE" "DRIVER_JOB_TIMEOUT_MS=$timeout_was" >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1

for job in $stopping $asking; do
    kubectl delete jobs -l "factory.job=$job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --ignore-not-found --wait=false >/dev/null 2>&1
done
fi
