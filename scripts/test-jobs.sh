#!/usr/bin/env bash
# End-to-end for the job board and its driver.
#
#   scripts/test-jobs.sh [--phase workflows]
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
CLI_WORKERS=2
while [ "$#" -gt 0 ]; do
    case "$1" in
    --phase)
        shift
        PHASE="${1:-}"
        case "$PHASE" in
        all|board|driver|github-credential|services|orphan-reaper|node-disruption|run-deadline|workflows|compose-driver|auth|cooperative-stop|tool-isolation|ask-user-question|question-round-trip) ;;
        *) echo 'test-jobs: invalid --phase (see --help)'; exit 2 ;;
        esac
        ;;
    --cli-workers)
        shift
        CLI_WORKERS="${1:-}"
        case "$CLI_WORKERS" in 1|2) ;; *) echo 'test-jobs: --cli-workers must be 1 or 2'; exit 2 ;; esac
        ;;
    --help)
        echo 'Usage: scripts/test-jobs.sh [--phase PHASE] [--cli-workers 1|2]'
        echo 'Phases: all (default), board, driver, github-credential, services, orphan-reaper,'
        echo '        node-disruption, run-deadline, workflows, compose-driver, auth, cooperative-stop,'
        echo '        tool-isolation, ask-user-question, question-round-trip'
        echo 'Each phase provisions its own prerequisites; standalone CLI phases need no database or build.'
        echo 'Standalone CLI cases use at most two workers; --cli-workers 1 runs them serially.'
        echo 'TIMINGS_FILE overrides artifacts/jobs/<run>.tsv; check timings and process logs are saved beside it.'
        exit 0
        ;;
    *) echo "test-jobs: unknown argument: $1"; exit 2 ;;
    esac
    shift
done
selected_phase() { [ "$PHASE" = all ] || [ "$PHASE" = "$1" ]; }
needs_board() {
    case "$PHASE" in cooperative-stop|tool-isolation|ask-user-question) return 1 ;; esac
    return 0
}

RUN_ID="$(date +%s)-$$"
PORT="${PORT:-8129}"
BASE="http://127.0.0.1:$PORT"
DB="${JOBS_TEST_DB:-factory_jobs_${RUN_ID//-/_}_test}"
DATABASE_URL="postgres://factory:factory@127.0.0.1:5432/$DB"
IMAGE_BASE="factory-jobs-$RUN_ID-base"
IMAGE_OK="factory-jobs-$RUN_ID-ok"
IMAGE_FAIL="factory-jobs-$RUN_ID-fail"
IMAGE_SVC="factory-jobs-$RUN_ID-svc"
IMAGE_RUN="factory-jobs-$RUN_ID-run"
IMAGE_GH="factory-jobs-$RUN_ID-github"
IMAGE_KILL="factory-jobs-$RUN_ID-kill"
VOLUME="factory-jobs-$RUN_ID-workspaces"
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
mint_pid=""
compose_pid=""
supervisor_log_pid=""
db_created=""
lane_worker_pids=''
lane_worker_name=main
# Preflight before creating or removing any shared lane resource.
for tool in docker node timeout; do
    command -v "$tool" >/dev/null || { echo "test-jobs: $tool is required"; exit 1; }
done
docker info >/dev/null 2>&1 || { echo 'test-jobs: docker daemon is unavailable'; exit 1; }
images=''
case "$PHASE" in
all|cooperative-stop|tool-isolation) images='claude-executor opencode-executor' ;;
ask-user-question|question-round-trip) images='claude-executor' ;;
esac
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

cleanup() {
    local result=$?
    begin_phase cleanup
    for pid in $lane_worker_pids; do kill -TERM "$pid" 2>/dev/null || true; done
    for marker in "$work"/*.endpoint "$work"/*.group; do
        [ -f "$marker" ] || continue
        worker="${marker##*/}"
        lane_resources_cleanup "${worker%.*}"
    done
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
        # Only ever drops a database this run created, and only one named *_test.
        if [ -n "$db_created" ]; then
            compose exec -T postgres psql -U factory -d postgres \
                -c "drop database if exists $DB" >/dev/null 2>&1
        fi
        docker volume rm "$VOLUME" >/dev/null 2>&1
        docker image rm -f "$IMAGE_OK" "$IMAGE_FAIL" "$IMAGE_SVC" "$IMAGE_RUN" "$IMAGE_GH" "$IMAGE_KILL" "$IMAGE_BASE" >/dev/null 2>&1
    fi
    for log in "$work"/*.log "$work"/*.supervisor-*.json "$work"/*.worker-*.tsv; do
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
    printf ''
}

start_driver() { # start_driver <image> [RUNNER_SERVICES]
    # No ORG_ID. The board sends `workspacePath` on the claim now — it owns the layout, because it
    # is the thing that created the directory — so the driver builds no path of its own.
    # RUNNER_SERVICES defaults to on now; every phase but the services one passes 0 explicitly, so
    # what each phase asserts stays independent of the default.
    env JOB_BOARD_URL="$BASE" CLAUDE_EXECUTOR_IMAGE="$1" OPENCODE_EXECUTOR_IMAGE="$1" \
        RUNNER_SERVICES="${2:-0}" \
        WORKSPACE_VOLUME="$VOLUME" \
        DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=60 \
        node driver/dist/index.js >>"$work/driver.log" 2>&1 &
    driver_pid=$!
}

stop_driver() {
    [ -n "$driver_pid" ] && kill "$driver_pid" 2>/dev/null
    wait "$driver_pid" 2>/dev/null
    driver_pid=""
}

# The file has to be on the origin's default branch: every task's startup sync fetches it and
# branches the task worktree from it, and the readout reads that worktree. There is no host path
# into a named volume, so a container commits it. A failed write fails the run here, not later as a
# misleading job verdict.
write_bellows() { # write_bellows <contents>
    docker run --rm -i -v "$VOLUME:/workspaces" -e HOME=/tmp "$IMAGE_BASE" sh -c '
        set -e
        git clone -q "$1" /tmp/tree
        cat >/tmp/tree/.bellows.yaml
        git -C /tmp/tree add .bellows.yaml
        git -C /tmp/tree -c user.name=test-jobs -c user.email=test-jobs@localhost commit -q --allow-empty -m bellows
        git -C /tmp/tree push -q origin HEAD:main' sh "/workspaces/$member_path/.smoke-origin.git" \
        <<<"$1" >/dev/null || {
        echo 'test-jobs: could not commit the .bellows.yaml fixture'
        exit 1
    }
    # The offline board has no GitHub: it reads the plan at claim time from a bare mirror under its
    # workspace root (server/src/github/local-origin-plan.ts), so the origin is copied out of the volume.
    local mirror="$work/workspaces/.origins/$SMOKE_REPO.git"
    rm -rf "$mirror" && mkdir -p "$mirror" &&
        docker run --rm -v "$VOLUME:/workspaces" "$IMAGE_BASE" \
            tar -C "/workspaces/$member_path/.smoke-origin.git" -cf - . | tar -C "$mirror" -xf - || {
        echo 'test-jobs: could not mirror the origin for the board'
        exit 1
    }
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
# --no-recreate: the stack's postgres is shared, and a run from another checkout carries another
# config hash, so a plain `up` would replace the container mid-write. A replaced one can spend most
# of a minute in crash recovery, hence the wait.
compose up -d --no-recreate postgres >"$work/postgres.log" 2>&1 || {
    echo 'test-jobs: could not start postgres'
    exit 1
}
postgres_ready=''
for _ in $(seq 1 120); do
    compose exec -T postgres pg_isready -U factory >/dev/null 2>&1 && { postgres_ready=1; break; }
    sleep 1
done
[ -n "$postgres_ready" ] || { echo 'test-jobs: postgres never became ready'; exit 1; }

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
npm run build -w core >"$work/build.log" 2>&1 && npm run build -w server >>"$work/build.log" 2>&1 &&
    npm run build -w driver >>"$work/build.log" 2>&1 || {
    echo 'test-jobs: build failed'
    exit 1
}

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
    docker/claude-executor/tool-bash.sh scripts/stub-agent.sh scripts/stub-runner.Dockerfile "$work/"
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

# A workspace root IS set, under $work, and it has to be: with none, the board reports a null
# `workspacePath` on every claim and the driver fails each job rather than guessing a directory.
# Nothing is cloned into it — clones only happen when somebody selects repositories — so this costs
# one empty directory per job author.

# Both boards boot the OFFLINE entry (server/dist/offline.js) — the same server built with the
# code-only no-fetch arm, which is what lets them run with no App credential at all and against a
# disposable database name. It drives the whole lease protocol with no credential anywhere.

start_open_board() { # boots the AUTH_MODE=none board on $BASE and waits until it is migrated
    env AUTH_MODE=none DATABASE_URL="$DATABASE_URL" PORT="$PORT" HOST=127.0.0.1 \
        ORG_WORKSPACE_ROOT="$work/workspaces" \
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

# A task runs against a checkout (issue #263, 372f5630): POST /api/jobs refuses a create whose repo
# is not the author's own ready selection. With no GitHub there is nothing to clone, so the fixture
# is what a finished clone leaves — the ready user_repo row and, in the driver volume, the clone —
# with its origin a bare repository beside it, so every startup sync fetches and branches its task
# worktree with no network. The author is AUTH_MODE=none's stand-in, read from /api/auth/me; the
# board names its tree `<org>/<user id>` on every claim (asserted below).
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
    "insert into user_repo (org_id, user_id, repo_owner, repo_name, status, ready_at)
     values ('$member_org', '$member_user', '${SMOKE_REPO%%/*}', '${SMOKE_REPO#*/}', 'ready', now())
     on conflict (org_id, user_id, repo_owner, repo_name)
     do update set status = 'ready', deselected_at = null, ready_at = now()" >/dev/null 2>&1 || {
    echo "test-jobs: could not select $SMOKE_REPO for the stand-in member"
    exit 1
}
# Production provisioning creates this subtree in the same volume the driver mounts. The harness's
# board uses a host tempdir while the driver uses a named volume, so bridge that boundary explicitly;
# volume-subpath refuses a missing target instead of silently mounting a broader parent. Owned by
# uid 1000, the user every runner, sync and gate container writes the tree as.
docker volume create "$VOLUME" >/dev/null &&
    docker run --rm -v "$VOLUME:/workspaces" alpine:3 \
        sh -c "mkdir -p '/workspaces/$member_path' && chown 1000:1000 '/workspaces/$member_path'" &&
    docker run --rm -v "$VOLUME:/workspaces" -w "/workspaces/$member_path" -e HOME=/tmp "$IMAGE_BASE" sh -c '
        set -e
        rm -rf .smoke-origin.git "$1" .worktrees /tmp/seed
        git init -q --bare -b main .smoke-origin.git
        git init -q -b main /tmp/seed
        git -C /tmp/seed -c user.name=test-jobs -c user.email=test-jobs@localhost commit -q --allow-empty -m init
        git -C /tmp/seed push -q "$PWD/.smoke-origin.git" main
        git clone -q "$PWD/.smoke-origin.git" "$1"' sh "${SMOKE_REPO#*/}" || {
    echo 'test-jobs: could not provision the member workspace in the driver volume'
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
    ORG_WORKSPACE_ROOT="$work/workspaces" \
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
    RUNNER_SERVICES=0 WORKSPACE_VOLUME="$VOLUME" \
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
    selected_phase run-deadline; then
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

if [ "$PHASE" = node-disruption ]; then
write_bellows "services:
  - name: stub-svc
    image: $IMAGE_SVC"
fi
fi

if selected_phase services; then
begin_phase services
# --- Auxiliary services (.bellows.yaml) -------------------------------------------------------
#
# Issue #6, end to end: a checkout declares a service, the driver starts it on a per-job network,
# and the runner reaches it by name. The stub runner is the one image here whose entrypoint EXECUTES
# the prompt (the driver always puts it last in the argv), so the job's output is an HTTP fetch of
# `http://stub-svc:8000/probe` — the assertion fails unless the service is up, on the job's network,
# under the name the file asked for.

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

svc="$(create_job 'wget -qO- http://stub-svc:8000/probe')"
expect_contains 'a declared service is reachable by name' "$(await_settled "$svc")" succeeded
expect_contains 'the service answered the runner'    "$(field "$(body "$(api GET "/api/jobs/$svc")")" output)" service-is-up

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

# Nothing of THIS RUN's jobs may survive the driver: the network is per-job (named after the job
# id), every runner is --rm, and the driver drains before it exits. Scoped to the ids this script
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
if [ "$svc_networks" = '0' ]; then ok 'no service networks left behind'; else bad 'no service networks left behind' "$svc_networks remain"; fi
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
# service container and the per-attempt network. The runner container is NOT the reaper's to reap
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
    RUNNER_SERVICES=1 WORKSPACE_VOLUME="$VOLUME" \
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
    RUNNER_SERVICES=0 WORKSPACE_VOLUME="$VOLUME" \
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

orphan_net=""
for _ in $(seq 1 30); do
    [ -z "$(docker network ls --filter "name=factory-job-$orphan-" --format '{{.Name}}')" ] && {
        orphan_net=1
        break
    }
    sleep 1
done
if [ -n "$orphan_net" ]; then
    ok "the reaper removes the crashed attempt's services network"
else
    bad "the reaper removes the crashed attempt's services network" 'the network survived the reaper'
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

disruption_driver() { # disruption_driver [VAR=value ...] — a services-off driver on the prompt-executing stub
    env JOB_BOARD_URL="$BASE" CLAUDE_EXECUTOR_IMAGE="$IMAGE_RUN" OPENCODE_EXECUTOR_IMAGE="$IMAGE_RUN" \
        RUNNER_SERVICES=0 WORKSPACE_VOLUME="$VOLUME" \
        DRIVER_POLL_MS=500 DRIVER_CONCURRENCY=2 DRIVER_LEASE_SECONDS=10 "$@" \
        node driver/dist/index.js >>"$work/driver.log" 2>&1 &
    driver_pid=$!
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
DRAINED='the driver was drained'
# The interruption the next claim records for an attempt whose lease expired (issue #822).
EXPIRED='the lease expired: its driver went silent'
# The adopting claim settles only once the lost driver's supervisor exits, and with no driver left to
# order its `finish` that is SUPERVISOR_ORPHAN_MS (90s, driver/src/scripts/supervisor.cjs) after its
# last answered call — the documented bound (driver/src/supervisor-contract.ts), plus the claim.
ADOPT_S=150

# a. The hard kill: no drain, no handover, the lease left to expire. The runner runs to its end
#    while no driver watches it; the next driver's claim (2) records the expiry as claim 1's
#    interruption and adopts it — at max_attempts 1, where an expiry used to retire the job dead.
disruption_driver
killed="$(create_job 'sleep 8; echo "ran in $HOSTNAME"')"
capped="$(last_attempt "$killed")" && ok 'the hard-kill job runs at max_attempts 1' ||
    bad 'the hard-kill job runs at max_attempts 1' "job '$killed': $capped"
killed_runner="$(await_first_runner "$killed" running)"
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
# Issue #824: the next claim takes the group between its agent's exit and its supervisor's end —
# the orphaned supervisor serves on until its bound — and waits it out rather than sweeping it.
[ -n "$(docker ps -q --filter "label=factory.job=$killed" --filter 'label=factory.role=supervisor' --filter status=running)" ] &&
    ok 'its supervisor still finalizes when the next driver starts' ||
    bad 'its supervisor still finalizes when the next driver starts' "$(docker ps -a --filter "label=factory.job=$killed" --format '{{.Names}} {{.Status}}')"
# A fast reaper round: the adopted run is kept until its verdict lands (issue #821), then reaped.
disruption_driver DRIVER_REAP_INTERVAL_MS=2000 DRIVER_REAP_GRACE_MS=1000
expect_contains 'the next claim settles the killed run' "$(await_settled "$killed" "$ADOPT_S")" succeeded
killed_body="$(body "$(api GET "/api/jobs/$killed")")"
expect_contains 'the adopted output is the first runner output' "$(field "$killed_body" output)" "ran in $killed_runner"
expect_field 'the killed attempt is refunded' "$killed_body" attempts 1
killed_int="$(interruptions_of "$killed_body")"
[ "$killed_int" = "1|1|$EXPIRED" ] && ok 'one interruption records the expiry of claim 1' ||
    bad 'one interruption records the expiry of claim 1' "count|claimSeq|reason: $killed_int"
grep -qF "job $killed: $ADOPTED" "$work/driver.log" && ok 'the driver logs the adoption' ||
    bad 'the driver logs the adoption' "$(grep -F "job $killed:" "$work/driver.log" | tail -5)"
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
#    once that runner exited: a claim of a STILL-running runner sweeps it (docs/kubernetes.md).
disruption_driver DRIVER_HANDOVER_MS=2000
drained="$(create_job 'sleep 12; echo "ran in $HOSTNAME"')"
drained_runner="$(await_first_runner "$drained" running)"
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
disruption_driver
expect_contains 'the next claim adopts the handed-over run' "$(await_settled "$drained" "$ADOPT_S")" succeeded
drained_body="$(body "$(api GET "/api/jobs/$drained")")"
expect_contains 'the handed-over output is the first runner output' "$(field "$drained_body" output)" "ran in $drained_runner"
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
    RUNNER_SERVICES=0 WORKSPACE_VOLUME="$VOLUME" DRIVER_JOB_TIMEOUT_MS="$DEADLINE_MS" \
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
    -e WORKSPACE_VOLUME="$VOLUME" \
    -e RUNNER_NETWORK="${COMPOSE_PROJECT}_default" \
    -e RUNNER_SERVICES=0 \
    -e JOB_BOARD_TOKEN= \
    driver >>"$work/compose-driver.log" 2>&1 &
compose_pid=$!

# The anti-stale discriminator: the running container must hold the checkout's driver SOURCE. The
# first start pays `npm install`, so poll rather than assume; the grep target is the current
# parser, so a container running a baked dist has nothing to grep and times out here.
mounted=""
for _ in $(seq 1 120); do
    if docker exec "$COMPOSE_DRIVER" grep -q '/fix' /app/driver/src/publish.ts 2>/dev/null; then
        mounted=1
        break
    fi
    # Give up only once `compose run` itself has exited. The container does not exist yet while
    # compose is still creating volumes and the network, so "no such container" is not an exit.
    kill -0 "$compose_pid" 2>/dev/null || break
    sleep 1
done
if [ -n "$mounted" ]; then
    ok 'the compose driver runs the checkout source'
else
    bad 'the compose driver runs the checkout source' "$(tail -3 "$work/compose-driver.log")"
fi

compose_job="$(create_job '/fix 987 compose driver lifecycle check')"
expect_contains 'the compose driver runs its job' "$(await_settled "$compose_job" 180)" succeeded
ran="$(body "$(api GET "/api/jobs/$compose_job")")"
expect_contains 'the compose driver names itself' "$(field "$ran" claimedBy)" 'driver-'

docker rm -f "$COMPOSE_DRIVER" >/dev/null 2>&1
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
    ORG_WORKSPACE_ROOT="$work/workspaces" \
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
