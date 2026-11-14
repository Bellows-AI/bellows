if selected_phase capacity; then
begin_phase capacity
# --- Competing drivers under one shared budget -----------------------------------
#
# Two AUTH_MODE=github boards and two drivers share one database and one admission budget
# (ADMISSION_MAX_RUNNING=2) while their own concurrency (2 + 2) would admit four. A heavy org queues
# three tasks before a light org queues one: the light task must start while the heavy org still
# waits, and the budget must hold on every row a once-a-second sampler reads. Then the driver that
# holds the first heavy task is killed (-9): its lease expires, its rows keep their slots until the
# survivor takes the running agent over, and no queued task is admitted past the budget meanwhile.
# Draining the barriers hands the freed slots on in turn, and every task runs exactly once.

echo
echo '# capacity'

CAP_DIR='/task/.lane-cap'
CAP_MK="mkdir -p $CAP_DIR;" # the volume is born at the claim: every command makes the directory first
CAP_TOKEN="drv_$(openssl rand -hex 32)" # the drivers' credential; their board records only its SHA-256
cap_pg=''
cap_a_pid=''
cap_b_pid=''
cap_board_pid=''
cap_sampler_pid=''
cap_heavy_token=''
cap_light_token=''
cap_light_job=''

cap_forget() { # cap_forget <pid> -> drops a stopped process from the list cleanup() kills
    local keep='' p
    for p in $lane_extra_pids; do [ "$p" = "$1" ] || keep="$keep $p"; done
    lane_extra_pids="${keep# }"
}

cap_stop() { # cap_stop <pid> -> the process gone, waited for, and no longer cleanup()'s to kill
    [ -n "$1" ] || return 0
    kill "$1" 2>/dev/null
    wait "$1" 2>/dev/null
    cap_forget "$1"
}

cap_psql() { # cap_psql <sql> -> the answer, unaligned; non-zero when the read failed
    timeout 10 docker exec -e PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' "$cap_pg" psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 -c "$1" 2>&1
}

cap_status() { # cap_status <job> -> its status once the board answered, retried for 30 s; non-zero when it never did
    local until=$(($(date +%s) + 30)) status
    while [ "$(date +%s)" -lt "$until" ]; do
        status="$(field "$(body "$(cap_api_job "$1")")" status)"
        [ -n "$status" ] && {
            printf '%s' "$status"
            return 0
        }
        sleep 1
    done
    return 1
}

cap_owner_of() { # cap_owner_of <job> -> the worker that held it when $owners was read; empty when it was not running
    printf '%s\n' "$owners" | sed -n "s/^$1|//p"
}

cap_hold_samples() { # cap_hold_samples <file> <readable rows wanted> -> success once the sampler has them, within 120 s
    local until=$(($(date +%s) + 120))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(grep -cE '^[0-9]+\|[0-9]+\|[0-9]+\|[0-9]+$' "$1")" -ge "$2" ] && return 0
        sleep 1
    done
    return 1
}

cap_running() { # cap_running -> how many non-review tasks run, as the database counts them
    cap_psql "select count(*) from job where status = 'running' and review_of is null"
}

cap_board() { # cap_board <port> <log> -> a shared-budget AUTH_MODE=github board; its pid in cap_board_pid
    env "${SECRET_STORE_ENV[@]}" DATABASE_URL="$DATABASE_URL" PORT="$1" HOST=127.0.0.1 \
        REPO_CLONE_BASE="$PLAN_BASE" \
        AUTH_MODE=github \
        GITHUB_OAUTH_CLIENT_ID=stub-client GITHUB_OAUTH_CLIENT_SECRET=stub-secret \
        SESSION_SECRET=a-job-harness-session-secret-32-chars \
        DRIVER_CREDENTIAL_SHA256="$(credential_sha256 "$CAP_TOKEN")" ADMISSION_MAX_RUNNING=2 \
        node server/dist/offline.js >>"$2" 2>&1 &
    cap_board_pid=$!
}

cap_up() { # cap_up <port> -> success once that board answers migrated, within 40 s
    local until=$(($(date +%s) + 40))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(status "$(BASE="http://127.0.0.1:$1" api GET /api/ready)")" = '200' ] && return 0
        sleep 1
    done
    return 1
}

cap_mint() { # cap_mint <login> -> CAP_MEMBER_TOKEN and CAP_MEMBER_USER of a new org member tracking $SMOKE_REPO; non-zero with psql's answer
    local hash out
    read -r CAP_MEMBER_TOKEN hash < <(node -e '
const c = require("node:crypto");
const t = "fat_" + c.randomBytes(32).toString("base64url");
process.stdout.write(t + " " + c.createHash("sha256").update(t).digest("hex"));
')
    out="$(timeout 30 docker exec -i -e PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' "$cap_pg" psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 \
        -v "login=$1" -v "hash=$hash" -v "owner=${SMOKE_REPO%%/*}" -v "name=${SMOKE_REPO#*/}" -f - 2>&1 <<'SQL'
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
select o.id, 'personal', u.id, u.id, 'test-jobs', decode(:'hash', 'hex') from o, u;
insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
values (:'login', 'claude-code', 'test-jobs-capacity', :'owner' || '/' || :'name', 'main', now(), now());
select user_id from org_membership where org_id = :'login';
SQL
    )" || {
        printf '%s' "$out"
        return 1
    }
    CAP_MEMBER_USER="$out"
    case "$CAP_MEMBER_USER" in
    ????????-????-????-????-????????????) ;;
    *)
        printf '%s' "no user id: $out"
        return 1
        ;;
    esac
}

cap_command() { # cap_command <name> -> a stub task that records its run, marks itself ready and holds until released
    printf '%s echo x >>%s/%s.ran; : >%s/%s.ready; %s; echo "ran in $HOSTNAME"' \
        "$CAP_MK" "$CAP_DIR" "$1" "$CAP_DIR" "$1" "$(lane_wait "$CAP_DIR/$1.go")"
}

cap_await_ready() { # cap_await_ready <job> <name> <seconds> -> success once the task's stub started
    lane_use "$1"
    lane_await_file "$3" "$CAP_DIR/$2.ready"
}

cap_release() { # cap_release <job> <name> -> the task's barrier opened
    lane_use "$1"
    lane_touch "$CAP_DIR/$2.go" || bad "capacity: $2's barrier is released" 'the touch failed'
}

cap_api_job() { # cap_api_job <job> -> the job's read, as the member who owns it: the github-mode boards refuse an anonymous one
    local bearer="Bearer $cap_heavy_token"
    [ "$1" = "$cap_light_job" ] && bearer="Bearer $cap_light_token"
    AUTH_HEADER="$bearer" api GET "/api/jobs/$1"
}

cap_await_settled() { # cap_await_settled <job> <seconds> -> its final status, read as its member
    local bearer="Bearer $cap_heavy_token"
    [ "$1" = "$cap_light_job" ] && bearer="Bearer $cap_light_token"
    AUTH_HEADER="$bearer" await_settled "$1" "$2"
}

cap_job() { # cap_job <h1|h2|h3|l1> -> its job id
    case "$1" in h1) printf '%s' "$h1" ;; h2) printf '%s' "$h2" ;; h3) printf '%s' "$h3" ;; l1) printf '%s' "$l1" ;; esac
}

cap_why() { # cap_why <job> -> what the board says about it, for a check that failed
    local job_json
    job_json="$(body "$(cap_api_job "$1")")"
    printf 'status %s, output: %s' "$(field "$job_json" status)" "$(field "$job_json" output)"
}

cap_settled() { # cap_settled <label> <job> <name> <owner> <lost owner> -> the checks every task shares once it ran to its end
    local job_json left
    expect_contains "capacity $1: the task succeeds" "$(cap_await_settled "$2" "$ADOPT_S")" succeeded
    job_json="$(body "$(cap_api_job "$2")")"
    expect_field "capacity $1: no attempt is spent" "$job_json" attempts 1
    # Only a task the killed driver held records an interruption, and exactly one.
    if [ -n "$5" ] && [ "$4" = "$5" ]; then
        [ "$(interruptions_of "$job_json")" = "1|1|$EXPIRED" ] && ok "capacity $1: one interruption records the lost lease" ||
            bad "capacity $1: one interruption records the lost lease" "count|claimSeq|reason: $(interruptions_of "$job_json")"
    else
        [ "$(interruptions_of "$job_json")" = '0||' ] && ok "capacity $1: no interruption" ||
            bad "capacity $1: no interruption" "count|claimSeq|reason: $(interruptions_of "$job_json")"
    fi
    lane_use "$2"
    dk_count "capacity $1: the task ran once" "$CAP_DIR/$3.ran" 1
    left="$(dk_clean "$2")" && ok "capacity $1: nothing of the task is left" ||
        bad "capacity $1: nothing of the task is left" "$left"
}

cap_sample() { # cap_sample <file> -> one row a second, until killed: <epoch>|<running>|<distinct global slots>|<running without one>, <epoch>|? when the read failed
    local row
    while sleep 1; do
        row="$(cap_psql "select count(*) || '|' || count(distinct admission_slot_global) || '|' || count(*) filter (where admission_slot_global is null) from job where status = 'running' and review_of is null")" ||
            row='?'
        printf '%s|%s\n' "$(date +%s)" "$row" >>"$1"
    done
}

cap_run() {
    local state running owners owners_known h2_owner h3_owner n tok until pending left l1_wave queued_jobs h1 h2 h3 l1 heavy light h1_owner l1_owner victim='' victim_name=''
    local h1_name="$RUN_ID-cap-h1" h2_name="$RUN_ID-cap-h2" h3_name="$RUN_ID-cap-h3" l1_name="$RUN_ID-cap-l1"
    local samples="$work/capacity.samples.log" kill_at='' took_at='' verdict

    # The budget counts every running row on the database: a leftover one is not this phase's to count around.
    # The docker executable itself under timeout, so the deadline kills the process holding the pipe; the compose project is the one compose() uses.
    cap_pg="$(timeout 30 docker ps -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME:-$(basename "$REPO" | tr '[:upper:]' '[:lower:]')}" \
        --filter label=com.docker.compose.service=postgres | sed -n 1p)"
    [ -n "$cap_pg" ] || {
        bad 'capacity: the postgres container is found' 'no running postgres container carries the compose project label'
        return 1
    }
    running="$(cap_psql "select count(*) from job where status in ('running', 'queued') and review_of is null")" && [ "$running" = 0 ] || {
        bad 'capacity: the board starts with no running or queued task' "rows: $running"
        return 1
    }

    # The open board hands its port pair to the two shared-budget boards, and gets it back at the end.
    kill "$server_pid" 2>/dev/null
    wait "$server_pid" 2>/dev/null
    server_pid=""
    cap_board "$PORT" "$work/capacity-board-a.log"
    server_pid=$cap_board_pid
    cap_up "$PORT" || {
        bad 'capacity: the first board came up' "$(tail -5 "$work/capacity-board-a.log")"
        return 1
    }
    cap_board "$CAP_LIGHT_PORT" "$work/capacity-board-b.log"
    lane_extra_pids="$lane_extra_pids $cap_board_pid"
    lane_extra_pids="${lane_extra_pids# }"
    cap_up "$CAP_LIGHT_PORT" && ok 'capacity: two boards share one budget' || {
        bad 'capacity: two boards share one budget' "$(tail -5 "$work/capacity-board-b.log")"
        return 1
    }

    # Two tenants of uneven demand: the heavy org queues three tasks, the light one a single task.
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
    ok 'capacity: two tenants are minted'
    for tok in "$cap_heavy_token" "$cap_light_token"; do
        AUTH_HEADER="Bearer $tok" expect_status 'capacity: the member stores the task executor' 200 PUT /api/workspace/executors \
            '{"executors":[{"name":"claude","type":"claude-code","config":{}},{"name":"opencode","type":"opencode","config":{}}]}'
    done

    # Queued before any driver exists, so the order the claim picks them in is the claim's own.
    h1="$(AUTH_HEADER="Bearer $cap_heavy_token" create_job "$(cap_command "$h1_name")")"
    h2="$(AUTH_HEADER="Bearer $cap_heavy_token" create_job "$(cap_command "$h2_name")")"
    h3="$(AUTH_HEADER="Bearer $cap_heavy_token" create_job "$(cap_command "$h3_name")")"
    l1="$(AUTH_HEADER="Bearer $cap_light_token" BASE="http://127.0.0.1:$CAP_LIGHT_PORT" create_job "$(cap_command "$l1_name")")"
    cap_light_job="$l1"
    [ -n "$h1" ] && [ -n "$h2" ] && [ -n "$h3" ] && [ -n "$l1" ] || {
        bad 'capacity: the four tasks are queued' "h1 '$h1' h2 '$h2' h3 '$h3' l1 '$l1'"
        return 1
    }
    printf '%s\n' "$h1" "$h2" "$h3" "$l1" >"$work/capacity-jobs"
    ok 'capacity: the four tasks are queued'

    # What the budget did to the running rows, once a second, from before the first claim to the last settle.
    : >"$samples"
    cap_sample "$samples" &
    cap_sampler_pid=$!
    lane_extra_pids="$lane_extra_pids $cap_sampler_pid"
    lane_extra_pids="${lane_extra_pids# }"

    # Both drivers start together and race for the first wave: polls reading the same demand at once may both
    # serve the heavy org (docs/jobs.md), so the light org either made the first wave or must get the first slot freed.
    disruption_driver DRIVER_WORKER=cap-a JOB_BOARD_URL="http://127.0.0.1:$PORT" DRIVER_CREDENTIAL="$CAP_TOKEN" \
        DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
    cap_a_pid=$driver_pid
    disruption_driver DRIVER_WORKER=cap-b JOB_BOARD_URL="http://127.0.0.1:$CAP_LIGHT_PORT" DRIVER_CREDENTIAL="$CAP_TOKEN" \
        DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
    cap_b_pid=$driver_pid
    driver_pid=""
    lane_extra_pids="$lane_extra_pids $cap_a_pid $cap_b_pid"
    lane_extra_pids="${lane_extra_pids# }"

    # The first wave: four drivers' worth of capacity, a budget of two.
    until=$(($(date +%s) + 90))
    running=''
    while [ "$(date +%s)" -lt "$until" ]; do
        running="$(cap_running)"
        [ "$running" = 2 ] && break
        sleep 1
    done
    sleep 10 # twenty polls of each driver against a full budget
    cap_await_ready "$h1" "$h1_name" 90 && ok 'capacity: the first heavy task runs' ||
        bad 'capacity: the first heavy task runs' "$(cap_why "$h1")"
    running="$(cap_running)"
    [ "$running" = 2 ] && ok 'capacity: two run, the rest wait' ||
        bad 'capacity: two run, the rest wait' "running rows: $running"
    l1_wave=''
    queued_jobs=''
    for n in "$h2" "$h3" "$l1"; do
        # A status that was never confirmed is no evidence either way: it fails, it does not drop the task from the checks.
        state="$(cap_status "$n")" || {
            bad 'capacity: the status of every task is confirmed' "no answer for $n: $(cap_why "$n")"
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
        lane_use "$n"
        [ "$(lane_vol_state)" = absent ] && ok 'capacity: a task over the budget waits queued, with no task volume' ||
            bad 'capacity: a task over the budget waits queued, with no task volume' "$(cap_why "$n"); volume $(lane_vol_state)"
    done
    if [ -n "$l1_wave" ]; then
        cap_await_ready "$l1" "$l1_name" 90 && ok 'capacity: the light org runs in the first wave' ||
            bad 'capacity: the light org runs in the first wave' "$(cap_why "$l1")"
    fi

    # The crash: whichever driver holds the first heavy task is killed outright. Read, not assumed: an unread owner kills nothing.
    # Every running task's owner is read together, once: a task's interruption is expected exactly when the killed driver held it.
    owners="$(cap_psql "select id, claimed_by from job where id in ('$h1', '$h2', '$h3', '$l1') and status = 'running' order by id")"
    owners_known=1
    [ "$(printf '%s\n' "$owners" | grep -c .)" = 2 ] || owners_known=''
    for n in $(printf '%s\n' "$owners" | cut -d'|' -f2); do
        case "$n" in cap-a | cap-b) ;; *) owners_known='' ;; esac
    done
    [ -n "$owners_known" ] && ok 'capacity: the owner of every running task is known' ||
        bad 'capacity: the owner of every running task is known' "running owners read: $owners"
    h1_owner="$(cap_owner_of "$h1")"
    h2_owner="$(cap_owner_of "$h2")"
    h3_owner="$(cap_owner_of "$h3")"
    l1_owner="$(cap_owner_of "$l1")"
    case "${owners_known:+$h1_owner}" in
    cap-a) victim=$cap_a_pid victim_name=cap-a ;;
    cap-b) victim=$cap_b_pid victim_name=cap-b ;;
    *) bad 'capacity: the driver of the first heavy task is known' "claimed_by read '$h1_owner'" ;;
    esac
    if [ -n "$victim" ]; then
        kill -9 "$victim" 2>/dev/null
        wait "$victim" 2>/dev/null
        cap_forget "$victim"
        kill_at=$(date +%s)
        dk_await_log "$h1" "$TOOK_OVER" "$ADOPT_S" && ok 'capacity: the surviving driver takes over the lost task' ||
            bad 'capacity: the surviving driver takes over the lost task' "$(grep -F "job $h1:" "$work/driver.log" | tail -5)"
        took_at=$(date +%s)
        # The lost rows kept their slots until now, so nothing over the budget was admitted meanwhile.
        running="$(cap_psql "select count(*) from job where status = 'running' and review_of is null")"
        [ "$running" = 2 ] && ok 'capacity: a crashed owner leaves the budget full, not exceeded' ||
            bad 'capacity: a crashed owner leaves the budget full, not exceeded' "running rows: $running"
        for n in $queued_jobs; do
            [ "$(field "$(body "$(cap_api_job "$n")")" status)" = queued ] &&
                ok 'capacity: no queued task was admitted while the owner was lost' ||
                bad 'capacity: no queued task was admitted while the owner was lost' "$(cap_why "$n")"
        done
    fi

    # Hold every barrier until the sampler has read enough rows, both through the crash and with the budget full.
    cap_hold_samples "$samples" 30 && ok 'capacity: the sampler read enough rows before the drain' ||
        bad 'capacity: the sampler read enough rows before the drain' "$(wc -l <"$samples") rows"

    # Drain: the first slot freed goes to the light org when the first wave raced to the heavy one, and
    # before any later heavy task is admitted; every task runs once.
    cap_release "$h1" "$h1_name"
    if [ -n "$l1_wave" ]; then
        cap_await_ready "$h2" "$h2_name" 90 && ok 'capacity: the freed slot admits the next heavy task' ||
            bad 'capacity: the freed slot admits the next heavy task' "$(cap_why "$h2")"
    else
        cap_await_ready "$l1" "$l1_name" 90 && [ "$(field "$(body "$(cap_api_job "$h3")")" status)" = queued ] &&
            ok 'capacity: the light org gets the next freed slot when the first wave raced to the heavy org' ||
            bad 'capacity: the light org gets the next freed slot when the first wave raced to the heavy org' \
                "light: $(cap_why "$l1"); last heavy: $(cap_why "$h3")"
    fi
    pending="h2 h3 l1"
    until=$(($(date +%s) + 300))
    while [ -n "$pending" ] && [ "$(date +%s)" -lt "$until" ]; do
        left=''
        for n in $pending; do
            lane_use "$(cap_job "$n")"
            if lane_has "$CAP_DIR/$RUN_ID-cap-$n.ready"; then
                cap_release "$(cap_job "$n")" "$RUN_ID-cap-$n"
            else
                left="$left $n"
            fi
        done
        pending="${left# }"
        [ -z "$pending" ] || sleep 1
    done
    [ -z "$pending" ] || bad 'capacity: every task ran and was released' "never ready: $pending"
    cap_settled h1 "$h1" "$h1_name" "$h1_owner" "$victim_name"
    cap_settled h2 "$h2" "$h2_name" "$h2_owner" "$victim_name"
    cap_settled h3 "$h3" "$h3_name" "$h3_owner" "$victim_name"
    cap_settled l1 "$l1" "$l1_name" "$l1_owner" "$victim_name"

    # The samples: the budget held on every row read, and the crash window was among them.
    cap_stop "$cap_sampler_pid"
    cap_sampler_pid=''
    verdict="$(node "$REPO/scripts/lane-capacity-samples.mjs" "$samples" "${kill_at:-0}" "${took_at:-0}" 2 "$(date +%s)")"
    echo "capacity: samples $verdict"
    [ "$(field "$verdict" readable)" -ge 30 ] 2>/dev/null && ok 'capacity: enough rows were read to mean it' ||
        bad 'capacity: enough rows were read to mean it' "$verdict"
    [ "$(field "$verdict" over)" = 0 ] && [ "$(field "$verdict" shared)" = 0 ] && [ "$(field "$verdict" unslotted)" = 0 ] &&
        ok 'capacity: no sample is over the budget, shares a slot or runs without one' ||
        bad 'capacity: no sample is over the budget, shares a slot or runs without one' "$verdict"
    # One failed read costs its 10 s command deadline plus the tick: three of those are the longest stretch left unobserved.
    # A failed read inside the crash window, or a long stretch with none readable, leaves the budget unobserved: inconclusive is a failure.
    [ -n "$victim" ] && [ "$(field "$verdict" window)" -ge 1 ] && [ "$(field "$verdict" windowUnreadable)" = 0 ] &&
        [ "$(field "$verdict" gap)" -le 30 ] 2>/dev/null &&
        ok 'capacity: the lost owner was sampled before the takeover' ||
        bad 'capacity: the lost owner was sampled before the takeover' "$verdict"
}

cap_run
# Every path ends here: the processes are gone, the containers of the four tasks removed, and the open board is back.
cap_stop "$cap_sampler_pid"
cap_stop "$cap_a_pid"
cap_stop "$cap_b_pid"
for job in $(cat "$work/capacity-jobs" 2>/dev/null); do
    leftovers="$(timeout 30 docker ps -aq --filter "label=factory.job=$job")" ||
        bad 'capacity: the containers of a task are listed for removal' "docker ps failed for $job"
    for container_id in $leftovers; do
        timeout 60 docker rm -f "$container_id" >/dev/null 2>&1 ||
            bad 'capacity: a leftover container is removed' "$container_id of $job"
    done
done
kill "$server_pid" 2>/dev/null
wait "$server_pid" 2>/dev/null
server_pid=""
for pid in $lane_extra_pids; do cap_stop "$pid"; done
start_open_board

fi
