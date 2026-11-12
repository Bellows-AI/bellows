if selected_phase acceptance; then
begin_phase acceptance
# --- The failure matrix, accepted end to end ----------------------------------------
#
# Every cell has unit or integration coverage; these are the lane's characterization of the whole:
# a driver runs a task whose runner leaves a transcript on the task volume (the stub's
# `factory-stub-transcript-<n>`), and the board's artifact read must hold those bytes — after a
# complete run, after the runner pod is force-deleted with its volume kept, and after a follow-up.
# A read that failed, was refused or came back malformed is `bad`, never a negative verdict.

echo
echo '# acceptance: the failure matrix'

# The shared helpers, and the board credential the artifact read sends (scripts/lane-lib.sh).
export ACC_AUTH="${FACTORY_TOKEN:+Bearer $FACTORY_TOKEN}"
ACC_N=5
ACC_REL="/task/.lane-acc"

acc_post() { # acc_post <path> [json body] -> the new job's id, empty unless the board answered 201 with a string one
    acc_post_id "$BASE" "$1" "${2-}"
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

acc_volume_records() { # acc_volume_records <pod> <id> <session> -> the lines of the session file on the volume; ? when unread
    local out
    # wc reads the file itself, so a failed read is its own status; one file only, never a glob's several.
    out="$(kubectl exec "$1" -c supervisor -n "$NAMESPACE" --request-timeout=10s -- sh -c \
        'set -- /task/.factory/transcripts/"$1"/projects/*/"$2".jsonl; [ "$#" -eq 1 ] && [ -f "$1" ] && n="$(wc -l <"$1")" && echo "$n"' sh "$2" "$3" 2>/dev/null)" &&
        out="${out//[[:space:]]/}" && case "$out" in '' | *[!0-9]*) false ;; esac && printf '%s' "$out" || printf '?'
}

acc_containers() { # acc_containers <pod> -> the pod's container names; "unread" when kubectl did not answer
    local out
    # Names a failed read printed before it failed are dropped: only a read that ended well is a listing.
    out="$(kubectl get pod "$1" -n "$NAMESPACE" --request-timeout=10s \
        -o jsonpath='{.spec.initContainers[*].name} {.spec.containers[*].name}' 2>/dev/null)" || { printf unread; return 0; }
    printf '%s' "$out"
}

acc_pvcs() { # acc_pvcs -> "ok <task claims>" or why not: the claims of this namespace must be the state's or a task volume
    # Reads the claims and the volumes behind them; any failed read is "unread", an empty claim list is "bad".
    kubectl get pvc -n "$NAMESPACE" --request-timeout=15s -o json >"$work/acc-pvc.json" 2>/dev/null || { printf 'unread: pvc list'; return 0; }
    kubectl get pv --request-timeout=15s -o json >"$work/acc-pv.json" 2>/dev/null || { printf 'unread: pv list'; return 0; }
    node -e '
const read = (f) => { try { return JSON.parse(require("fs").readFileSync(f, "utf8")); } catch { return null; } };
const claims = read(process.argv[3]), volumes = read(process.argv[4]);
if (!Array.isArray(claims?.items) || !Array.isArray(volumes?.items)) { process.stdout.write("unread: malformed list"); process.exit(0); }
const state = process.argv[1];
const bad = [];
let tasks = 0;
const pvs = new Map(volumes.items.map((v) => [v?.metadata?.name, v]));
const shared = (v) => v.spec?.nfs || /nfs|efs/i.test((v.metadata?.annotations?.["pv.kubernetes.io/provisioned-by"] ?? "") + (v.spec?.csi?.driver ?? ""));
for (const c of claims.items) {
    const name = c?.metadata?.name, modes = c?.spec?.accessModes;
    // A claim is judged only once its access modes and the volume behind it were both read.
    if (typeof name !== "string" || !Array.isArray(modes) || modes.length === 0 || !modes.every((m) => ["ReadWriteOnce", "ReadOnlyMany", "ReadWriteMany", "ReadWriteOncePod"].includes(m))) { process.stdout.write("unread: malformed claim " + name); process.exit(0); }
    const volume = pvs.get(c.spec.volumeName);
    if (typeof c.spec.volumeName !== "string" || !volume) { process.stdout.write("unread: claim " + name + " has no readable volume (" + c.spec.volumeName + ")"); process.exit(0); }
    if (/^factory-task-/.test(name)) tasks++;
    else if (!name.includes(state)) bad.push("claim " + name);
    if (modes.includes("ReadWriteMany")) bad.push("RWX " + name);
    if (shared(volume)) bad.push("shared volume " + volume.metadata.name + " behind " + name);
}
for (const v of volumes.items) {
    if (v.spec.claimRef?.namespace !== process.argv[2]) continue;
    const by = v.metadata.annotations?.["pv.kubernetes.io/provisioned-by"] ?? "";
    if (v.spec.nfs || /nfs|efs/i.test(by + (v.spec.csi?.driver ?? ""))) bad.push("shared volume " + v.metadata.name + " " + by);
}
process.stdout.write(bad.length ? "bad: " + bad.join("; ") : "ok " + tasks + " " + claims.items.map((c) => c.metadata.name).join(" "));
' "$STATE_RELEASE" "$NAMESPACE" "$work/acc-pvc.json" "$work/acc-pv.json"
}

# a. A complete task: its runner carries an exporter, leaves ACC_N records on the volume, and once settled
#    is reaped while the artifact read still holds every record, byte for byte, in a complete stream.
acc_a="$(queue_job "factory-stub-transcript-$ACC_N factory-stub-wait-$ACC_REL-a")"
acc_a_pod="$(await_runner_pod "$acc_a")"
if [ -z "$acc_a" ] || [ -z "$acc_a_pod" ]; then
    bad 'acceptance: a. the runner pod is running' "job '$acc_a': $(job_brief "$acc_a")"
    give_up
fi
ok 'acceptance: a. the runner pod is running'
await_blocked "$acc_a_pod" "$ACC_REL-a" || give_up
acc_a_session="$(acc_session "$acc_a")"
acc_names=''
for _ in 1 2 3 4 5 6 7 8 9 10; do
    acc_names="$(acc_containers "$acc_a_pod")"
    case "$acc_names" in '' | unread) sleep 3 ;; *) break ;; esac
done
case " $acc_names " in
*' exporter '*) ok 'acceptance: a. the runner pod carried an exporter container' ;;
*) bad 'acceptance: a. the runner pod carried an exporter container' "containers: '$acc_names'" ;;
esac
tk_check "acceptance: a. the volume holds $ACC_N records before the run ends" "$(acc_poll "$ACC_N" 60 acc_volume_records "$acc_a_pod" "$acc_a" "$acc_a_session")" "$ACC_N"
release_stub "$ACC_REL-a"
acc_a_end="$(await_brief "$acc_a" 'succeeded*' 120)"
tk_check 'acceptance: a. the task succeeds in one attempt' "$acc_a_end" 'succeeded|1|0||'
tk_left_out=''
acc_reaped=''
acc_until=$(($(date +%s) + 120))
until tk_left_out="$(tk_left "$acc_a")" && acc_reaped=1; do
    [ "$(date +%s)" -lt "$acc_until" ] || break
    sleep 2
done
[ -n "$acc_reaped" ] && ok 'acceptance: a. the runner Job and pod are reaped' ||
    bad 'acceptance: a. the runner Job and pod are reaped' "${tk_left_out:-unconfirmed}"
tk_check "acceptance: a. the artifact read holds the $ACC_N records, whole" "$(acc_poll exact 90 acc_transcript "$BASE" "$acc_a" "$acc_a_session" 1 "$ACC_N")" exact

# b. A task whose agent exits non-zero fails, with a recorded cause.
# c. POST /retry on it: a driver claims the fresh attempt and it succeeds.
acc_b="$(queue_job 'factory-stub-fail-once')"
acc_b_end="$(await_brief "$acc_b" 'failed*' 120)"
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
    acc_c_end="$(await_brief "$acc_c" 'succeeded*' 180)"
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
    acc_d_end="$(await_brief "$acc_d" 'succeeded*' 180)"
    case "$acc_d_end" in
    succeeded*) ok 'acceptance: d. the follow-up succeeds' ;;
    *) bad 'acceptance: d. the follow-up succeeds' "status|attempts|count|claimSeq|reason: $acc_d_end" ;;
    esac
    expect_contains 'acceptance: d. the follow-up resumes the first run'"'"'s session' "$(job_output "$acc_d")" "--resume $acc_a_session"
    tk_check 'acceptance: d. the follow-up read continues at the prior offset' \
        "$(acc_poll exact 90 acc_transcript "$BASE" "$acc_d" "$acc_a_session" $((ACC_N + 1)) $((ACC_N + 2)))" exact
fi

# e. The runner pod is force-deleted once its records are on the volume and the agent is at its
#    barrier: the volume is kept, the next claim succeeds, and the artifact read holds every record.
acc_e="$(queue_job "factory-stub-transcript-$ACC_N factory-stub-wait-$ACC_REL-e")"
acc_e_pod="$(await_runner_pod "$acc_e")"
if [ -z "$acc_e" ] || [ -z "$acc_e_pod" ]; then
    bad 'acceptance: e. the runner pod to delete is running' "job '$acc_e': $(job_brief "$acc_e")"
else
    ok 'acceptance: e. the runner pod to delete is running'
    await_blocked "$acc_e_pod" "$ACC_REL-e" || give_up
    acc_e_session="$(acc_session "$acc_e")"
    tk_check "acceptance: e. the volume holds $ACC_N records before the pod is deleted" \
        "$(acc_poll "$ACC_N" 60 acc_volume_records "$acc_e_pod" "$acc_e" "$acc_e_session")" "$ACC_N"
    # The loss must have something to lose: the exporter flushes at 15 s / 256 KiB, so the store is read
    # now and must NOT yet hold all $ACC_N records; a read that fails or finds them all is not a pass.
    tk_check "acceptance: e. the store does not yet hold all $ACC_N records when the pod is deleted" \
        "$(acc_stored_short "$BASE" "$acc_e" "$acc_e_session" 1 "$ACC_N")" short
    kubectl delete pod "$acc_e_pod" -n "$NAMESPACE" --grace-period=0 --force --wait=false --request-timeout=10s >/dev/null 2>&1
    acc_e_mid="$(await_brief "$acc_e" "*|1|1|$POD_LOST*" 60)"
    case "$acc_e_mid" in
    *"|1|1|$POD_LOST"*) ok 'acceptance: e. the deleted runner pod is an interruption' ;;
    *) bad 'acceptance: e. the deleted runner pod is an interruption' "status|attempts|count|claimSeq|reason: $acc_e_mid" ;;
    esac
    release_stub "$ACC_REL-e"
    acc_e_end="$(await_brief "$acc_e" 'succeeded*' 180)"
    case "$acc_e_end" in
    "succeeded|1|1|1|$POD_LOST"*) ok 'acceptance: e. the next claim succeeds: one attempt, one interruption' ;;
    *) bad 'acceptance: e. the next claim succeeds: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $acc_e_end" ;;
    esac
    tk_check "acceptance: e. the artifact read holds all $ACC_N records after the pod loss" \
        "$(acc_poll exact 90 acc_transcript "$BASE" "$acc_e" "$acc_e_session" 1 "$ACC_N" lossy)" exact
fi

# f. No EFS or RWX: every claim of the namespace is the state's or a task volume, none is
#    ReadWriteMany, no volume behind them is NFS or EFS. The listing must contain (a)'s task claim.
acc_pvc="$(acc_pvcs)"
case "$acc_pvc" in
"ok "*" "*"factory-task-$acc_a-1"*) ok 'acceptance: f. no claim is ReadWriteMany or backed by NFS/EFS, and (a)'"'"'s task claim is listed' ;;
"ok "*) bad 'acceptance: f. the claim listing contains (a)'"'"'s task claim' "listing: $acc_pvc" ;;
*) bad 'acceptance: f. no claim is ReadWriteMany or backed by NFS/EFS' "$acc_pvc" ;;
esac

# g. (a)'s task claim still exists after the task settled, inside the TTL.
kubectl get pvc "factory-task-$acc_a-1" -n "$NAMESPACE" --request-timeout=10s -o name >"$work/acc-g.out" 2>&1 &&
    ok 'acceptance: g. the settled task'"'"'s volume claim is still there' ||
    bad 'acceptance: g. the settled task'"'"'s volume claim is still there' "$(cat "$work/acc-g.out")"

for job in $acc_a $acc_b $acc_c $acc_d $acc_e; do
    [ -z "$job" ] || kubectl delete jobs -l "factory.job=$job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --ignore-not-found --wait=false --request-timeout=10s >/dev/null 2>&1
done
fi
