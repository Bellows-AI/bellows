if [ "$PHASE" = bench ]; then
begin_phase bench
# --- Throughput and recovery on one laptop's kind cluster (issue #831) ----------------------------
#
# Cells of N tasks (1, 4, 8, 16) against R driver replicas (1, 2) at the chart's production poll, lease
# and reaper values, one dashboard replica (the chart default, docs/kubernetes.md), tasks that hold a
# slot for a minute and write no barrier (`factory-stub-sleep-60`, scripts/k8s-stub.sh). Beside the
# timings it writes `<timings>.bench/<cell>.*` (scripts/bench-summary.mjs documents the files) and
# `<timings>.bench.tsv`. A recovery cell kills the driver that holds the tasks and reads seconds until
# every claim moved on (held) and until every task settled. Explicit only, never part of `all`: it
# takes the host for an hour or more. Every read is bounded and a failed one is `?`, never zero.

echo
echo '# bench'

BENCH_DIR="${TIMINGS_FILE%.tsv}.bench"
BENCH_TSV="${TIMINGS_FILE%.tsv}.bench.tsv"
# A fresh directory: a file left by an earlier run is never evidence for this one.
rm -rf -- "${BENCH_DIR:?}" "${BENCH_TSV:?}"
mkdir -p "$BENCH_DIR"
bench_sampler_pid=''
BENCH_TASK_S=60
BENCH_RECOVERY_TASK_S=180
BENCH_STEADY_S=30

# The chart's own production values for the driver's pace, read from its defaults and never typed here.
bench_default() { # bench_default <driver key> -> its default, digits only; empty when the chart does not say
    helm show values charts/factory 2>/dev/null | sed -n "s/^    $1: '\{0,1\}\([0-9][0-9]*\)'\{0,1\}\$/\1/p" | sed -n 1p
}

bench_psql() { # bench_psql <sql> -> the answer, unaligned; non-zero when the read failed
    bounded 15 kubectl exec -n "$NAMESPACE" --request-timeout=10s "statefulset/$STATE_RELEASE-postgres" -- \
        env PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' psql -qtA -v ON_ERROR_STOP=1 postgres://factory:factory@127.0.0.1:5432/factory_dev -c "$1" 2>&1
}

bench_sample() { # bench_sample <file> <deadline epoch> -> one row a second until the deadline: <epoch>|<lock waiters>|<ungranted locks>|<active backends>, <epoch>|? when the read failed
    local row
    while [ "$(date +%s)" -lt "$2" ]; do
        row="$(bench_psql "select count(*) filter (where wait_event_type = 'Lock') || '|' || (select count(*) from pg_locks where not granted) || '|' || count(*) filter (where state = 'active') from pg_stat_activity where datname = 'factory_dev'")" ||
            row='?'
        printf '%s|%s\n' "$(date +%s)" "$row" >>"$1"
        sleep 1
    done
}

bench_stop_sampler() {
    if [ -n "$bench_sampler_pid" ]; then
        kill "$bench_sampler_pid" 2>/dev/null
        wait "$bench_sampler_pid" 2>/dev/null
        bench_sampler_pid=''
    fi
}

bench_pods() { # bench_pods <component> -> the ready, non-terminating pods of the component, one a line; non-zero when the list was not read
    local json
    json="$(bounded 25 kubectl get pods -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=$1" -n "$NAMESPACE" --request-timeout=15s -o json 2>/dev/null)" || return 1
    printf '%s' "$json" | node -e '
let s = "";
process.stdin.on("data", (c) => (s += c)).on("end", () => {
    try {
        for (const p of JSON.parse(s).items) {
            const ready = (p.status?.conditions ?? []).some((c) => c.type === "Ready" && c.status === "True");
            if (p.status?.phase === "Running" && ready && !p.metadata.deletionTimestamp) console.log(p.metadata.name);
        }
    } catch { process.exit(1); }
});'
}

# The scrape runs inside the pod and reads the board token from the pod's own environment: it is in no argv here.
BENCH_SCRAPE_JS='fetch(process.argv[1], { headers: { authorization: "Bearer " + process.env.JOB_BOARD_TOKEN }, signal: AbortSignal.timeout(8000) })
    .then(async (r) => { if (r.status !== 200) process.exit(3); process.stdout.write(await r.text()); })
    .catch(() => process.exit(4));'

bench_scrape() { # bench_scrape <cell> <s|a|b|c> -> the pods listed (<cell>.<board|driver>.<stage>.list) and each one's metrics (<pod>.prom) with the epoch second it answered (<pod>.at); every file is dropped first, so a scrape that fails leaves none
    local spec comp name container port path pod pods file list
    for spec in dashboard:board:dashboard:8080:/api/metrics driver:driver:driver:9464:/metrics; do
        IFS=: read -r comp name container port path <<<"$spec"
        list="$BENCH_DIR/$1.$name.$2.list"
        rm -f -- "${list:?}"
        pods="$(bench_pods "$comp")" || continue
        printf '%s\n' "$pods" >"$list"
        for pod in $pods; do
            file="$BENCH_DIR/$1.$name-$pod.$2"
            rm -f -- "${file:?}.prom" "${file:?}.at" "${file:?}.prom.tmp"
            if bounded 30 kubectl exec "$pod" -c "$container" -n "$NAMESPACE" --request-timeout=10s -- node -e "$BENCH_SCRAPE_JS" "http://127.0.0.1:$port$path" >"$file.prom.tmp" 2>/dev/null &&
                [ -s "$file.prom.tmp" ]; then
                date +%s >"$file.at"
                mv "$file.prom.tmp" "$file.prom"
            else
                rm -f -- "${file:?}.prom.tmp" "${file:?}.at"
            fi
        done
    done
}

bench_count() { # bench_count <ids sql> <condition> -> how many of the tasks match; non-zero when the read failed
    local out
    out="$(bench_psql "select count(*) from job where id in ($1) and $2")" || return 1
    case "$out" in '' | *[!0-9]*) return 1 ;; esac
    printf '%s' "$out"
}

bench_wait() { # bench_wait <seconds> <ids sql> <condition> <want> -> success once exactly <want> tasks match; a failed read is another poll, never a count
    local until=$(($(date +%s) + $1)) got
    while [ "$(date +%s)" -lt "$until" ]; do
        got="$(bench_count "$2" "$3")" && [ "$got" = "$4" ] && return 0
        sleep 1
    done
    return 1
}

bench_rollout() { # bench_rollout <resource> <seconds> -> the rollout settled within its own timeout
    bounded $(($2 + 30)) kubectl rollout status "$1" -n "$NAMESPACE" --timeout="$2s" >/dev/null 2>&1
}

# The cell's settings: R driver replicas at the chart's production pace, with the lane's own rebind grace.
bench_upgrade() { # bench_upgrade <replicas> -> the release at that replica count, rolled out and answering
    local out until pods
    out="$(bounded 300 helm upgrade "$RELEASE" charts/factory --reuse-values -n "$NAMESPACE" \
        --set "driver.replicas=$1" --set-string driver.concurrency=16 \
        --set-string "driver.pollMs=$BENCH_POLL_MS" --set-string "driver.leaseSeconds=$BENCH_LEASE_S" \
        --set-string "driver.reapIntervalMs=$BENCH_REAP_INTERVAL_MS" --set-string "driver.reapGraceMs=$BENCH_REAP_GRACE_MS" 2>&1)" || {
        bad "bench: the release is upgraded to $1 driver replicas" "${out:0:300}"
        return 1
    }
    bench_rollout "$DRIVER_DEPLOY" 180 || {
        bad "bench: $1 driver replicas roll out" "$(bounded 20 kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" --request-timeout=10s 2>&1 | tail -4)"
        return 1
    }
    until=$(($(date +%s) + 90))
    while [ "$(date +%s)" -lt "$until" ]; do
        pods="$(bench_pods driver | wc -l | tr -d ' ')" && [ "$pods" = "$1" ] && [ "$(http_status GET "$BASE/api/ready")" = 200 ] && return 0
        sleep 1
    done
    bad "bench: $1 driver replicas are ready and the board answers" "$(bounded 20 kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" --request-timeout=10s 2>&1 | tail -4)"
    return 1
}

bench_dump() { # bench_dump <cell> <ids sql> -> <cell>.db.tsv: the tasks' rows as epoch seconds; absent when the read failed
    local out
    out="$(bench_psql "select id, extract(epoch from created_at), extract(epoch from started_at), extract(epoch from finished_at), status, attempts, claim_seq from job where id in ($2) order by created_at")" || {
        rm -f -- "${BENCH_DIR:?}/$1.db.tsv"
        return 1
    }
    { printf 'id\tcreated\tstarted\tfinished\tstatus\tattempts\tclaim_seq\n'; printf '%s\n' "$out" | tr '|' '\t'; } >"$BENCH_DIR/$1.db.tsv"
}

bench_meta() { # bench_meta <cell> <key> <value> -> one line of <cell>.meta.tsv
    printf '%s\t%s\n' "$2" "$3" >>"$BENCH_DIR/$1.meta.tsv"
}

bench_cell() { # bench_cell <throughput|recovery> <n> <r>
    local kind="$1" n="$2" r="$3" cell prefix ids ids_sql id i since task_s deadline running a_at b_at running_at_b settle_deadline until last
    local victim_pod victims victim_count moved t_kill held_deadline held='' got last
    prefix=t
    task_s=$BENCH_TASK_S
    if [ "$kind" = recovery ]; then
        prefix=r
        task_s=$BENCH_RECOVERY_TASK_S
    fi
    cell="$prefix-n$n-r$r"
    : >"$BENCH_DIR/$cell.meta.tsv"
    for i in kind=$kind n=$n r=$r pollMs=$BENCH_POLL_MS leaseSeconds=$BENCH_LEASE_S reapIntervalMs=$BENCH_REAP_INTERVAL_MS \
        reapGraceMs=$BENCH_REAP_GRACE_MS concurrency=16 taskSeconds=$task_s; do
        bench_meta "$cell" "${i%%=*}" "${i#*=}"
    done
    echo "# bench cell $cell"
    got="$(bench_psql "select count(*) from job where status in ('running', 'queued') and review_of is null")" && [ "$got" = 0 ] || {
        bad "bench $cell: the board starts with no running or queued task" "rows: $got"
        return 1
    }
    since="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    bench_scrape "$cell" s
    bench_stop_sampler
    : >"$BENCH_DIR/$cell.sampler.tsv"
    deadline=$(($(date +%s) + 1500))
    [ "$kind" = recovery ] && deadline=$((deadline + BENCH_LEASE_S))
    bench_sample "$BENCH_DIR/$cell.sampler.tsv" "$deadline" &
    bench_sampler_pid=$!
    ids=''
    ids_sql=''
    for _ in $(seq 1 "$n"); do
        id="$(queue_job "factory-stub-sleep-$task_s")"
        [ -n "$id" ] || {
            bad "bench $cell: $n tasks are queued" "the board refused a task after ${ids:-none}"
            bench_stop_sampler
            return 1
        }
        ids="$ids $id"
        ids_sql="${ids_sql:+$ids_sql,}'$id'"
    done
    ok "bench $cell: $n tasks are queued"

    if [ "$kind" = throughput ]; then
        bench_wait 300 "$ids_sql" "status = 'running'" "$n" && running=yes || running=no
        a_at="$(date +%s)"
        bench_scrape "$cell" a
        until=$((a_at + BENCH_STEADY_S))
        while [ "$(date +%s)" -lt "$until" ]; do sleep 1; done
        b_at="$(date +%s)"
        bench_scrape "$cell" b
        running_at_b="$(bench_count "$ids_sql" "status = 'running'")" || running_at_b=''
        bench_meta "$cell" running_at_b "$running_at_b"
        [ "$running" = yes ] && ok "bench $cell: all $n tasks run at once" || bad "bench $cell: all $n tasks run at once" "$running_at_b of $n running at the steady scrape"
        settle_deadline=420
    else
        bench_wait 300 "$ids_sql" "status = 'running'" "$n" || bad "bench $cell: all $n tasks run" "not all claimed within 300 s"
        # The claims run; the runner pods stand once the Jobs' pods do.
        until=$(($(date +%s) + 240))
        while [ "$(date +%s)" -lt "$until" ]; do
            got="$(bounded 25 kubectl get pods -l "factory.job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --request-timeout=15s \
                -o jsonpath='{range .items[?(@.status.phase=="Running")]}x{end}' 2>/dev/null)" && [ "${#got}" -ge "$n" ] && break
            sleep 1
        done
        sleep 10
        if [ "$r" = 1 ]; then
            victim_pod=''
            victims="$(bench_psql "select id, claim_seq from job where id in ($ids_sql) and status = 'running'")" || victims=''
        else
            victim_pod="$(bench_psql "select claimed_by from job where id in ($ids_sql) and status = 'running' order by created_at limit 1")" || victim_pod=''
            case "$victim_pod" in '' | *[!a-z0-9.-]*) victim_pod='' ;; esac
            victims="$(bench_psql "select id, claim_seq from job where id in ($ids_sql) and status = 'running' and claimed_by = '$victim_pod'")" || victims=''
        fi
        victim_count="$(printf '%s\n' "$victims" | grep -c '|')"
        if [ "$victim_count" -lt 1 ] || { [ "$r" != 1 ] && [ -z "$victim_pod" ]; }; then
            bad "bench $cell: a driver holds running tasks to kill" "victim '$victim_pod', rows: ${victims:0:200}"
            bench_stop_sampler
            return 1
        fi
        moved="$(printf '%s\n' "$victims" | awk -F'|' 'NF == 2 { printf "%s(\047%s\047, %s)", sep, $1, $2; sep = "," }')"
        t_kill="$(date +%s)"
        bench_meta "$cell" kill_at "$t_kill"
        bench_meta "$cell" victim_tasks "$victim_count"
        if { [ "$r" = 1 ] && kill_driver_pods; } || { [ "$r" != 1 ] && kill_driver_pods "pod/$victim_pod"; }; then
            bench_meta "$cell" kill_confirmed yes
        else
            # No recovery evidence from a kill nobody confirmed: the cell ends here and says so.
            bench_meta "$cell" kill_confirmed no
            bad "bench $cell: the driver kill is confirmed" "the driver identity read or the termination proof failed"
            bench_wait $((BENCH_LEASE_S + 600)) "$ids_sql" 'finished_at is not null' "$n" || true
            bench_stop_sampler
            bench_dump "$cell" "$ids_sql"
            return 1
        fi
        held_deadline=$((t_kill + BENCH_LEASE_S + 200))
        while [ "$(date +%s)" -lt "$held_deadline" ]; do
            got="$(bench_psql "select count(*) from job j join (values $moved) v(id, seq) on j.id = v.id::uuid where j.claim_seq > v.seq")" || got=''
            if [ "$got" = "$victim_count" ]; then
                held=$(($(date +%s) - t_kill))
                break
            fi
            sleep 2
        done
        if [ -n "$held" ]; then
            bench_meta "$cell" held_s "$held"
            ok "bench $cell: every claim of the lost driver moved on ($held s)"
        else
            bad "bench $cell: every claim of the lost driver moved on" "no confirmed advance within $((BENCH_LEASE_S + 200)) s of the kill"
        fi
        settle_deadline=$((t_kill + BENCH_LEASE_S + 780 - $(date +%s)))
        [ "$settle_deadline" -ge 60 ] || settle_deadline=60
        a_at="$t_kill"
    fi

    if bench_wait "$settle_deadline" "$ids_sql" 'finished_at is not null' "$n"; then
        if [ "$kind" = recovery ]; then
            # The last confirmed finish in the database, not the moment this loop noticed it.
            last="$(bench_psql "select floor(extract(epoch from max(finished_at))) from job where id in ($ids_sql)")" || last=''
            case "$last" in '' | *[!0-9]*) ;; *) [ "$last" -ge "$a_at" ] && bench_meta "$cell" settled_s "$((last - a_at))" ;; esac
        fi
        bench_wait 20 "$ids_sql" "status = 'succeeded'" "$n" && ok "bench $cell: every task succeeded" ||
            bad "bench $cell: every task succeeded" "$(bench_psql "select status, count(*) from job where id in ($ids_sql) group by status" | tr '\n' ';')"
    else
        bad "bench $cell: every task settles" "unsettled after the deadline: $(bench_psql "select status, count(*) from job where id in ($ids_sql) group by status" | tr '\n' ';')"
        for id in $(bench_psql "select id from job where id in ($ids_sql) and finished_at is null limit 3"); do kind_dump_stall "$id"; done
    fi
    bench_stop_sampler
    bench_scrape "$cell" c
    bench_dump "$cell" "$ids_sql"
    if bounded 40 kubectl get events -n "$NAMESPACE" -o json --request-timeout=20s 2>/dev/null |
        node scripts/k8s-pod-timeline.mjs "$since" '^factory-runner-' >"$BENCH_DIR/$cell.pods.tsv.tmp" 2>/dev/null; then
        mv "$BENCH_DIR/$cell.pods.tsv.tmp" "$BENCH_DIR/$cell.pods.tsv"
    else
        rm -f -- "${BENCH_DIR:?}/$cell.pods.tsv.tmp"
    fi
}

BENCH_POLL_MS="$(bench_default pollMs)"
BENCH_LEASE_S="$(bench_default leaseSeconds)"
BENCH_REAP_INTERVAL_MS="$(bench_default reapIntervalMs)"
BENCH_REAP_GRACE_MS="$(bench_default reapGraceMs)"
if [ -z "$BENCH_POLL_MS" ] || [ -z "$BENCH_LEASE_S" ] || [ -z "$BENCH_REAP_INTERVAL_MS" ] || [ -z "$BENCH_REAP_GRACE_MS" ]; then
    bad 'bench: the chart names its production poll, lease and reaper values' "pollMs '$BENCH_POLL_MS' leaseSeconds '$BENCH_LEASE_S' reapIntervalMs '$BENCH_REAP_INTERVAL_MS' reapGraceMs '$BENCH_REAP_GRACE_MS'"
else
    {
        echo "started $(date -u +%FT%TZ)"
        echo "load $(uptime)"
        sysctl -n hw.ncpu hw.memsize 2>/dev/null | tr '\n' ' '
        echo
        bounded 30 kubectl get nodes -o wide --request-timeout=15s 2>&1
        echo "values pollMs=$BENCH_POLL_MS leaseSeconds=$BENCH_LEASE_S reapIntervalMs=$BENCH_REAP_INTERVAL_MS reapGraceMs=$BENCH_REAP_GRACE_MS rebindGraceMs=$((LANE_REBIND_GRACE_S * 1000))"
    } >"$BENCH_DIR/environment.txt" 2>&1
    for bench_r in 1 2; do
        bench_upgrade "$bench_r" || continue
        for bench_n in 1 4 8 16; do bench_cell throughput "$bench_n" "$bench_r"; done
        for bench_n in 1 8; do bench_cell recovery "$bench_n" "$bench_r"; done
    done
    echo "finished $(date -u +%FT%TZ)" >>"$BENCH_DIR/environment.txt"
    echo "load $(uptime)" >>"$BENCH_DIR/environment.txt"
fi
bench_stop_sampler
node scripts/bench-summary.mjs "$BENCH_DIR" >"$BENCH_TSV" 2>"$work/bench-summary.err" && ok "bench: the summary is written to $BENCH_TSV" ||
    bad 'bench: the summary is written' "$(cat "$work/bench-summary.err")"
fi
