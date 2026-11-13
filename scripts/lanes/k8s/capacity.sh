if selected_phase capacity; then
begin_phase capacity
# --- Competing driver replicas under one shared budget ------------------------------
#
# The dashboard runs with ADMISSION_MAX_RUNNING=2 and the driver Deployment with two replicas, each
# able to run two tasks: four against a budget of two. A heavy member queues three tasks before a light
# member queues one, while no driver exists. The light task must start while the heavy member still
# queues, the running rows must never pass the budget (a sampler reads them every two seconds into
# `<timings>.capacity.tsv`), and the driver pod holding the first heavy task is deleted hard: its row
# keeps its slot, so no queued task is admitted, until the surviving replica takes the running agent
# over. Draining the barriers hands the freed slots on in turn, and every task succeeds. Two dashboard
# replicas have their own phase (replicas.sh); the docker lane runs two boards.

echo
echo '# capacity'

CAP_RELEASE="/task/.lane-cap-$RELEASE"
CAP_SAMPLES="${TIMINGS_FILE%.tsv}.capacity.tsv"
capacity_sampler_pid=''
cap_heavy_token=''
cap_light_token=''

cap_running() { # cap_running -> how many non-review tasks run, as the database counts them
    lane_psql "select count(*) from job where status = 'running' and review_of is null"
}

cap_heavy() { FACTORY_TOKEN="$cap_heavy_token" "$@"; } # cap_heavy <function> [arg...] -> the call, as the heavy member
cap_light() { FACTORY_TOKEN="$cap_light_token" "$@"; } # cap_light <function> [arg...] -> the call, as the light member

cap_board_ready() { # cap_board_ready <seconds> -> success once the board answers migrated through the forward
    local until=$(($(date +%s) + $1))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(http_status GET "$BASE/api/ready")" = '200' ] && return 0
        sleep 1
    done
    return 1
}

cap_mint() { # cap_mint <login> -> CAP_MEMBER_TOKEN of a new org member tracking $SMOKE_REPO; non-zero with psql's answer
    local hash out
    read -r CAP_MEMBER_TOKEN hash < <(node -e '
const c = require("node:crypto");
const t = "fat_" + c.randomBytes(32).toString("base64url");
process.stdout.write(t + " " + c.createHash("sha256").update(t).digest("hex"));
')
    out="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        env PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' psql -q -v ON_ERROR_STOP=1 -v "login=$1" -v "hash=$hash" -v "owner=${SMOKE_REPO%%/*}" -v "name=${SMOKE_REPO#*/}" \
        postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
with o as (
    insert into organization (id, name) values (:'login', :'login') returning id
), u as (
    insert into app_user (github_user_id, github_login)
    values ((1000000000 + floor(random() * 1000000000000))::bigint, :'login') returning id
), m as (
    insert into org_membership (org_id, github_login, user_id, role, claimed_at)
    select o.id, :'login', u.id, 'member', now() from o, u
)
insert into access_token (org_id, kind, user_id, created_by, label, token_hash)
select o.id, 'personal', u.id, u.id, 'test-k8s', decode(:'hash', 'hex') from o, u;
insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
values (:'login', 'claude-code', 'test-k8s-capacity', :'owner' || '/' || :'name', 'main', now(), now());
SQL
    )" || {
        printf '%s' "$out"
        return 1
    }
}

cap_executors() { # cap_executors <function wrapper> -> the member stores the executor its tasks run under
    local until=$(($(date +%s) + 60))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$("$1" http_status PUT "$BASE/api/workspace/executors" \
            '{"executors":[{"name":"claude","type":"claude-code","config":{}}]}')" = '200' ] && return 0
        sleep 1
    done
    return 1
}

cap_rows() { # cap_rows -> the four tasks' scheduling rows, for a check that failed (diagnostics only)
    lane_psql "select id, status, claimed_by, claim_seq, lease_expires_at, org_id from job where id in ('$h1', '$h2', '$h3', '$l1') order by created_at" | tr '\n' ';'
}

cap_owner_of() { # cap_owner_of <job> -> the worker that held it when $owners was read; empty when it was not running
    printf '%s\n' "$owners" | sed -n "s/^$1|//p"
}

cap_hold_samples() { # cap_hold_samples <file> <readable rows wanted> -> success once the sampler has them, within 180 s
    local until=$(($(date +%s) + 180))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(grep -cE '^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$' "$1")" -ge "$2" ] && return 0
        sleep 1
    done
    return 1
}

cap_field() { # cap_field <json> <key>
    node -e 'try { process.stdout.write(String(JSON.parse(process.argv[1])[process.argv[2]] ?? "")); } catch {}' "$1" "$2"
}

cap_sample() { # cap_sample <file> -> one row every 2 s, until killed: <epoch>|<running>|<distinct global slots>|<running without one>, <epoch>|? when the read failed
    local row
    while sleep 2; do
        row="$(lane_psql "select count(*) || '|' || count(distinct admission_slot_global) || '|' || count(*) filter (where admission_slot_global is null) from job where status = 'running' and review_of is null")" ||
            row='?'
        printf '%s|%s\n' "$(date +%s)" "$row" >>"$1"
    done
}

cap_wrap() { # cap_wrap <job> -> the wrapper of the member who owns it
    if [ "$1" = "$l1" ]; then printf cap_light; else printf cap_heavy; fi
}

cap_job() { # cap_job <h1|h2|h3|l1> -> its job id
    case "$1" in h1) printf '%s' "$h1" ;; h2) printf '%s' "$h2" ;; h3) printf '%s' "$h3" ;; l1) printf '%s' "$l1" ;; esac
}

cap_try_release() { # cap_try_release <release file> <job> -> success once its runner stands at the barrier and the file is touched
    local name pod
    name="$(first_runner_job "$2")"
    [ -n "$name" ] || return 1
    pod="$(kubectl get pods -l "job-name=$name" -n "$NAMESPACE" --request-timeout=10s \
        -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{end}' 2>/dev/null)"
    [ -n "$pod" ] || return 1
    bounded 20 kubectl exec "$pod" -c supervisor -n "$NAMESPACE" --request-timeout=10s -- test -f "$1.ready-$pod" >/dev/null 2>&1 || return 1
    bounded 20 kubectl exec "$pod" -c supervisor -n "$NAMESPACE" --request-timeout=10s -- touch "$1" >/dev/null 2>&1
}

cap_state() { # cap_state <job> -> its status once the board answered, retried for 30 s; non-zero when it never did
    local until=$(($(date +%s) + 30)) brief state
    while [ "$(date +%s)" -lt "$until" ]; do
        brief="$("$(cap_wrap "$1")" job_brief "$1")"
        state="${brief%%|*}"
        case "$state" in '' | unread | undefined) ;; *)
            printf '%s' "$state"
            return 0
            ;;
        esac
        sleep 1
    done
    return 1
}

cap_kubectl() { # cap_kubectl <seconds> <what> <kubectl args...> -> the call, with a request timeout and an outer deadline; a failure is reported and returned
    local secs="$1" what="$2" out
    shift 2
    out="$(bounded "$secs" kubectl --request-timeout=20s "$@" 2>&1)" || {
        bad "capacity: $what" "${out:0:300}"
        return 1
    }
}

cap_rollout() { # cap_rollout <resource> <seconds> <what> -> the rollout settled within its own timeout, or reported and returned (a watch takes no request timeout)
    local out
    out="$(bounded $(($2 + 30)) kubectl rollout status "$1" -n "$NAMESPACE" --timeout="$2s" 2>&1)" || {
        bad "capacity: $3" "${out:0:300}"
        return 1
    }
}

cap_drivers_gone() { # cap_drivers_gone <seconds> -> success once a confirmed read lists no driver pod; an unread list is not "gone"
    local until=$(($(date +%s) + $1)) pods
    while [ "$(date +%s)" -lt "$until" ]; do
        pods="$(bounded 20 kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" --request-timeout=10s -o name 2>/dev/null)" && [ -z "$pods" ] && return 0
        sleep 1
    done
    return 1
}

cap_queued() { # cap_queued <wrapper> <job> -> success while the task is queued and has created no runner Job
    local created
    case "$("$1" job_brief "$2")" in queued\|*) ;; *) return 1 ;; esac
    # A lookup that failed is no proof of absence: the Jobs are listed with their status read, not through first_runner_job's pipe.
    created="$(kubectl get jobs -l "factory.job=$2,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --request-timeout=10s -o name 2>&1)" || return 1
    [ -z "$created" ]
}

cap_settled() { # cap_settled <label> <wrapper> <job> <owner> <lost owner> -> the checks every task shares once it ran to its end
    local want="succeeded|1|0||" got runs
    [ -n "$5" ] && [ "$4" = "$5" ] && want="succeeded|1|1|1|$EXPIRED"
    got="$("$2" await_brief "$3" 'succeeded*' 300)"
    [ "$got" = "$want" ] && ok "capacity $1: the task succeeds with $(printf '%s' "$want" | cut -d'|' -f3) interruptions" ||
        bad "capacity $1: the task succeeds with $(printf '%s' "$want" | cut -d'|' -f3) interruptions" \
            "status|attempts|count|claimSeq|reason: $got, want $want"
    # One persistent marker per agent execution (`<release file>.ready-<pod>`): a task restarted under recovery leaves two.
    tk_use "$3"
    runs="$(tk_final tk_ready "$CAP_RELEASE-$1.ready-")"
    [ "$runs" = 1 ] && ok "capacity $1: the agent ran once" || bad "capacity $1: the agent ran once" "$runs execution markers, want 1"
}

cap_run() {
    local state running owners owners_known h2_owner h3_owner n pending left l1_wave queued_jobs h1 h2 h3 l1 h1_pod l1_pod h2_pod h3_pod h1_owner l1_owner victim='' kill_at='' took_at='' until verdict
    local heavy light
    running="$(lane_psql "select count(*) from job where status in ('running', 'queued') and review_of is null")" && [ "$running" = 0 ] || {
        bad 'capacity: the board starts with no running or queued task' "rows: $running"
        return 1
    }

    # The budget lives on the dashboard: set, rolled out, and the forward re-pointed at the new pod.
    cap_kubectl 40 'the budget is set on the dashboard' set env "deployment/$RELEASE-factory" -n "$NAMESPACE" ADMISSION_MAX_RUNNING=2 || return 1
    cap_rollout "deployment/$RELEASE-factory" 180 'the dashboard rolls out with the budget' || return 1
    kill "$pf_pid" 2>/dev/null
    wait "$pf_pid" 2>/dev/null
    start_port_forward
    cap_board_ready 120 && ok 'capacity: the board answers under a budget of two' ||
        {
            bad 'capacity: the board answers under a budget of two' "$(tail -3 "$PF_LOG")"
            return 1
        }

    heavy="cap-heavy-$(openssl rand -hex 4)"
    light="cap-light-$(openssl rand -hex 4)"
    cap_mint "$heavy" >"$work/capacity-mint.log" || {
        bad 'capacity: the heavy member is minted' "$(cat "$work/capacity-mint.log")"
        return 1
    }
    cap_heavy_token="$CAP_MEMBER_TOKEN"
    cap_mint "$light" >"$work/capacity-mint.log" || {
        bad 'capacity: the light member is minted' "$(cat "$work/capacity-mint.log")"
        return 1
    }
    cap_light_token="$CAP_MEMBER_TOKEN"
    ok 'capacity: two members are minted'
    cap_executors cap_heavy && cap_executors cap_light && ok 'capacity: both members store the task executor' || {
        bad 'capacity: both members store the task executor' 'PUT /api/workspace/executors never answered 200'
        return 1
    }

    # No driver exists while the four tasks queue, so the order the claim picks them in is the claim's own.
    cap_kubectl 40 'the drivers are scaled to none' scale "$DRIVER_DEPLOY" -n "$NAMESPACE" --replicas=0 || return 1
    cap_drivers_gone 90 || {
        bad 'capacity: no driver pod stands while the tasks queue' "$(bounded 20 kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" --request-timeout=10s 2>&1 | tail -3)"
        return 1
    }
    h1="$(cap_heavy queue_job "factory-stub-patient factory-stub-wait-$CAP_RELEASE-h1")"
    h2="$(cap_heavy queue_job "factory-stub-patient factory-stub-wait-$CAP_RELEASE-h2")"
    h3="$(cap_heavy queue_job "factory-stub-patient factory-stub-wait-$CAP_RELEASE-h3")"
    l1="$(cap_light queue_job "factory-stub-patient factory-stub-wait-$CAP_RELEASE-l1")"
    [ -n "$h1" ] && [ -n "$h2" ] && [ -n "$h3" ] && [ -n "$l1" ] || {
        bad 'capacity: the four tasks are queued' "h1 '$h1' h2 '$h2' h3 '$h3' l1 '$l1'"
        return 1
    }
    cap_jobs="$h1 $h2 $h3 $l1"
    ok 'capacity: the four tasks are queued'

    : >"$CAP_SAMPLES"
    cap_sample "$CAP_SAMPLES" &
    capacity_sampler_pid=$!
    cap_kubectl 40 'the drivers are scaled to two replicas' scale "$DRIVER_DEPLOY" -n "$NAMESPACE" --replicas=2 || return 1
    cap_rollout "$DRIVER_DEPLOY" 120 'two driver replicas roll out' || return 1

    # The first wave: both replicas race for it. Polls reading the same demand at once may both serve the heavy
    # member (docs/jobs.md), so the light member either made the first wave or must get the first slot freed.
    until=$(($(date +%s) + 90))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(cap_running)" = 2 ] && break
        sleep 1
    done
    sleep 10 # twenty polls of each replica against a full budget
    h1_pod="$(await_runner_pod "$h1")"
    [ -n "$h1_pod" ] && ok 'capacity: the first heavy task runs' ||
        bad 'capacity: the first heavy task runs' "$(cap_heavy job_brief "$h1")"
    running="$(cap_running)"
    [ "$running" = 2 ] && ok 'capacity: two run, the rest wait' || bad 'capacity: two run, the rest wait' "running rows: $running"
    l1_wave=''
    queued_jobs=''
    for n in "$h2" "$h3" "$l1"; do
        # A status that was never confirmed is no evidence either way: it fails, it does not drop the task from the checks.
        state="$(cap_state "$n")" || {
            bad 'capacity: the status of every task is confirmed' "no answer for $n"
            continue
        }
        case "$state" in
        running) [ "$n" != "$l1" ] || l1_wave=1; continue ;;
        queued) ;;
        *)
            bad 'capacity: a task not in the first wave is queued' "$n is $state"
            continue
            ;;
        esac
        queued_jobs="$queued_jobs $n"
        cap_queued "$(cap_wrap "$n")" "$n" && ok 'capacity: a task over the budget waits queued, with no runner Job' ||
            bad 'capacity: a task over the budget waits queued, with no runner Job' "$("$(cap_wrap "$n")" job_brief "$n")"
    done
    if [ -n "$l1_wave" ]; then
        l1_pod="$(await_runner_pod "$l1")"
        [ -n "$l1_pod" ] && ok 'capacity: the light member runs in the first wave' ||
            bad 'capacity: the light member runs in the first wave' "$(cap_light job_brief "$l1")"
    fi
    [ -z "$h1_pod" ] || await_blocked "$h1_pod" "$CAP_RELEASE-h1" >/dev/null || true
    [ -z "${l1_pod:-}" ] || await_blocked "$l1_pod" "$CAP_RELEASE-l1" >/dev/null || true

    # The crash: the replica holding the first heavy task (its worker name is its pod name) is deleted
    # hard. Read, not assumed: an owner that is no driver pod kills nothing.
    owners="$(lane_psql "select id, claimed_by from job where id in ('$h1', '$h2', '$h3', '$l1') and status = 'running' order by id")"
    owners_known=1
    [ "$(printf '%s\n' "$owners" | grep -c .)" = 2 ] || owners_known=''
    for n in $(printf '%s\n' "$owners" | cut -d'|' -f2); do
        [ -n "$n" ] || owners_known=''
    done
    [ -n "$owners_known" ] && ok 'capacity: the owner of every running task is known' ||
        bad 'capacity: the owner of every running task is known' "running owners read: $owners"
    h1_owner="$(cap_owner_of "$h1")"
    h2_owner="$(cap_owner_of "$h2")"
    h3_owner="$(cap_owner_of "$h3")"
    l1_owner="$(cap_owner_of "$l1")"
    if [ -n "$owners_known" ] && [ -n "$h1_owner" ] && kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" --request-timeout=10s -o name 2>/dev/null |
        grep -x "pod/$h1_owner" >/dev/null; then
        victim="$h1_owner"
        kill_driver_pods "pod/$victim" || bad 'capacity: the lost driver is confirmed stopped' "pod/$victim was not confirmed deleted and stopped"
        kill_at=$(date +%s)
        # Waiting the lease out would take the lane lease; its expiry is what a silent driver comes to. Done at once,
        # before the replacement rolls out; a lease that already ran out (or a claim already taken over) is read, not assumed.
        n="$(expire_claim_one "$h1")"
        if [ "$n" = 1 ]; then
            ok 'capacity: the lost driver lease is expired'
        elif [ "$(lane_psql "select lease_expires_at <= now() or claim_seq > 1 from job where id = '$h1'")" = t ]; then
            ok 'capacity: the lost driver lease had already run out'
        else
            bad 'capacity: the lost driver lease is expired' "$n"
        fi
        cap_rollout "$DRIVER_DEPLOY" 120 'the replacement driver rolls out'
        took=''
        until=$(($(date +%s) + 300))
        while [ "$(date +%s)" -lt "$until" ]; do
            case "$(driver_logs)" in *"job $h1: $TOOK_OVER"*)
                took=1
                break
                ;;
            esac
            sleep 2
        done
        took_at=$(date +%s)
        [ -n "$took" ] && ok 'capacity: the surviving driver takes over the lost task' ||
            bad 'capacity: the surviving driver takes over the lost task' "$(driver_logs | grep -F "job $h1:" | tail -5)"
        running="$(cap_running)"
        [ "$running" = 2 ] && ok 'capacity: a crashed owner leaves the budget full, not exceeded' ||
            bad 'capacity: a crashed owner leaves the budget full, not exceeded' "running rows: $running"
        for n in $queued_jobs; do
            cap_queued "$(cap_wrap "$n")" "$n" && ok 'capacity: no queued task was admitted while the owner was lost' ||
                bad 'capacity: no queued task was admitted while the owner was lost' "$("$(cap_wrap "$n")" job_brief "$n")"
        done
    else
        bad 'capacity: the driver of the first heavy task is known' "claimed_by read '$h1_owner'"
    fi

    # Hold every barrier until the sampler has read enough rows, both through the crash and with the budget full.
    cap_hold_samples "$CAP_SAMPLES" 20 && ok 'capacity: the sampler read enough rows before the drain' ||
        bad 'capacity: the sampler read enough rows before the drain' "$(wc -l <"$CAP_SAMPLES") rows"

    # Drain: the first slot freed goes to the light member when the first wave raced to the heavy one, and
    # before any later heavy task is admitted; every task succeeds.
    release_stub "$CAP_RELEASE-h1"
    if [ -n "$l1_wave" ]; then
        h2_pod="$(await_runner_pod "$h2")"
        [ -n "$h2_pod" ] && ok 'capacity: the freed slot admits the next heavy task' ||
            bad 'capacity: the freed slot admits the next heavy task' "$(cap_heavy job_brief "$h2")"
    else
        l1_pod="$(await_runner_pod "$l1")"
        [ -n "$l1_pod" ] && cap_queued cap_heavy "$h3" &&
            ok 'capacity: the light member gets the next freed slot when the first wave raced to the heavy member' ||
            bad 'capacity: the light member gets the next freed slot when the first wave raced to the heavy member' \
                "light: $(cap_light job_brief "$l1"); last heavy: $(cap_heavy job_brief "$h3"); rows: $(cap_rows)"
    fi
    pending="h2 h3 l1"
    until=$(($(date +%s) + 300))
    while [ -n "$pending" ] && [ "$(date +%s)" -lt "$until" ]; do
        left=''
        for n in $pending; do
            cap_try_release "$CAP_RELEASE-$n" "$(cap_job "$n")" || left="$left $n"
        done
        pending="${left# }"
        [ -z "$pending" ] || sleep 1
    done
    [ -z "$pending" ] || bad 'capacity: every task ran and was released' "never ready: $pending"
    cap_settled h1 cap_heavy "$h1" "$h1_owner" "$victim"
    cap_settled h2 cap_heavy "$h2" "$h2_owner" "$victim"
    cap_settled h3 cap_heavy "$h3" "$h3_owner" "$victim"
    cap_settled l1 cap_light "$l1" "$l1_owner" "$victim"

    # The samples: the budget held on every row read, and the crash window was among them.
    kill "$capacity_sampler_pid" 2>/dev/null
    wait "$capacity_sampler_pid" 2>/dev/null
    capacity_sampler_pid=''
    verdict="$(node scripts/lane-capacity-samples.mjs "$CAP_SAMPLES" "${kill_at:-0}" "${took_at:-0}" 2 "$(date +%s)")"
    echo "capacity: samples $verdict"
    [ "$(cap_field "$verdict" readable)" -ge 20 ] 2>/dev/null && ok 'capacity: enough rows were read to mean it' ||
        bad 'capacity: enough rows were read to mean it' "$verdict"
    [ "$(cap_field "$verdict" over)" = 0 ] && [ "$(cap_field "$verdict" shared)" = 0 ] && [ "$(cap_field "$verdict" unslotted)" = 0 ] &&
        ok 'capacity: no sample is over the budget, shares a slot or runs without one' ||
        bad 'capacity: no sample is over the budget, shares a slot or runs without one' "$verdict"
    # One failed read costs its 15 s command deadline plus the tick: two of those are the longest stretch left unobserved.
    # A failed read inside the crash window, or a long stretch with none readable, leaves the budget unobserved: inconclusive is a failure.
    [ -n "$victim" ] && [ "$(cap_field "$verdict" window)" -ge 1 ] && [ "$(cap_field "$verdict" windowUnreadable)" = 0 ] &&
        [ "$(cap_field "$verdict" gap)" -le 40 ] 2>/dev/null &&
        ok 'capacity: the lost owner was sampled before the takeover' ||
        bad 'capacity: the lost owner was sampled before the takeover' "$verdict"
}

cap_jobs=''
cap_run
# Every path ends here: the sampler gone, the budget and the driver count back to the lane's, the forward re-pointed.
if [ -n "$capacity_sampler_pid" ]; then
    kill "$capacity_sampler_pid" 2>/dev/null
    wait "$capacity_sampler_pid" 2>/dev/null
    capacity_sampler_pid=''
fi
cap_kubectl 40 'the budget is removed from the dashboard' set env "deployment/$RELEASE-factory" -n "$NAMESPACE" ADMISSION_MAX_RUNNING= ||
    true
cap_rollout "deployment/$RELEASE-factory" 180 'the dashboard rolls out without the budget' || true
kill "$pf_pid" 2>/dev/null
wait "$pf_pid" 2>/dev/null
start_port_forward
cap_board_ready 120 || bad 'capacity: the board answers again without the budget' "$(tail -3 "$PF_LOG")"
cap_kubectl 40 'the drivers are back to one replica' scale "$DRIVER_DEPLOY" -n "$NAMESPACE" --replicas=1 || true
cap_rollout "$DRIVER_DEPLOY" 120 'one driver replica rolls out' || true
for job in $cap_jobs; do
    cap_kubectl 40 "the runner Jobs of $job are deleted" delete jobs -l "factory.job=$job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --ignore-not-found --wait=false || true
done
fi
