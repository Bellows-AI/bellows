#!/usr/bin/env bash
# End-to-end for the job board and its driver.
#
#   scripts/test-jobs.sh [--phase workflows | --phase driver,services | --changed origin/main]
#
# Real HTTP, a real database, stub runners and real agent CLIs against a scripted model endpoint.
# No model credential or quota. Selected phases provision fixtures without running other phases.
#
# Runtime fixtures are removed; timings and process logs remain under artifacts/jobs/.
# Needs: docker and node; board phases also need compose Postgres. See --help.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

PHASE=all
PHASE_GIVEN=''
CHANGED_BASE=''
CLI_WORKERS=2
PARALLEL=''
PARALLEL_SLOTS=2
WATCH_STALLS="${LANE_WATCH_STALLS:-0}"
valid_phase() {
    case "$1" in
    board|driver|github-credential|services|orphan-reaper|node-disruption|driver-kill|run-deadline|capacity|review|workflows|acceptance|compose-driver|auth|cooperative-stop|tool-isolation|ask-user-question|question-round-trip) return 0 ;;
    esac
    return 1
}
while [ "$#" -gt 0 ]; do
    case "$1" in
    --phase)
        shift
        PHASE="${1:-}"
        PHASE_GIVEN=1
        # `all`, one phase, or a comma list of phases that share one board fixture.
        if [ "$PHASE" != all ]; then
            case ",$PHASE," in *,,*) PHASE='' ;; esac
            [ -n "$PHASE" ] || { echo 'test-jobs: invalid --phase (see --help)'; exit 2; }
            for phase in ${PHASE//,/ }; do
                valid_phase "$phase" || { echo 'test-jobs: invalid --phase (see --help)'; exit 2; }
            done
        fi
        ;;
    --changed)
        shift
        CHANGED_BASE="${1:-}"
        [ -n "$CHANGED_BASE" ] || { echo 'test-jobs: --changed needs a base ref (see --help)'; exit 2; }
        ;;
    --cli-workers)
        shift
        CLI_WORKERS="${1:-}"
        case "$CLI_WORKERS" in 1|2) ;; *) echo 'test-jobs: --cli-workers must be 1 or 2'; exit 2 ;; esac
        ;;
    --parallel) PARALLEL=1 ;;
    --slots)
        shift
        PARALLEL_SLOTS="${1:-}"
        case "$PARALLEL_SLOTS" in 2|3|4) ;; *) echo 'test-jobs: --slots must be 2, 3 or 4'; exit 2 ;; esac
        ;;
    --watch-stalls) WATCH_STALLS=1 ;;
    --help)
        echo 'Usage: scripts/test-jobs.sh [--phase PHASE[,PHASE...] | --changed BASE] [--cli-workers 1|2] [--watch-stalls] [--parallel [--slots 2|3|4]]'
        echo 'Phases: all (default), board, driver, github-credential, services, orphan-reaper,'
        echo '        node-disruption, run-deadline, review, workflows, acceptance, compose-driver, auth, cooperative-stop,'
        echo '        tool-isolation, ask-user-question, question-round-trip, driver-kill, capacity'
        echo 'A comma list (--phase driver,services) runs those phases, in lane order, on one board fixture.'
        echo '--changed BASE runs the phases scripts/test-jobs-changed.mjs maps from `git diff --name-only` since the merge base with BASE'
        echo '        (uncommitted and untracked files included), prints why, and falls back to the full lane for'
        echo '        shared files; an empty set runs nothing. For iteration and per-PR checks; the full lane'
        echo '        (no flag) runs at the end of a PR series and on main.'
        echo 'Each phase provisions its own prerequisites; standalone CLI phases need no database or build.'
        echo 'Standalone CLI cases use at most two workers; --cli-workers 1 runs them serially.'
        echo '--parallel runs the selected phases as groups (scripts/test-jobs-groups.mjs) on --slots concurrent slots (default 2): each group is'
        echo '        its own test-jobs.sh run with its own board fixture, database, run-specific names and a ten-port slice from PORT;'
        echo '        core, server and driver are built once, and the summary lists every group. Default stays serial.'
        echo 'TIMINGS_FILE overrides artifacts/jobs/<run>.tsv; check timings and process logs are saved beside it.'
        echo '--watch-stalls (or LANE_WATCH_STALLS=1) dumps every job container alive past LANE_STALL_S (default 120) seconds.'
        echo 'The run ends with a slow-jobs summary of attempts past LANE_SLOW_S (default 30) seconds, beside the timings.'
        exit 0
        ;;
    *) echo "test-jobs: unknown argument: $1"; exit 2 ;;
    esac
    shift
done
if [ -n "$CHANGED_BASE" ]; then
    [ -z "$PHASE_GIVEN" ] || { echo 'test-jobs: --changed and --phase are exclusive'; exit 2; }
    command -v node >/dev/null || { echo 'test-jobs: node is required'; exit 1; }
    chosen="$(node "$REPO/scripts/test-jobs-changed.mjs" "$CHANGED_BASE")" ||
        { echo "test-jobs: could not map the changes since $CHANGED_BASE"; exit 2; }
    case "$chosen" in
    '') echo "test-jobs: --changed $CHANGED_BASE selected no phase; nothing to run"; exit 0 ;;
    full) PHASE=all ;;
    *) PHASE="$chosen" ;;
    esac
    echo "test-jobs: --changed $CHANGED_BASE runs: $PHASE"
fi
selected_phase() {
    [ "$PHASE" = all ] && return 0
    case ",$PHASE," in *",$1,"*) return 0 ;; esac
    return 1
}
# The standalone CLI phases boot no board; any other selected phase does.
needs_board() {
    [ "$PHASE" = all ] && return 0
    for phase in ${PHASE//,/ }; do
        case "$phase" in cooperative-stop|tool-isolation|ask-user-question) ;; *) return 0 ;; esac
    done
    return 1
}

RUN_ID="$(date +%s)-$$"
PORT="${PORT:-8129}"
BASE="http://127.0.0.1:$PORT"
# The identity the host drivers of this run stamp on what they create (driver/src/task-volume.ts
# boardIdentity: a digest of JOB_BOARD_URL), so a check can look at its own board's objects only
# when other groups share the daemon (--parallel).
board_id() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 16))' "$BASE"; }
DB="${JOBS_TEST_DB:-factory_jobs_${RUN_ID//-/_}_test}"
DATABASE_URL="postgres://factory:factory@127.0.0.1:5432/$DB"
IMAGE_BASE="factory-jobs-$RUN_ID-base"
IMAGE_OK="factory-jobs-$RUN_ID-ok"
IMAGE_FAIL="factory-jobs-$RUN_ID-fail"
IMAGE_SVC="factory-jobs-$RUN_ID-svc"
IMAGE_RUN="factory-jobs-$RUN_ID-run"
IMAGE_REVIEW="factory-jobs-$RUN_ID-review"
IMAGE_GH="factory-jobs-$RUN_ID-github"
IMAGE_KILL="factory-jobs-$RUN_ID-kill"
IMAGE_ACC="factory-jobs-$RUN_ID-acceptance"
# The smoke origin (issue #775): a bare repository on a named volume, served by a git daemon on a
# network the runners join (RUNNER_NETWORK), because a runner clones its task's checkout onto its
# own task volume and mounts nothing else. REPO_CLONE_BASE names the daemon.
ORIGIN_VOLUME="factory-jobs-$RUN_ID-origins"
ORIGIN_NAME="factory-jobs-$RUN_ID-origin"
NETWORK="factory-jobs-$RUN_ID-net"
CLONE_BASE="git://$ORIGIN_NAME:9418"
COMPOSE_DRIVER="factory-jobs-$RUN_ID-compose-driver"
# The compose phase pins its own project name, so the volumes and network its `run` creates can be
# torn down by name without touching the stack services the script itself started (postgres).
COMPOSE_PROJECT="factory-jobs-$RUN_ID-compose"
# docker-compose.yml requires JOB_BOARD_TOKEN for the dashboard service, and compose interpolates the
# whole file on every call (on a current compose even `exec` into postgres), so every call goes
# through compose(). The compose phase's driver is started with the token cleared
# (`-e JOB_BOARD_TOKEN=`), like every host-driven one: this value only satisfies the parse.
COMPOSE_TOKEN="${JOB_BOARD_TOKEN:-test-jobs-compose-interpolation-only}"
compose() { JOB_BOARD_TOKEN="$COMPOSE_TOKEN" docker compose "$@"; }
# The repository every task runs against (issue #263): a ready selection on the board and, in the
# driver volume, a clone whose origin is a bare repository beside it — no GitHub, no network.
SMOKE_REPO="factory-smoke/demo"

pass=0
fail=0
server_pid=""
driver_pid=""
stall_watch_pid=""
mint_pid=""
compose_pid=""
supervisor_log_pid=""
db_created=""
lane_worker_pids=''
lane_extra_pids='' # processes a phase starts beyond the one board and driver, for cleanup() to kill
lane_worker_name=main
# Preflight before creating or removing any shared lane resource.
for tool in docker node timeout; do
    command -v "$tool" >/dev/null || { echo "test-jobs: $tool is required"; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'test-jobs: docker daemon is unavailable'; exit 1; }
images=''
if selected_phase cooperative-stop || selected_phase tool-isolation; then
    images='claude-executor opencode-executor'
elif selected_phase ask-user-question || selected_phase question-round-trip; then
    images='claude-executor'
fi
for image in $images; do
    docker image inspect "$image" >/dev/null 2>&1 || {
        echo "test-jobs: $image is missing — run make runners"
        exit 1
    }
done
if needs_board; then
    for tool in npm openssl; do
        command -v "$tool" >/dev/null || { echo "test-jobs: $tool is required"; exit 1; }
    done
    compose version >/dev/null 2>&1 || { echo 'test-jobs: the compose plugin is required'; exit 1; }
    [[ "$DB" =~ ^[a-z_][a-z0-9_]*_test$ ]] || { echo 'test-jobs: JOBS_TEST_DB must be a SQL identifier ending _test'; exit 2; }
fi

# Bring Postgres up and wait until it answers. --no-recreate: the stack's postgres is shared, and a
# run from another checkout carries another config hash, so a plain `up` would replace the container
# mid-write. A replaced one can spend most of a minute in crash recovery, hence the wait.
start_postgres() { # start_postgres <log>
    compose up -d --no-recreate postgres >"$1" 2>&1 || {
        echo 'test-jobs: could not start postgres'
        exit 1
    }
    local ready=''
    for _ in $(seq 1 120); do
        compose exec -T postgres pg_isready -U factory >/dev/null 2>&1 && { ready=1; break; }
        sleep 1
    done
    [ -n "$ready" ] || { echo 'test-jobs: postgres never became ready'; exit 1; }
}

build_workspaces() { # build_workspaces <log>
    npm run build -w core >"$1" 2>&1 && npm run build -w server >>"$1" 2>&1 &&
        npm run build -w driver >>"$1" 2>&1 || {
        echo 'test-jobs: build failed'
        exit 1
    }
}

# --parallel (issue #887): the selected phases as groups (scripts/test-jobs-groups.mjs), each one
# a separate `test-jobs.sh --phase` run — its own board fixture, database, images, network and
# volumes (RUN_ID) and a ten-port slice from PORT — dealt to --slots concurrent slots. The shared
# parts are done once here: Postgres, and the build of core, server and driver (every group runs from
# the same dist). The docker reaper of each group's driver sees only its own board's containers
# (the factory.board label), so groups on one daemon do not reap each other.
run_parallel() {
    local base_port="$PORT" stamp dir plan started slot slots pids='' pid code=0
    [ -z "${JOBS_TEST_DB:-}" ] ||
        { echo 'test-jobs: --parallel gives every group its own database; unset JOBS_TEST_DB'; exit 2; }
    plan="$(node "$REPO/scripts/test-jobs-groups.mjs" "$PARALLEL_SLOTS" "$PHASE")" ||
        { echo 'test-jobs: could not plan --parallel'; exit 2; }
    [ -n "$plan" ] || { echo 'test-jobs: --parallel has no phase to run'; exit 2; }
    stamp="$(date +%Y%m%d-%H%M%S)-$$"
    # TIMINGS_FILE names the run: its logs and each group's timings land beside it, in <name>-parallel/.
    dir="${TIMINGS_FILE:+${TIMINGS_FILE%.tsv}-parallel}"
    dir="${dir:-$REPO/artifacts/jobs/$stamp-parallel}"
    mkdir -p "$dir" || exit 1
    started=$SECONDS
    local prebuilt='' watch_flag=''
    [ "$WATCH_STALLS" = 1 ] && watch_flag=--watch-stalls
    if needs_board; then
        echo 'starting postgres'
        start_postgres "$dir/postgres.log"
        echo 'building core, server, driver'
        build_workspaces "$dir/build.log"
        prebuilt=1
    fi
    printf '%s\n' "$plan" | while IFS="$(printf '\t')" read -r slot name phases; do
        printf '[parallel] slot %s (PORT %s): %s = %s\n' "$slot" "$((base_port + 10 * slot))" "$name" "$phases"
    done
    slots="$(printf '%s\n' "$plan" | cut -f1 | sort -u)"
    : >"$dir/results.tsv"
    for slot in $slots; do
        (
            child=''
            trap '[ -z "$child" ] || kill -TERM "$child" 2>/dev/null; wait; exit 143' INT TERM
            while IFS="$(printf '\t')" read -r s name phases; do
                [ "$s" = "$slot" ] || continue
                group_started=$SECONDS
                env -u JOBS_TEST_DB TIMINGS_FILE="$dir/$name.tsv" PORT="$((base_port + 10 * slot))" TEST_JOBS_PREBUILT="$prebuilt" \
                    "$REPO/scripts/test-jobs.sh" --phase "$phases" --cli-workers "$CLI_WORKERS" \
                    $watch_flag \
                    >"$dir/$name.log" 2>&1 </dev/null &
                child=$!
                wait "$child"
                group_exit=$?
                printf '%s\t%s\t%s\t%s\n' "$name" "$phases" "$group_exit" "$((SECONDS - group_started))" >>"$dir/results.tsv"
                child=''
            done <<EOF_PLAN
$plan
EOF_PLAN
        ) &
        pids="$pids $!"
    done
    trap 'for pid in $pids; do kill -TERM "$pid" 2>/dev/null; done; wait; exit 130' INT TERM
    for pid in $pids; do wait "$pid"; done
    trap - INT TERM
    local passed=0 failed=0 name phases group_code seconds
    while IFS="$(printf '\t')" read -r name phases group_code seconds; do
        printf '[parallel] %s: exit %s in %ss (%s)\n' "$name" "$group_code" "$seconds" "$phases"
        [ "$group_code" -eq 0 ] || code=1
        passed=$((passed + $(grep -c '^ok ' "$dir/$name.log")))
        failed=$((failed + $(grep -c '^FAIL ' "$dir/$name.log")))
        if [ "$group_code" -ne 0 ]; then
            grep -A1 '^FAIL ' "$dir/$name.log" | head -n 40
            [ "$(grep -c '^FAIL ' "$dir/$name.log")" -gt 0 ] || tail -n 15 "$dir/$name.log"
        fi
    done <"$dir/results.tsv"
    [ "$(wc -l <"$dir/results.tsv" | tr -d ' ')" = "$(printf '%s\n' "$plan" | wc -l | tr -d ' ')" ] || code=1
    printf '[timing] parallel total: %ss over %s slots; logs and timings: %s\n' "$((SECONDS - started))" "$PARALLEL_SLOTS" "$dir"
    printf '\n%d passed, %d failed\n' "$passed" "$failed"
    return "$code"
}
if [ -n "$PARALLEL" ]; then
    run_parallel
    exit $?
fi

TIMINGS_FILE="${TIMINGS_FILE:-$REPO/artifacts/jobs/$(date +%Y%m%d-%H%M%S)-$$.tsv}"
CHECKS_FILE="${TIMINGS_FILE%.tsv}.checks.tsv"
LIFECYCLE_FILE="${TIMINGS_FILE%.tsv}.lifecycle.tsv"
mkdir -p "$(dirname "$TIMINGS_FILE")" || exit 1
printf 'phase\tseconds\n' >"$TIMINGS_FILE" || exit 1
printf 'phase\tseconds\tresult\tcheck\n' >"$CHECKS_FILE" || exit 1
printf 'phase\tcase\tstep\tseconds\texit\n' >"$LIFECYCLE_FILE" || exit 1
lane_started=$SECONDS
phase_name=''
phase_started=$SECONDS
check_started=$SECONDS
end_phase() {
    [ -n "$phase_name" ] || return 0
    local elapsed=$((SECONDS - phase_started))
    printf '[timing] %s: %ss\n' "$phase_name" "$elapsed"
    printf '%s\t%s\n' "$phase_name" "$elapsed" >>"$TIMINGS_FILE"
    phase_name=''
}
begin_phase() {
    end_phase
    phase_name="$1"
    phase_started=$SECONDS
    check_started=$SECONDS
}
check_timing() {
    printf '%s\t%s\t%s\t%s\n' "$phase_name" "$((SECONDS - check_started))" "$1" "$2" >>"$CHECKS_FILE"
    check_started=$SECONDS
}
lane_timed() { # lane_timed <case> <step> <command...> — preserve the command's stdout and status
    local case_name="$1" step="$2" started=$SECONDS result
    shift 2
    "$@"
    result=$?
    printf '%s\t%s\t%s\t%s\t%s\n' "$phase_name" "$case_name" "$step" "$((SECONDS - started))" "$result" >>"$LIFECYCLE_FILE"
    return "$result"
}
work="$(mktemp -d)" || exit 1

ok() {
    check_timing ok "$1"
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
}

bad() {
    check_timing FAIL "$1"
    printf 'FAIL %s\n     %s\n' "$1" "${2:0:400}"
    fail=$((fail + 1))
}

watch_stalls() { # background: dump each job container alive past LANE_STALL_S once, into $work/stalls (--watch-stalls)
    local limit="${LANE_STALL_S:-120}" c started age
    mkdir -p "$work/stalls"
    while sleep 10; do
        # Only this run's own jobs: the daemon is shared with other lanes.
        for c in $(for job in $(cat "$work/created-jobs" 2>/dev/null); do
            timeout 10 docker ps -q --filter "label=factory.job=$job" 2>/dev/null
        done); do
            [ -e "$work/stalls/$c.log" ] && continue
            started="$(timeout 10 docker inspect --format '{{.State.StartedAt}}' "$c" 2>/dev/null)" || continue
            case "$started" in '' | 0001-*) continue ;; esac # never started: not a stall
            age="$(node -e 'const t = Date.parse(process.argv[1]); if (Number.isFinite(t)) process.stdout.write(String(Math.floor((Date.now() - t) / 1000)));' "$started" 2>/dev/null)" || continue
            [ -n "$age" ] && [ "$age" -ge "$limit" ] || continue
            {
                echo "== alive ${age}s at $(date -u +%T)"
                dump_container "$c"
            } >"$work/stalls/$c.log" 2>&1
        done
    done
}

cleanup() {
    local result=$?
    begin_phase cleanup
    for pid in $lane_worker_pids; do kill -TERM "$pid" 2>/dev/null || true; done
    for pid in $lane_extra_pids; do
        kill "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
    done
    for marker in "$work"/*.endpoint "$work"/*.group; do
        [ -f "$marker" ] || continue
        worker="${marker##*/}"
        lane_resources_cleanup "${worker%.*}"
    done
    [ -n "$stall_watch_pid" ] && kill "$stall_watch_pid" 2>/dev/null
    [ -n "$driver_pid" ] && kill "$driver_pid" 2>/dev/null
    [ -n "$supervisor_log_pid" ] && kill "$supervisor_log_pid" 2>/dev/null
    [ -n "$compose_pid" ] && kill "$compose_pid" 2>/dev/null
    [ -n "$mint_pid" ] && kill "$mint_pid" 2>/dev/null
    [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null
    wait 2>/dev/null
    if needs_board; then
        docker rm -f "$COMPOSE_DRIVER" >/dev/null 2>&1
        # The compose phase's own project: its volumes and network, not the stack's postgres.
        compose -p "$COMPOSE_PROJECT" down --volumes --remove-orphans >/dev/null 2>&1
        # The task volumes the driver created for this run's threads, by the roots in its database.
        for root in $(compose exec -T postgres psql -U factory -d "$DB" -qtA \
            -c 'select distinct coalesce(root_job_id, id) from job' 2>/dev/null); do
            for volume in $(docker volume ls -q --filter "label=factory.task-root=$root" 2>/dev/null); do
                docker volume rm "$volume" >/dev/null 2>&1
            done
        done
        # Only ever drops a database this run created, and only one named *_test.
        if [ -n "$db_created" ]; then
            compose exec -T postgres psql -U factory -d postgres \
                -c "drop database if exists $DB" >/dev/null 2>&1
        fi
        docker rm -f "$ORIGIN_NAME" >/dev/null 2>&1
        docker network rm "$NETWORK" >/dev/null 2>&1
        docker volume rm "$ORIGIN_VOLUME" >/dev/null 2>&1
        docker image rm -f "$IMAGE_OK" "$IMAGE_FAIL" "$IMAGE_SVC" "$IMAGE_RUN" "$IMAGE_REVIEW" "$IMAGE_GH" "$IMAGE_KILL" "$IMAGE_ACC" "$IMAGE_BASE" >/dev/null 2>&1
    fi
    # Which attempts held a slot past LANE_SLOW_S, and which never ended (issue #829); a report, never a verdict.
    if [ -f "$work/driver.log" ]; then
        node "$REPO/scripts/lane-slow-jobs.mjs" "$work/driver.log" "${LANE_SLOW_S:-30}" >"$work/slow-jobs.txt" 2>&1 || true
        [ -s "$work/slow-jobs.txt" ] && printf '[slow-jobs] %s\n' "$(tail -n 1 "$work/slow-jobs.txt")"
    fi
    for log in "$work"/*.log "$work"/*.supervisor-*.json "$work"/*.worker-*.tsv "$work"/slow-jobs.txt "$work"/stalls/*; do
        [ -f "$log" ] && cp "$log" "${TIMINGS_FILE%.tsv}.$(basename "$log")"
    done
    rm -rf "$work"
    end_phase
    printf 'total\t%s\n' "$((SECONDS - lane_started))" >>"$TIMINGS_FILE"
    printf '[timing] total: %ss; timings: %s; exit: %s\n' "$((SECONDS - lane_started))" "$TIMINGS_FILE" "$result"
    trap - EXIT
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
[ "$WATCH_STALLS" = 1 ] && {
    watch_stalls &
    stall_watch_pid=$!
}

# --- HTTP, in node, so the script needs neither curl nor jq ----------------------------------

# BASE and AUTH_HEADER are read from the environment, so a single call can be aimed at the
# authenticated board or carry a worker token without every existing call site growing two
# arguments it does not use.
api() { # api METHOD PATH [json] -> "<status>\t<body>"
    node -e '
const [base, method, path, body, auth] = process.argv.slice(1);
fetch(base + path, {
    method,
    // A board that never answers is a refusal like any other, not a lane that hangs.
    signal: AbortSignal.timeout(10000),
    headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(auth ? { authorization: auth } : {}),
    },
    body: body || undefined,
})
    .then(async (r) => process.stdout.write(r.status + "\t" + (await r.text()).replace(/\s+/g, " ")))
    .catch((e) => process.stdout.write("000\t" + e.message));
' "$BASE" "$1" "$2" "${3:-}" "${AUTH_HEADER:-}"
}

status() { printf '%s' "${1%%$'\t'*}"; }
body() { printf '%s' "${1#*$'\t'}"; }

field() { # field <json> <key>
    node -e 'try { const o = JSON.parse(process.argv[1] || "{}"); process.stdout.write(String(o[process.argv[2]] ?? "")); } catch { process.stdout.write(""); }' \
        "$1" "$2"
}

expect_status() { # expect_status <name> <want> <method> <path> [json]
    local name="$1" want="$2"
    shift 2
    local out got
    out="$(api "$@")"
    got="$(status "$out")"
    if [ "$got" = "$want" ]; then ok "$name"; else bad "$name" "wanted $want, got $got: $(body "$out")"; fi
}

expect_status_at() { # expect_status_at <base> <name> <want> <method> <path> [json]
    local base="$1"
    shift
    BASE="$base" expect_status "$@"
}

expect_field() { # expect_field <name> <json> <key> <want>
    local got
    got="$(field "$2" "$3")"
    if [ "$got" = "$4" ]; then ok "$1"; else bad "$1" "$3 wanted '$4', got '$got'"; fi
}

expect_contains() { # expect_contains <name> <haystack> <needle>
    case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1" "wanted substring '$3' in: $2" ;;
    esac
}

create_job() { # create_job <command> [executor] [scope] -> id, recorded in $work/created-jobs for teardown
    local id payload
    # One node call builds the whole body. Two `$(node -e '…')` spliced into an escaped JSON string
    # inside nested "$( … )" is a quoting shape macOS's bash 3.2 mis-parses into an invalid body.
    payload="$(node -e 'process.stdout.write(JSON.stringify({ command: process.argv[1], executor: process.argv[2], repo: process.argv[4], ...(process.argv[3] ? { executorScope: process.argv[3] } : {}) }))' "$1" "${2:-claude}" "${3:-}" "$SMOKE_REPO")"
    id="$(field "$(body "$(api POST /api/jobs "$payload")")" id)"
    # A file, not a variable: every caller captures this function's output by command substitution,
    # which runs it in a subshell — an assignment here would be thrown away.
    printf '%s\n' "$id" >>"$work/created-jobs"
    printf '%s' "$id"
}

settled() { # settled <id> -> status once it is no longer queued/running, empty otherwise
    local s
    s="$(field "$(body "$(api GET "/api/jobs/$1")")" status)"
    case "$s" in
    queued | running) printf '' ;;
    *) printf '%s' "$s" ;;
    esac
}

dump_container() { # dump_container <container> — its state, process tree and log tail; diagnostics only, never a verdict
    echo "== $(timeout 10 docker inspect --format '{{.Name}} {{json .State}}' "$1" 2>&1)"
    timeout 10 docker top "$1" -o pid,ppid,stat,etime,args 2>&1
    timeout 10 docker logs --tail 40 "$1" 2>&1
}

dump_stall() { # dump_stall <job-id> — what a job that never settled was still running, for the log
    # Every container of the job with its state, process tree and log tail: a stall names its own
    # stuck process instead of costing a re-run to catch it live. Diagnostics only; never a verdict.
    local file="$work/stall-$1.log" c
    {
        echo "== job $1 at $(date -u +%T)"
        timeout 10 docker ps -a --filter "label=factory.job=$1" \
            --format '{{.Names}} {{.Status}} {{.Label "factory.role"}} {{.Label "factory.claim-seq"}}' 2>&1
        for c in $(timeout 10 docker ps -aq --filter "label=factory.job=$1" 2>/dev/null); do
            dump_container "$c"
        done
    } >"$file" 2>&1
    echo "test-jobs: job $1 did not settle; its containers: $file" >&2
}

await_settled() { # await_settled <id> [seconds] -> final status, or empty on timeout
    # Wall-clock seconds, not polls: each poll's request may itself take up to its own timeout.
    local id="$1" until=$(($(date +%s) + ${2:-60})) s=""
    while [ "$(date +%s)" -lt "$until" ]; do
        s="$(settled "$id")"
        [ -n "$s" ] && {
            printf '%s' "$s"
            return
        }
        sleep 1
    done
    dump_stall "$id"
    printf ''
}

start_driver() { # start_driver <image> [RUNNER_SERVICES] [DRIVER_CONCURRENCY]
    # No ORG_ID. The board sends `workspacePath` on the claim now — it owns the layout, because it
    # is the thing that created the directory — so the driver builds no path of its own.
    # RUNNER_SERVICES defaults to on now; every phase but the services one passes 0 explicitly, so
    # what each phase asserts stays independent of the default.
    env JOB_BOARD_URL="$BASE" CLAUDE_EXECUTOR_IMAGE="$1" OPENCODE_EXECUTOR_IMAGE="$1" \
        RUNNER_SERVICES="${2:-0}" \
        REPO_CLONE_BASE="$CLONE_BASE" RUNNER_NETWORK="$NETWORK" \
        DRIVER_POLL_MS=500 DRIVER_CONCURRENCY="${3:-2}" DRIVER_LEASE_SECONDS=60 \
        DRIVER_HANDOVER_MS="${LANE_HANDOVER_MS:-5000}" DRIVER_REBIND_GRACE_MS="${LANE_REBIND_GRACE_MS:-20000}" \
        node driver/dist/index.js >>"$work/driver.log" 2>&1 &
    driver_pid=$!
}

stop_driver() {
    [ -n "$driver_pid" ] && kill "$driver_pid" 2>/dev/null
    wait "$driver_pid" 2>/dev/null
    driver_pid=""
}

# The file has to be on the origin's default branch: every task clones it onto its task volume and
# the readout reads that tree. There is no host path
# into a named volume, so a container commits it. A failed write fails the run here, not later as a
# misleading job verdict.
write_bellows() { # write_bellows <contents>
    docker run --rm -i -v "$ORIGIN_VOLUME:/origins" -e HOME=/tmp "$IMAGE_BASE" sh -c '
        set -e
        git clone -q "$1" /tmp/tree
        cat >/tmp/tree/.bellows.yaml
        git -C /tmp/tree add .bellows.yaml
        git -C /tmp/tree -c user.name=test-jobs -c user.email=test-jobs@localhost commit -q --allow-empty -m bellows
        git -C /tmp/tree push -q origin HEAD:main' sh "/origins/$SMOKE_REPO.git" \
        <<<"$1" >/dev/null || {
        echo 'test-jobs: could not commit the .bellows.yaml fixture'
        exit 1
    }
}
# The recovery helpers the node-disruption and driver-kill phases share (issues #796, #829).
disruption_driver() { # disruption_driver [VAR=value ...] — a services-off driver on the prompt-executing stub
    env JOB_BOARD_URL="$BASE" CLAUDE_EXECUTOR_IMAGE="$IMAGE_RUN" OPENCODE_EXECUTOR_IMAGE="$IMAGE_RUN" \
        RUNNER_SERVICES=0 REPO_CLONE_BASE="$CLONE_BASE" RUNNER_NETWORK="$NETWORK" \
        DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS="$LANE_LEASE_S" \
        DRIVER_REBIND_GRACE_MS="${LANE_REBIND_GRACE_MS:-20000}" "$@" \
        node driver/dist/index.js >>"$work/driver.log" 2>&1 &
    driver_pid=$!
}

supervisor_served() { # supervisor_served <job-id> <seconds> -> 0 once its supervisor logged it stopped serving; an unreadable log is not a pass
    local i=0 sup logs
    while [ "$i" -lt "$2" ]; do
        sup="$(docker ps -aq --filter "label=factory.job=$1" --filter 'label=factory.role=supervisor' | sed -n 1p)"
        if [ -n "$sup" ] && logs="$(docker logs "$sup" 2>&1)"; then
            printf '%s' "$logs" | grep -qF 'supervisor: stopped serving the steps' && return 0
        fi
        sleep 1
        i=$((i + 1))
    done
    return 1
}

first_runner() { # first_runner <job-id> [docker ps filter] -> the claim-1 runner container's id
    docker ps -aq --filter "label=factory.job=$1" --filter "label=factory.claim-seq=1" ${2:+--filter "$2"}
}

await_first_runner() { # await_first_runner <job-id> <status> [seconds] -> the container id, empty on timeout
    local i=0 c=""
    while [ "$i" -lt "${3:-60}" ]; do
        c="$(first_runner "$1" "status=$2")"
        [ -n "$c" ] && break
        sleep 1
        i=$((i + 1))
    done
    printf '%s' "$c"
}

runner_host() { # runner_host <runner container> -> the $HOSTNAME its commands see
    # The agent joins its supervisor's network namespace (issue #773), and with it the supervisor's
    # hostname: the short id of the container named by its network mode, not its own.
    docker inspect -f '{{.HostConfig.NetworkMode}}' "$1" 2>/dev/null | sed 's/^container://' | cut -c1-12
}

await_released() { # await_released <runner container> -> success once the supervisor released its agent (`go`)
    # A driver lost before `go` leaves nothing to adopt: the group ends lost (supervisor exit 75) and the run is redone.
    local i=0
    while [ "$i" -lt 60 ]; do
        # As the agent uid: the agent container runs as root without DAC_OVERRIDE (issue #814).
        docker exec --user 1000 "$1" sh -c 'test -f /factory/in/agent/go' >/dev/null 2>&1 && return 0
        sleep 1
        i=$((i + 1))
    done
    return 1
}

interruptions_of() { # interruptions_of <job json> -> "<count>|<claimSeq of the first>|<reason of the first>"
    node -e 'try { const l = JSON.parse(process.argv[1] || "{}").interruptions ?? []; process.stdout.write(`${l.length}|${l[0]?.claimSeq ?? ""}|${l[0]?.reason ?? ""}`); } catch { process.stdout.write("?||"); }' \
        "$1"
}

last_attempt() { # last_attempt <id> -> the job allowed one attempt, so an expiry spending it would retire it dead
    # Non-zero, printing what psql answered, unless the update returned that job: a cap that did not land proves nothing.
    local capped
    capped="$(compose exec -T postgres psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 \
        -c "update job set max_attempts = 1 where id = '$1' returning id" 2>&1)"
    [ "$capped" = "$1" ] || {
        printf '%s' "${capped:-no job row changed}"
        return 1
    }
}

ADOPTED='adopted the finished runner of claim 1, whose driver was lost'
TOOK_OVER='took over the running agent of claim 1, whose driver was lost'
DRAINED='the driver was drained'
# The interruption the next claim records for an attempt whose lease expired (issue #822).
EXPIRED='the lease expired: its driver went silent'
# The adopting claim settles only once the lost driver's supervisor exits, and with no driver left to
# order its `finish` that is orphanBoundMs after its last answered call (a quarter of the lease,
# floored at SUPERVISOR_ORPHAN_MIN_MS: 30 s at the lane's lease, driver/src/supervisor-plan.ts), then
# the lease the adopting claim waits out and the rebind grace it gives a released group, plus a margin
# for the run itself and its publish.
LANE_LEASE_S=10
LANE_ORPHAN_S=30
LANE_MARGIN_S=40
ADOPT_S=$((LANE_ORPHAN_S + LANE_LEASE_S + ${LANE_REBIND_GRACE_MS:-20000} / 1000 + LANE_MARGIN_S))

# Barriers and counters for the driver-kill phase (issue #829). Every container of a run — setup,
# gates, the agent, the publish steps — mounts the thread's task volume at /task, so a file under
# $LANE_DIR is one every one of them sees; the publish's own state (the gh stand-in's PR list and
# hold) sits beside it in /task/.lane-gh, the origin's push log in the bare origin on $ORIGIN_VOLUME.
# lane_use names the volume of the job under test: the driver creates it at the claim, so a read
# before then finds it absent, never creates it (a volume docker makes is not one the driver owns).
LANE_DIR='/task/.lane-kill'
LANE_GH_DIR='/task/.lane-gh'
LANE_VOL=''
LANE_MNT='/task'

lane_use() { # lane_use <job id> -> later lane_* calls read that job's task volume (a first job: its id is its thread's root)
    LANE_VOL="factory-task-$1-1"
    LANE_MNT=/task
}

lane_origin() { # lane_origin <lane_* function> [arg...] -> the call, aimed at the origins volume (paths are relative to /origins)
    local LANE_VOL="$ORIGIN_VOLUME" LANE_MNT=/origins
    "$@"
}

lane_vol_state() { # -> present, absent, or ? when docker did not answer
    local out
    out="$(timeout 30 docker volume ls -q --filter "name=^$LANE_VOL\$" 2>/dev/null)" || {
        printf '?'
        return
    }
    case "$out" in '') printf absent ;; *) printf present ;; esac
}

lane_run() { # lane_run <sh script> [arg...] -> the script's own status; 124-127 mean docker or the timeout failed, not the script
    [ "$(lane_vol_state)" = present ] || return 125
    timeout 30 docker run --rm -v "$LANE_VOL:$LANE_MNT" --user 1000 -e HOME=/tmp -w "$LANE_MNT" "$IMAGE_BASE" \
        sh -c "$1" sh "${@:2}"
}

lane_touch() { # lane_touch <path> -> success once the file exists
    lane_run 'mkdir -p "$(dirname "$1")" && : >"$1"' "$1"
}

lane_has() { # lane_has <path> -> 0 present, 1 positively absent, 2 unconfirmed
    case "$(lane_vol_state)" in absent) return 1 ;; present) ;; *) return 2 ;; esac
    lane_run 'test -e "$1"' "$1" >/dev/null 2>&1
    case "$?" in 0) return 0 ;; 1) return 1 ;; *) return 2 ;; esac
}

lane_count() { # lane_count <path> -> its line count; 0 only when absent; ? when the read failed
    local n
    case "$(lane_vol_state)" in absent) printf 0; return ;; present) ;; *) printf '?'; return ;; esac
    n="$(lane_run 'if [ -e "$1" ]; then wc -l <"$1"; else echo 0; fi' "$1" 2>/dev/null)" || {
        printf '?'
        return
    }
    n="$(printf '%s' "$n" | tr -d ' \n')"
    case "$n" in '' | *[!0-9]*) printf '?' ;; *) printf '%s' "$n" ;; esac
}

lane_await() { # lane_await <seconds> <path> <want> -> success once the file holds at least <want> lines
    local until=$(($(date +%s) + $1)) n=""
    while [ "$(date +%s)" -lt "$until" ]; do
        n="$(lane_count "$2")"
        [ "$n" != '?' ] && [ "$n" -ge "$3" ] && return 0
        sleep 1
    done
    return 1
}

lane_await_file() { # lane_await_file <seconds> <path> -> success once the file exists
    local until=$(($(date +%s) + $1))
    while [ "$(date +%s)" -lt "$until" ]; do
        lane_has "$2" && return 0
        sleep 1
    done
    return 1
}

lane_wait() { # lane_wait <path> -> shell text that blocks (at most 300 s) until the file exists
    printf 't=$(($(date +%%s)+300)); while [ ! -e %s ] && [ "$(date +%%s)" -lt "$t" ]; do sleep 1; done' "$1"
}

lane_left() { # lane_left <job id> -> success only when docker answered both reads and the job has no container or volume
    local c v
    c="$(timeout 30 docker ps -aq --filter "label=factory.job=$1" 2>&1)" || {
        printf 'docker ps failed: %s' "$c"
        return 1
    }
    v="$(timeout 30 docker volume ls -q --filter "label=factory.job=$1" 2>&1)" || {
        printf 'docker volume ls failed: %s' "$v"
        return 1
    }
    [ -z "$c$v" ] || {
        printf 'containers: %s volumes: %s' "$(printf '%s' "$c" | tr '\n' ' ')" "$(printf '%s' "$v" | tr '\n' ' ')"
        return 1
    }
}

# The driver-log and leftovers checks the driver-kill and capacity phases share (issues #829, #831).
dk_log() { # dk_log <job id> <text> -> success once the driver log carries the line
    grep -qF "job $1: $2" "$work/driver.log"
}

dk_await_log() { # dk_await_log <job id> <text> <seconds>
    local until=$(($(date +%s) + $3))
    while [ "$(date +%s)" -lt "$until" ]; do
        dk_log "$1" "$2" && return 0
        sleep 1
    done
    return 1
}

dk_clean() { # dk_clean <job id> -> success once, within 60 s, docker answered and nothing of the job was left
    local until=$(($(date +%s) + 60)) left=""
    while [ "$(date +%s)" -lt "$until" ]; do
        left="$(lane_left "$1")" && return 0
        sleep 2
    done
    printf '%s' "$left"
    return 1
}

dk_count() { # dk_count <name> <path> <want> -> a check on one barrier counter, exact
    local got
    got="$(lane_count "$2")"
    [ "$got" = "$3" ] && ok "$1" || bad "$1" "$2 holds '$got' lines, want $3"
}

lane_group_up() { # lane_group_up <name> <image> <control-url>
    local name="$RUN_ID-$1" image="$2" url="$3" box
    printf '%s\n' "$name" >"$work/$lane_worker_name.group"
    for box in in out export supervisor; do
        docker volume create "lane-$name-$box" >/dev/null
    done
    docker run -d --name "lane-sup-$name" --add-host host.docker.internal:host-gateway \
        -v "$PWD/driver/src/scripts/supervisor.cjs:/supervisor.cjs:ro" \
        -v "lane-$name-in:/factory/in" -v "lane-$name-out:/factory/out" \
        -v "lane-$name-export:/factory/export" -v "lane-$name-supervisor:/factory/supervisor" \
        -e "SUPERVISOR_CONTROL_URL=$url" -e SUPERVISOR_CONTROL_TOKEN=lane \
        -e SUPERVISOR_CONTROL_MS=200 -e SUPERVISOR_TICK_MS=100 \
        --entrypoint node "$image" /supervisor.cjs >/dev/null
}

lane_group_agent_args() { # lane_group_agent_args <name>: the agent's half of the mailboxes, as argv words
    local name="$RUN_ID-$1"
    printf '%s\n' -v "lane-$name-in:/factory/in:ro" -v "lane-$name-out:/factory/out" \
        -e FACTORY_CTL_IN=/factory/in/agent -e FACTORY_CTL_OUT=/factory/out/agent -e FACTORY_CTL_GO=/factory/in/agent/go \
        -e FACTORY_CTL_TICK_MS=200
}

lane_group_down() { # lane_group_down <name>: the supervisor finalizes after the agent exits; then the group goes
    local name="$RUN_ID-$1" waited result
    lane_timed "$1" supervisor-wait timeout 60 docker wait "lane-sup-$name" >"$work/$1.supervisor-wait.log" 2>"$work/$1.supervisor-wait-error.log"
    result=$?
    waited="$(cat "$work/$1.supervisor-wait.log")"
    lane_group_diagnostics "$name"
    lane_timed "$1" cleanup lane_group_remove "$name"
    rm -f "$work/$lane_worker_name.group"
    if [ "$result" = 0 ] && [ "$waited" = 0 ]; then
        ok "$1 supervisor finalizes on its own"
    else
        bad "$1 supervisor finalizes on its own" "wait exit $result, supervisor exit '$waited': $(tail -3 "$work/$1.supervisor.log") $(tail -3 "$work/$1.supervisor-wait-error.log")"
    fi
}

lane_group_diagnostics() { # lane_group_diagnostics <run-qualified name>
    local name="$1" case_name="${1#"$RUN_ID-"}" box
    docker logs "lane-sup-$name" >"$work/$case_name.supervisor.log" 2>&1
    for box in state report; do
        docker cp "lane-sup-$name:/factory/supervisor/$box.json" "$work/$case_name.supervisor-$box.json" >/dev/null 2>&1 || true
    done
}

lane_group_remove() { # lane_group_remove <run-qualified name>
    local name="$1" box
    docker rm -f "lane-agent-$name" "lane-sup-$name" >/dev/null 2>&1
    for box in in out export supervisor; do
        docker volume rm -f "lane-$name-$box" >/dev/null 2>&1
    done
}

lane_endpoint_started() { printf '%s\n' "$1" >"$work/$lane_worker_name.endpoint"; }
lane_endpoint_stop() {
    kill "$1" 2>/dev/null || true
    wait "$1" 2>/dev/null || true
    rm -f "$work/$lane_worker_name.endpoint"
}

lane_resources_cleanup() { # lane_resources_cleanup <worker>: only resources this worker registered
    local worker="$1" pid name
    if [ -f "$work/$worker.endpoint" ]; then
        read -r pid <"$work/$worker.endpoint"
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        rm -f "$work/$worker.endpoint"
    fi
    if [ -f "$work/$worker.group" ]; then
        read -r name <"$work/$worker.group"
        lane_group_diagnostics "$name"
        lane_group_remove "$name"
        rm -f "$work/$worker.group"
    fi
}

lane_worker_exit() {
    local result=$?
    lane_resources_cleanup "$lane_worker_name"
    printf '%s %s %s\n' "$pass" "$fail" "$result" >"$work/$lane_worker_name.counts"
    trap - EXIT
    exit "$result"
}

lane_pair() { # lane_pair <first case function> <second case function>; at most two isolated workers
    if [ "$CLI_WORKERS" = 1 ]; then "$1"; "$2"; return; fi
    local fn pid first_pid='' second_pid='' result successes failures recorded
    for fn in "$1" "$2"; do
        (
            trap - EXIT
            trap 'exit 130' INT
            trap 'exit 143' TERM
            lane_worker_name="$phase_name-$fn"
            pass=0 fail=0 check_started=$SECONDS
            CHECKS_FILE="$work/$lane_worker_name.worker-checks.tsv"
            LIFECYCLE_FILE="$work/$lane_worker_name.worker-lifecycle.tsv"
            : >"$CHECKS_FILE"
            : >"$LIFECYCLE_FILE"
            trap lane_worker_exit EXIT
            "$fn"
        ) >"$work/$phase_name-$fn.worker.log" 2>&1 &
        if [ -z "$first_pid" ]; then first_pid=$!; else second_pid=$!; fi
    done
    lane_worker_pids="$first_pid $second_pid"
    for fn in "$1" "$2"; do
        if [ "$fn" = "$1" ]; then pid="$first_pid"; else pid="$second_pid"; fi
        wait "$pid"
        result=$?
        if [ "$pid" = "$first_pid" ]; then lane_worker_pids="$second_pid"; else lane_worker_pids=''; fi
        lane_resources_cleanup "$phase_name-$fn"
        cat "$work/$phase_name-$fn.worker.log"
        cat "$work/$phase_name-$fn.worker-checks.tsv" >>"$CHECKS_FILE"
        cat "$work/$phase_name-$fn.worker-lifecycle.tsv" >>"$LIFECYCLE_FILE"
        if [ -f "$work/$phase_name-$fn.counts" ] &&
            read -r successes failures recorded <"$work/$phase_name-$fn.counts" &&
            [[ "$successes $failures $recorded" =~ ^[0-9]+\ [0-9]+\ [0-9]+$ ]]; then
            pass=$((pass + successes))
            fail=$((fail + failures))
            if [ "$result" != 0 ] && [ "$failures" = 0 ]; then bad "$fn completes" "exit $result"; fi
        else
            bad "$fn reports its checks" "exit $result"
        fi
    done
    lane_worker_pids=''
    check_started=$SECONDS
}

# --- Bring up everything it needs -------------------------------------------------------------

if needs_board; then
begin_phase postgres
echo 'starting postgres'
start_postgres "$work/postgres.log"

# The name ends in _test on purpose: it marks the database disposable, and the drop in cleanup()
# refuses anything this run did not create.
if compose exec -T postgres psql -U factory -d postgres -tAc \
    "select 1 from pg_database where datname = '$DB'" 2>/dev/null | grep -q 1; then
    echo "reusing database $DB"
else
    compose exec -T postgres psql -U factory -d postgres -c "create database $DB" >/dev/null 2>&1 ||
        {
            echo "test-jobs: could not create $DB"
            exit 1
        }
    db_created=1
fi

begin_phase build
echo 'building core, server, driver'
if [ -n "${TEST_JOBS_PREBUILT:-}" ]; then
    echo 'build skipped: --parallel built it once for every group'
else
    build_workspaces "$work/build.log"
fi

begin_phase stub-images
echo 'building the stub runner images'
# The OK stub prints two env probes BEFORE echoing its arguments, so the output proves both the
# argv path (prompt, session id) and the env path (the claim's stacked environment) reached the
# container. It then re-echoes the LAST argument — the prompt — on its own final line: the
# workflow engine's marker edges match the run's final non-empty line (docs/workflows.md, the
# contract a real model honours by emitting the marker last), and the one-line `echo "$@"` puts
# the driver's `--session-id <uuid> -p` flags ahead of the prompt on that line, so every marker
# edge missed and the stub-walk graph stalled after its first review round.
# Every stub stands on scripts/stub-runner.Dockerfile: node + git as the uid-1000 `node` user, like
# the executor images — the driver runs the startup sync and the other git steps IN the job's
# executor image (`--entrypoint node`), and every task has a checkout to sync (issue #263) — and the
# images' tool isolation (issue #814). Each executor stub starts through factory-launch and
# scripts/stub-agent.sh, beside ctl-agent.cjs, over the node-owned mailbox mount points: the task
# supervisor's agent contract (driver/test/lane-stubs.test.ts), which the real entrypoints honor.
cp docker/claude-executor/ctl-agent.cjs docker/claude-executor/factory-launch.sh docker/claude-executor/factory-tool.cjs \
    docker/claude-executor/tool-bash.sh scripts/stub-agent.sh scripts/lane-gh.sh scripts/stub-runner.Dockerfile "$work/"
printf 'FROM %s\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","-c","echo $FACTORY_ENV_PROBE; echo $SECRET_PROBE; echo ${CLAUDE_CODE_CONFIG_CONTENT:-none}; echo \\"$@\\"; for last; do :; done; echo \\"$last\\"","sh"]\n' "$IMAGE_BASE" >"$work/Dockerfile.ok"
printf 'FROM %s\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","-c","echo boom >&2; exit 3"]\n' "$IMAGE_BASE" >"$work/Dockerfile.fail"
# Issue #814: an agent whose one tool signals everything its uid may, through the CLI's shell.
mkdir -p "$work/kill"
printf '%s\n' '"$SHELL" -c '"'"'kill -TERM 1 2>/dev/null; kill -KILL -1 2>/dev/null; echo "the tool ran as $(id -u)"'"'" \
    'echo agent survived' >"$work/kill/kill.sh"
printf 'FROM %s\nCOPY kill.sh /kill.sh\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","/kill.sh"]\n' "$IMAGE_BASE" >"$work/kill/Dockerfile"
docker build -q -t "$IMAGE_BASE" -f "$work/stub-runner.Dockerfile" "$work" >/dev/null &&
    docker build -q -t "$IMAGE_OK" -f "$work/Dockerfile.ok" "$work" >/dev/null &&
    docker build -q -t "$IMAGE_FAIL" -f "$work/Dockerfile.fail" "$work" >/dev/null &&
    docker build -q -t "$IMAGE_KILL" "$work/kill" >/dev/null || {
    echo 'test-jobs: could not build the stub images'
    exit 1
}

# Every board boots the OFFLINE entry (server/dist/offline.js) — the same server built with the
# code-only no-fetch arm, which is what lets them run with no App credential at all and against a
# disposable database name. It drives the whole lease protocol with no credential anywhere. It reads
# each repo's .bellows.yaml at claim time from the smoke origin, over git, at $PLAN_BASE
# (REPO_CLONE_BASE; server/src/github/local-origin-plan.ts).

start_open_board() { # boots the AUTH_MODE=none board on $BASE and waits until it is migrated
    env AUTH_MODE=none DATABASE_URL="$DATABASE_URL" PORT="$PORT" HOST=127.0.0.1 \
        REPO_CLONE_BASE="$PLAN_BASE" \
        node server/dist/offline.js >>"$work/server.log" 2>&1 &
    server_pid=$!

    # /api/ready, not /api/health: health answers while the migrations still run, and the truncate
    # below needs the schema they create.
    local up=""
    for _ in $(seq 1 40); do
        [ "$(status "$(api GET /api/ready)")" = '200' ] && {
            up=1
            break
        }
        sleep 1
    done
    [ -n "$up" ] || {
        echo 'test-jobs: the board never came up'
        tail -20 "$work/server.log"
        exit 1
    }
}

# The origin: the bare repository `<owner>/<name>.git` on the origin volume, one commit on main, and
# a git daemon on the runners' network that serves it and takes pushes (a publish pushes back to it).
# The daemon is also published to loopback: the offline board runs on the host and reads each plan
# from it. Uid 1000 owns the repository, as the user every runner and gate container writes as.
docker volume create "$ORIGIN_VOLUME" >/dev/null &&
    docker network create "$NETWORK" >/dev/null &&
    docker run --rm -u 0 -v "$ORIGIN_VOLUME:/origins" "$IMAGE_BASE" sh -c \
        "mkdir -p /origins/${SMOKE_REPO%%/*} && chown 1000:1000 /origins /origins/${SMOKE_REPO%%/*}" &&
    docker run --rm -v "$ORIGIN_VOLUME:/origins" -e HOME=/tmp "$IMAGE_BASE" sh -c '
        set -e
        git init -q --bare -b main "/origins/$1.git"
        git init -q -b main /tmp/seed
        git -C /tmp/seed -c user.name=test-jobs -c user.email=test-jobs@localhost commit -q --allow-empty -m init
        git -C /tmp/seed push -q "/origins/$1.git" main' sh "$SMOKE_REPO" &&
    docker run -d --name "$ORIGIN_NAME" --network "$NETWORK" -p 127.0.0.1::9418 -v "$ORIGIN_VOLUME:/origins" "$IMAGE_BASE" \
        git daemon --reuseaddr --base-path=/origins --export-all --enable=receive-pack \
        --listen=0.0.0.0 --port=9418 /origins >/dev/null || {
    echo 'test-jobs: could not serve the smoke origin'
    exit 1
}
PLAN_BASE="git://127.0.0.1:$(docker port "$ORIGIN_NAME" 9418/tcp | head -n 1 | sed 's/.*://')"
case "$PLAN_BASE" in
git://127.0.0.1:[0-9]*) ;;
*)
    echo "test-jobs: the smoke origin published no loopback port: $PLAN_BASE"
    exit 1
    ;;
esac

begin_phase board-fixture
echo "starting the board on $BASE"
start_open_board

# --- The board on its own --------------------------------------------------------------------

# The queue is FIFO, so every check below depends on what is already in it. A reused database, or
# a job left by a failed run, would otherwise hand the claim a different job than the one under
# test — which reads as a broken lease rather than a dirty fixture. workflow is truncated with it,
# so the definitions the workflow phase creates below start from an empty table.
# cascade, because every table that references a job (job_question, the batch tables)
# must empty with it, and a named list rots the day a migration adds another.
compose exec -T postgres psql -U factory -d "$DB" -c 'truncate job, workflow cascade' >/dev/null 2>&1 || {
    echo 'test-jobs: could not truncate job, workflow'
    exit 1
}

# A create must name a tracked repo, and an offline board's tracked list is its session_branch rows: the
# fixture is one row for the smoke repo. The runner clones the origin (issue #775) onto its own task
# volume. The author is AUTH_MODE=none's stand-in, read from /api/auth/me; the board names its tree
# `<org>/<user id>` on every claim (asserted below).
member="$(body "$(api GET /api/auth/me)")"
member_org="$(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).organization.id); } catch {}' "$member")"
member_user="$(node -e 'try { process.stdout.write(JSON.parse(process.argv[1]).user.id); } catch {}' "$member")"
member_path="$member_org/$member_user"
case "$member_path" in
default/????????-????-????-????-????????????) ;;
*)
    echo "test-jobs: /api/auth/me named no stand-in member: $member"
    exit 1
    ;;
esac
compose exec -T postgres psql -U factory -d "$DB" -v ON_ERROR_STOP=1 -c \
    "insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
     values ('$member_org', 'claude-code', 'test-jobs-fixture', '$SMOKE_REPO', 'main', now(), now())
     on conflict do nothing" >/dev/null 2>&1 || {
    echo "test-jobs: could not select $SMOKE_REPO for the stand-in member"
    exit 1
}
expect_status 'stores the task-selectable executors' 200 PUT /api/workspace/executors \
    '{"executors":[{"name":"claude","type":"claude-code","config":{}},{"name":"opencode","type":"opencode","config":{}}]}'

# Organization-scoped executor profiles (issue 391). AUTH_MODE=none's stand-in account is the
# seeded admin, so the create is allowed; the org config marker is what tells the run's output
# apart from any personal row's — the personal list carries only empty configs. The name carries
# a per-run suffix: the lane may run against a reused database, and a name is unique per scope.
ORG_EXECUTOR="team-$(openssl rand -hex 3)"
expect_status 'stores an org executor as the admin' 201 POST /api/org/executors \
    "{\"name\":\"$ORG_EXECUTOR\",\"type\":\"claude-code\",\"config\":{\"model\":\"org-team-model\"}}"
expect_status 'puts the core env' 200 PUT /api/env/org \
    '{"vars":[{"name":"FACTORY_ENV_PROBE","value":"org-marker","isSecret":false},{"name":"SECRET_PROBE","value":"secret-marker","isSecret":true}]}'
fi

if selected_phase board; then
begin_phase board
echo
echo '# board'

expect_status 'refuses a duplicate org name'         409 POST /api/org/executors \
    "{\"name\":\"$ORG_EXECUTOR\",\"type\":\"claude-code\",\"config\":{}}"
expect_status 'a scope outside the pair is refused' 400 POST /api/jobs \
    "{\"command\":\"x\",\"executor\":\"$ORG_EXECUTOR\",\"executorScope\":\"repo\",\"repo\":\"$SMOKE_REPO\"}"

expect_status 'health answers'            200 GET /api/health
expect_status 'refuses an empty command'  400 POST /api/jobs '{"command":""}'
expect_status 'refuses a malformed id'    400 GET '/api/jobs/not-a-uuid'
expect_status 'unknown job is 404'        404 GET '/api/jobs/00000000-0000-4000-8000-000000000000'
expect_status 'refuses an unknown status' 400 GET '/api/jobs?status=pending'

# The runner environment, configured the way the UI would: one plain variable and one secret on the
# org ("core") scope. AUTH_MODE=none resolves the stand-in admin, so the PUT is allowed.
expect_status 'refuses an env name that is not a name' 400 PUT /api/env/org \
    '{"vars":[{"name":"not a name","value":"x","isSecret":false}]}'
env_list="$(body "$(api GET /api/env)")"
expect_contains 'the env list names the plain variable' "$env_list" 'FACTORY_ENV_PROBE'
# The write-only contract, end to end: the secret travels by name, its value is withheld from
# every read.
expect_contains 'the core secret value is withheld' "$env_list" '"name":"SECRET_PROBE","value":null'

id="$(create_job 'board only')"
case "$id" in
*-*-*-*-*) ok 'queues a job' ;;
*) bad 'queues a job' "no id came back: '$id'" ;;
esac
claim="$(body "$(api POST /api/jobs/claim '{"worker":"probe","leaseSeconds":300}')")"
token="$(field "$claim" leaseToken)"
expect_field 'claim returns the command' "$claim" command 'board only'
expect_field 'first attempt is 1'        "$claim" attempts 1

# A live lease is the whole point: nothing else may take this job while probe holds it.
expect_status 'a held job is not offered again' 204 POST /api/jobs/claim '{"worker":"other"}'
expect_status 'heartbeat extends the lease'     200 POST "/api/jobs/$id/heartbeat" "{\"leaseToken\":\"$token\"}"
expect_status 'a wrong token is refused'        409 POST "/api/jobs/$id/complete" \
    '{"leaseToken":"00000000-0000-4000-8000-000000000000","status":"succeeded","exitCode":0,"output":"x"}'
expect_status 'the holder may complete'         200 POST "/api/jobs/$id/complete" \
    "{\"leaseToken\":\"$token\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"hello\"}"

done_body="$(body "$(api GET "/api/jobs/$id")")"
expect_field 'the result is recorded'   "$done_body" status succeeded
expect_field 'the exit code is kept'    "$done_body" exitCode 0
expect_field 'the output is kept'       "$done_body" output hello

# Reclaim, proven by ageing the lease rather than by waiting one out. The expiry is the lost
# attempt's interruption: the takeover keeps the attempt count and resumes the lost session.
RECLAIMED_SESSION='44444444-4444-4444-8444-444444444444'
reclaim_id="$(create_job 'reclaim me')"
stale="$(field "$(body "$(api POST /api/jobs/claim '{"worker":"dies","leaseSeconds":300}')")" leaseToken)"
api POST "/api/jobs/$reclaim_id/session" \
    "{\"leaseToken\":\"$stale\",\"sessionId\":\"$RECLAIMED_SESSION\"}" >/dev/null
compose exec -T postgres psql -U factory -d "$DB" \
    -c "update job set lease_expires_at = now() - interval '1 second' where id = '$reclaim_id'" >/dev/null 2>&1
again="$(body "$(api POST /api/jobs/claim '{"worker":"takes-over","leaseSeconds":300}')")"
expect_field 'an expired lease is reclaimed'     "$again" id "$reclaim_id"
expect_field 'the attempt count stays'           "$again" attempts 1
expect_field 'the claim sequence grows'          "$again" claimSeq 2
expect_field 'the takeover resumes the session'  "$again" resumeSessionId "$RECLAIMED_SESSION"
# The fencing token, end to end: the first worker is still alive and still wrong.
expect_status 'the superseded worker is refused' 409 POST "/api/jobs/$reclaim_id/complete" \
    "{\"leaseToken\":\"$stale\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"zombie\"}"
api POST "/api/jobs/$reclaim_id/complete" \
    "{\"leaseToken\":\"$(field "$again" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

PARKED_SESSION='55555555-5555-4555-8555-555555555555'

# Stop, end to end: a running job asked to stop is settled by its worker's park, lands stopped —
# terminal, the session kept — and continues as a follow-up (docs/jobs.md).
park_id="$(create_job 'park me')"
park_claim="$(body "$(api POST /api/jobs/claim '{"worker":"parks","leaseSeconds":300}')")"
park_token="$(field "$park_claim" leaseToken)"
api POST "/api/jobs/$park_id/session" \
    "{\"leaseToken\":\"$park_token\",\"sessionId\":\"$PARKED_SESSION\"}" >/dev/null
# A live lease: the stop is stamped and rides the heartbeat to the worker, which parks the run.
expect_status 'a running job can be asked to stop' 202 POST "/api/jobs/$park_id/stop"
expect_status 'the worker parks the stopped run'   200 POST "/api/jobs/$park_id/suspend" \
    "{\"leaseToken\":\"$park_token\"}"
stopped="$(body "$(api GET "/api/jobs/$park_id")")"
expect_field  'it is stopped'                 "$stopped" status stopped
expect_field  'stopped keeps the session'     "$stopped" sessionId "$PARKED_SESSION"
# Parking handed the attempt back: the stopped row never burned a try.
# (suspend: attempts = greatest(attempts - 1, 0).)
expect_field  'parking did not burn a try'    "$stopped" attempts 0
# Stopped is terminal: an idle poll must not pick it back up.
expect_status 'a stopped job is not offered'  204 POST /api/jobs/claim '{"worker":"idle-poll"}'
# One api call, not expect_status plus a second request: every follow-up POST that passes the
# preconditions INSERTS a row, so a duplicate call would queue a second continuation.
follow_out="$(api POST "/api/jobs/$park_id/follow-up" '{"command":"continue this"}')"
if [ "$(status "$follow_out")" = '201' ]; then ok 'a stopped task can be continued'; else
    bad 'a stopped task can be continued' "wanted 201, got $(status "$follow_out"): $(body "$follow_out")"; fi
fu_id="$(field "$(body "$follow_out")" id)"
printf '%s\n' "$fu_id" >>"$work/created-jobs"
fu_claim="$(body "$(api POST /api/jobs/claim '{"worker":"follows","leaseSeconds":300}')")"
expect_field  'the follow-up claim comes back' "$fu_claim" id "$fu_id"
# The per-member workspace, ready-made by the board: `<org>/<user id>`. The driver refuses anything
# that is not exactly that before interpolating it into a `docker run`.
workspace_path="$(field "$fu_claim" workspacePath)"
case "$workspace_path" in
default/????????-????-????-????-????????????) ok 'the claim carries a workspace path' ;;
*) bad 'the claim carries a workspace path' "got '$workspace_path'" ;;
esac
expect_field  'the claim carries the session' "$fu_claim" resumeSessionId "$PARKED_SESSION"
expect_field  'the claim says it is a follow-up' "$fu_claim" followUp true
expect_field  'the follow-up starts at attempt 1' "$fu_claim" attempts 1
api POST "/api/jobs/$fu_id/complete" \
    "{\"leaseToken\":\"$(field "$fu_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

[ "$workspace_path" = "$member_path" ] && ok 'the claim names the provisioned member tree' ||
    bad 'the claim names the provisioned member tree' "claim '$workspace_path', provisioned '$member_path'"

# Retry (issue #326): a finished run whose driver died before reporting a session queues a fresh
# attempt of the thread head's command in the SAME thread: no session resumed, the command
# delivered fresh, the same worktree root.
retry_id="$(create_job 'retry me')"
expect_status 'a queued task cannot be retried' 409 POST "/api/jobs/$retry_id/retry"
retry_claim="$(body "$(api POST /api/jobs/claim '{"worker":"sessionless","leaseSeconds":300}')")"
api POST "/api/jobs/$retry_id/complete" \
    "{\"leaseToken\":\"$(field "$retry_claim" leaseToken)\",\"status\":\"failed\",\"exitCode\":1,\"output\":\"died\"}" >/dev/null
retry_out="$(api POST "/api/jobs/$retry_id/retry")"
if [ "$(status "$retry_out")" = '201' ]; then ok 'a sessionless finished task can be retried'; else
    bad 'a sessionless finished task can be retried' "wanted 201, got $(status "$retry_out"): $(body "$retry_out")"; fi
retry2_id="$(field "$(body "$retry_out")" id)"
printf '%s\n' "$retry2_id" >>"$work/created-jobs"
r2_claim="$(body "$(api POST /api/jobs/claim '{"worker":"retries","leaseSeconds":300}')")"
expect_field 'the retry claim comes back'         "$r2_claim" id "$retry2_id"
expect_field 'the retry re-runs the head command' "$r2_claim" command 'retry me'
expect_field 'the retry stays in the thread'      "$r2_claim" rootJobId "$retry_id"
expect_field 'the retry claims no session'        "$r2_claim" resumeSessionId ''
expect_field 'the retry is not a follow-up'       "$r2_claim" followUp false
expect_field 'the retry starts at attempt 1'      "$r2_claim" attempts 1
api POST "/api/jobs/$retry2_id/complete" \
    "{\"leaseToken\":\"$(field "$r2_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

# Only done or removed closes a task: the sessionless retry still takes a follow-up, which starts a
# fresh session and is delivered behind a recap of the earlier turns.
fu_out="$(api POST "/api/jobs/$retry2_id/follow-up" '{"command":"continue this"}')"
if [ "$(status "$fu_out")" = '201' ]; then ok 'a sessionless finished task can be followed up'; else
    bad 'a sessionless finished task can be followed up' "wanted 201, got $(status "$fu_out"): $(body "$fu_out")"; fi
fu_id="$(field "$(body "$fu_out")" id)"
printf '%s\n' "$fu_id" >>"$work/created-jobs"
fu_claim="$(body "$(api POST /api/jobs/claim '{"worker":"sessionless-follow-up","leaseSeconds":300}')")"
expect_field 'the sessionless follow-up claim comes back' "$fu_claim" id "$fu_id"
expect_field 'the sessionless follow-up resumes nothing'  "$fu_claim" resumeSessionId ''
expect_field 'the sessionless follow-up is a follow-up'   "$fu_claim" followUp true
api POST "/api/jobs/$fu_id/complete" \
    "{\"leaseToken\":\"$(field "$fu_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

fi

if selected_phase driver; then
begin_phase driver
# --- The driver ------------------------------------------------------------------------------

echo
echo '# driver'

start_driver "$IMAGE_OK"

first="$(create_job 'first prompt')"
second="$(create_job 'second prompt')"
third="$(create_job 'third prompt')"

expect_contains 'runs a queued job'        "$(await_settled "$first")"  succeeded
expect_contains 'runs the second'          "$(await_settled "$second")" succeeded
# Three jobs against a concurrency of two: this one only runs once a slot frees.
expect_contains 'queues past the slots'    "$(await_settled "$third")"  succeeded

ran="$(body "$(api GET "/api/jobs/$first")")"
expect_field    'the exit code comes back' "$ran" exitCode 0
# The stub image echoes its arguments, so the output is the proof the prompt reached the container.
expect_contains 'the prompt reached it'    "$(field "$ran" output)" 'first prompt'
expect_contains 'the driver names itself'  "$(field "$ran" claimedBy)" driver-
expect_field    'one attempt was enough'   "$ran" attempts 1

# A normal run's claim ends `observed` (the runner proved the agent started) with its end stamped:
# only observed|adopted claims count as run segments, so `unknown` here is a launch-proof bug.
exec_rows="$(compose exec -T postgres psql -U factory -d "$DB" -qtA -v ON_ERROR_STOP=1 \
    -c "select launch || '|' || (ended_at is not null) || '|' || (created_at <= ended_at) from job_execution where job_id = '$first'" 2>&1)"
if [ "$exec_rows" = 'observed|true|true' ]; then ok 'the finished claim ends observed'
else bad 'the finished claim ends observed' "job_execution rows (launch|ended|ordered): $exec_rows"; fi

# The driver mints the session id, passes it to the runner as --session-id and reports it to the
# board. The stub echoes its arguments, so finding the reported id inside the output is what proves
# the two are the same one — a link built from it opens the session the job actually ran as.
session="$(field "$ran" sessionId)"
case "$session" in
    ????????-????-????-????-????????????) ok 'the session id was reported' ;;
    *) bad 'the session id was reported' "got '$session'" ;;
esac
expect_contains 'the runner was given that id' "$(field "$ran" output)" "$session"

# The vertical proof for the runner environment: configured on the board in the board section,
# resolved onto the claim, forwarded into the container, printed by the stub. Today the whole
# chain is dark; with it, the markers come back in the job's output.
env_job="$(create_job 'env probe')"
expect_contains 'runs the env job' "$(await_settled "$env_job")" succeeded
env_ran="$(body "$(api GET "/api/jobs/$env_job")")"
expect_contains 'the core env reached the runner'     "$(field "$env_ran" output)" 'org-marker'
expect_contains 'the core secret reached the runner'  "$(field "$env_ran" output)" 'secret-marker'

stop_driver
start_driver "$IMAGE_FAIL"

failing="$(create_job 'this one fails')"
expect_contains 'a non-zero exit is a failure' "$(await_settled "$failing")" failed
failed_body="$(body "$(api GET "/api/jobs/$failing")")"
expect_field    'the exit code is reported'    "$failed_body" exitCode 3
expect_contains 'stderr is captured'           "$(field "$failed_body" output)" boom

# Issue #814, through the real driver's agent flags: the agent's tool runs as the tool uid, so its
# `kill -TERM 1; kill -KILL -1` reaches only its own processes and the run goes on to succeed.
stop_driver
start_driver "$IMAGE_KILL"

killing="$(create_job 'a tool that kills everything it may')"
expect_contains 'a run whose tool signals everything it may succeeds' "$(await_settled "$killing")" succeeded
kill_body="$(body "$(api GET "/api/jobs/$killing")")"
expect_contains 'the agent survived its tool'  "$(field "$kill_body" output)" 'agent survived'
expect_contains 'the tool ran as the tool uid' "$(field "$kill_body" output)" 'the tool ran as 1001'
expect_field    'one attempt was enough for it' "$kill_body" attempts 1

# Issue #824 D11: an executor image the daemon refuses on its own words (an invalid reference — no
# network asked) fails the job as a configuration fault on its first attempt, the daemon's reason in
# the output, instead of a lease burnt down to dead.
stop_driver
start_driver 'Factory-Lane-Invalid-Reference'

unstartable="$(create_job 'an image the daemon refuses')"
expect_contains 'a refused executor image is a failure' "$(await_settled "$unstartable")" failed
unstartable_body="$(body "$(api GET "/api/jobs/$unstartable")")"
expect_field    'it is a configuration fault'     "$unstartable_body" failureKind config
expect_field    'on its first attempt'            "$unstartable_body" attempts 1
expect_contains 'the daemon says why'             "$(field "$unstartable_body" output)" 'invalid reference format'

stop_driver
start_driver "$IMAGE_OK"

# The opencode switch, end to end: same stub image (its entrypoint echoes, so the output is the
# argv the container received), but the driver now speaks opencode's headless form — `run <prompt>`
# — and, because opencode cannot adopt a minted session id, reports no session at all.
oc="$(create_job 'opencode prompt' opencode)"
expect_contains 'an opencode driver runs its job' "$(await_settled "$oc")" succeeded
oc_body="$(body "$(api GET "/api/jobs/$oc")")"
# The reserved `factory` primary agent carries the board's master prompt (issue #244), so the
# headless form is `run --agent factory <message>`. The message is the turn context, then the prompt
# (#518, 87eaca1f): the stub re-echoes the last argument on its final line, so that line is the
# prompt's own.
expect_contains 'the opencode argv reached it' "$(field "$oc_body" output)" 'run --agent factory '
oc_last="$(node -e 'process.stdout.write(process.argv[1].trimEnd().split("\n").at(-1))' "$(field "$oc_body" output)")"
[ "$oc_last" = 'opencode prompt' ] && ok 'the opencode message ends with the prompt' ||
    bad 'the opencode message ends with the prompt' "last line: '$oc_last'"
expect_field    'no session was reported'      "$oc_body" sessionId ''

# The org scope, end to end: the task stamps `executorScope: 'org'`, the claim resolves the ORG
# row, and its configuration reaches the container — the marker in the output is the org profile's
# `model`, which no personal row carries (issue 391).
org_job="$(create_job 'org prompt' "$ORG_EXECUTOR" org)"
expect_contains 'an org-scoped task runs' "$(await_settled "$org_job")" succeeded
org_body="$(body "$(api GET "/api/jobs/$org_job")")"
expect_contains 'the org config reached the runner' "$(field "$org_body" output)" 'org-team-model'
expect_field    'the org scope is stamped'          "$org_body" executorScope org

stop_driver

fi

if selected_phase github-credential; then
begin_phase github-credential
# --- The runner's GitHub token (docs/connections.md) ------------------------------------------
#
# A second board on the same database boots the lanes' entry (server/dist/offline-mint.js): the
# offline board plus a stand-in mint whose tokens live just past the helper's renewal skew. The
# driver claims from the open board, which holds no App, so its own steps get no token and the
# plain file-origin sync stays as it is; RUNNER_STATS_URL points the runner at the mint board. The
# job runs the image helper itself in a container the driver built: it renews across the forced
# expiry, caches on the memory tmpfs at 0700, carries no token in its env, answers git's credential
# protocol, and clears the cache. The output carries markers, never a token.

echo
echo '# github credential'

MINT_PORT=$((PORT + 2))
env AUTH_MODE=none DATABASE_URL="$DATABASE_URL" PORT="$MINT_PORT" HOST=127.0.0.1 \
    REPO_CLONE_BASE="$PLAN_BASE" \
    node server/dist/offline-mint.js >>"$work/mint-server.log" 2>&1 &
mint_pid=$!
mint_up=""
for _ in $(seq 1 40); do
    [ "$(status "$(BASE="http://127.0.0.1:$MINT_PORT" api GET /api/ready)")" = '200' ] && {
        mint_up=1
        break
    }
    sleep 1
done
[ -n "$mint_up" ] && ok 'the mint board comes up' || bad 'the mint board comes up' "$(tail -5 "$work/mint-server.log")"

mkdir -p "$work/github"
cp docker/claude-executor/github-credential.cjs "$work/github/"
# Through the tool shell: git and gh run as the tool uid, which owns the cache (issue #814).
printf '#!/bin/sh\nfor last in "$@"; do :; done\nexec "$SHELL" -c "$last"\n' >"$work/github/run.sh"
printf 'FROM %s\nCOPY github-credential.cjs /usr/local/bin/github-credential.cjs\nCOPY run.sh /run.sh\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","/run.sh"]\n' "$IMAGE_BASE" >"$work/github/Dockerfile"
docker build -q -t "$IMAGE_GH" "$work/github" >/dev/null || {
    echo 'test-jobs: could not build the github helper stub image'
    exit 1
}

env JOB_BOARD_URL="$BASE" RUNNER_STATS_URL="http://host.docker.internal:$MINT_PORT" \
    CLAUDE_EXECUTOR_IMAGE="$IMAGE_GH" OPENCODE_EXECUTOR_IMAGE="$IMAGE_GH" \
    RUNNER_SERVICES=0 REPO_CLONE_BASE="$CLONE_BASE" RUNNER_NETWORK="$NETWORK" \
    DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=60 \
    node driver/dist/index.js >>"$work/driver.log" 2>&1 &
driver_pid=$!

gh_job="$(create_job 'h=/usr/local/bin/github-credential.cjs
a="$(node $h token)" || exit 11
b="$(node $h token)" || exit 12
sleep 6
c="$(node $h token)" || exit 13
[ "$a" = "$b" ] && echo gh-cached
[ "$c" != "$a" ] && echo gh-renewed
echo "gh-mode-$(stat -c %a /run/factory-github)"
awk '"'"'$2 == "/run/factory-github" { print "gh-fs-" $3 }'"'"' /proc/mounts
env | grep -q -e "^GITHUB_TOKEN=" -e "^GH_TOKEN=" || echo gh-no-env-token
git config --global credential.https://github.com.helper "!node $h git"
printf "protocol=https\nhost=github.com\n\n" | git credential fill | grep -q "^password=lane_" && echo gh-git-answers
node $h clear && [ ! -e /run/factory-github/token.json ] && echo gh-cleared')"
expect_contains 'the github helper job succeeds' "$(await_settled "$gh_job" 120)" succeeded
gh_out="$(field "$(body "$(api GET "/api/jobs/$gh_job")")" output)"
expect_contains 'a token is served from the cache inside its life' "$gh_out" gh-cached
expect_contains 'a token past the renewal skew is renewed'       "$gh_out" gh-renewed
expect_contains 'the cache directory is 0700'                    "$gh_out" gh-mode-700
expect_contains 'the cache is a memory tmpfs'                    "$gh_out" gh-fs-tmpfs
expect_contains 'the runner env carries no GitHub token'         "$gh_out" gh-no-env-token
expect_contains "git's credential protocol answers github.com"   "$gh_out" gh-git-answers
expect_contains 'the cache is cleared'                           "$gh_out" gh-cleared
case "$gh_out" in
*lane_*) bad 'no token reaches the job output' "a lane token is in the output" ;;
*) ok 'no token reaches the job output' ;;
esac
expect_contains "the driver's own steps got no token from the App-less board" "$(cat "$work/driver.log")" \
    'the board issued no GitHub token for the checkout sync'

stop_driver
kill "$mint_pid" 2>/dev/null
wait "$mint_pid" 2>/dev/null
mint_pid=""

fi

if selected_phase services || selected_phase orphan-reaper || selected_phase node-disruption ||
    selected_phase driver-kill || selected_phase run-deadline || selected_phase capacity; then
begin_phase service-fixture
mkdir -p "$work/svc"
printf '%s\n' \
    '#!/bin/sh' \
    'while true; do' \
    "    printf 'HTTP/1.1 200 OK\\r\\nContent-Length: 13\\r\\n\\r\\nservice-is-up' | nc -l -p 8000" \
    'done' >"$work/svc/serve.sh"
printf 'FROM alpine:3\nCOPY serve.sh /serve.sh\nCMD ["sh","/serve.sh"]\n' >"$work/svc/Dockerfile"
docker build -q -t "$IMAGE_SVC" "$work/svc" >/dev/null || {
    echo 'test-jobs: could not build the service stub image'
    exit 1
}
mkdir -p "$work/run"
printf '#!/bin/sh\nfor last in "$@"; do :; done\nexec sh -c "$last"\n' >"$work/run/run.sh"
# `sh /run.sh` rather than exec-ing it: a file written by this script has no exec bit to copy in.
printf 'FROM %s\nCOPY run.sh /run.sh\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","/run.sh"]\n' "$IMAGE_BASE" >"$work/run/Dockerfile"
docker build -q -t "$IMAGE_RUN" "$work/run" >/dev/null || {
    echo 'test-jobs: could not build the runner-exec stub image'
    exit 1
}

fi

if selected_phase services; then
begin_phase services
# --- Auxiliary services (.bellows.yaml) -------------------------------------------------------
#
# Issue #6, end to end: a checkout declares a service, the driver starts it in the network
# namespace of the task's group supervisor, whose hosts file names it on loopback (issue #773), and
# the runner and the gate container reach it by name. The stub runner is the one image here whose
# entrypoint EXECUTES the prompt (the driver always puts it last in the argv), so the job's output
# is the hosts entry and an HTTP fetch of `http://stub-svc:8000/probe` — the assertion fails unless
# the name resolves to 127.0.0.1 and the service answers there.

echo
echo '# services'

# The author and their tree, learned the way the board phase learns one: a probe claim, completed
# immediately so the FIFO below is not holding a live lease.
wp_id="$(create_job 'services probe')"
wp_claim="$(body "$(api POST /api/jobs/claim '{"worker":"svc-probe","leaseSeconds":300}')")"
wp="$(field "$wp_claim" workspacePath)"
case "$wp" in
default/????????-????-????-????-????????????) ;;
*) bad 'the services probe claim carries a workspace path' "got '$wp'" ;;
esac
api POST "/api/jobs/$wp_id/complete" \
    "{\"leaseToken\":\"$(field "$wp_claim" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"ok\"}" >/dev/null

# The service: a one-file HTTP responder on busybox nc — current alpine:3 ships no httpd applet,
# and the answer is deliberately static so the assertion reads the alias, not the server. The
# runner-exec image: a script that runs the prompt, which the echo stubs cannot do.
write_bellows "services:
  - name: stub-svc
    image: $IMAGE_SVC"

start_driver "$IMAGE_RUN" 1

svc="$(create_job 'grep -E "^127\.0\.0\.1[[:space:]]+stub-svc$" /etc/hosts && wget -qO- http://stub-svc:8000/probe')"
expect_contains 'a declared service is reachable by name' "$(await_settled "$svc")" succeeded
svc_out="$(field "$(body "$(api GET "/api/jobs/$svc")")" output)"
expect_contains 'the service answered the runner'           "$svc_out" service-is-up
expect_contains 'the name resolves to 127.0.0.1 for the agent' "$svc_out" '127.0.0.1'

# The gate container shares the same namespace: a declared gate that passes only when the name is
# on its loopback and the service answers there. The gate image is the service stub's alpine.
write_bellows "services:
  - name: stub-svc
    image: $IMAGE_SVC
environment:
    image: $IMAGE_SVC
    gates:
        - name: reach
          command: 'grep -Eq \"^127\\.0\\.0\\.1[[:space:]]+stub-svc\$\" /etc/hosts && wget -qO- http://stub-svc:8000/probe'"
gated="$(create_job 'echo the agent ran')"
expect_contains 'the gate reaches the service by name on 127.0.0.1' "$(await_settled "$gated" 120)" succeeded

# The refusal path, end to end: a file the parser refuses fails the job with the reason, and the
# runner never spawns — the output is the parse error alone.
write_bellows 'services:
  - name: db
    image: postgres
    ports: ["5432:5432"]'
broken="$(create_job 'echo must not run')"
expect_contains 'a malformed file fails the job' "$(await_settled "$broken")" failed
expect_contains 'the parse reason comes back'    "$(field "$(body "$(api GET "/api/jobs/$broken")")" output)" '.bellows.yaml'

stop_driver

# Nothing of THIS RUN's jobs may survive the driver, and no job made a network of its own: the
# services share their group supervisor's namespace (issue #773). Scoped to the ids this script
# created — the daemon may be serving a live deployment whose factory.job containers and
# factory-job-* networks are none of this suite's business.
svc_networks=0
leftover=0
for job in $(cat "$work/created-jobs" 2>/dev/null); do
    n="$(docker network ls --filter "name=factory-job-$job-" --format '{{.Name}}' | wc -l | tr -d ' ')"
    svc_networks=$((svc_networks + n))
    n="$(docker ps -aq --filter "label=factory.job=$job" | wc -l | tr -d ' ')"
    leftover=$((leftover + n))
done
if [ "$svc_networks" = '0' ]; then ok 'no job made a network of its own'; else bad 'no job made a network of its own' "$svc_networks found"; fi
if [ "$leftover" = '0' ]; then ok 'no containers left behind'; else bad 'no containers left behind' "$leftover remain"; fi

fi

if selected_phase orphan-reaper; then
begin_phase orphan-reaper
# --- The orphan reaper (issue #301) -----------------------------------------------------------
#
# The exact shape the issue describes: a service fleet is up, the driver is kill -9ed before its
# teardown can run, and the job goes terminal WITHOUT any driver alive to sweep it — the stop
# route's in-place landing on a row whose lease has already expired (#152) is what settles it.
# A restarted driver's reaper (one fast round of DRIVER_REAP_INTERVAL_MS/GRACE) then removes the
# service container; no network is the attempt's (issue #773). The runner container is NOT the reaper's to reap
# (its scope is the service label; the fence owns the rest), so it is hand-removed at the end,
# by label, exactly as an operator would.

echo
echo '# orphan reaper'

write_bellows "services:
  - name: stub-svc
    image: $IMAGE_SVC"

# A 10s lease keeps the expired-lease wait short; the reaper driver after the kill gets a fast
# cadence and a grace the fleet has long outlived.
env JOB_BOARD_URL="$BASE" CLAUDE_EXECUTOR_IMAGE="$IMAGE_RUN" OPENCODE_EXECUTOR_IMAGE="$IMAGE_RUN" \
    RUNNER_SERVICES=1 REPO_CLONE_BASE="$CLONE_BASE" RUNNER_NETWORK="$NETWORK" \
    DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=10 \
    node driver/dist/index.js >>"$work/driver.log" 2>&1 &
driver_pid=$!

orphan="$(create_job 'sleep 60')"

orphan_fleet=""
for _ in $(seq 1 60); do
    orphan_fleet="$(docker ps -aq --filter "label=factory.job=$orphan" --filter "label=factory.service")"
    [ -n "$orphan_fleet" ] && break
    sleep 1
done
if [ -n "$orphan_fleet" ]; then
    ok 'the service fleet is up'
else
    bad 'the service fleet is up' "no factory.service container appeared; job: $(field "$(body "$(api GET "/api/jobs/$orphan")")" output 2>/dev/null); driver: $(tail -3 "$work/driver.log")"
fi

# The crash: no teardown, no verdict, no heartbeat. kill -9 takes the DRIVER only — the spawned
# `docker run` client is orphaned, not killed, and the container runs on detached, which is
# exactly the state the reaper exists to clean up: a fleet whose owner is gone.
kill -9 "$driver_pid" 2>/dev/null
wait "$driver_pid" 2>/dev/null
driver_pid=""

# The lease has 10 seconds on it; the stop is only an in-place landing once it has expired
# (#152), so poll the stop until the row says stopped.
orphan_stopped=""
for _ in $(seq 1 45); do
    sleep 1
    out="$(api POST "/api/jobs/$orphan/stop" '{}')"
    case "$(status "$out")" in
    200) orphan_stopped=1; break ;;
    esac
done
if [ -n "$orphan_stopped" ] && [ "$(field "$(body "$(api GET "/api/jobs/$orphan")")" status)" = 'stopped' ]; then
    ok 'the crashed job settles stopped with no driver alive'
else
    bad 'the crashed job settles stopped with no driver alive' "$(field "$(body "$(api GET "/api/jobs/$orphan")")" status)"
fi

# The leak the issue exists for: terminal job, fleet still on the daemon.
orphan_fleet="$(docker ps -aq --filter "label=factory.job=$orphan" --filter "label=factory.service")"
if [ -n "$orphan_fleet" ]; then
    ok 'the terminal job keeps its fleet on the daemon'
else
    bad 'the terminal job keeps its fleet on the daemon' 'the fleet vanished before the reaper ran'
fi

# The reaper, at a fast cadence: first sweep fires at startup, the fleet is minutes old by now,
# so one round is all it takes.
env JOB_BOARD_URL="$BASE" CLAUDE_EXECUTOR_IMAGE="$IMAGE_OK" OPENCODE_EXECUTOR_IMAGE="$IMAGE_OK" \
    RUNNER_SERVICES=0 REPO_CLONE_BASE="$CLONE_BASE" RUNNER_NETWORK="$NETWORK" \
    DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=60 \
    DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000 \
    node driver/dist/index.js >>"$work/driver.log" 2>&1 &
driver_pid=$!

orphan_reaped=""
for _ in $(seq 1 30); do
    [ -z "$(docker ps -aq --filter "label=factory.job=$orphan" --filter "label=factory.service")" ] && {
        orphan_reaped=1
        break
    }
    sleep 1
done
if [ -n "$orphan_reaped" ]; then
    ok "the reaper removes the crashed attempt's service container"
else
    bad "the reaper removes the crashed attempt's service container" 'the service container survived the reaper'
fi

if [ -z "$(docker network ls --filter "name=factory-job-$orphan-" --format '{{.Name}}')" ]; then
    ok 'the crashed attempt made no network of its own'
else
    bad 'the crashed attempt made no network of its own' 'a factory-job network exists for it'
fi

# The runner container is the fence's territory, not the reaper's — cleaned up by label, the
# way an operator would, so the daemon is left as the script found it. One id per rm: a quoted
# command substitution would hand docker the whole match list as ONE newline-joined argument and
# nothing would be removed.
docker ps -aq --filter "label=factory.job=$orphan" |
    while IFS= read -r container_id; do
        [ -n "$container_id" ] && docker rm -f "$container_id" >/dev/null 2>&1
    done

stop_driver

fi

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
expect_field 'the killed attempt is refunded' "$killed_body" attempts 1
killed_int="$(interruptions_of "$killed_body")"
[ "$killed_int" = "1|1|$EXPIRED" ] && ok 'one interruption records the expiry of claim 1' ||
    bad 'one interruption records the expiry of claim 1' "count|claimSeq|reason: $killed_int"
grep -qF "job $killed: $TOOK_OVER" "$work/driver.log" && ok 'the driver logs the takeover' ||
    bad 'the driver logs the takeover' "$(grep -F "job $killed:" "$work/driver.log" | tail -5)"
reaped=""
for _ in $(seq 1 30); do
    [ -z "$(first_runner "$killed")" ] && {
        reaped=1
        break
    }
    sleep 1
done
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
handed=""
for _ in $(seq 1 8); do
    sleep 1
    drained_body="$(body "$(api GET "/api/jobs/$drained")")"
    [ "$(field "$drained_body" status)|$(interruptions_of "$drained_body")" = "queued|1|1|$DRAINED" ] && {
        handed=1
        break
    }
done
[ -n "$handed" ] && ok 'a drained driver hands its run back as an interruption' ||
    bad 'a drained driver hands its run back as an interruption' "status: $(field "$drained_body" status), count|claimSeq|reason: $(interruptions_of "$drained_body")"
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
expect_field 'the handed-over attempt is refunded' "$drained_body" attempts 1
drained_int="$(interruptions_of "$drained_body")"
[ "$drained_int" = "1|1|$DRAINED" ] && ok 'the handover and its adoption are one interruption' ||
    bad 'the handover and its adoption are one interruption' "count|claimSeq|reason: $drained_int"
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
marked=""
for _ in $(seq 1 30); do
    docker exec "$lost_runner" sh -c 'test -f "$WORKDIR/.factory/lane-lost.mark"' >/dev/null 2>&1 && {
        marked=1
        break
    }
    sleep 1
done
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
expect_field 'the lost attempt spends no attempt' "$lost_body" attempts 1
lost_int="$(interruptions_of "$lost_body")"
[ "$lost_int" = "1|1|$EXPIRED" ] && ok 'one interruption records the expiry of claim 1' ||
    bad 'one interruption records the expiry of claim 1' "count|claimSeq|reason: $lost_int"
expect_field 'the row keeps the lost session' "$lost_body" sessionId "$lost_session"
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

if selected_phase driver-kill; then
begin_phase driver-kill
# --- Driver killed at each step of a run (issue #829) ----------------------------------------
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

dk_settled() { # dk_settled <name> <job id> <interruption> -> the checks every case shares once the job ran to its end
    local body_json left
    expect_contains "$1: the next claim finishes the task" "$(await_settled "$2" "$ADOPT_S")" succeeded
    body_json="$(body "$(api GET "/api/jobs/$2")")"
    expect_field "$1: the killed attempt is refunded" "$body_json" attempts 1
    [ "$(interruptions_of "$body_json")" = "1|1|$3" ] && ok "$1: one interruption records claim 1" ||
        bad "$1: one interruption records claim 1" "count|claimSeq|reason: $(interruptions_of "$body_json")"
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
k1_ended=""
for _ in $(seq 1 75); do
    [ -n "$(dk_supervisor "$k1" status=exited)" ] && {
        k1_ended=1
        break
    }
    sleep 2
done
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
dk_settled k1 "$k1" "$EXPIRED"
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
k2="$(create_job "$MK echo x >>$D/$n.agent.count; : >$D/$n.ready; $(lane_wait "$D/$n.go"); echo \"ran in \$HOSTNAME\"")"
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
rebound=""
for _ in $(seq 1 30); do
    # Captured first: under pipefail a grep -q that quits early would fail the pipe.
    k2_logs="$(docker logs "$k2_sup" 2>&1)"
    case "$k2_logs" in *'supervisor: rebound to claim 2'*)
        rebound=1
        break
        ;;
    esac
    sleep 1
done
[ -n "$rebound" ] && ok 'k2: the supervisor rebinds to claim 2' || bad 'k2: the supervisor rebinds to claim 2' "$(printf '%s' "$k2_logs" | tail -5)"
sleep 5
# A failed docker ps is not an empty list: it fails the case with docker's own words.
k2_second="$(docker ps -aq --filter "label=factory.job=$k2" --filter 'label=factory.claim-seq=2' --filter 'label=factory.role=agent' 2>&1)" &&
    [ -z "$k2_second" ] && ok 'k2: no second agent is started' ||
    bad 'k2: no second agent is started' "a claim-2 agent container exists, or docker failed: $k2_second"
lane_touch "$LANE_DIR/$n.go" || bad 'k2: the barrier is released' 'the touch failed'
dk_settled k2 "$k2" "$EXPIRED"
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
k2d_handed=""
for _ in $(seq 1 8); do
    sleep 1
    k2d_body="$(body "$(api GET "/api/jobs/$k2d")")"
    [ "$(field "$k2d_body" status)|$(interruptions_of "$k2d_body")" = "queued|1|1|$DRAINED" ] && {
        k2d_handed=1
        break
    }
done
[ -n "$k2d_handed" ] && ok 'k2d: the drained driver hands its run back' || bad 'k2d: the drained driver hands its run back' "$(interruptions_of "$k2d_body")"
# A drained driver ends on its own; one that does not within the deadline is killed, never waited on forever.
for _ in $(seq 1 60); do
    kill -0 "$driver_pid" 2>/dev/null || break
    sleep 1
done
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
dk_settled k2d "$k2d" "$DRAINED"
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
k4="$(create_job "$MK echo x >>$D/$n.agent.count; echo \"ran in \$HOSTNAME\"")"
lane_use "$k4"
lane_await 120 "$LANE_DIR/$n.gate.count" 1 && ok 'k4: the gate is running' || bad 'k4: the gate is running' "$(lane_count "$LANE_DIR/$n.gate.count")"
driver_kill
disruption_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
lane_touch "$LANE_DIR/$n.go" || bad 'k4: the barrier is released' 'the touch failed'
dk_settled k4 "$k4" "$EXPIRED"
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
k5="$(create_job "$MK mkdir -p $LANE_GH_DIR && : >$LANE_GH_DIR/lane-gh-hold && cd \"\$WORKDIR\" && git -c user.name=lane -c user.email=lane@localhost commit -q --allow-empty -m lane-commit && echo x >>$D/$n.agent.count && echo \"ran in \$HOSTNAME\"")"
lane_use "$k5"
lane_await_file 180 "$LANE_GH_DIR/lane-gh-hold.ready" && ok 'k5: the publish is at the PR' ||
    bad 'k5: the publish is at the PR' "job: $(field "$(body "$(api GET "/api/jobs/$k5")")" status), pushes '$(lane_origin lane_count "$DK_ORIGIN/lane-pushes.log")'"
driver_kill
lane_touch "$LANE_GH_DIR/lane-gh-hold.go" || bad 'k5: the hold is released' 'the touch failed'
disruption_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
dk_settled k5 "$k5" "$EXPIRED"
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
report=''
until=$(($(date +%s) + 60))
while [ "$(date +%s)" -lt "$until" ]; do
    report="$(grep -F 'FACTORY_SUPERVISOR_REPORT ' "$work/run-deadline.supervisor.log" 2>/dev/null | tail -1)"
    [ -n "$report" ] && break
    sleep 1
done
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

if selected_phase capacity; then
begin_phase capacity
# --- Competing drivers under one shared budget (issue #831) -----------------------------------
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
CAP_LIGHT_PORT=$((PORT + 1))
CAP_TOKEN="cap-$(openssl rand -hex 16)" # the boards' and drivers' shared worker secret, 32+ characters
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
    env DATABASE_URL="$DATABASE_URL" PORT="$1" HOST=127.0.0.1 \
        REPO_CLONE_BASE="$PLAN_BASE" \
        AUTH_MODE=github \
        GITHUB_OAUTH_CLIENT_ID=stub-client GITHUB_OAUTH_CLIENT_SECRET=stub-secret \
        SESSION_SECRET=a-job-harness-session-secret-32-chars \
        JOB_BOARD_TOKEN="$CAP_TOKEN" ADMISSION_MAX_RUNNING=2 \
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
    disruption_driver DRIVER_WORKER=cap-a JOB_BOARD_URL="http://127.0.0.1:$PORT" JOB_BOARD_TOKEN="$CAP_TOKEN" \
        DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
    cap_a_pid=$driver_pid
    disruption_driver DRIVER_WORKER=cap-b JOB_BOARD_URL="http://127.0.0.1:$CAP_LIGHT_PORT" JOB_BOARD_TOKEN="$CAP_TOKEN" \
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

if selected_phase review; then
begin_phase review
# --- The in-band reviewer (issue #774) ---------------------------------------------------------
#
# A task asks for a named review and waits on it, with ONE driver slot: the review is a step of the
# caller's own task group, run in the group's `reviewer` container (uid 1002, the shared clone
# read-only), never a queued job, never a container of its own. The stub image answers the reviewer
# as a scripted reviewer (scripts/stub-agent.sh, review mode): it names its executor and uid, tries
# a write into the clone and reports whether it failed, and ends on the verdict line. The first
# review holds for a while (a marker in the profile's instructions), long enough for a second key
# to meet it and for the containers to be counted.

echo
echo '# review'

mkdir -p "$work/review"
cat >"$work/review/review-caller.cjs" <<'CALLER'
const http = require('node:http');
const socketPath = `${process.env.FACTORY_CTL_OUT}/control.sock`;
const call = (method, path, body) =>
    new Promise((resolve, reject) => {
        const req = http.request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
            let text = '';
            res.on('data', (c) => (text += c));
            res.on('end', () => resolve({ status: res.statusCode, text }));
        });
        req.on('error', reject);
        req.end(body);
    });
const ask = (key) => call('POST', '/review', JSON.stringify({ key, profile: 'audit' }));
(async () => {
    console.log('first=' + (await ask('rv-a')).status);
    if (process.argv.slice(2).join(' ').includes('REVIEW-SECOND')) {
        const second = await ask('rv-b');
        console.log('second=' + second.status + ' ' + second.text);
    }
    let last;
    for (let i = 0; i < 150; i++) {
        last = await call('GET', '/review/rv-a');
        if (JSON.parse(last.text).done) break;
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.log('final=' + last.text);
    const reread = await call('GET', '/review/rv-a');
    console.log('reread=' + reread.status + ' ' + reread.text);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
CALLER
printf 'FROM %s\nCOPY review-caller.cjs /review-caller.cjs\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","node","/review-caller.cjs"]\n' "$IMAGE_BASE" >"$work/review/Dockerfile"
docker build -q -t "$IMAGE_REVIEW" "$work/review" >/dev/null || {
    echo 'test-jobs: could not build the review caller image'
    exit 1
}

write_bellows 'reviewers:
  - name: audit
    instructions: "Audit the tree. STUB-REVIEW-HOLD-20"
    timeout: 5'
start_driver "$IMAGE_REVIEW" 0 1

jobs_seen() { docker ps -a --filter 'label=factory.job' --filter "label=factory.board=$(board_id)" --format '{{.ID}} {{.Label "factory.job"}} {{.Label "factory.role"}}'; }
jobs_seen | cut -d' ' -f1 | sort -u >"$work/review-before"

rv="$(create_job 'review REVIEW-SECOND')"
: >"$work/review-seen"
: >"$work/review-user"
rv_until=$(($(date +%s) + 180))
while [ -z "$(settled "$rv")" ] && [ "$(date +%s)" -lt "$rv_until" ]; do
    jobs_seen | grep -v -F -f "$work/review-before" >>"$work/review-seen"
    for c in $(grep ' reviewer$' "$work/review-seen" | cut -d' ' -f1 | sort -u); do
        [ -s "$work/review-user" ] || docker inspect -f '{{.Config.User}}' "$c" >"$work/review-user" 2>/dev/null
    done
    sleep 1
done
expect_contains 'a caller that requests a review and waits on it completes with one driver slot' "$(await_settled "$rv" 120)" succeeded
rv_out="$(field "$(body "$(api GET "/api/jobs/$rv")")" output)"
expect_contains 'the first request starts the review'            "$rv_out" 'first=201'
expect_contains 'a second concurrent key is refused 409'          "$rv_out" 'second=409'
expect_contains 'the refusal says the first review is running'    "$rv_out" 'is running'
expect_contains 'the review ends clean'                           "$rv_out" 'verdict":"clean'
expect_contains 'the review ran as uid 1002'                      "$rv_out" 'uid=1002'
expect_contains 'the review could not write the shared tree'      "$rv_out" 'tree-write=denied'
expect_contains 'the stored key reads back after the review'      "$rv_out" 'reread=200'
rv_reviewers="$(grep -c ' reviewer$' <(sort -u "$work/review-seen"))"
rv_foreign="$(sort -u "$work/review-seen" | awk -v job="$rv" '$2 != job' | wc -l | tr -d ' ')"
[ "$rv_reviewers" = 1 ] && ok 'the group has exactly one reviewer container' ||
    bad 'the group has exactly one reviewer container' "$rv_reviewers seen: $(sort -u "$work/review-seen" | tr '\n' ';')"
[ "$rv_foreign" = 0 ] && ok 'no container besides the group'"'"'s was created for the review' ||
    bad 'no container besides the group'"'"'s was created for the review' "$(sort -u "$work/review-seen" | tr '\n' ';')"
case "$(cat "$work/review-user")" in
1002:*) ok 'the reviewer container is created as uid 1002' ;;
*) bad 'the reviewer container is created as uid 1002' "user: '$(cat "$work/review-user")'" ;;
esac

# The opencode executor reaches the same reviewer container through its own entrypoint.
rvo="$(create_job 'review' opencode)"
expect_contains 'an opencode caller completes its review' "$(await_settled "$rvo" 180)" succeeded
rvo_out="$(field "$(body "$(api GET "/api/jobs/$rvo")")" output)"
expect_contains 'the opencode review ran through opencode-executor' "$rvo_out" 'executor=opencode-executor'
expect_contains 'the opencode review ends clean'                   "$rvo_out" 'verdict":"clean'

# Clear the reviewer plan before later phases reuse the smoke repository.
write_bellows ''
stop_driver
fi

if selected_phase workflows; then
begin_phase workflows
# --- Workflows -------------------------------------------------------------------------------
#
# Issue #94, end to end. A workflow definition lives on the board (created through the API, the
# way the composer's dropdown is fed), and the board walks the graph: fetch → implement →
# review(BLOCKERS-marker) → fix → review(publish-marker) → publish. The echo stub makes every
# run's output deterministic, which is what lets marker edges decide the walk on a real board.
# A second and a third task are then walked BY HAND through the claim API, where the claim body
# itself is the assertion: the publish flag is true on the publish node's claim and false on every
# other, and a bounded edge rests the thread instead of walking past its limit.

echo
echo '# workflows'

# The stub walk. The marker contract rides the templates: review ends with the fix node's output
# tail — empty on round one (the BLOCKERS-marker shape), the fix marker on round two (the publish
# shape) — so the SAME deterministic stub output walks a different edge the second time through.
cat >"$work/stub-walk.json" <<'JSON'
{
  "name": "stub-walk",
  "scope": "org",
  "definition": {
    "entry": "fetch",
    "nodes": [
      { "name": "fetch", "kind": "agent", "session": "resume", "prompt": "fetch the issue" },
      { "name": "implement", "kind": "agent", "session": "resume", "prompt": "implement it\n{{fetch.output}}" },
      { "name": "review", "kind": "agent", "session": "fresh", "gates": false, "prompt": "review the work\n{{fix.output}}" },
      { "name": "fix", "kind": "agent", "session": "resume", "prompt": "fix it\n{{review.output}}\nFIXED-ONE-ROUND" },
      { "name": "publish", "kind": "agent", "session": "resume", "publish": true, "prompt": "ship it" }
    ],
    "edges": [
      { "from": "fetch", "to": "implement", "when": "succeeded" },
      { "from": "implement", "to": "review", "when": "succeeded" },
      { "from": "review", "to": "fix", "when": { "marker": "review the work" }, "max": 1 },
      { "from": "review", "to": "publish", "when": { "marker": "FIXED-ONE-ROUND" } },
      { "from": "fix", "to": "review", "when": "succeeded" }
    ]
  }
}
JSON
expect_status 'creates the stub workflow' 201 POST /api/workflows "$(cat "$work/stub-walk.json")"
expect_status 'the stub workflow is listed' 200 GET /api/workflows
expect_status 'refuses a pasted foreign pipeline' 400 POST /api/workflows \
    '{"name":"foreign","scope":"org","definition":{"nodes":[],"edges":[],"trigger":"on-push"}}'
expect_status 'refuses an unknown workflow name' 404 POST /api/jobs "{\"command\":\"x\",\"workflow\":\"ghost\",\"repo\":\"$SMOKE_REPO\"}"

# Thread reads, in node, because the assertions below walk arrays — no jq in the harness.
thread_nodes() { # thread_nodes <root-id> -> the node labels, oldest first, space-separated
    api GET "/api/jobs/$1/thread" |
        node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(t.map((j)=>j.workflowNode??"-").join(" "))})'
}
thread_session() { # thread_session <root-id> <index> -> that row's sessionId
    api GET "/api/jobs/$1/thread" |
        node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(String(t[Number(process.argv[1])]?.sessionId??""))})' "$2"
}
thread_command() { # thread_command <root-id> <index> -> that row's command
    api GET "/api/jobs/$1/thread" |
        node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(String(t[Number(process.argv[1])]?.command??""))})' "$2"
}

start_driver "$IMAGE_OK"
walked="$(api POST /api/jobs "{\"command\":\"walk me end to end\",\"executor\":\"claude\",\"workflow\":\"stub-walk\",\"repo\":\"$SMOKE_REPO\"}")"
wf_id="$(field "$(body "$walked")" id)"
printf '%s\n' "$wf_id" >>"$work/created-jobs"

# The board walks while the driver runs: wait until the thread holds all six nodes and the last is
# terminal — the walk is the BOARD's, so the row count is the assertion, not one job's verdict.
walk_done=""
for _ in $(seq 1 120); do
    nodes="$(thread_nodes "$wf_id")"
    last_status="$(api GET "/api/jobs/$wf_id/thread" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const t=JSON.parse(s.split("\t").slice(1).join("\t")||"{}").jobs||[];process.stdout.write(String(t[t.length-1]?.status??""))})')"
    if [ "$nodes" = 'fetch implement review fix review publish' ] && [ "$last_status" != queued ] && [ "$last_status" != running ]; then
        walk_done=1
        break
    fi
    sleep 1
done
if [ -n "$walk_done" ]; then ok 'the board walked fetch→implement→review→fix→review→publish'; else
    bad 'the board walked fetch→implement→review→fix→review→publish' "nodes: '$(thread_nodes "$wf_id")' last: '$last_status'"; fi

# The interpolation proof: the implement row's command is the template FILLED with the fetch row's
# output tail — the prompt that reached the stub container, not the {{...}} skeleton.
expect_contains 'the implement prompt carries the fetch output' "$(thread_command "$wf_id" 1)" 'fetch the issue'
expect_contains 'the fix prompt carries the review output'       "$(thread_command "$wf_id" 3)" 'review the work'

# The session proof: resume nodes (fetch, implement, fix, publish) carry the primary session; the
# fresh review rows do not — one worktree, N sessions.
primary="$(thread_session "$wf_id" 0)"
case "$primary" in
????????-????-????-????-????????????) ok 'the entry run reported a session' ;;
*) bad 'the entry run reported a session' "got '$primary'" ;;
esac
[ "$(thread_session "$wf_id" 1)" = "$primary" ] && ok 'implement resumed the primary session' ||
    bad 'implement resumed the primary session' "got '$(thread_session "$wf_id" 1)'"
[ "$(thread_session "$wf_id" 3)" = "$primary" ] && ok 'fix resumed the primary session' ||
    bad 'fix resumed the primary session' "got '$(thread_session "$wf_id" 3)'"
review1="$(thread_session "$wf_id" 2)"
review2="$(thread_session "$wf_id" 4)"
if [ -n "$review1" ] && [ "$review1" != "$primary" ] && [ -n "$review2" ] && [ "$review2" != "$primary" ] && [ "$review1" != "$review2" ]; then
    ok 'the review rounds ran fresh'
else
    bad 'the review rounds ran fresh' "review sessions: '$review1' '$review2' primary: '$primary'"
fi
stop_driver

# The claim-level assertions, walked by hand with the driver parked. The stub's walk is
# deterministic, so each complete below decides the next edge exactly as a real run would.
claim_walk() { # claim_walk <output> -> "id<TAB>leaseToken<TAB>publish" of the claimed row
    claim="$(api POST /api/jobs/claim '{"worker":"walker","leaseSeconds":300}')"
    if [ "$(status "$claim")" = '204' ]; then
        printf ''
        return
    fi
    node -e 'const c=JSON.parse(process.argv[1]);process.stdout.write([c.id,c.leaseToken,c.publish===undefined?"absent":String(c.publish)].join("\t"))' \
        "$(body "$claim")"
    if [ -n "$1" ]; then
        api POST "/api/jobs/$(field "$(body "$claim")" id)/complete" \
            "{\"leaseToken\":\"$(field "$(body "$claim")" leaseToken)\",\"status\":\"succeeded\",\"exitCode\":0,\"output\":\"$1\"}" >/dev/null
    fi
}
walk_flag() { # walk_flag <name> <got> <want>
    if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "publish wanted '$3', got '$2'"; fi
}

# Task two: the publish flag. Every node's claim says false until the graph's publish node — six
# claims to walk the whole graph: fetch, implement, review, fix, the second review, then publish.
wf2="$(api POST /api/jobs "{\"command\":\"flag walk\",\"executor\":\"claude\",\"workflow\":\"stub-walk\",\"repo\":\"$SMOKE_REPO\"}")"
wf2_id="$(field "$(body "$wf2")" id)"
printf '%s\n' "$wf2_id" >>"$work/created-jobs"
walk_out="$(claim_walk 'fetch the issue')"
walk_flag 'the fetch claim may not publish'    "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'implement it')"
walk_flag 'the implement claim may not publish' "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'review the work')"
walk_flag 'the review claim may not publish'    "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'FIXED-ONE-ROUND')"
walk_flag 'the fix claim may not publish'       "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'FIXED-ONE-ROUND')"
walk_flag 'the second review claim may not publish' "$(printf '%s' "$walk_out" | cut -f3)" false
walk_out="$(claim_walk 'ship it')"
walk_flag 'the publish node claim may publish'  "$(printf '%s' "$walk_out" | cut -f3)" true

# Task three: the loop bound. The second review names the fix marker AGAIN, but review→fix is
# bounded at one and the fix row already exists — the board rests the thread instead.
wf3="$(api POST /api/jobs "{\"command\":\"bound walk\",\"executor\":\"claude\",\"workflow\":\"stub-walk\",\"repo\":\"$SMOKE_REPO\"}")"
wf3_id="$(field "$(body "$wf3")" id)"
printf '%s\n' "$wf3_id" >>"$work/created-jobs"
claim_walk 'fetch the issue' >/dev/null
claim_walk 'implement it' >/dev/null
claim_walk 'review the work' >/dev/null
claim_walk 'fixed' >/dev/null
claim_walk 'review the work' >/dev/null
sleep 2
if [ "$(thread_nodes "$wf3_id")" = 'fetch implement review fix review' ]; then
    ok 'the bounded edge rests the loop at its limit'
else
    bad 'the bounded edge rests the loop at its limit' "nodes: '$(thread_nodes "$wf3_id")'"
fi
expect_status 'a rested thread offers nothing more' 204 POST /api/jobs/claim '{"worker":"idle-walker"}'

fi

if selected_phase acceptance; then
begin_phase acceptance
# --- The failure matrix, accepted end to end (issue #779) -------------------------------------
#
# The docker twin of the kind lane's acceptance phase (scripts/test-k8s.sh): a driver runs a task
# whose runner leaves a transcript on the task volume (scripts/k8s-stub.sh `factory-stub-transcript-<n>`),
# and the board's artifact read must hold those bytes — after a complete run, after the runner's whole
# container group is force-removed with the task volume kept, and after a follow-up. A read that
# failed, was refused or came back malformed is `bad`, never a negative verdict.

echo
echo '# acceptance: the failure matrix'

. "$REPO/scripts/acceptance-lib.sh"
ACC_N=5
ACC_REL="/task/.lane-acc"
export ACC_AUTH="${AUTH_HEADER:-}"

# The runner image: the kind lane's stub itself, so both lanes answer the same `factory-stub-*` words.
mkdir -p "$work/acc"
cp scripts/k8s-stub.sh "$work/acc/stub.sh"
printf 'FROM %s\nCOPY stub.sh /stub.sh\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","/stub.sh"]\n' "$IMAGE_BASE" >"$work/acc/Dockerfile"
docker build -q -t "$IMAGE_ACC" "$work/acc" >/dev/null || {
    echo 'test-jobs: could not build the acceptance stub image'
    exit 1
}
start_driver "$IMAGE_ACC" 0 2

acc_job() { # acc_job <command> -> the new job's id (create_job records it for teardown)
    create_job "$1" claude
}

acc_post() { # acc_post <path> [json] -> the new job's id, empty unless the board answered 201 with one; why in $work/acc-post.refusal
    # acceptance-lib.sh does the POST and the shape check: an id that is not a string is a refusal.
    acc_post_id "$BASE" "$1" "${2-}" | tee -a "$work/created-jobs"
}

acc_brief() { # acc_brief <id> -> "status|attempts|interruptions|first claimSeq|first reason"; "unread: ..." when the read failed or was misshapen
    acc_job_read "$BASE" "$1" brief
}

acc_await() { # acc_await <id> <case pattern> <seconds> -> the last brief; returns 0 once it matched
    local until=$(($(date +%s) + $3)) b=""
    while [ "$(date +%s)" -lt "$until" ]; do
        b="$(acc_brief "$1")"
        # shellcheck disable=SC2254 # the pattern is the point
        case "$b" in $2) printf '%s' "$b"; return 0 ;; esac
        sleep 1
    done
    dump_stall "$1"
    printf '%s' "$b"
    return 1
}

acc_check() { # acc_check <name> <got> <want>
    [ "$2" = "$3" ] && ok "$1" || bad "$1" "got '$2', wanted '$3'"
}

acc_session() { # acc_session <id> -> its session id, asked again until the board answered with one
    local got until=$(($(date +%s) + 60))
    while :; do
        got="$(acc_job_read "$BASE" "$1" session)"
        case "$got" in '' | unread*) ;; *) break ;; esac
        [ "$(date +%s)" -lt "$until" ] || break
        sleep 3
    done
    printf '%s' "$got"
}

acc_volume_records() { # acc_volume_records <id> <session> -> the lines of the session file on the volume; ? when unread
    local out
    lane_use "$1"
    # wc reads the file itself, so a failed read is its own status; one file only, never a glob's several.
    out="$(lane_run 'set -- /task/.factory/transcripts/"$1"/projects/*/"$2".jsonl; [ "$#" -eq 1 ] && [ -f "$1" ] && n="$(wc -l <"$1")" && echo "$n"' "$1" "$2" 2>/dev/null)" &&
        out="${out//[[:space:]]/}" && case "$out" in '' | *[!0-9]*) false ;; esac && printf '%s' "$out" || printf '?'
}

acc_ready() { # acc_ready <release path> -> 0 once the stub marked itself waiting there, 1 when absent, 2 unconfirmed
    lane_run 'for f in "$1".ready-*; do [ -e "$f" ] && exit 0; done; exit 1' "$1" >/dev/null 2>&1
    case "$?" in 0) return 0 ;; 1) return 1 ;; *) return 2 ;; esac
}

acc_barrier() { # acc_barrier <id> <release path> -> success once the volume exists and the stub is at its barrier
    local until=$(($(date +%s) + 90))
    lane_use "$1"
    while [ "$(date +%s)" -lt "$until" ]; do
        acc_ready "$2" && return 0
        sleep 1
    done
    return 1
}

acc_containers() { # acc_containers <id> <role> -> the ids of the group's containers of that role; "unread" when docker did not answer
    local out
    # Whatever a failed listing printed first is dropped: only a listing that ended well is one.
    out="$(timeout 30 docker ps -aq --filter "label=factory.job=$1" --filter "label=factory.role=$2" 2>/dev/null)" || { printf unread; return 0; }
    printf '%s' "$out"
}

acc_mounts() { # acc_mounts <agent container> <task volume> <out file> -> "ok" or why not: every mount a named local volume, the task volume among them
    # What docker says the runner mounts and what each mounted volume is; unread is never ok. Read while the runner lives.
    timeout 30 docker inspect "$1" >"$3.inspect" 2>/dev/null || { printf 'unread: inspect'; return 0; }
    node -e '
const read = (f) => { try { return JSON.parse(require("fs").readFileSync(f, "utf8")); } catch { return null; } };
const c = read(process.argv[1] + ".inspect")?.[0];
if (!Array.isArray(c?.Mounts)) { process.stdout.write("unread: malformed inspect"); process.exit(0); }
const bad = [];
let task = false;
for (const m of c.Mounts) {
    if (m.Type !== "volume") bad.push(m.Type + " mount " + m.Destination);
    else if (m.Driver !== "local") bad.push("driver " + m.Driver + " " + m.Name);
    if (m.Name === process.argv[2]) task = true;
}
process.stdout.write(bad.length ? "bad: " + bad.join("; ") : task ? "ok" : "bad: the task volume " + process.argv[2] + " is not mounted: " + c.Mounts.map((m) => m.Name).join(" "));
' "$3" "$2"
}

acc_volumes() { # acc_volumes -> "ok <task volumes>" or why not: every task volume is a local, option-free docker volume
    local names
    names="$(timeout 30 docker volume ls -q --filter 'label=factory.task-root' --filter "label=factory.task-board=$(board_id)" 2>/dev/null)" || { printf 'unread: volume ls'; return 0; }
    # shellcheck disable=SC2086 # one name per word
    timeout 30 docker volume inspect $names >"$work/acc-vols.json" 2>/dev/null || { printf 'unread: volume inspect'; return 0; }
    node -e '
let list = null;
try { list = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); } catch {}
if (!Array.isArray(list)) { process.stdout.write("unread: malformed list"); process.exit(0); }
const bad = [];
for (const v of list) {
    if (!/^factory-task-/.test(v.Name)) bad.push("name " + v.Name);
    if (v.Driver !== "local" || (v.Options && Object.keys(v.Options).length)) bad.push("shared " + v.Name + " " + v.Driver + " " + JSON.stringify(v.Options));
}
process.stdout.write(bad.length ? "bad: " + bad.join("; ") : "ok " + list.map((v) => v.Name).join(" "));
' "$work/acc-vols.json"
}

acc_release() { # acc_release <id> <release path> -> success once the barrier file exists on the job'"'"'s volume
    lane_use "$1"
    lane_touch "$2" && return 0
    return 1
}

# a. A complete task: its group carries an exporter, leaves ACC_N records on the volume, and once settled
#    is reaped while the artifact read still holds every record, byte for byte, in a complete stream.
acc_a="$(acc_job "factory-stub-transcript-$ACC_N factory-stub-wait-$ACC_REL-a")"
if [ -z "$acc_a" ] || ! acc_barrier "$acc_a" "$ACC_REL-a"; then
    bad 'acceptance: a. the runner is running' "job '$acc_a': $(acc_brief "$acc_a")"
    exit 1
fi
ok 'acceptance: a. the runner is running'
acc_a_session="$(acc_session "$acc_a")"
acc_a_exporter="$(acc_containers "$acc_a" exporter)"
case "$acc_a_exporter" in
'' | unread) bad 'acceptance: a. the runner group carried an exporter container' "exporters: '$acc_a_exporter'" ;;
*) ok 'acceptance: a. the runner group carried an exporter container' ;;
esac
acc_a_agent="$(acc_containers "$acc_a" agent)"
acc_a_mounts=unread
case "$acc_a_agent" in '' | unread) ;; *) acc_a_mounts="$(acc_mounts "$(printf '%s' "$acc_a_agent" | sed -n 1p)" "factory-task-$acc_a-1" "$work/acc-a")" ;; esac
acc_check "acceptance: a. the volume holds $ACC_N records before the run ends" \
    "$(acc_poll "$ACC_N" 60 acc_volume_records "$acc_a" "$acc_a_session")" "$ACC_N"
acc_release "$acc_a" "$ACC_REL-a" || bad 'acceptance: a. the barrier is released' "could not write $ACC_REL-a"
acc_a_end="$(acc_await "$acc_a" 'succeeded*' 120)"
acc_check 'acceptance: a. the task succeeds in one attempt' "$acc_a_end" 'succeeded|1|0||'
acc_left=""
acc_reaped=""
acc_until=$(($(date +%s) + 120))
until acc_left="$(lane_left "$acc_a")" && acc_reaped=1; do
    [ "$(date +%s)" -lt "$acc_until" ] || break
    sleep 2
done
[ -n "$acc_reaped" ] && ok 'acceptance: a. the runner group is reaped' ||
    bad 'acceptance: a. the runner group is reaped' "${acc_left:-unconfirmed}"
acc_check "acceptance: a. the artifact read holds the $ACC_N records, whole" \
    "$(acc_poll exact 90 acc_transcript "$BASE" "$acc_a" "$acc_a_session" 1 "$ACC_N")" exact

# b. A task whose agent exits non-zero fails, with a recorded cause.
# c. POST /retry on it: a driver claims the fresh attempt and it succeeds.
acc_b="$(acc_job 'factory-stub-fail-once')"
acc_b_end="$(acc_await "$acc_b" 'failed*' 120)"
case "$acc_b_end" in
failed*) ok 'acceptance: b. the task with a failing agent fails' ;;
*) bad 'acceptance: b. the task with a failing agent fails' "status|attempts|count|claimSeq|reason: $acc_b_end" ;;
esac
acc_b_kind="$(acc_job_read "$BASE" "$acc_b" cause)"
case "$acc_b_kind" in
'' | unread*) bad 'acceptance: b. the failure carries its cause' "failureKind '$acc_b_kind'" ;;
*) ok "acceptance: b. the failure carries its cause ($acc_b_kind)" ;;
esac
acc_c="$(acc_post "/api/jobs/$acc_b/retry")"
if [ -z "$acc_c" ]; then
    bad 'acceptance: c. the retry is queued' "$(cat "$work/acc-post.refusal" 2>/dev/null)"
else
    ok 'acceptance: c. the retry is queued'
    acc_c_end="$(acc_await "$acc_c" 'succeeded*' 180)"
    case "$acc_c_end" in
    succeeded*) ok 'acceptance: c. a driver claims the retry and it succeeds' ;;
    *) bad 'acceptance: c. a driver claims the retry and it succeeds' "status|attempts|count|claimSeq|reason: $acc_c_end" ;;
    esac
fi

# d. POST /follow-up on (a): the next run resumes its session on the same task volume, and the
#    transcript stream continues at the prior offset.
acc_d="$(acc_post "/api/jobs/$acc_a/follow-up" '{"command":"factory-stub-transcript-'"$((ACC_N + 2))"'"}')"
if [ -z "$acc_d" ]; then
    bad 'acceptance: d. the follow-up is queued' "$(cat "$work/acc-post.refusal" 2>/dev/null)"
else
    ok 'acceptance: d. the follow-up is queued'
    acc_d_end="$(acc_await "$acc_d" 'succeeded*' 180)"
    case "$acc_d_end" in
    succeeded*) ok 'acceptance: d. the follow-up succeeds' ;;
    *) bad 'acceptance: d. the follow-up succeeds' "status|attempts|count|claimSeq|reason: $acc_d_end" ;;
    esac
    expect_contains "acceptance: d. the follow-up resumes the first run's session" \
        "$(field "$(body "$(api GET "/api/jobs/$acc_d")")" output)" "--resume $acc_a_session"
    acc_check 'acceptance: d. the follow-up read continues at the prior offset' \
        "$(acc_poll exact 90 acc_transcript "$BASE" "$acc_d" "$acc_a_session" $((ACC_N + 1)) $((ACC_N + 2)))" exact
fi

# e. The runner's whole container group is force-removed once its records are on the volume and the
#    agent is at its barrier: the volume is kept, the next claim succeeds, and the artifact read holds every record.
acc_e="$(acc_job "factory-stub-transcript-$ACC_N factory-stub-wait-$ACC_REL-e")"
if [ -z "$acc_e" ] || ! acc_barrier "$acc_e" "$ACC_REL-e"; then
    bad 'acceptance: e. the runner to remove is running' "job '$acc_e': $(acc_brief "$acc_e")"
else
    ok 'acceptance: e. the runner to remove is running'
    acc_e_session="$(acc_session "$acc_e")"
    acc_check "acceptance: e. the volume holds $ACC_N records before the group is removed" \
        "$(acc_poll "$ACC_N" 60 acc_volume_records "$acc_e" "$acc_e_session")" "$ACC_N"
    # The loss must have something to lose: the exporter flushes at 15 s / 256 KiB, so the store is read
    # now and must NOT yet hold all $ACC_N records; a read that fails or finds them all is not a pass.
    acc_check "acceptance: e. the store does not yet hold all $ACC_N records when the group is removed" \
        "$(acc_stored_short "$BASE" "$acc_e" "$acc_e_session" 1 "$ACC_N")" short
    docker ps -aq --filter "label=factory.job=$acc_e" |
        while IFS= read -r container_id; do
            [ -n "$container_id" ] && docker rm -f "$container_id" >/dev/null 2>&1
        done
    acc_e_mid="$(acc_await "$acc_e" '*|1|1|*' 60)"
    case "$acc_e_mid" in
    *'|1|1|infrastructure loss:'*) ok 'acceptance: e. the removed runner is an interruption' ;;
    *) bad 'acceptance: e. the removed runner is an interruption' "status|attempts|count|claimSeq|reason: $acc_e_mid" ;;
    esac
    acc_release "$acc_e" "$ACC_REL-e" || bad 'acceptance: e. the barrier is released' "could not write $ACC_REL-e"
    acc_e_end="$(acc_await "$acc_e" 'succeeded*' 180)"
    case "$acc_e_end" in
    'succeeded|1|1|1|infrastructure loss:'*) ok 'acceptance: e. the next claim succeeds: one attempt, one interruption' ;;
    *) bad 'acceptance: e. the next claim succeeds: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $acc_e_end" ;;
    esac
    acc_check "acceptance: e. the artifact read holds all $ACC_N records after the group loss" \
        "$(acc_poll exact 90 acc_transcript "$BASE" "$acc_e" "$acc_e_session" 1 "$ACC_N" lossy)" exact
fi

# f. No shared storage: the runner mounts only named local docker volumes, its task volume among them,
#    and every task volume is a local one with no options. The listing must contain (a)'s task volume.
case "$acc_a_mounts" in
ok) ok "acceptance: f. the runner mounted only named local volumes, its task volume among them" ;;
*) bad "acceptance: f. the runner mounted only named local volumes, its task volume among them" "$acc_a_mounts" ;;
esac
acc_vols="$(acc_volumes)"
case "$acc_vols" in
"ok "*"factory-task-$acc_a-1"*) ok "acceptance: f. no task volume is shared storage, and (a)'s task volume is listed" ;;
"ok "*) bad "acceptance: f. the volume listing contains (a)'s task volume" "listing: $acc_vols" ;;
*) bad 'acceptance: f. no task volume is shared storage' "$acc_vols" ;;
esac

# g. (a)'s task volume still exists after the task settled.
LANE_VOL="factory-task-$acc_a-1"
acc_check "acceptance: g. the settled task's volume is still there" "$(lane_vol_state)" present

stop_driver
fi

if selected_phase compose-driver; then
begin_phase compose-driver
# --- The compose driver -----------------------------------------------------------------------
#
# Issue #174: this service used to build the baked `runtime` stage, so an `up` or restart without
# `--build` served whatever publisher code was baked last — `/fix N` PRs went out without a
# closing keyword and merged with the issue still open. Every phase above runs the driver from the
# host, which is why the bug was invisible here; this phase runs the COMPOSE service against the
# same board. The service bind-mounts the working tree (docker/driver.Dockerfile's `dev` stage),
# so the container must see the checkout's driver source — under the old compose file there is no
# source in the image at all and this phase fails — and a job must settle exactly as the
# host-driven ones did.

echo
echo '# compose driver'

compose -p "$COMPOSE_PROJECT" build driver >/dev/null 2>&1 || {
    echo 'test-jobs: could not build the compose driver image'
    exit 1
}
ok 'the compose driver image builds'

# RUNNER_SERVICES=0 like every host-driven phase above: the services phase seeded a malformed
# .bellows.yaml into the stand-in author's tree, and the services readout failing is a verdict of
# "failed" — the lifecycle here must be settled by the driver itself, not by that leftover.
# The supervisor pulls its steps from the advertised `http://driver`: it runs on the project network,
# where `--use-aliases` gives this one-off container the service's name.
compose -p "$COMPOSE_PROJECT" run --rm --use-aliases --name "$COMPOSE_DRIVER" --no-deps \
    -e JOB_BOARD_URL="http://host.docker.internal:$PORT" \
    -e CLAUDE_EXECUTOR_IMAGE="$IMAGE_OK" \
    -e OPENCODE_EXECUTOR_IMAGE="$IMAGE_OK" \
    -e REPO_CLONE_BASE="$CLONE_BASE" \
    -e RUNNER_NETWORK="${COMPOSE_PROJECT}_default" \
    -e RUNNER_SERVICES=0 \
    -e JOB_BOARD_TOKEN= \
    driver >>"$work/compose-driver.log" 2>&1 &
compose_pid=$!

# The anti-stale discriminator: the running container must hold the checkout's driver SOURCE. The
# source is a bind mount, so it is readable the moment the container exists; the slow part is
# compose creating its volumes, network and container, which a busy daemon stretches past any count
# of polls. Poll against a deadline while `compose run` is alive, and give up only when it exits.
# The grep target is the current parser, so a container running a baked dist has nothing to grep.
mounted=""
deadline=$((SECONDS + 300))
while [ "$SECONDS" -lt "$deadline" ]; do
    if docker exec "$COMPOSE_DRIVER" grep -q '/fix' /app/driver/src/publish/publish.ts 2>/dev/null; then
        mounted=1
        break
    fi
    # The container does not exist yet while compose is still creating volumes and the network, so
    # "no such container" is not an exit.
    kill -0 "$compose_pid" 2>/dev/null || break
    sleep 1
done
if [ -n "$mounted" ]; then
    ok 'the compose driver runs the checkout source'
else
    bad 'the compose driver runs the checkout source' "$(tail -3 "$work/compose-driver.log")"
fi

# The runners of this phase join the project network, so the origin joins it too (its name resolves there).
if docker network connect "${COMPOSE_PROJECT}_default" "$ORIGIN_NAME" >/dev/null 2>&1; then
    compose_job="$(create_job '/fix 987 compose driver lifecycle check')"
    expect_contains 'the compose driver runs its job' "$(await_settled "$compose_job" 180)" succeeded
    ran="$(body "$(api GET "/api/jobs/$compose_job")")"
    expect_contains 'the compose driver names itself' "$(field "$ran" claimedBy)" 'driver-'
else
    # Without the origin on the network the job could only wait out its whole settle deadline.
    bad 'the smoke origin joins the compose network' "$(tail -3 "$work/compose-driver.log")"
fi

docker rm -f "$COMPOSE_DRIVER" >/dev/null 2>&1
docker network disconnect "${COMPOSE_PROJECT}_default" "$ORIGIN_NAME" >/dev/null 2>&1
compose -p "$COMPOSE_PROJECT" down --volumes --remove-orphans >/dev/null 2>&1
wait "$compose_pid" 2>/dev/null
compose_pid=""
supervisor_log_pid=""

fi

if selected_phase auth; then
begin_phase auth
# --- The same board, with auth on -------------------------------------------------------------
#
# Everything above runs against AUTH_MODE=none, which is what this script has always been and what
# it must keep exercising: that mode is what `npm run seed`, the route harness and `git clone && npm
# run dev` all depend on. This section is the other half — the only end-to-end proof that the two
# credentials really are disjoint, that a human cannot claim a lease and a worker cannot queue a job.

echo
echo '# auth'

kill "$server_pid" 2>/dev/null
wait "$server_pid" 2>/dev/null
server_pid=""

AUTH_PORT=$((PORT + 1))
AUTH_BASE="http://127.0.0.1:$AUTH_PORT"

env DATABASE_URL="$DATABASE_URL" PORT="$AUTH_PORT" HOST=127.0.0.1 \
    REPO_CLONE_BASE="$PLAN_BASE" \
    AUTH_MODE=github \
    GITHUB_OAUTH_CLIENT_ID=stub-client GITHUB_OAUTH_CLIENT_SECRET=stub-secret \
    SESSION_SECRET=a-job-harness-session-secret-32-chars \
    JOB_BOARD_TOKEN=a-job-harness-board-secret-32-chars \
    node server/dist/offline.js >"$work/auth-server.log" 2>&1 &
server_pid=$!

up=""
for _ in $(seq 1 40); do
    [ "$(status "$(BASE="$AUTH_BASE" api GET /api/health)")" = '200' ] && {
        up=1
        break
    }
    sleep 1
done

if [ -z "$up" ]; then
    bad 'the authenticated board came up' "$(tail -5 "$work/auth-server.log")"
else
    ok 'the authenticated board came up'

    # Open, because the compose healthcheck carries no credential and this route has to answer
    # while the migrations are still retrying.
    expect_status_at "$AUTH_BASE" 'health stays open'           200 GET /api/health
    expect_status_at "$AUTH_BASE" 'the dashboard needs a login' 401 GET '/api/stats?range=all'
    # The route docs/security.md calls remote code execution. This is the assertion the whole
    # change exists for.
    expect_status_at "$AUTH_BASE" 'queueing a job needs a login' 401 POST /api/jobs '{"command":"rm -rf /"}'
    expect_status_at "$AUTH_BASE" 'claiming needs a worker token' 401 POST /api/jobs/claim '{"worker":"driver-1"}'

    # The shared secret the board was started with above — the same value in both processes is
    # the whole credential model now, so the harness presents exactly what the board holds.
    token=a-job-harness-board-secret-32-chars

    claim="$(AUTH_HEADER="Bearer $token" BASE="$AUTH_BASE" api POST /api/jobs/claim '{"worker":"harness-driver"}')"
    case "$(status "$claim")" in
    200 | 204) ok 'the board secret claims' ;;
    *) bad 'the board secret claims' "got $(status "$claim"): $(body "$claim")" ;;
    esac

    # The other direction, and the one that is easy to get wrong: a credential that may claim work
    # must not be able to create it, or the job it queues has no author.
    queued="$(AUTH_HEADER="Bearer $token" BASE="$AUTH_BASE" api POST /api/jobs '{"command":"echo hi"}')"
    if [ "$(status "$queued")" = '401' ]; then
        ok 'a worker token cannot queue a job'
    else
        bad 'a worker token cannot queue a job' "got $(status "$queued")"
    fi
fi

# The phases below drive the open board again (the question round trip queues jobs on $BASE), so
# the authenticated board hands the port pair back to it — same database, same stand-in member.
kill "$server_pid" 2>/dev/null
wait "$server_pid" 2>/dev/null
server_pid=""
start_open_board

fi

if selected_phase cooperative-stop; then
begin_phase cooperative-stop
# --- A cooperative Stop at the model-step boundary (issue #442) --------------------------------
#
# The real `claude` and `opencode` binaries, in the real executor images (`make runners`), against
# scripts/fake-model-endpoint.mjs: offline, deterministic, no credential. The endpoint also plays
# the driver's control endpoint and raises the Stop the moment the first model request arrives —
# inside the first step. The supervisor relays it through the mailbox, the agent's helper turns it into the marker, and the baked hook / plugin
# must end the run after that step's tool call and before a second model request: the endpoint
# counts exactly one agent request, the first step's tool ran, the second never did, and the
# container exited on its own.

echo
echo '# cooperative stop (real agent CLIs against a scripted model endpoint)'

# The driver's container group in miniature (docker-group.ts): the task supervisor, holding the
# control pair and all four mailboxes, beside an agent that mounts `in` read-only and `out` and
# nothing else. The scripted endpoint plays the driver's control endpoint; the supervisor reads the
# Stop or the question from it, and the agent's mailbox helper and bridge read what it wrote.
stop_lane() { # stop_lane <claude|opencode>
    local cli="$1" image="$1-executor" dir="$work/stop-$1" fake_pid port requests
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli stops at the step boundary" "the $image image is missing — run make runners"
        return
    fi
    mkdir -p "$dir"
    chmod 777 "$dir"
    node scripts/fake-model-endpoint.mjs --first-delay-ms 3000 --tool-steps 3 >"$work/fake-$cli.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$cli.port" ] && break
        sleep 0.25
    done
    port="$(cat "$work/fake-$cli.port")"
    local host="http://host.docker.internal:$port" run=(docker run --rm --name "lane-agent-$RUN_ID-stop-$cli" --add-host host.docker.internal:host-gateway)
    lane_timed "stop-$cli" setup lane_group_up "stop-$cli" "$image" "$host"
    run+=(-v "$dir:/workspace" -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key)
    while IFS= read -r word; do run+=("$word"); done < <(lane_group_agent_args "stop-$cli")
    if [ "$cli" = claude ]; then
        # `-p <prompt>` last: the bridge the entrypoint execs refuses any other shape (#536), and it
        # is the shape the driver passes.
        run+=(-e "ANTHROPIC_BASE_URL=$host" "$image" --dangerously-skip-permissions --model fake-model
            -p 'touch the step markers')
    else
        run+=(-e "OPENCODE_CONFIG_CONTENT={\"model\":\"anthropic/claude-sonnet-4-5\",\"provider\":{\"anthropic\":{\"options\":{\"baseURL\":\"$host/v1\",\"apiKey\":\"fake-key\"}}}}"
            "$image" --print-logs --log-level DEBUG run 'touch the step markers')
    fi
    # On its own, and 0 for both CLIs: opencode's `Error: Aborted` exit after the stop plugin's abort
    # is mapped to 0 by its entrypoint (docker/opencode-executor/entrypoint.sh).
    local status
    lane_timed "stop-$cli" agent timeout 180 "${run[@]}" >"$work/stop-$cli.log" 2>&1
    status=$?
    lane_group_down "stop-$cli"
    if [ "$status" = 0 ]; then
        ok "$cli exits on its own after the stop"
    else
        bad "$cli exits on its own after the stop" "exit $status: $(tail -5 "$work/stop-$cli.log")"
    fi
    requests="$(node -e 'fetch(process.argv[1] + "/requests").then((r) => r.json()).then((j) => console.log(j.agentRequests))' "http://127.0.0.1:$port")"
    lane_endpoint_stop "$fake_pid"
    if [ "$requests" = 1 ]; then
        ok "$cli makes no model request after the stop"
    else
        bad "$cli makes no model request after the stop" "agent model requests: $requests"
    fi
    if [ -e "$dir/step-1" ] && [ ! -e "$dir/step-2" ]; then
        ok "$cli finished the step it was in and started no other"
    else
        bad "$cli finished the step it was in and started no other" "$(ls "$dir")"
    fi
}

claude_stop_lane() { stop_lane claude; }
opencode_stop_lane() { stop_lane opencode; }
lane_pair claude_stop_lane opencode_stop_lane

fi

if selected_phase tool-isolation; then
begin_phase tool-isolation
# --- The agent's tool isolation (issue #814) ------------------------------------------------------
#
# The real CLIs again, now under the driver's own agent flags — root, every capability dropped but
# the launch pair, no-new-privileges — against the endpoint's `--kill-tools` mode: each of two tool
# calls runs `kill -TERM 1; kill -KILL -1` and then marks its step. The tools run as the tool uid, so
# the CLI survives both, sends its third request and exits 0 on its own. The control is the same run
# without the flags — the CLI and its tools one uid — and must die: an honest probe, so the lane can
# never pass on a tool that kills nothing.

echo
echo '# tool isolation (real agent CLIs whose tools signal everything they may)'

AGENT_FLAGS=(--user 0:0 --cap-drop ALL --cap-add SETUID --cap-add SETGID --security-opt no-new-privileges)

kill_lane() { # kill_lane <claude|opencode> <isolated|control>
    local cli="$1" mode="$2" image="$1-executor" name="kill-$1-$2" fake_pid port counts status
    local dir="$work/$name"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli under the tool uid ($mode)" "the $image image is missing — run make runners"
        return
    fi
    mkdir -p "$dir"
    chmod 777 "$dir"
    node scripts/fake-model-endpoint.mjs --kill-tools --tool-steps 2 >"$work/fake-$name.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$name.port" ] && break
        sleep 0.25
    done
    port="$(cat "$work/fake-$name.port")"
    local host="http://host.docker.internal:$port" run=(docker run --rm --name "lane-agent-$RUN_ID-$name" --add-host host.docker.internal:host-gateway)
    if [ "$mode" = isolated ]; then run+=("${AGENT_FLAGS[@]}"); fi
    lane_timed "$name" setup lane_group_up "$name" "$image" "$host"
    run+=(-v "$dir:/workspace" -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key)
    while IFS= read -r word; do run+=("$word"); done < <(lane_group_agent_args "$name")
    if [ "$cli" = claude ]; then
        run+=(-e "ANTHROPIC_BASE_URL=$host" "$image" --dangerously-skip-permissions --model fake-model
            -p 'touch the step markers')
    else
        run+=(-e "OPENCODE_CONFIG_CONTENT={\"model\":\"anthropic/claude-sonnet-4-5\",\"provider\":{\"anthropic\":{\"options\":{\"baseURL\":\"$host/v1\",\"apiKey\":\"fake-key\"}}}}"
            "$image" --print-logs --log-level DEBUG run 'touch the step markers')
    fi
    lane_timed "$name" agent timeout 180 "${run[@]}" >"$work/$name.log" 2>&1
    status=$?
    lane_group_down "$name"
    counts="$(node -e 'Promise.all(["/requests", "/tool-results"].map((p) => fetch(process.argv[1] + p).then((r) => r.json())))
        .then(([a, b]) => console.log(`${a.agentRequests} ${b.toolResults}`))' "http://127.0.0.1:$port")"
    lane_endpoint_stop "$fake_pid"
    if [ "$mode" = isolated ]; then
        if [ "$status" = 0 ] && [ "$counts" = '3 2' ] && [ -e "$dir/step-1" ] && [ -e "$dir/step-2" ]; then
            ok "$cli survives its tools signalling everything they may, and finishes"
        else
            bad "$cli survives its tools signalling everything they may, and finishes" \
                "exit $status, agent requests and tool results: $counts: $(tail -5 "$work/$name.log")"
        fi
    # The control dies by the tool's own signal (137 KILL, 143 TERM): a timeout's 124 is a hang.
    elif { [ "$status" = 137 ] || [ "$status" = 143 ]; } && [ "$counts" = '1 0' ] && [ ! -e "$dir/step-2" ]; then
        ok "the control: $cli and its tools as one uid, and the first tool kills it"
    else
        bad "the control: $cli and its tools as one uid, and the first tool kills it" \
            "exit $status, agent requests and tool results: $counts — a probe that kills nothing proves nothing"
    fi
}

claude_isolation_lanes() { kill_lane claude control; kill_lane claude isolated; }
opencode_isolation_lanes() { kill_lane opencode control; kill_lane opencode isolated; }
lane_pair claude_isolation_lanes opencode_isolation_lanes

# --- Skill helper scripts under the tool uid (issue #1006) -----------------------------------------
#
# The endpoint's `--probe-files` mode: its one tool call opens every file given, as the tool uid, and
# marks `probe-<n>` open, denied or other. The files are every non-SKILL.md file under docker/skills/
# at /usr/local/share/factory-skills/ — they must open — and, last, the control: a file inside the
# CLI's private config directory (claude: the skill copy in CLAUDE_CONFIG_DIR; opencode: its data
# directory), which must be denied, so a probe that never sees a denial cannot pass. The directory is
# in its runner shape: FACTORY_TRANSCRIPT_DIR / XDG_DATA_HOME on the workspace volume, and the
# entrypoint's chmod 0700 applies.

skill_helper_lane() { # skill_helper_lane <claude|opencode>
    local cli="$1" image="$1-executor" name="skillhelper-$1" fake_pid port status counts n=0 rel
    local ws="lane-$RUN_ID-$name-ws" helpers=() probes=() control
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli runs skill helpers as the tool uid" "the $image image is missing — run make runners"
        return
    fi
    while IFS= read -r rel; do helpers+=("${rel#./}"); done < <(cd docker/skills && find . -type f ! -name SKILL.md | LC_ALL=C sort)
    [ "${#helpers[@]}" -gt 0 ] || { bad "$cli runs skill helpers as the tool uid" "no helper file under docker/skills"; return; }
    for rel in "${helpers[@]}"; do probes+=("/usr/local/share/factory-skills/$rel"); done
    if [ "$cli" = claude ]; then control="/workspace/.factory/t/skills/${helpers[0]}"; else control=/workspace/.factory/opencode/probe/opencode/opencode.db; fi
    probes+=("$control")
    # A docker volume, as the task volume is: a macOS bind mount maps every uid to the host user and
    # would never deny the control.
    docker volume create "$ws" >/dev/null
    node scripts/fake-model-endpoint.mjs --probe-files "$(IFS=,; echo "${probes[*]}")" --tool-steps 1 >"$work/fake-$name.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$name.port" ] && break
        sleep 0.25
    done
    port="$(cat "$work/fake-$name.port")"
    local host="http://host.docker.internal:$port" run=(docker run --rm --name "lane-agent-$RUN_ID-$name" --add-host host.docker.internal:host-gateway)
    run+=("${AGENT_FLAGS[@]}")
    lane_timed "$name" setup lane_group_up "$name" "$image" "$host"
    run+=(-v "$ws:/workspace" -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key)
    while IFS= read -r word; do run+=("$word"); done < <(lane_group_agent_args "$name")
    if [ "$cli" = claude ]; then
        run+=(-e FACTORY_TRANSCRIPT_DIR=/workspace/.factory/t -e "ANTHROPIC_BASE_URL=$host" "$image" --dangerously-skip-permissions
            --model fake-model -p 'probe the skill helpers')
    else
        run+=(-e XDG_DATA_HOME=/workspace/.factory/opencode/probe
            -e "OPENCODE_CONFIG_CONTENT={\"model\":\"anthropic/claude-sonnet-4-5\",\"provider\":{\"anthropic\":{\"options\":{\"baseURL\":\"$host/v1\",\"apiKey\":\"fake-key\"}}}}"
            "$image" --print-logs --log-level DEBUG run 'probe the skill helpers')
    fi
    lane_timed "$name" agent timeout 180 "${run[@]}" >"$work/$name.log" 2>&1
    status=$?
    lane_group_down "$name"
    local result
    result="$(node -e 'Promise.all(["/tool-results", "/requests"].map((p) => fetch(process.argv[1] + p).then((r) => r.json())))
        .then(([a, b]) => console.log(JSON.stringify({ ...a, agentRequests: b.agentRequests })))' "http://127.0.0.1:$port")"
    counts="$(node -e 'console.log(JSON.parse(process.argv[1]).toolResults)' "$result")"
    lane_endpoint_stop "$fake_pid"
    docker volume rm "$ws" >/dev/null
    local seen not_open=''
    probe_outcome() { node -e 'const m = new RegExp("^PROBE " + process.argv[2] + " (.*)$", "m").exec(JSON.parse(process.argv[1]).text); console.log(m ? m[1] : "missing")' "$result" "$1"; }
    for n in $(seq 1 "${#helpers[@]}"); do
        seen="$(probe_outcome "$n")"
        [ "$seen" = open ] || not_open="$not_open ${helpers[$((n - 1))]}=$seen"
    done
    seen="$(probe_outcome "$((${#helpers[@]} + 1))")"
    if [ "$status" = 0 ] && [ "$counts" = 1 ] && [ -z "$not_open" ]; then
        ok "$cli: every skill helper under docker/skills opens for the tool uid at its fixed path"
    else
        bad "$cli: every skill helper under docker/skills opens for the tool uid at its fixed path" \
            "exit $status, tool results $counts, not open:${not_open:- none}, result $result: $(tail -5 "$work/$name.log")"
    fi
    if [ "$seen" = denied ]; then
        ok "the control: $cli's private config directory is denied to the tool uid"
    else
        bad "the control: $cli's private config directory is denied to the tool uid" \
            "$control opened as '$seen' — a probe that never sees a denial proves nothing"
    fi
}

claude_skill_lanes() { skill_helper_lane claude; }
opencode_skill_lanes() { skill_helper_lane opencode; }
lane_pair claude_skill_lanes opencode_skill_lanes

# --- The seam between the CLI's uid and the tool uid (epic #1025: #1016, #1021, #1023, #1024) ----------
#
# The endpoint's `--steps` mode drives the real CLI through one scripted run: its own Read and Write
# tools and its Bash tool, which runs as the tool uid. What each step does and how the results are
# judged is scripts/tool-seam-lane.mjs, whose driver/test/tool-seam-lane.test.ts pins that every
# control can fail:
#   #1016  the CLI reads a 0600 mktemp file and a file in a 0700 directory the tool made in its TMPDIR;
#          control: private files in the tool's HOME and outside its TMPDIR stay closed to the CLI
#   #1021  the tool's node processes fill a compile cache of their own; control: the CLI's own cache
#          directory, which the tool cannot write, gives the same process none
#   #1023  the tool uses repositories the CLI's uid made, anywhere, and clones one; the stated
#          limit: the CLI's uid refuses every repository the tool wrote (core.fsmonitor would run as it)
#   #1024  a skill is loaded from one path with the runner's private config dir and without it, and
#          the tool reads it there; control: the CLI's private directory is closed to the tool
# The volume is a docker volume mounted twice, as the task volume is: a macOS bind mount maps every
# uid to the host user and would never refuse anything.

seam_run() { # seam_run <cli> <runner|plain> <steps json> <out json>: one scripted run on $seam_ws; its /steps answer to <out>
    local cli="$1" shape="$2" steps="$3" out="$4" image="$1-executor" name="seam-$1-$2" fake_pid port status
    node scripts/fake-model-endpoint.mjs --steps "$steps" >"$work/fake-$name.port" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$name.port" ] && break
        sleep 0.25
    done
    port="$(cat "$work/fake-$name.port")"
    local host="http://host.docker.internal:$port" run=(docker run --rm --name "lane-agent-$RUN_ID-$name" --add-host host.docker.internal:host-gateway)
    run+=("${AGENT_FLAGS[@]}")
    lane_timed "$name" setup lane_group_up "$name" "$image" "$host"
    run+=(-v "$seam_ws:/workspace" -v "$seam_ws:/elsewhere" -e WORKDIR=/workspace -e ANTHROPIC_API_KEY=fake-key -e "BELLOWS_GATE_URL=$(node scripts/tool-seam-lane.mjs gate-url "$cli")" -e BELLOWS_GATE_TOKEN=lane-gate-token)
    while IFS= read -r word; do run+=("$word"); done < <(lane_group_agent_args "$name")
    if [ "$cli" = claude ]; then
        if [ "$shape" = runner ]; then run+=(-e FACTORY_TRANSCRIPT_DIR=/workspace/.factory/t); fi
        run+=(-e "ANTHROPIC_BASE_URL=$host" "$image" --dangerously-skip-permissions --model fake-model -p 'cross the seam')
    else
        if [ "$shape" = runner ]; then run+=(-e XDG_DATA_HOME=/workspace/.factory/opencode/probe); fi
        run+=(-e "OPENCODE_CONFIG_CONTENT={\"model\":\"anthropic/claude-sonnet-4-5\",\"provider\":{\"anthropic\":{\"options\":{\"baseURL\":\"$host/v1\",\"apiKey\":\"fake-key\"}}}}"
            "$image" --print-logs --log-level DEBUG run 'cross the seam')
    fi
    lane_timed "$name" agent timeout 240 "${run[@]}" >"$work/$name.log" 2>&1
    status=$?
    lane_group_down "$name"
    node -e 'fetch(process.argv[1] + "/steps").then((r) => r.json()).then((j) => console.log(JSON.stringify(j)))' "http://127.0.0.1:$port" >"$out"
    lane_endpoint_stop "$fake_pid"
    return $status
}

seam_lane() { # seam_lane <claude|opencode>
    local cli="$1" image="$1-executor" name="seam-$1" status
    local full="$work/$name.full.json" plain="$work/$name.plain.json" git_out="$work/$name.git.txt" evidence="$work/$name.evidence.json"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "$cli crosses the CLI/tool uid seam" "the $image image is missing — run make runners"
        return
    fi
    seam_ws="lane-$RUN_ID-$name-ws"
    docker volume create "$seam_ws" >/dev/null
    local mounts=(-v "$seam_ws:/workspace" -v "$seam_ws:/elsewhere")
    # The volume as the runner leaves it: the CLI's uid owns it, group-writable and setgid; the CLI's uid
    # makes a repository inside the trusted tree and one outside it.
    docker run --rm --user 0:0 "${mounts[@]}" -e SEAM_REPOS="$(node scripts/tool-seam-lane.mjs node-repos "$cli")" --entrypoint sh "$image" -c \
        'chown 1000:1000 /workspace && chmod 2775 /workspace && setpriv --reuid=1000 --regid=1000 --clear-groups sh -c "$SEAM_REPOS"' \
        >"$work/$name.prep.log" 2>&1 || { bad "$cli crosses the CLI/tool uid seam" "preparing the volume failed: $(tail -3 "$work/$name.prep.log")"; docker volume rm "$seam_ws" >/dev/null; return; }
    seam_run "$cli" runner "$(node scripts/tool-seam-lane.mjs steps "$cli")" "$full"
    status=$?
    docker run --rm --user 1000:1000 "${mounts[@]}" --entrypoint sh "$image" -c "$(node scripts/tool-seam-lane.mjs node-git "$cli")" >"$git_out" 2>&1
    seam_run "$cli" plain "$(node scripts/tool-seam-lane.mjs skill-steps "$cli")" "$plain"
    docker volume rm "$seam_ws" >/dev/null
    node -e 'const fs = require("node:fs"); const [full, plain, git] = process.argv.slice(1).map((f) => fs.readFileSync(f, "utf8"));
        const a = JSON.parse(full), b = JSON.parse(plain);
        console.log(JSON.stringify({ results: a.results, skillBases: a.skillBases, plainSkillBases: b.skillBases, nodeGit: git }))' \
        "$full" "$plain" "$git_out" >"$evidence"
    if [ "$status" != 0 ]; then bad "$cli runs its scripted tools to the end" "exit $status: $(tail -5 "$work/seam-$cli-runner.log")"; fi
    local verdict_name detail mark
    while IFS=$'\t' read -r mark verdict_name detail; do
        if [ "$mark" = ok ]; then ok "$verdict_name"; else bad "$verdict_name" "$detail"; fi
    done < <(node scripts/tool-seam-lane.mjs verdict "$cli" "$evidence")
}

claude_seam_lanes() { seam_lane claude; }
opencode_seam_lanes() { seam_lane opencode; }
lane_pair claude_seam_lanes opencode_seam_lanes

fi

if selected_phase ask-user-question; then
begin_phase ask-user-question
# --- AskUserQuestion answered inside the same Claude run (issue #226) ----------------------------
#
# The real claude-executor image against the same scripted endpoint in `--ask` mode. The model's
# first reply is an AskUserQuestion tool call; the bridge POSTs it to the endpoint's /question,
# polls until it answers "Blue", and hands the answer back into the SAME CLI process, whose next
# model request carries it. The run ends 0 with `ANSWER=Blue` in the progress output and exactly
# one question POST recorded.

echo
echo '# AskUserQuestion (real claude CLI, answered through the bridge)'

#
# The prose mode (`--ask-prose`) starts from a plain-text question ending the turn: the baked Stop
# hook must turn it into the same AskUserQuestion, inside the same run.

ask_lane() {
    local mode="$1" flag="$2" image=claude-executor fake_pid port posts hooks
    local dir="$work/ask-claude-$mode" log="$work/ask-claude-$mode.log" portfile="$work/fake-ask-$mode.port"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad "claude asks and receives an answer ($mode)" "the $image image is missing — run make runners"
        return
    fi
    mkdir -p "$dir"
    chmod 777 "$dir"
    node scripts/fake-model-endpoint.mjs "$flag" >"$portfile" &
    fake_pid=$!
    lane_endpoint_started "$fake_pid"
    for _ in $(seq 1 20); do
        [ -s "$portfile" ] && break
        sleep 0.25
    done
    port="$(cat "$portfile")"
    local host="http://host.docker.internal:$port" agent_words=() word
    lane_timed "ask-$mode" setup lane_group_up "ask-$mode" "$image" "$host"
    while IFS= read -r word; do agent_words+=("$word"); done < <(lane_group_agent_args "ask-$mode")
    if lane_timed "ask-$mode" agent timeout 180 docker run --rm --name "lane-agent-$RUN_ID-ask-$mode" --add-host host.docker.internal:host-gateway -v "$dir:/workspace" -e WORKDIR=/workspace \
        -e ANTHROPIC_API_KEY=fake-key -e "ANTHROPIC_BASE_URL=$host" "${agent_words[@]}" \
        "$image" --dangerously-skip-permissions --model fake-model -p 'ask which colour' >"$log" 2>&1; then
        ok "claude exits 0 after the question is answered ($mode)"
    else
        bad "claude exits 0 after the question is answered ($mode)" "$(tail -5 "$log")"
    fi
    lane_group_down "ask-$mode"
    posts="$(node -e 'fetch(process.argv[1] + "/questions").then((r) => r.json()).then((j) => console.log(j.questionPosts))' "http://127.0.0.1:$port")"
    hooks="$(node -e 'fetch(process.argv[1] + "/hooks").then((r) => r.json()).then((j) => console.log(j.hookRequests))' "http://127.0.0.1:$port")"
    lane_endpoint_stop "$fake_pid"
    if grep -q 'ANSWER=Blue' "$log"; then
        ok "the answer reaches the same run (ANSWER=Blue in the progress output, $mode)"
    else
        bad "the answer reaches the same run (ANSWER=Blue in the progress output, $mode)" "$(tail -5 "$log")"
    fi
    if [ "$posts" = 1 ]; then
        ok "exactly one question was posted ($mode)"
    else
        bad "exactly one question was posted ($mode)" "question POSTs: $posts"
    fi
    if [ "$mode" = prose ]; then
        # The block, then the allowed stop after the answer (stop_hook_active): two evaluations.
        if [ "$hooks" = 2 ]; then
            ok 'the Stop hook turned the prose question into AskUserQuestion (prose)'
        else
            bad 'the Stop hook turned the prose question into AskUserQuestion (prose)' "Stop-hook evaluations: $hooks"
        fi
    fi
}

tool_ask_lane() { ask_lane tool --ask; }
prose_ask_lane() { ask_lane prose --ask-prose; }
lane_pair tool_ask_lane prose_ask_lane

fi

if selected_phase question-round-trip; then
begin_phase question-round-trip
# --- The question round trip: board + driver + the real claude-executor (issue #226) -------------
#
# The board and the driver are the real ones. The model is the scripted endpoint in `--ask` mode,
# reached through the org env a member would configure, so the real claude CLI inside the real
# claude-executor image asks, the bridge POSTs the question to the DRIVER's control endpoint, the
# driver relays it to the board, and a member's answer travels back on the heartbeat. First case:
# the job shows a pending question, a member answers, the job settles succeeded with ANSWER=Blue,
# and a second answer is refused. Second case: stopped while pending, the job settles stopped and
# the question reads closed.

echo
echo '# question round trip (board + driver + real claude-executor, scripted model)'

pending_question() { # pending_question <job-id> -> the pending question's id, empty when none
    node -e 'try { const j = JSON.parse(process.argv[1]); const q = (j.questions || []).find((x) => x.status === "pending"); process.stdout.write(q ? q.id : ""); } catch {}' \
        "$(body "$(api GET "/api/jobs/$1")")"
}

await_pending_question() { # await_pending_question <job-id> [seconds] -> the question id, empty on timeout
    local qid="" i=0
    while [ "$i" -lt "${2:-120}" ]; do
        qid="$(pending_question "$1")"
        [ -n "$qid" ] && break
        sleep 1
        i=$((i + 1))
    done
    printf '%s' "$qid"
}

start_ask_endpoint() { # start_ask_endpoint <name> -> sets ask_pid and ask_port
    node scripts/fake-model-endpoint.mjs --ask >"$work/fake-$1.port" &
    ask_pid=$!
    lane_endpoint_started "$ask_pid"
    for _ in $(seq 1 20); do
        [ -s "$work/fake-$1.port" ] && break
        sleep 0.25
    done
    ask_port="$(cat "$work/fake-$1.port")"
}

point_runners_at() { # point_runners_at <port>: the org env a member would set, aimed at the scripted model
    api PUT /api/env/org "{\"vars\":[{\"name\":\"ANTHROPIC_API_KEY\",\"value\":\"fake-key\",\"isSecret\":true},{\"name\":\"ANTHROPIC_BASE_URL\",\"value\":\"http://host.docker.internal:$1\",\"isSecret\":false}]}" >/dev/null
}

ask_roundtrip_lane() {
    local image=claude-executor ask_pid ask_port id qid answer answered done_job
    if ! docker image inspect "$image" >/dev/null 2>&1; then
        bad 'a member answers the agent through the board' "the $image image is missing — run make runners"
        return
    fi
    stop_driver
    start_driver "$image"

    start_ask_endpoint answer
    point_runners_at "$ask_port"
    id="$(create_job 'ask which colour')"
    qid="$(await_pending_question "$id")"
    if [ -n "$qid" ]; then
        ok 'the board shows the question as pending'
    else
        bad 'the board shows the question as pending' "$(tail -5 "$work/driver.log")"
    fi
    answer="{\"answers\":{\"Which colour should the report use?\":\"Blue\"}}"
    expect_status 'a member answers the question' 200 POST "/api/jobs/$id/questions/$qid/answer" "$answer"
    done_job="$(await_settled "$id" 180)"
    expect_contains 'the job settles succeeded' "$done_job" succeeded
    answered="$(body "$(api GET "/api/jobs/$id")")"
    expect_contains 'the answer reached the same run (ANSWER=Blue)' "$(field "$answered" output)" 'ANSWER=Blue'
    answered="$(api POST "/api/jobs/$id/questions/$qid/answer" "$answer")"
    expect_status 'a second answer is refused' 409 POST "/api/jobs/$id/questions/$qid/answer" "$answer"
    expect_contains 'the refusal names the answered question' "$answered" 'QUESTION_ANSWERED'
    lane_endpoint_stop "$ask_pid"

    # Stop while pending: the question is cancelled, the CLI interrupted, the job parked stopped.
    start_ask_endpoint stop
    point_runners_at "$ask_port"
    id="$(create_job 'ask which colour, then be stopped')"
    qid="$(await_pending_question "$id")"
    expect_status 'a pending job can be asked to stop' 202 POST "/api/jobs/$id/stop"
    expect_contains 'the job settles stopped' "$(await_settled "$id" 180)" stopped
    answered="$(body "$(api GET "/api/jobs/$id")")"
    case "$(node -e 'try { const q = (JSON.parse(process.argv[1]).questions || []).find((x) => x.id === process.argv[2]); process.stdout.write(q ? q.status : ""); } catch {}' "$answered" "$qid")" in
    closed) ok 'the stopped job'"'"'s question reads closed' ;;
    *) bad 'the stopped job'"'"'s question reads closed' "$answered" ;;
    esac
    lane_endpoint_stop "$ask_pid"
    stop_driver
}

ask_roundtrip_lane

fi

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
