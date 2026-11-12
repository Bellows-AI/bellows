# The takeover and drain phases share these.
# Barriers are flat files at /task/.lane-kill-<case>.* on the job's own task volume: a
# volume only the pods of its thread mount, so they are reached through whichever of the job's pods
# mounts /task — the origin's state and push log through the origin pod. The stub gh keeps its PR list
# and hold in /task/.lane-gh.
TK_D="/task/.lane-kill-"
TK_GH="/task/.lane-gh"
TK_REPO="/origins/$SMOKE_REPO.git"
TK_JOB=''

tk_use() { # tk_use <job id> -> later tk_* reads and writes go to that job's task volume (a first job: its id is its thread's root)
    TK_JOB="$1"
}

tk_reader() { # tk_reader <argv...> -> the command in a one-shot pod that mounts the job's task volume, for when none of its pods stands
    local pod="$RELEASE-tk-read" script out
    kubectl get pvc "factory-task-$TK_JOB-1" -n "$NAMESPACE" --request-timeout=10s >/dev/null 2>&1 || return 1
    kubectl delete pod "$pod" -n "$NAMESPACE" --ignore-not-found --wait=true >/dev/null 2>&1
    script="$(node -e 'process.stdout.write(JSON.stringify({ spec: {
        automountServiceAccountToken: false,
        securityContext: { seccompProfile: { type: "RuntimeDefault" } },
        volumes: [{ name: "task", persistentVolumeClaim: { claimName: process.argv[1] } }],
        containers: [{ name: "tk-read", image: process.argv[2], imagePullPolicy: "IfNotPresent",
            securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
            command: process.argv.slice(3), volumeMounts: [{ name: "task", mountPath: "/task" }] }] } }))' \
        "factory-task-$TK_JOB-1" "$STUB_REF" "$@")" || return 1
    kubectl run "$pod" -n "$NAMESPACE" --image="$STUB_REF" --restart=Never --overrides="$script" >/dev/null 2>&1 || return 1
    kubectl wait --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s "pod/$pod" -n "$NAMESPACE" >/dev/null 2>&1
    out="$(kubectl logs "$pod" -n "$NAMESPACE" 2>/dev/null)"
    kubectl delete pod "$pod" -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1
    printf '%s' "$out"
}

tk_exec() { # tk_exec <argv...> -> runs in a container of the job's that mounts /task; TK_FALLBACK=1 lets a reader pod stand in
    local pod container out
    for pod in $(kubectl get pods -l "factory.job=$TK_JOB,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --request-timeout=10s --field-selector=status.phase=Running -o jsonpath='{.items[*].metadata.name}' 2>/dev/null); do
        for container in $(kubectl get pod "$pod" -n "$NAMESPACE" --request-timeout=10s \
            -o jsonpath='{.spec.containers[*].name}' 2>/dev/null); do
            out="$(kubectl exec "$pod" -c "$container" -n "$NAMESPACE" --request-timeout=10s -- sh -c \
                'case "$(cat /proc/mounts)" in *" /task "*) echo TKMOUNT; "$@" ;; esac' sh "$@" 2>/dev/null)"
            case "$out" in TKMOUNT*)
                printf '%s' "${out#TKMOUNT}" | sed '1{/^$/d;}'
                return 0
                ;;
            esac
        done
    done
    [ -n "${TK_FALLBACK:-}" ] && tk_reader sh -c 'exec "$@"' sh "$@"
}

tk_final() { # tk_final <tk_* function> [arg...] -> the read after the job settled: its pods are gone, so a reader pod mounts the volume
    local TK_FALLBACK=1
    "$@"
}

tk_count() { # tk_count <path> -> its line count; 0 only when absent; ? when the read failed
    local out
    out="$(tk_exec sh -c 'if [ -e "$1" ]; then wc -l <"$1" | tr -d " "; else echo 0; fi' sh "$1" 2>/dev/null)" &&
        [ -n "$out" ] && printf '%s' "$out" || printf '?'
}

tk_ready() { # tk_ready <path prefix> -> how many files start with it; ? when the read failed
    local out
    out="$(tk_exec sh -c 'ls -1d "$1"* 2>/dev/null | wc -l | tr -d " "' sh "$1" 2>/dev/null)" &&
        [ -n "$out" ] && printf '%s' "$out" || printf '?'
}

tk_touch() { # tk_touch <path> -> success once the file exists; retried while no pod of the job stands
    local until=$(($(date +%s) + 90)) out
    while [ "$(date +%s)" -lt "$until" ]; do
        # A directory made here is shared with the publish step, which runs as another user.
        out="$(tk_exec sh -c 'd="$(dirname "$1")"; mkdir -p "$d"; [ "$d" = /task ] || chmod 0777 "$d" 2>/dev/null; touch "$1" && echo touched' sh "$1" 2>/dev/null)"
        case "$out" in *touched*) return 0 ;; esac
        sleep 2
    done
    return 1
}

tk_origin() { # tk_origin <argv...> -> runs in the origin pod, which serves the bare repository
    kubectl exec "$RELEASE-origin" -n "$NAMESPACE" --request-timeout=10s -- "$@"
}

tk_origin_count() { # tk_origin_count <path> -> its line count; 0 only when absent; ? when the read failed
    local out
    out="$(tk_origin sh -c 'if [ -e "$1" ]; then wc -l <"$1" | tr -d " "; else echo 0; fi' sh "$1" 2>/dev/null)" &&
        [ -n "$out" ] && printf '%s' "$out" || printf '?'
}

tk_await() { # tk_await <path> <want> <seconds> -> success once the file holds at least <want> lines
    local until=$(($(date +%s) + $3)) got
    while [ "$(date +%s)" -lt "$until" ]; do
        got="$(tk_count "$1")"
        case "$got" in '' | '?' | *[!0-9]*) ;; *) [ "$got" -ge "$2" ] && return 0 ;; esac
        sleep 1
    done
    return 1
}

tk_wait() { # tk_wait <path> -> shell text that blocks (at most 300 s) until the file exists
    printf 'i=0; while [ ! -e %s ] && [ $i -lt 300 ]; do i=$((i+1)); sleep 1; done' "$1"
}

tk_plan() { # tk_plan <gate command> [setup command] -> a .bellows.yaml with one gate on the stub image
    printf 'environment:\n    image: %s\n' "$STUB_REF"
    [ -z "${2:-}" ] || printf "    setup: '%s'\n" "$2"
    printf "    gates:\n        - name: hold\n          command: '%s'\n" "$1"
}

tk_left() { # tk_left <job id> -> success only when kubectl answered and the job has no Job or pod
    local out
    out="$(kubectl get jobs,pods -l "factory.job=$1,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --request-timeout=10s -o name 2>"$work/tk-left.err")" || {
        printf '%s' "$(cat "$work/tk-left.err")"
        return 1
    }
    [ -z "$out" ] || {
        printf '%s' "$out"
        return 1
    }
}

tk_claim_jobs() { # tk_claim_jobs <job id> <claim seq> -> the runner Jobs of that claim; non-zero when kubectl did not answer
    kubectl get jobs -l "factory.job=$1,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --request-timeout=10s \
        -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.annotations.factory\.claim-seq}{"\n"}{end}' |
        awk -v seq="$2" '$2 == seq { print $1 }'
}

tk_supervisor_exit() { # tk_supervisor_exit <job id> <claim seq> <seconds> -> the supervisor container's exit code; ? when never read
    local until=$(($(date +%s) + $3)) job code=''
    while [ "$(date +%s)" -lt "$until" ]; do
        # A kubectl error leaves the code empty and the loop polling: an unread pod is never an exit code.
        if job="$(tk_claim_jobs "$1" "$2")" && [ -n "$job" ]; then
            code="$(kubectl get pods -l "job-name=$job" -n "$NAMESPACE" --request-timeout=10s \
                -o jsonpath='{.items[0].status.containerStatuses[?(@.name=="supervisor")].state.terminated.exitCode}' 2>/dev/null)" &&
                [ -n "$code" ] && break
        fi
        code=''
        sleep 2
    done
    printf '%s' "${code:-?}"
}

tk_exit='' # the exit code of the lost driver's supervisor, set by tk_kill when asked to wait for it
tk_kill() { # tk_kill <job id> [wait] -> the driver pod gone with no drain, a replacement up, the dead claim's lease expired
    # `wait`: the lost claim-1 supervisor is given the time to end on its own orphan bound first. The expiry
    # lets the next claim sweep a group that never released its agent, and a swept supervisor dies by SIGKILL
    # (137) before it can end lost (75) (`driver/test/takeover-sim.test.ts`, t1).
    local expired
    tk_exit=''
    kill_driver_pods
    kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1 ||
        { bad "$1: the replacement driver is rolled out" "$(kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" 2>&1)"; give_up; }
    [ "${2:-}" = wait ] && tk_exit="$(tk_supervisor_exit "$1" 1 120)"
    expired="$(expire_claim_one "$1")"
    [ "$expired" = 1 ] && ok "$1: the dead driver's lease is expired" || {
        bad "$1: the dead driver's lease is expired" "$expired"
        give_up
    }
}

tk_settled_at='' # the second the brief first read succeeded, set by tk_settled; empty when it never did
tk_settled() { # tk_settled <name> <job id> <interruption> -> the checks every case shares once the job ran to its end
    local brief left clean until=$(($(date +%s) + 120))
    tk_settled_at=''
    brief="$(await_brief "$2" 'succeeded*' 240)"
    # An interruption may carry the pod's own words after the stated cause: "<cause> (<reason>: <message>)".
    case "$brief" in
    "succeeded|1|1|1|$3" | "succeeded|1|1|1|$3 ("*")") tk_settled_at=$(date +%s) ;;
    esac
    [ -n "$tk_settled_at" ] && ok "$1: the next claim finishes the task once, with one interruption" ||
        bad "$1: the next claim finishes the task once, with one interruption" "status|attempts|count|claimSeq|reason: $brief"
    clean=''
    while :; do
        if left="$(tk_left "$2")"; then
            clean=1
            break
        fi
        [ "$(date +%s)" -lt "$until" ] || break
        sleep 2
    done
    [ -n "$clean" ] && ok "$1: nothing of the job is left" || bad "$1: nothing of the job is left" "${left:-unconfirmed}"
}

tk_check() { # tk_check <name> <got> <want>
    [ "$2" = "$3" ] && ok "$1" || bad "$1" "got '$2', want '$3'"
}

tk_prepare() { # tk_prepare -> the origin's push log hook exists; the lane stops when it cannot
    # The origin keeps a push log (a hook): its daemon user owns the repository, so nothing else need write it.
    tk_origin sh -c 'printf "%s\n" "#!/bin/sh" "while read old new ref; do echo \"\$ref\" >>lane-pushes.log; done" >"$1/hooks/post-receive" &&
        chmod 0755 "$1/hooks/post-receive"' sh "$TK_REPO" >/dev/null 2>&1 &&
        ok 'the origin push log is prepared' || {
        bad 'the origin push log is prepared' 'the origin pod could not write its repository'
        give_up
    }
}

if selected_phase takeover; then
begin_phase takeover
# --- Driver killed at each step of a run -------------------------------------------
#
# The driver pod is deleted hard at one step of a run — while its setup blocks, while the agent
# runs, while a gate runs, while the publish waits at the PR — and the lease is expired as waiting it
# out would. The replacement driver finishes the task once: counted from outside by barrier files
# under the member tree (`.lane-kill/`, mounted at the same path in the task pod's supervisor, gate
# sidecar, setup Job and the dashboard), the origin's push log and the stub gh's PR list. A driver
# lost after the publish has nothing left to repeat, and the finalizing step is recovery case e.

echo
echo '# driver takeover'

tk_prepare  # the origin push log exists before the first case

# T1. Before the agent: setup blocks. Lost before `go`, the group has nothing to take over; the next
#     claim runs the whole attempt once.
begin_phase takeover-setup
n="$RELEASE-t1"
commit_plan takeover-setup "$(tk_plan "echo x >>$TK_D$n.gate.count" "echo x >>$TK_D$n.setup.count; $(tk_wait "$TK_D$n.go")")" ||
    bad 'the setup plan is committed' 'the plan pod did not commit'
t1="$(queue_job "factory-stub-change factory-stub-pass-$TK_D$n.agent")"
tk_use "$t1"
if [ -z "$t1" ]; then
    bad 'the setup job is queued' 'the board refused it'
else
    tk_await "$TK_D$n.setup.count" 1 240 && ok 't1: the setup is running' || bad 't1: the setup is running' "$(tk_count "$TK_D$n.setup.count")"
    tk_check 't1: the agent has not started' "$(tk_ready "$TK_D$n.agent.ready-")" 0
    tk_kill "$t1" wait
    tk_check 't1: the supervisor of the lost driver ends lost (exit 75)' "$tk_exit" 75
    await_brief "$t1" "*|1|1|$EXPIRED" 120 >/dev/null && ok 't1: the next claim records the interruption' ||
        bad 't1: the next claim records the interruption' "$(job_brief "$t1")"
    tk_touch "$TK_D$n.go" || bad 't1: the barrier is released' 'the touch failed'
    tk_settled t1 "$t1" "$EXPIRED"
    tk_check 't1: the agent ran once' "$(tk_final tk_ready "$TK_D$n.agent.ready-")" 1
    tk_check 't1: the gate ran once' "$(tk_final tk_count "$TK_D$n.gate.count")" 1
fi

# T2. The agent runs, its driver dies: the next driver rebinds the supervisor and takes over the live
#     agent (no second runner Job is ever created); the agent finishes once, in its own pod.
begin_phase takeover-agent
n="$RELEASE-t2"
commit_plan takeover-agent "$(tk_plan "echo x >>$TK_D$n.gate.count")" || bad 'the agent plan is committed' 'the plan pod did not commit'
t2="$(queue_job "factory-stub-change factory-stub-patient factory-stub-wait-$TK_D$n.go")"
tk_use "$t2"
t2_pod="$(await_runner_pod "$t2")"
if [ -z "$t2" ] || [ -z "$t2_pod" ]; then
    bad 't2: the agent is running' "job '$t2': $(job_brief "$t2")"
else
    await_blocked "$t2_pod" "$TK_D$n.go" && ok 't2: the agent is running' || give_up
    tk_kill "$t2"
    took=""
    until=$(($(date +%s) + 240))
    while [ "$(date +%s)" -lt "$until" ]; do
        case "$(driver_logs)" in *"job $t2: $TOOK_OVER"*)
            took=1
            break
            ;;
        esac
        sleep 2
    done
    [ -n "$took" ] && ok 't2: the next driver takes over the running agent' ||
        bad 't2: the next driver takes over the running agent' "$(driver_logs | grep -F "job $t2:" | tail -5)"
    # The new binding reaches the supervisor through a mounted Secret: the kubelet refreshes it within a minute or two.
    rebound=""
    until=$(($(date +%s) + 300))
    while [ "$(date +%s)" -lt "$until" ]; do
        sup_logs="$(kubectl logs "$t2_pod" -c supervisor -n "$NAMESPACE" --request-timeout=10s 2>/dev/null)"
        case "$sup_logs" in *'supervisor: rebound to claim 2'*)
            rebound=1
            break
            ;;
        esac
        sleep 2
    done
    [ -n "$rebound" ] && ok 't2: the supervisor rebinds to claim 2' ||
        bad 't2: the supervisor rebinds to claim 2' "$(printf '%s' "$sup_logs" | tail -5)"
    second="$(tk_claim_jobs "$t2" 2)" && [ -z "$second" ] && ok 't2: no second runner is started' ||
        bad 't2: no second runner is started' "claim 2 Jobs: '$second'"
    tk_touch "$TK_D$n.go" || bad 't2: the barrier is released' 'the touch failed'
    tk_settled t2 "$t2" "$EXPIRED"
    tk_check 't2: the agent ran once' "$(tk_final tk_ready "$TK_D$n.go.ready-")" 1
    tk_check 't2: the gate ran once' "$(tk_final tk_count "$TK_D$n.gate.count")" 1
fi

# T4. The gates: killed while a gate runs. The agent has exited but its supervisor still serves, so the
#     next claim takes the group over (it does not wait out the finished runner); the gate that never
#     finished has no checkpoint and is run again under its own step; the agent is not repeated.
begin_phase takeover-gates
n="$RELEASE-t4"
commit_plan takeover-gates "$(tk_plan "echo x >>$TK_D$n.gate.count; $(tk_wait "$TK_D$n.go")")" || bad 'the gate plan is committed' 'the plan pod did not commit'
t4="$(queue_job "factory-stub-change factory-stub-pass-$TK_D$n.agent")"
tk_use "$t4"
if [ -z "$t4" ]; then
    bad 'the gate job is queued' 'the board refused it'
else
    tk_await "$TK_D$n.gate.count" 1 300 && ok 't4: the gate is running' || bad 't4: the gate is running' "$(tk_count "$TK_D$n.gate.count")"
    tk_kill "$t4"
    await_brief "$t4" "*|1|1|$EXPIRED" 120 >/dev/null && ok 't4: the next claim records the interruption' ||
        bad 't4: the next claim records the interruption' "$(job_brief "$t4")"
    tk_touch "$TK_D$n.go" || bad 't4: the barrier is released' 'the touch failed'
    tk_settled t4 "$t4" "$EXPIRED"
    tk_check 't4: the gate ran again, once' "$(tk_final tk_count "$TK_D$n.gate.count")" 2
    tk_check 't4: the agent ran once' "$(tk_final tk_ready "$TK_D$n.agent.ready-")" 1
    expect_contains 't4: the next claim takes over the group whose agent exited' "$(driver_logs)" "job $t4: $TOOK_OVER"
    expect_not_contains 't4: the finished runner was not waited out' "$(driver_logs)" "job $t4: $ADOPTED"
fi

# T4b. The gates: the runner pod is deleted while a gate runs. The pod's supervisor goes with
#      it, so the waiting gate step is released at once and the attempt ends as an interruption inside two
#      leases, never failed or dead; the pod's agent is gone with it, so the next claim resumes the session
#      in a new runner and reruns the gate that never finished.
begin_phase takeover-gate-pod-lost
n="$RELEASE-t4b"
commit_plan takeover-gate-pod-lost "$(tk_plan "echo x >>$TK_D$n.gate.count; $(tk_wait "$TK_D$n.go")")" || bad 'the gate plan is committed' 'the plan pod did not commit'
t4b="$(queue_job "factory-stub-change factory-stub-pass-$TK_D$n.agent")"
tk_use "$t4b"
t4b_pod="$(await_runner_pod "$t4b")"
if [ -z "$t4b" ] || [ -z "$t4b_pod" ]; then
    bad 't4b: the gate job is running' "job '$t4b': $(job_brief "$t4b")"
else
    tk_await "$TK_D$n.gate.count" 1 300 && ok 't4b: the gate is running' || bad 't4b: the gate is running' "$(tk_count "$TK_D$n.gate.count")"
    deleted_at="$(date +%s)"
    kubectl delete pod "$t4b_pod" -n "$NAMESPACE" --grace-period=0 --force --wait=false >/dev/null 2>&1
    t4b_mid="$(await_brief "$t4b" "*|1|1|$GATE_LOST*" $((2 * LANE_LEASE_S + 30)))"
    took=$(($(date +%s) - deleted_at))
    case "$t4b_mid" in
    *"|1|1|$GATE_LOST"*) [ "$took" -lt $((2 * LANE_LEASE_S)) ] && ok "t4b: a deleted runner pod under a gate is an interruption (${took}s, inside two ${LANE_LEASE_S}s leases)" ||
        bad 't4b: a deleted runner pod under a gate is an interruption inside two leases' "took ${took}s: $t4b_mid" ;;
    *) bad 't4b: a deleted runner pod under a gate is an interruption inside two leases' "status|attempts|count|claimSeq|reason: $t4b_mid" ;;
    esac
    tk_touch "$TK_D$n.go" || bad 't4b: the barrier is released' 'the touch failed'
    tk_settled t4b "$t4b" "$GATE_LOST"
    tk_check 't4b: the gate ran again, once' "$(tk_final tk_count "$TK_D$n.gate.count")" 2
    tk_check 't4b: the agent ran again in a new runner, once' "$(tk_final tk_ready "$TK_D$n.agent.ready-")" 2
    expect_contains 't4b: the next claim resumes the session' "$(driver_logs)" "job $t4b: attempt 1 resuming session"
fi

# T5. The publish: the agent commits, the stub gh holds `pr create`, the driver dies there. The next
#     claim resumes from the gates' checkpoint and publishes without a second push or a second PR.
begin_phase takeover-publish
n="$RELEASE-t5"
commit_plan takeover-publish "$(tk_plan "echo x >>$TK_D$n.gate.count")" || bad 'the publish plan is committed' 'the plan pod did not commit'
t5_pushes="$(tk_origin_count "$TK_REPO/lane-pushes.log")"
t5_prs=0 # the stub gh's PR list is the task's own, born with its volume
t5="$(queue_job "factory-stub-commit factory-stub-wait-$TK_D$n.agent")"
tk_use "$t5"
if [ -z "$t5" ]; then
    bad 'the publish job is queued' 'the board refused it'
else
    # The hold lives on the task's volume, which exists once the agent stands at its barrier: set it there, then release the agent.
    at_barrier=""
    until=$(($(date +%s) + 300))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(tk_ready "$TK_D$n.agent.ready-")" = 1 ] && {
            at_barrier=1
            break
        }
        sleep 2
    done
    tk_touch "$TK_GH/lane-gh-hold" && tk_touch "$TK_D$n.agent" || bad 't5: the gh hold is set' "the hold or the release was not written (agent at its barrier: '$at_barrier')"
    held=""
    until=$(($(date +%s) + 300))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(tk_exec sh -c 'test -e "$1" && echo yes' sh "$TK_GH/lane-gh-hold.ready")" = yes ] && {
            held=1
            break
        }
        sleep 1
    done
    [ -n "$held" ] && ok 't5: the publish is at the PR' || bad 't5: the publish is at the PR' "job: $(job_brief "$t5"): $(job_output "$t5" | tail -c 600)"
    tk_kill "$t5"
    tk_touch "$TK_GH/lane-gh-hold.go" || bad 't5: the hold is released' 'the touch failed'
    tk_settled t5 "$t5" "$EXPIRED"
    t5_pushes_now="$(tk_origin_count "$TK_REPO/lane-pushes.log")"
    t5_prs_now="$(tk_final tk_count "$TK_GH/lane-gh-prs")"
    case "$t5_pushes$t5_pushes_now" in *'?'*) t5_pushed='?' ;; *) t5_pushed=$((t5_pushes_now - t5_pushes)) ;; esac
    case "$t5_prs$t5_prs_now" in *'?'*) t5_opened='?' ;; *) t5_opened=$((t5_prs_now - t5_prs)) ;; esac
    # The origin's post-receive hook logs ref updates: a no-op push of the same commit fires none, so this
    # counts updates; the PR count is the check against a duplicate publication.
    tk_check 't5: the branch ref is updated once' "$t5_pushed" 1
    tk_check 't5: one PR is opened' "$t5_opened" 1
    tk_check 't5: the gate ran once' "$(tk_final tk_count "$TK_D$n.gate.count")" 1
    tk_check 't5: the agent ran once' "$(tk_final tk_ready "$TK_D$n.agent.ready-")" 1
    expect_contains 't5: the next claim takes over the group whose agent exited' "$(driver_logs)" "job $t5: $TOOK_OVER"
    expect_not_contains 't5: the finished runner was not waited out' "$(driver_logs)" "job $t5: $ADOPTED"
    expect_contains 't5: the gates are resumed from their checkpoint' "$(driver_logs)" "job $t5: resumed gates from claim 1's checkpoint"
    expect_contains 't5: the verdict carries the stub PR' "$(job_output "$t5")" 'factory-smoke/demo/pull/'
fi

# The origin carries no plan again: a later phase runs as it always did.
commit_plan takeover-restore '' && ok 'the plan is removed again' || bad 'the plan is removed again' 'the plan pod did not commit'
fi
