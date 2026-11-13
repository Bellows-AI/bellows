if [ "$PHASE" = replicas ]; then
begin_phase replicas
# --- Two dashboard replicas ---------------------------------------------------------
#
# Explicit only: the release is installed with dashboard.replicas=2 on an S3-compatible store of the
# lane's own (the filesystem artifact backend is one pod's /tmp), no node cordoned, so the chart's
# spread puts the boards on two nodes — a cluster made with `make cluster LAYOUT=drain` has four. a: both
# boards booted at once; both are Ready on different nodes, never restarted, and the migration ledger
# holds exactly the shipped versioned files, once each. b: two tasks hold a barrier, one board is
# deleted the way a node notice deletes it (gracefully), and two more tasks queue meanwhile; every task
# settles succeeded and none ends dead, the driver keeping the pod it had and reaching the surviving
# board through the Service. The lane's own reads move to the surviving pod first, so they never use
# the pod being deleted.

echo
echo '# two dashboard replicas'

REP_RELEASE="/task/.lane-rep-$RELEASE"
REP_SEL="app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=dashboard"

rep_pods() { # rep_pods -> one row per dashboard pod: name, node, Ready, restarts, deletionTimestamp; non-zero when unread
    bounded 30 kubectl get pods -l "$REP_SEL" -n "$NAMESPACE" --request-timeout=10s \
        -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.spec.nodeName}{"\t"}{.status.conditions[?(@.type=="Ready")].status}{"\t"}{.status.containerStatuses[0].restartCount}{"\t"}{.metadata.deletionTimestamp}{"\n"}{end}'
}

rep_await_ready() { # rep_await_ready <seconds> -> the rows of exactly two live Ready pods, each placed; non-zero on timeout
    local until=$(($(date +%s) + $1)) rows live total ready
    while [ "$(date +%s)" -lt "$until" ]; do
        rows="$(rep_pods)" && {
            live="$(printf '%s\n' "$rows" | awk -F'\t' '$5 == "" && $2 != "" && $3 == "True"')"
            total="$(printf '%s\n' "$rows" | awk 'NF' | wc -l)"
            ready="$(printf '%s\n' "$live" | awk 'NF' | wc -l)"
            [ "$((total))" = 2 ] && [ "$((ready))" = 2 ] && { printf '%s\n' "$live"; return 0; }
        }
        sleep 2
    done
    return 1
}

rep_kill_forward() { # rep_kill_forward -> the lane's port-forward stopped
    [ -z "${pf_pid:-}" ] && return 0
    kill "$pf_pid" 2>/dev/null
    wait "$pf_pid" 2>/dev/null
    pf_pid=''
}

rep_board_ready() { # rep_board_ready <seconds> -> success once the board answers migrated through the forward
    local until=$(($(date +%s) + $1))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(http_status GET "$BASE/api/ready")" = '200' ] && return 0
        sleep 1
    done
    return 1
}

rep_nodes() { # rep_nodes <rows> -> the distinct node count of the rows
    printf '%s\n' "$1" | awk -F'\t' 'NF && $2 != "" { seen[$2] = 1 } END { n = 0; for (k in seen) n++; print n }'
}

# a: the boards booted together.
rows="$(rep_await_ready 240)" && ok 'a: both dashboard replicas are Ready' ||
    bad 'a: both dashboard replicas are Ready' "pods: $(rep_pods 2>&1 | tr '\t\n' ' |')"
if [ -n "$rows" ]; then
    [ "$(rep_nodes "$rows")" = 2 ] && ok 'a: the replicas sit on two different nodes' ||
        bad 'a: the replicas sit on two different nodes' "pods: $(printf '%s\n' "$rows" | tr '\t\n' ' |')"
    [ "$(printf '%s\n' "$rows" | awk -F'\t' '$4 != "0"' | grep -c .)" = 0 ] && ok 'a: neither replica restarted' ||
        bad 'a: neither replica restarted' "pods: $(printf '%s\n' "$rows" | tr '\t\n' ' |')"
fi
shipped="$(cd "$REPO/server/migrations" && ls -1 | grep -v '\.repeatable\.sql$' | LC_ALL=C sort)" || shipped=''
recorded="$(lane_psql 'select version from schema_migrations order by version collate "C"')" || recorded="unread: $recorded"
if [ -z "$shipped" ]; then
    bad 'a: the migration ledger holds exactly the shipped versions' 'the shipped migration files could not be listed'
elif [ "$recorded" = "$shipped" ]; then
    ok 'a: the migration ledger holds exactly the shipped versions, once each'
else
    bad 'a: the migration ledger holds exactly the shipped versions' "ledger: $(printf '%.300s' "$recorded") | shipped: $(printf '%s\n' "$shipped" | wc -l) files"
fi
dupes="$(lane_psql 'select count(*) from (select version from schema_migrations group by version having count(*) > 1) d')" || dupes="unread: $dupes"
[ "$dupes" = 0 ] && ok 'a: no migration is recorded twice' || bad 'a: no migration is recorded twice' "duplicates: $dupes"

# b: one board is deleted while tasks run.
if [ -n "$rows" ]; then
    b1="$(queue_job "factory-stub-patient factory-stub-wait-$REP_RELEASE-b1")"
    b2="$(queue_job "factory-stub-patient factory-stub-wait-$REP_RELEASE-b2")"
    if [ -z "$b1" ] || [ -z "$b2" ]; then
        bad 'b: two barrier tasks are queued' "ids: '$b1' '$b2'"
    else
        b1_pod="$(await_runner_pod "$b1")"
        b2_pod="$(await_runner_pod "$b2")"
        if [ -z "$b1_pod" ] || [ -z "$b2_pod" ]; then
            bad 'b: both barrier tasks run' "runner pods: '$b1_pod' '$b2_pod'"
        else
            await_blocked "$b1_pod" "$REP_RELEASE-b1" >/dev/null && await_blocked "$b2_pod" "$REP_RELEASE-b2" >/dev/null &&
                ok 'b: both tasks hold their barrier'
        fi
        driver_before="$(bounded 30 kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" --request-timeout=10s \
            -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[*].restartCount}{"\n"}{end}')" || driver_before=''
        victim="$(printf '%s\n' "$rows" | awk -F'\t' 'NR == 1 { print $1 }')"
        survivor="$(printf '%s\n' "$rows" | awk -F'\t' 'NR == 2 { print $1 }')"
        survivor_node="$(printf '%s\n' "$rows" | awk -F'\t' 'NR == 2 { print $2 }')"
        # The lane reads through the survivor from here on; a forward to the Service may sit on the victim.
        rep_kill_forward
        start_port_forward "pod/$survivor"
        rep_board_ready 60 && ok 'b: the surviving board answers through the lane forward' ||
            bad 'b: the surviving board answers through the lane forward' "pod $survivor: $(tail -3 "$PF_LOG" 2>/dev/null)"
        if [ -n "$driver_before" ] && [ -n "$victim" ] && [ -n "$survivor" ]; then
            bounded 60 kubectl delete "pod/$victim" -n "$NAMESPACE" --wait=false --request-timeout=20s >/dev/null 2>&1 &&
                ok "b: the dashboard pod $victim is deleted" || bad "b: the dashboard pod $victim is deleted" 'kubectl delete failed'
            b3="$(queue_job 'factory-stub-patient')"
            b4="$(queue_job 'factory-stub-patient')"
            [ -n "$b3" ] && [ -n "$b4" ] && ok 'b: two more tasks queue while a board is gone' ||
                bad 'b: two more tasks queue while a board is gone' "ids: '$b3' '$b4'"
            release_stub "$REP_RELEASE-b1" || bad 'b: the first barrier is released' 'no pod stood at it'
            release_stub "$REP_RELEASE-b2" || bad 'b: the second barrier is released' 'no pod stood at it'
            for id in "$b1" "$b2" "$b3" "$b4"; do
                [ -n "$id" ] || continue
                got="$(await_brief "$id" 'succeeded*' 300)" && ok "b: task $id settles succeeded" ||
                    bad "b: task $id settles succeeded" "brief: $got"
                case "$got" in dead*) bad "b: task $id is not dead" "$got" ;; esac
            done
            driver_after="$(bounded 30 kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" --request-timeout=10s \
                -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[*].restartCount}{"\n"}{end}')" || driver_after='unread'
            [ "$driver_after" = "$driver_before" ] && ok 'b: the driver kept its pod and never restarted' ||
                bad 'b: the driver kept its pod and never restarted' "before: $driver_before after: $driver_after"
            after="$(rep_await_ready 240)" && ok 'b: two dashboard replicas are Ready again' ||
                bad 'b: two dashboard replicas are Ready again' "pods: $(rep_pods 2>&1 | tr '\t\n' ' |')"
            if [ -n "$after" ]; then
                [ "$(rep_nodes "$after")" = 2 ] && ok 'b: the replacement runs on another node than the survivor' ||
                    bad 'b: the replacement runs on another node than the survivor' "survivor on $survivor_node, pods: $(printf '%s\n' "$after" | tr '\t\n' ' |')"
            fi
        else
            bad 'b: the dashboard pods and the driver are read' "victim '$victim', survivor '$survivor', driver '$driver_before'"
        fi
    fi
fi
# The forward goes back to the Service for whatever runs after.
rep_kill_forward
start_port_forward
fi
