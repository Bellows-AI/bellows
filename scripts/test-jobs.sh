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
    board|driver|github-credential|services|orphan-reaper|node-disruption|driver-kill|run-deadline|capacity|review|workflows|acceptance|compose-driver|auth|cooperative-stop|tool-isolation|image-checks|ask-user-question|question-round-trip|pinned-skills|repo-skills|mcp) return 0 ;;
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
        echo '        tool-isolation, image-checks, ask-user-question, question-round-trip, pinned-skills, repo-skills, driver-kill, capacity, mcp'
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
        case "$phase" in cooperative-stop|tool-isolation|image-checks|ask-user-question|repo-skills) ;; *) return 0 ;; esac
    done
    return 1
}

RUN_ID="$(date +%s)-$$"
PORT="${PORT:-8129}"
# PORT is the lane's main board. Every other board a phase starts has a port of its own, inside the ten-port slice
# --parallel deals each group (PORT .. PORT + 9): none reuses a stopped board's port, so no phase depends on the
# phases that ran before it.
CAP_LIGHT_PORT=$((PORT + 1))
MINT_PORT=$((PORT + 2))
AUTH_PORT=$((PORT + 3))
MCP_PORT=$((PORT + 4))
MCP_IDP_PORT=$((PORT + 5))
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
# The smoke origin: a bare repository on a named volume, served by a git daemon on a
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
# The file's path is fixed here (compose() and cleanup() name it); the file itself is written after the preflight.
SECRETS_ENV_FILE_PATH="${TMPDIR:-/tmp}/factory-jobs-$RUN_ID-secrets.env"
compose() { JOB_BOARD_TOKEN="$COMPOSE_TOKEN" SECRETS_ENV_FILE="$SECRETS_ENV_FILE_PATH" docker compose "$@"; }
# The repository every task runs against: a ready selection on the board and, in the
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
if selected_phase cooperative-stop || selected_phase tool-isolation || selected_phase image-checks || selected_phase repo-skills; then
    images='claude-executor opencode-executor'
elif selected_phase question-round-trip || selected_phase pinned-skills; then
    images='claude-executor opencode-executor'
elif selected_phase ask-user-question; then
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
# Generated after the preflight: a refused run (missing tool, image or unsafe database) pays for no keys and leaves no file.
# The secret store's keys (docs/secrets.md), generated per run. They ride ONLY on each board's launch command
# (SECRET_STORE_ENV) and in the file compose hands the dashboard service (SECRETS_ENV_FILE): never exported, so
# no driver, CLI or runner this script starts can inherit one. server/test/secrets.environment.test.ts pins that.
secret_key() { head -c 32 /dev/urandom | base64; }
SECRET_STORE_ENV=(
    SECRETS_BACKEND=database
    "SECRETS_DATA_KEYS=jobs:$(secret_key)"
    SECRETS_ACTIVE_KEY_ID=jobs
    "SECRETS_OPERATION_KEY=$(secret_key)"
    "SECRETS_FINGERPRINT_KEY=$(secret_key)"
)
(umask 077 && printf '%s\n' "${SECRET_STORE_ENV[@]}" >"$SECRETS_ENV_FILE_PATH")

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

# --parallel: the selected phases as groups (scripts/test-jobs-groups.mjs), each one
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
            grep -A1 '^FAIL ' "$dir/$name.log" | sed -n '1,40p'
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
. "$REPO/scripts/lane-lib.sh"
lane_timed() { # lane_timed <case> <step> <command...> — preserve the command's stdout and status
    local case_name="$1" step="$2" started=$SECONDS result
    shift 2
    "$@"
    result=$?
    printf '%s\t%s\t%s\t%s\t%s\n' "$phase_name" "$case_name" "$step" "$((SECONDS - started))" "$result" >>"$LIFECYCLE_FILE"
    return "$result"
}
work="$(mktemp -d)" || exit 1

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
    lane_api_stop # before the wait below: it would wait on the helper
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
    # Which attempts held a slot past LANE_SLOW_S, and which never ended; a report, never a verdict.
    if [ -f "$work/driver.log" ]; then
        node "$REPO/scripts/lane-slow-jobs.mjs" "$work/driver.log" "${LANE_SLOW_S:-30}" >"$work/slow-jobs.txt" 2>&1 || true
        [ -s "$work/slow-jobs.txt" ] && printf '[slow-jobs] %s\n' "$(tail -n 1 "$work/slow-jobs.txt")"
    fi
    for log in "$work"/*.log "$work"/*.supervisor-*.json "$work"/*.requests.json "$work"/*.worker-*.tsv "$work"/slow-jobs.txt "$work"/stalls/*; do
        [ -f "$log" ] && cp "$log" "${TIMINGS_FILE%.tsv}.$(basename "$log")"
    done
    rm -rf "$work" "$SECRETS_ENV_FILE_PATH"
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

# --- HTTP, in node, so the script needs neither curl nor jq: api and field live in scripts/lane-lib.sh ---

lane_api_start || exit 1

# BASE and AUTH_HEADER are read from the environment, so a single call can be aimed at the
# authenticated board or carry a worker token without every existing call site growing two
# arguments it does not use.
status() { printf '%s' "${1%%$'\t'*}"; }
body() { printf '%s' "${1#*$'\t'}"; }

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

lane_collect_evidence() { # lane_collect_evidence <dir> — the first FAIL's bundle: board and driver logs, this run's containers, the job rows
    local dir="$1" job c
    cp "$work"/*.log "$dir/" 2>/dev/null
    for job in $(cat "$work/created-jobs" 2>/dev/null); do
        {
            echo "== job $job"
            timeout 10 docker ps -a --filter "label=factory.job=$job" \
                --format '{{.Names}} {{.Status}} {{.Label "factory.role"}} {{.Label "factory.claim-seq"}}' 2>&1
            for c in $(timeout 10 docker ps -aq --filter "label=factory.job=$job" 2>/dev/null); do
                timeout 10 docker inspect "$c" 2>&1
                dump_container "$c"
            done
        } >>"$dir/containers.txt" 2>&1
    done
    # The disposable database of this run: every job row, as the board saw it when the check failed.
    compose exec -T -e PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' postgres psql -U factory -d "$DB" -qtA \
        -c 'select to_jsonb(j) from job j order by created_at' >"$dir/job-rows.jsonl" 2>&1
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
# The recovery helpers the node-disruption and driver-kill phases share.
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
            printf '%s' "$logs" | grep -F 'supervisor: stopped serving the steps' >/dev/null && return 0
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
    # The agent joins its supervisor's network namespace, and with it the supervisor's
    # hostname: the short id of the container named by its network mode, not its own.
    docker inspect -f '{{.HostConfig.NetworkMode}}' "$1" 2>/dev/null | sed 's/^container://' | cut -c1-12
}

await_released() { # await_released <runner container> -> success once the supervisor released its agent (`go`)
    # A driver lost before `go` leaves nothing to adopt: the group ends lost (supervisor exit 75) and the run is redone.
    local i=0
    while [ "$i" -lt 60 ]; do
        # As the agent uid: the agent container runs as root without DAC_OVERRIDE.
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
# The interruption the next claim records for an attempt whose lease expired.
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

# Barriers and counters for the driver-kill phase. Every container of a run — setup,
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

# The driver-log and leftovers checks the driver-kill and capacity phases share.
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

# opencode refuses a model id the live models.dev catalog marks deprecated, so the lane declares its
# own model in the config: a declared id has no catalog entry to look up, merge or deprecate.
LANE_OPENCODE_MODEL=fake-model

lane_opencode_config() { # lane_opencode_config <baseURL> -> OPENCODE_CONFIG_CONTENT for the scripted model at <baseURL>
    printf '{"model":"anthropic/%s","provider":{"anthropic":{"options":{"baseURL":"%s","apiKey":"fake-key"},"models":{"%s":{"name":"%s","tool_call":true,"limit":{"context":200000,"output":8192}}}}}}' \
        "$LANE_OPENCODE_MODEL" "$1" "$LANE_OPENCODE_MODEL" "$LANE_OPENCODE_MODEL"
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
    "select 1 from pg_database where datname = '$DB'" 2>/dev/null | grep 1 >/dev/null; then
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
# edge missed and the stub-walk graph stalled after its first review round. The argv line leaves out
# the `--append-system-prompt` value: the stub-walk nests each node's output into the next prompt and
# the board keeps only the head of an interpolated output (INTERP_TAIL_LIMIT), so echoing the master
# prompt every round pushed the fix node's FIXED-ONE-ROUND marker past the cut.
# Every stub stands on scripts/stub-runner.Dockerfile: node + git as the uid-1000 `node` user, like
# the executor images — the driver runs the startup sync and the other git steps IN the job's
# executor image (`--entrypoint node`), and every task has a checkout to sync — and the
# images' tool isolation. Each executor stub starts through factory-launch and
# scripts/stub-agent.sh, beside ctl-agent.cjs, over the node-owned mailbox mount points: the task
# supervisor's agent contract (driver/test/lane-stubs.test.ts), which the real entrypoints honor.
cp docker/executor-common/ctl-agent.cjs docker/executor-common/factory-launch.sh docker/executor-common/factory-tool.cjs \
    docker/executor-common/tool-bash.sh scripts/stub-agent.sh scripts/lane-gh.sh scripts/stub-runner.Dockerfile "$work/"
printf 'FROM %s\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","-c","echo $FACTORY_ENV_PROBE; echo $SECRET_PROBE; echo ${CLAUDE_CODE_CONFIG_CONTENT:-none}; skip=; line=; for a; do if [ -n \\"$skip\\" ]; then skip=; elif [ \\"$a\\" = --append-system-prompt ]; then skip=1; else line=\\"$line $a\\"; fi; done; echo \\"${line# }\\"; for last; do :; done; echo \\"$last\\"","sh"]\n' "$IMAGE_BASE" >"$work/Dockerfile.ok"
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
    env "${SECRET_STORE_ENV[@]}" AUTH_MODE=none DATABASE_URL="$DATABASE_URL" PORT="$PORT" HOST=127.0.0.1 \
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
PLAN_BASE="git://127.0.0.1:$(docker port "$ORIGIN_NAME" 9418/tcp | sed -n '1s/.*://p')"
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
# fixture is one row for the smoke repo. The runner clones the origin onto its own task
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

. "$REPO/scripts/lanes/jobs/board.sh"

. "$REPO/scripts/lanes/jobs/driver.sh"

. "$REPO/scripts/lanes/jobs/github-credential.sh"

. "$REPO/scripts/lanes/jobs/service-fixture.sh"

. "$REPO/scripts/lanes/jobs/services.sh"

. "$REPO/scripts/lanes/jobs/orphan-reaper.sh"

. "$REPO/scripts/lanes/jobs/node-disruption.sh"

. "$REPO/scripts/lanes/jobs/driver-kill.sh"

. "$REPO/scripts/lanes/jobs/run-deadline.sh"

. "$REPO/scripts/lanes/jobs/capacity.sh"

. "$REPO/scripts/lanes/jobs/review.sh"

. "$REPO/scripts/lanes/jobs/workflows.sh"

. "$REPO/scripts/lanes/jobs/acceptance.sh"

. "$REPO/scripts/lanes/jobs/compose-driver.sh"

. "$REPO/scripts/lanes/jobs/auth.sh"

. "$REPO/scripts/lanes/jobs/cooperative-stop.sh"

. "$REPO/scripts/lanes/jobs/tool-isolation.sh"

. "$REPO/scripts/lanes/jobs/image-checks.sh"

. "$REPO/scripts/lanes/jobs/repo-skills.sh"

. "$REPO/scripts/lanes/jobs/ask-user-question.sh"

. "$REPO/scripts/lanes/jobs/question-round-trip.sh"

. "$REPO/scripts/lanes/jobs/pinned-skills.sh"

. "$REPO/scripts/lanes/jobs/mcp.sh"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
