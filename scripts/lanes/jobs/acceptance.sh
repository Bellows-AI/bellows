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
    # lane-lib.sh does the POST and the shape check: an id that is not a string is a refusal.
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
    lane_use "$1"
    acc_until 90 acc_ready "$2"
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
acc_group_left() { acc_left="$(lane_left "$acc_a")"; }
acc_left=""
acc_reaped=""
acc_until 120 acc_group_left && acc_reaped=1
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
