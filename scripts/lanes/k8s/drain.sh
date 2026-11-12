if [ "$PHASE" = drain ]; then
begin_phase drain
# --- Node drain on a multi-node cluster --------------------------------------------
#
# Explicit only: it needs a cluster made with `make cluster LAYOUT=drain` (a control plane and three
# workers labelled factory.lane/shared), so no other phase includes it. D1 drains the node the
# driver runs on while a runner holds a barrier elsewhere: the replacement driver takes the running
# agent over. D2 drains the node the runner runs on while the driver survives: the replacement
# runner resumes the attempt. Each case times, from the start of `kubectl drain`, how long until the
# task is held again and until it is settled, into <timings>.recovery.tsv. Seconds at `date +%s`
# resolution on one machine: a sample, not a bound (docs/limits.md).

echo
echo '# node drain'

RECOVERY_TSV="${TIMINGS_FILE%.tsv}.recovery.tsv"
printf 'case\tnode\tdrain_s\theld_s\tsettled_s\n' >"$RECOVERY_TSV" || exit 1

drain_refuse() { # drain_refuse <what is wrong> -> the lane stops with the way to a cluster that fits
    echo "test-k8s: the drain phase needs a LAYOUT=drain cluster: $1"
    echo "make cleanup CLUSTER=$kind_name; make cluster CLUSTER=$kind_name LAYOUT=drain"
    exit 1
}

all_nodes="$(kubectl get nodes -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' --request-timeout=10s)" ||
    drain_refuse 'the node list could not be read'
drain_workers="$(kubectl get nodes -l 'factory.lane/shared=true,!node-role.kubernetes.io/control-plane' --request-timeout=10s \
    -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.unschedulable}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\n"}{end}')" ||
    drain_refuse 'the worker list could not be read'
drain_workers="$(printf '%s\n' "$drain_workers" | awk -F'\t' '$2 == "" && $3 == "True" { print $1 }')"
[ "$(printf '%s\n' "$drain_workers" | grep -c .)" -ge 3 ] || drain_refuse 'fewer than three Ready, schedulable workers share the volume'
WA="$(printf '%s\n' "$drain_workers" | sed -n 1p)"
WB="$(printf '%s\n' "$drain_workers" | sed -n 2p)"
WC="$(printf '%s\n' "$drain_workers" | sed -n 3p)"
on_workers="$(kubectl get pods -n "$NAMESPACE" --request-timeout=10s \
    -l "app.kubernetes.io/instance in ($RELEASE,$STATE_RELEASE),app.kubernetes.io/component in (dashboard,postgres,collector)" \
    -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}')" || drain_refuse 'the board pods could not be read'
case "$on_workers" in *"$WA"* | *"$WB"* | *"$WC"*) drain_refuse "the board or the database runs on a worker: $on_workers" ;; esac

drain_isolate() { # drain_isolate <node>... -> the named nodes schedulable, every other node cordoned
    local node k keep
    for node in $all_nodes; do
        keep=''
        for k in "$@"; do [ "$k" = "$node" ] && keep=1; done
        if [ -n "$keep" ]; then lane_uncordon "$node" || return 1; else lane_cordon "$node" || return 1; fi
    done
}

driver_node() { # driver_node -> the node of the running driver pod; non-zero when unread or none
    local at
    at="$(kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" --request-timeout=10s --field-selector=status.phase=Running \
        -o jsonpath='{range .items[*]}{.spec.nodeName}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}')" || return 1
    # A terminating pod is still Running: only one that is not being deleted is the driver.
    at="$(printf '%s\n' "$at" | awk -F'\t' '$2 == "" && $1 != "" && !found { print $1; found = 1 }')"
    [ -n "$at" ] || return 1
    printf '%s' "$at"
}

drain_place_driver() { # drain_place_driver <node> -> the driver runs on that node, the only schedulable one
    drain_isolate "$1" || return 1
    [ "$(driver_node)" = "$1" ] && return 0
    kubectl rollout restart "$DRIVER_DEPLOY" -n "$NAMESPACE" --request-timeout=20s >/dev/null &&
        kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=180s >/dev/null || return 1
    [ "$(driver_node)" = "$1" ]
}

pod_node() { # pod_node <pod> -> its node, empty when unread
    kubectl get pod "$1" -n "$NAMESPACE" --request-timeout=10s -o jsonpath='{.spec.nodeName}' 2>/dev/null
}

drain_start() { # drain_start <node> -> drains it in the background; <work>/drain.end holds the second it succeeded
    rm -f "$work/drain.end" "$work/drain.log"
    lane_cordon "$1" || return 1
    (
        if kubectl drain "$1" --ignore-daemonsets --delete-emptydir-data --timeout=180s >"$work/drain.log" 2>&1; then
            date +%s >"$work/drain.end"
        fi
    ) &
    drain_pid=$!
}

drain_record() { # drain_record <case> <node> <t0> <held at> <settled at> -> one row; ? where an event was not observed
    local drained held=? settled=?
    drained="$(cat "$work/drain.end" 2>/dev/null)"
    if [ -n "$drained" ]; then drained=$((drained - $3)); else drained='?'; fi
    [ -n "$4" ] && held=$(($4 - $3))
    [ -n "$5" ] && settled=$(($5 - $3))
    [ "$held" != '?' ] && [ "$settled" != '?' ] || bad "$1: the recovery was measured" "held '${4:-}', settled '${5:-}'"
    printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$drained" "$held" "$settled" >>"$RECOVERY_TSV"
}

drain_restore() { # drain_restore -> every node schedulable again
    local node
    for node in $all_nodes; do lane_uncordon "$node" || bad "$node is schedulable again" 'kubectl uncordon failed'; done
}

tk_prepare

# D1. The driver's node is drained while the runner holds its barrier on another node.
begin_phase drain-driver
n="$RELEASE-d1"
if drain_place_driver "$WA" && drain_isolate "$WA" "$WB" && lane_cordon "$WA"; then
    ok "d1: the driver runs on $WA and the runner is placed on $WB"
    d1="$(queue_job "factory-stub-patient factory-stub-wait-$TK_D$n.go")"
    tk_use "$d1"
    d1_pod="$(await_runner_pod "$d1")"
    if [ -z "$d1" ] || [ -z "$d1_pod" ]; then
        bad 'd1: the runner is running' "job '$d1': $(job_brief "$d1")"
    else
        await_blocked "$d1_pod" "$TK_D$n.go" && ok 'd1: the agent is running' || give_up
        tk_check "d1: the runner pod is on $WB" "$(pod_node "$d1_pod")" "$WB"
        # The replacement driver may land on any node but the drained one.
        drain_isolate "$WB" "$WC" || bad 'd1: the other workers are schedulable' 'kubectl uncordon failed'
        t0=$(date +%s)
        drain_start "$WA" || bad 'd1: the drain starts' "$(cat "$work/drain.log" 2>/dev/null)"
        held_at=''
        until=$((t0 + 300))
        while [ "$(date +%s)" -lt "$until" ]; do
            case "$(driver_logs)" in *"job $d1: $TOOK_OVER"*)
                held_at=$(date +%s)
                break
                ;;
            esac
            sleep 1
        done
        [ -n "$held_at" ] && ok 'd1: the replacement driver takes over the running agent' ||
            bad 'd1: the replacement driver takes over the running agent' "$(driver_logs | grep -F "job $d1:" | tail -5)"
        wait "$drain_pid" 2>/dev/null
        drain_pid=''
        [ -f "$work/drain.end" ] && ok "d1: $WA is drained" || bad "d1: $WA is drained" "$(tail -5 "$work/drain.log" 2>/dev/null)"
        tk_touch "$TK_D$n.go" || bad 'd1: the barrier is released' 'the touch failed'
        tk_settled d1 "$d1" "$DRAINED"
        tk_check 'd1: the agent ran once' "$(tk_final tk_ready "$TK_D$n.go.ready-")" 1
        drain_record D1 "$WA" "$t0" "$held_at" "$tk_settled_at"
    fi
else
    bad 'd1: the driver runs on the first worker' "driver on '$(driver_node)'"
fi
drain_restore

# D2. The runner's node is drained while the driver survives elsewhere.
begin_phase drain-runner
n="$RELEASE-d2"
if drain_place_driver "$WA" && drain_isolate "$WA" "$WB" && lane_cordon "$WA"; then
    ok "d2: the driver runs on $WA and the runner is placed on $WB"
    d2="$(queue_job "factory-stub-patient factory-stub-wait-$TK_D$n.go")"
    tk_use "$d2"
    d2_pod="$(await_runner_pod "$d2")"
    if [ -z "$d2" ] || [ -z "$d2_pod" ]; then
        bad 'd2: the runner is running' "job '$d2': $(job_brief "$d2")"
    else
        await_blocked "$d2_pod" "$TK_D$n.go" && ok 'd2: the agent is running' || give_up
        tk_check "d2: the runner pod is on $WB" "$(pod_node "$d2_pod")" "$WB"
        # The replacement runner may land on any node but the drained one and the control plane.
        drain_isolate "$WA" "$WC" || bad 'd2: the other workers are schedulable' 'kubectl uncordon failed'
        t0=$(date +%s)
        drain_start "$WB" || bad 'd2: the drain starts' "$(cat "$work/drain.log" 2>/dev/null)"
        held_at=''
        until=$((t0 + 300))
        returned=''
        while [ "$(date +%s)" -lt "$until" ]; do
            # The task volume is bound to the node it was provisioned on (kind's local-path), so the replacement
            # runner can only resume where the volume is: the drained node returns once the drain is done.
            [ -z "$returned" ] && [ -f "$work/drain.end" ] && lane_uncordon "$WB" && returned=1
            second="$(tk_claim_jobs "$d2" 2)" && [ -n "$second" ] &&
                [ "$(kubectl get pods -l "job-name=$second" -n "$NAMESPACE" --request-timeout=10s \
                    -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{end}' 2>/dev/null)" != '' ] &&
                [ "$(tk_ready "$TK_D$n.go.ready-")" = 2 ] && {
                held_at=$(date +%s)
                break
            }
            sleep 1
        done
        [ -n "$held_at" ] && ok 'd2: the replacement runner holds the barrier again' ||
            bad 'd2: the replacement runner holds the barrier again' "job: $(job_brief "$d2"), markers: $(tk_ready "$TK_D$n.go.ready-")"
        wait "$drain_pid" 2>/dev/null
        drain_pid=''
        [ -f "$work/drain.end" ] && ok "d2: $WB is drained" || bad "d2: $WB is drained" "$(tail -5 "$work/drain.log" 2>/dev/null)"
        tk_touch "$TK_D$n.go" || bad 'd2: the barrier is released' 'the touch failed'
        tk_settled d2 "$d2" "$POD_LOST before it exited"
        drain_record D2 "$WB" "$t0" "$held_at" "$tk_settled_at"
    fi
else
    bad 'd2: the driver runs on the first worker' "driver on '$(driver_node)'"
fi
drain_restore
fi
