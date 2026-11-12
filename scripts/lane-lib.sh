# The harness scripts/test-jobs.sh and scripts/test-k8s.sh share: phase timing, the ok/bad verdicts,
# the evidence bundle written on the first FAIL, and the acceptance helpers. Sourced once each lane
# has set TIMINGS_FILE, CHECKS_FILE, pass and fail. Pinned by driver/test/lane-lib.test.ts and
# driver/test/lane-stubs.test.ts.
#
# A lane may define lane_collect_evidence <dir> before its first check: it adds that lane's own
# state (containers or pods, the job rows) to the bundle. It is diagnostics, never a verdict.

phase_name=''
phase_started=$SECONDS
check_started=$SECONDS
lane_started=$SECONDS

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

check_timing() { # check_timing <ok|FAIL> <name>
    printf '%s\t%s\t%s\t%s\n' "$phase_name" "$((SECONDS - check_started))" "$1" "$2" >>"$CHECKS_FILE"
    check_started=$SECONDS
}

lane_evidence() { # lane_evidence <check name> <message> — the bundle for the first FAIL: artifacts/<lane>/evidence-<phase>/
    local dir="${LANE_EVIDENCE_ROOT:-$(dirname "$TIMINGS_FILE")}/evidence-${phase_name:-none}"
    mkdir -p "$dir" 2>/dev/null || return 0
    {
        printf 'phase\t%s\ncheck\t%s\nat\t%s\n\n' "${phase_name:-none}" "$1" "$(date -u +%FT%TZ)"
        printf '%s\n' "$2"
    } >"$dir/failure.txt" 2>&1
    cp "$CHECKS_FILE" "$dir/checks.tsv" 2>/dev/null
    if type lane_collect_evidence >/dev/null 2>&1; then
        lane_collect_evidence "$dir" >"$dir/collect.log" 2>&1 || true
    fi
    printf '     evidence: %s\n' "$dir"
}

ok() {
    check_timing ok "$1"
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
}

bad() {
    check_timing FAIL "$1"
    printf 'FAIL %s\n     %s\n' "$1" "${2:0:400}"
    if [ -z "${lane_evidence_taken:-}" ]; then
        lane_evidence_taken=1
        lane_evidence "$1" "${2:-}"
    fi
    fail=$((fail + 1))
}

expect_contains() { # expect_contains <name> <haystack> <needle>
    case "$2" in
    *"$3"*) ok "$1" ;;
    *) bad "$1" "wanted substring '$3' in: ${2:0:200}" ;;
    esac
}

expect_not_contains() { # expect_not_contains <name> <haystack> <needle>
    case "$2" in
    *"$3"*) bad "$1" "did not want '$3' in: ${2:0:200}" ;;
    *) ok "$1" ;;
    esac
}

# --- the acceptance helpers both lanes' acceptance phases share ---------------------------------

acc_poll() { # acc_poll <want> <seconds> <function> [arg...] -> the function's last answer, once it equals <want> or the time is up
    # A read that failed on a loaded host answers "unread" or nothing and is asked again; only the last answer is judged.
    local want="$1" until=$(($(date +%s) + $2)) got=''
    shift 2
    while :; do
        got="$("$@")"
        [ "$got" = "$want" ] && break
        [ "$(date +%s)" -lt "$until" ] || break
        sleep 3
    done
    printf '%s' "$got"
}

acc_transcript() { # acc_transcript <board base> <id> <session> <first> <last> [lossy] -> "exact" when the job's artifact read is records first..last, whole
    # Every page of the read, followed by cursor; the streams must be complete, the chunks gapless from the
    # byte where record <first> starts, and the text exactly those records. Anything else says why;
    # a read that did not answer 200 with a well-formed body says "unread: ..." and is never "no transcript".
    node "$(dirname "${BASH_SOURCE[0]}")/acceptance-transcript.mjs" "$1/api/jobs/$2/artifacts" "$3" "$4" "$5" "${6-}"
}

acc_stored_short() { # acc_stored_short <board base> <id> <session> <first> <last> -> "short" only when the store is confirmed to hold fewer than records first..last
    node "$(dirname "${BASH_SOURCE[0]}")/acceptance-transcript.mjs" "$1/api/jobs/$2/artifacts" "$3" "$4" "$5" before-loss
}

acc_job_read() { # acc_job_read <board base> <id> <brief|session|cause> -> the validated value, or "unread: <why>"
    # "brief" is "status|attempts|interruptions|first claimSeq|first reason". A non-200, a body that is not a
    # job object or a field of the wrong shape says "unread"; it is never a value a check can pass on.
    node "$(dirname "${BASH_SOURCE[0]}")/acceptance-job.mjs" GET "$1/api/jobs/$2" "$3"
}

acc_post_id() { # acc_post_id <board base> <path> [json] -> the new job's id, empty unless the board answered 201 with one
    # Why not, in $work/acc-post.refusal. Callers read $work from their lane.
    local out
    out="$(node "$(dirname "${BASH_SOURCE[0]}")/acceptance-job.mjs" POST "$1$2" id "${3-}")"
    case "$out" in
    unread:* | refused:*) printf '%s' "$out" >"$work/acc-post.refusal" ;;
    *) printf '%s' "$out" ;;
    esac
}

# --- HTTP and JSON through one long-lived node helper (scripts/lane-api.mjs) -----------------------
# lane_api_start runs once, in the lane's own shell, before the first api/field call; lane_api_stop in
# its cleanup. A call is a request file and a private fifo: the helper answers into "<file>.out" and
# says "done" on the fifo, so concurrent callers (subshells, workers) never read each other's answers.

lane_api_start() {
    LANE_API_DIR="$(mktemp -d)" || return 1
    mkfifo "$LANE_API_DIR/requests" || return 1
    exec 9<>"$LANE_API_DIR/requests"
    node "$(dirname "${BASH_SOURCE[0]}")/lane-api.mjs" "$LANE_API_DIR/requests" &
    LANE_API_PID=$!
}

lane_api_stop() {
    if [ -n "${LANE_API_PID:-}" ]; then
        kill "$LANE_API_PID" 2>/dev/null
        wait "$LANE_API_PID" 2>/dev/null
    fi
    [ -n "${LANE_API_DIR:-}" ] && rm -rf "$LANE_API_DIR"
    LANE_API_PID=''
    LANE_API_DIR=''
}

lane_call() { # lane_call <op> <arg...> -> the helper's answer, "000<TAB>helper ..." when it is not running or does not answer
    local req
    if [ -z "${LANE_API_DIR:-}" ] || ! kill -0 "$LANE_API_PID" 2>/dev/null; then
        printf '000\tlane api helper is not running'
        return 0
    fi
    req="$(mktemp "$LANE_API_DIR/req.XXXXXX")" || return 1
    mkfifo "$req.resp" || return 1
    printf '%s\0' "$@" >"$req"
    printf '%s\n' "$req" >&9
    # Read-write, so the open never blocks on a helper that has died; the deadline outlasts the helper's own 10 s fetch timeout.
    if IFS= read -r -t 30 _ <>"$req.resp"; then
        cat "$req.out"
    else
        printf '000\tlane api helper did not answer'
    fi
    rm -f "$req" "$req.out" "$req.resp"
}

api() { # api METHOD PATH [json] -> "<status>\t<body>"; BASE and AUTH_HEADER come from the environment
    lane_call api "$BASE" "$1" "$2" "${3:-}" "${AUTH_HEADER:-}"
}

field() { # field <json> <key>
    lane_call field "$1" "$2"
}
