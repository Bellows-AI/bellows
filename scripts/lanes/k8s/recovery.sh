# What the recovery and takeover phases share: the interruption reasons the board records, and the lease expiry
# that stands in for waiting a dead driver's lease out.
ADOPTED='adopted the finished runner of claim 1, whose driver was lost'
TOOK_OVER='took over the running agent of claim 1, whose driver was lost'
# A released group waits takeoverBoundMs (the lease plus the rebind grace, driver/src/supervisor-plan.ts)
# for a new holder, so a runner handed over by a lost or drained driver finishes only past it; the wait
# is derived from the lane's lease and grace, plus a margin for the run itself.
HANDOVER_S=$((LANE_LEASE_S + LANE_REBIND_GRACE_S + LANE_MARGIN_S))
ORPHANED_S=$((LANE_ORPHAN_S + HANDOVER_S))
DRAINED='the driver was drained'
POD_LOST='infrastructure loss: the runner pod was deleted'
# What a gate or setup whose supervisor was lost records (`gateLossReason`, driver/src/loop-run.ts); the cause follows in parentheses.
GATE_LOST='infrastructure loss: the task supervisor running the gates was lost'
JOB_LOST='infrastructure loss: the runner job '
# The interruption the next claim records for an attempt whose lease expired.
EXPIRED='the lease expired: its driver went silent'

expire_claim_one() { # expire_claim_one <id> -> "1" once claim 1's lease is expired: by this call, or already on its own
    # A short lease (15 s) can run out while a case waits for the lost supervisor to end, and the next claim
    # may have taken it since (claim_seq > 1): either way claim 1's lease is over, which is all the callers need.
    bounded 30 kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        env PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' psql -qtA -v ON_ERROR_STOP=1 -v "job=$1" \
        postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
update job set lease_expires_at = now() - interval '1 second'
where id = :'job' and status = 'running' and claim_seq = 1 and lease_expires_at > now();
select count(*) from job
where id = :'job' and status = 'running' and (claim_seq > 1 or lease_expires_at <= now());
SQL
}

if selected_phase recovery; then
#
# Infrastructure loss interrupts a task, it never loses one — on a real apiserver. The release was
# installed with the lane lease (LANE_LEASE_S) and a 70s drain grace, so the chart's handover (grace minus 60s) is
# 10s. a: the driver pod deleted hard while its runner runs — the replacement driver's reaper
# spares the live runner Job, and once the lease ran out the replacement takes the run over. b: the
# driver drained (scaled to 0) — the handover queues the job with an interruption and leaves the
# runner running; the driver scaled back adopts it. c: the runner pod deleted mid-run (an eviction
# stand-in) — an interruption, then the next attempt, in its session. d: the driver pod and its
# runner Job deleted together — a replacement runner redoes the attempt in the lost session, on the
# restored tree. e: the driver lost after its agent exited, while the supervisor still finalizes —
# the surviving replica's claim takes the group over, never sweeps it or waits it out.
# f: pinned org and workspace skills reach the runner pod and survive its deletion at the pinned sha set.
# Each job refunds its interrupted attempt and records exactly one interruption; an expired lease
# is that interruption. Only this release's objects are touched, by label.

echo
echo '# node disruption'

job_session() { # job_session <id>
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers }).then(async (r) => process.stdout.write(String((await r.json()).sessionId ?? ""))).catch(() => {});
' "$BASE/api/jobs/$1"
}

last_attempt() { # last_attempt <id> -> the job allowed one attempt, so an expiry spending it would retire it dead
    # Non-zero, printing what psql answered, unless the update returned that job: a cap that did not land proves nothing.
    local capped
    capped="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        psql -qtA -v ON_ERROR_STOP=1 -v "id=$1" postgres://factory:factory@127.0.0.1:5432/factory_dev -f - \
        2>&1 <<'SQL'
update job set max_attempts = 1 where id = :'id' returning id;
SQL
    )"
    [ "$capped" = "$1" ] || {
        printf '%s' "${capped:-no job row changed}"
        return 1
    }
}

advance_origin() { # advance_origin -> success once the origin's main has a new `lane-upstream` commit
    local out
    out="$(kubectl exec "$RELEASE-origin" -n "$NAMESPACE" -- sh -c "set -e; rm -rf /tmp/up; git clone -q /origins/$SMOKE_REPO.git /tmp/up; git -C /tmp/up -c user.name=test-k8s -c user.email=test-k8s@localhost commit -q --allow-empty -m lane-upstream; git -C /tmp/up push -q origin HEAD:main; echo advanced" 2>&1 || true)"
    case "$out" in *advanced*) return 0 ;; esac
    return 1
}

await_job_complete() { # await_job_complete <runner Job name> <seconds>
    kubectl wait --for=condition=complete "job/$1" -n "$NAMESPACE" --timeout="$2s" >/dev/null 2>&1
}

hard_release="/task/.lane-hard"
drain_release="/task/.lane-drain"
evict_release="/task/.lane-evict"
lost_release="/task/.lane-lost"
final_release="/task/.lane-finalizing"

# a. The hard kill: a lease expiry. A forced delete is no SIGKILL — the kubelet still
#    sends SIGTERM and kills ~2s later — so this is no drain only while the 10s handover outlasts
#    that. The lane lease (LANE_LEASE_S) keeps the job live, under the dead driver's claim, through the reaper check, which
#    runs while the agent is blocked; the lease then ends naturally and claim 2 takes the run over.
#    At max_attempts 1: the claim records the expiry as claim 1's interruption and takes over.
begin_phase recovery-hard-kill
hard="$(queue_job "factory-stub-wait-$hard_release hard kill")"
if [ -n "$hard" ]; then
    capped="$(last_attempt "$hard")" && ok 'the hard-kill job runs at max_attempts 1' ||
        bad 'the hard-kill job runs at max_attempts 1' "job '$hard': $capped"
fi
hard_pod="$(await_runner_pod "$hard")"
if [ -z "$hard" ] || [ -z "$hard_pod" ]; then
    bad 'the hard-kill runner is running' "job '$hard': $(job_brief "$hard")"
else
    ok 'the hard-kill runner is running'
    await_blocked "$hard_pod" "$hard_release" && ok 'the hard-kill agent is blocked at its barrier' || give_up
    hard_job="$(first_runner_job "$hard")"
    hard_sup_log="${TIMINGS_FILE%.tsv}.hard-kill.supervisor.log"
    kubectl logs -f "$hard_pod" -c supervisor -n "$NAMESPACE" >"$hard_sup_log" 2>&1 &
    hard_sup_pid=$!
    kill_driver_pods
    kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
    # Two and more 3s reaper rounds of the replacement driver while the agent is still blocked at its
    # barrier under the dead driver's live lease: the live runner Job is no orphan, and stays.
    sleep 6
    hard_live="$(job_brief "$hard")"
    case "$hard_live" in
    running*) ok 'the job is still running under the dead driver lease' ;;
    *) bad 'the job is still running under the dead driver lease' "$hard_live (the lease ran out before the reaper check)" ;;
    esac
    kubectl get job "$hard_job" -n "$NAMESPACE" >/dev/null 2>&1 && ok 'the reaper spares the live runner Job' ||
        bad 'the reaper spares the live runner Job' 'the runner Job is gone while its agent runs'
    expect_not_contains 'the reaper logs nothing for the live job' "$(driver_logs)" "reaper: job $hard"
    # The lease then runs out on its own: the runner finishes only past it, and claim 2 takes it over.
    release_stub "$hard_release"
    # The adopting driver deletes the finished Job, which can win the race against Complete: a Job gone
    # with the board row's attempt ended is the same end.
    if await_job_complete "$hard_job" "$ORPHANED_S"; then
        ok 'the runner of a deleted driver runs to its end'
    elif ! kubectl get job "$hard_job" -n "$NAMESPACE" >/dev/null 2>&1 &&
        case "$(await_brief "$hard" 'succeeded*' 60)" in succeeded*) true ;; *) false ;; esac; then
        ok 'the runner of a deleted driver runs to its end'
    else
        bad 'the runner of a deleted driver runs to its end' "$(kubectl get job "$hard_job" -n "$NAMESPACE" 2>&1)"
    fi
    hard_end="$(await_brief "$hard" 'succeeded*' 240)"
    [ "$hard_end" = "succeeded|1|1|1|$EXPIRED" ] && ok 'the replacement driver adopts the run: one attempt, one interruption' ||
        bad 'the replacement driver adopts the run: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $hard_end
$(driver_logs | grep -F "job $hard" | tail -15)
supervisor: $(tail -20 "$hard_sup_log")"
    kill "$hard_sup_pid" 2>/dev/null
    expect_contains 'the adopted output is the first runner pod output' "$(job_output "$hard")" "released in $hard_pod"
    expect_contains 'the replacement driver logs the takeover' "$(driver_logs)" "job $hard: $TOOK_OVER"
fi

# b. The drain: SIGTERM, and the handover 10s in. Scaled to 0, so no driver claims the queued job
#    while its runner still runs (a claim of a still-running runner sweeps it: the stated limit).
begin_phase recovery-drain
drained="$(queue_job "factory-stub-wait-$drain_release handover")"
drained_pod="$(await_runner_pod "$drained")"
if [ -z "$drained" ] || [ -z "$drained_pod" ]; then
    bad 'the handover runner is running' "job '$drained': $(job_brief "$drained")"
else
    ok 'the handover runner is running'
    await_blocked "$drained_pod" "$drain_release" && ok 'the handover agent is blocked at its barrier' || give_up
    drained_job="$(first_runner_job "$drained")"
    kubectl scale "$DRIVER_DEPLOY" -n "$NAMESPACE" --replicas=0 >/dev/null 2>&1
    drained_mid="$(await_brief "$drained" "queued|0|1|1|$DRAINED" 30)" &&
        ok 'a drained driver hands its run back as an interruption' ||
        bad 'a drained driver hands its run back as an interruption' "status|attempts|count|claimSeq|reason: $drained_mid"
    kubectl wait --for=delete pod -l "$DRIVER_SEL" -n "$NAMESPACE" --timeout=90s >/dev/null 2>&1
    [ "$(kubectl get pod "$drained_pod" -n "$NAMESPACE" -o jsonpath='{.status.phase}' 2>/dev/null)" = 'Running' ] &&
        ok 'the handed-over runner pod is left running' ||
        bad 'the handed-over runner pod is left running' "$(kubectl get pod "$drained_pod" -n "$NAMESPACE" 2>&1)"
    release_stub "$drain_release"
    await_job_complete "$drained_job" "$HANDOVER_S" && ok 'the handed-over runner Job completes on its own' ||
        bad 'the handed-over runner Job completes on its own' "$(kubectl get job "$drained_job" -n "$NAMESPACE" 2>&1)"
fi
# Scaled back whatever happened above: the case after this one needs a driver.
kubectl scale "$DRIVER_DEPLOY" -n "$NAMESPACE" --replicas=1 >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
if [ -n "$drained_pod" ]; then
    drained_end="$(await_brief "$drained" 'succeeded*' 120)"
    [ "$drained_end" = "succeeded|1|1|1|$DRAINED" ] && ok 'the returning driver adopts the handed-over run' ||
        bad 'the returning driver adopts the handed-over run' "status|attempts|count|claimSeq|reason: $drained_end"
    expect_contains 'the handed-over output is the first runner pod output' "$(job_output "$drained")" "released in $drained_pod"
    expect_contains 'the returning driver logs the adoption' "$(driver_logs)" "job $drained: $ADOPTED"
fi

# c. The runner pod deleted mid-run, its driver alive: an interruption the driver reports at once,
#    not a failed run and not a lease left to expire; the next attempt runs the job again.
begin_phase recovery-eviction
evicted="$(queue_job "factory-stub-wait-$evict_release pod deleted")"
evicted_pod="$(await_runner_pod "$evicted")"
if [ -z "$evicted" ] || [ -z "$evicted_pod" ]; then
    bad 'the runner pod to delete is running' "job '$evicted': $(job_brief "$evicted")"
else
    ok 'the runner pod to delete is running'
    await_blocked "$evicted_pod" "$evict_release" && ok 'the evicted agent is blocked at its barrier' || give_up
    deleted_at="$(date +%s)"
    kubectl delete pod "$evicted_pod" -n "$NAMESPACE" --grace-period=5 --wait=false >/dev/null 2>&1
    evicted_mid="$(await_brief "$evicted" "*|1|1|$POD_LOST*" 45)"
    took=$(($(date +%s) - deleted_at))
    case "$evicted_mid" in
    *"|1|1|$POD_LOST"*) [ "$took" -lt $((2 * LANE_LEASE_S)) ] && ok "a deleted runner pod is an interruption (${took}s, inside two ${LANE_LEASE_S}s leases)" ||
        bad 'a deleted runner pod is an interruption inside the lease' "took ${took}s: $evicted_mid" ;;
    *) bad 'a deleted runner pod is an interruption inside the lease' "status|attempts|count|claimSeq|reason: $evicted_mid" ;;
    esac
    release_stub "$evict_release"
    evicted_end="$(await_brief "$evicted" 'succeeded*' 120)"
    case "$evicted_end" in
    "succeeded|1|1|1|$POD_LOST"*) ok 'the next attempt succeeds: one attempt, one interruption' ;;
    *) bad 'the next attempt succeeds: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $evicted_end" ;;
    esac
    expect_contains 'the job output is the second runner pod' "$(job_output "$evicted")" 'released in '
    expect_not_contains 'the deleted pod produced no verdict' "$(job_output "$evicted")" "released in $evicted_pod"
    expect_contains 'the next attempt resumes the session' "$(job_output "$evicted")" "--resume $(job_session "$evicted")"
fi

# d. The driver and its runner lost together: nothing survives to adopt, so the next
#    claim redoes the attempt in a replacement runner — in the lost attempt's session, on its tree.
#    The first runner marks the worktree's git-ignored .factory/ and blocks at its barrier; the
#    replacement finds the mark and ends. Restored, not synced: the origin moves after the first
#    runner synced, and a sync would have moved the tree onto that commit. At max_attempts 1, where
#    an expiry spending an attempt would retire the job dead.
begin_phase recovery-lost-together
lost="$(queue_job "factory-stub-mark factory-stub-wait-$lost_release lost together")"
if [ -n "$lost" ]; then
    capped="$(last_attempt "$lost")" && ok 'the lost-together job runs at max_attempts 1' ||
        bad 'the lost-together job runs at max_attempts 1' "job '$lost': $capped"
fi
lost_pod="$(await_runner_pod "$lost")"
if [ -z "$lost" ] || [ -z "$lost_pod" ]; then
    bad 'the lost-together runner is running' "job '$lost': $(job_brief "$lost")"
else
    ok 'the lost-together runner is running'
    await_blocked "$lost_pod" "$lost_release" && ok 'the lost-together agent is blocked at its barrier' || give_up
    lost_session="$(job_session "$lost")"
    lost_job="$(first_runner_job "$lost")"
    # Before the disruption, while the live driver still heartbeats the lease: the first runner's tree
    # is already synced, and only a replacement that re-synced would move onto this commit.
    advance_origin && ok 'the origin moves after the first runner synced its tree' ||
        bad 'the origin moves after the first runner synced its tree' 'the advance pod did not push'
    kill_driver_pods
    kubectl delete job "$lost_job" -n "$NAMESPACE" --grace-period=0 --force --wait=false >/dev/null 2>&1
    kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
    # A force-deleted driver lives on for a moment, and may see its runner Job deleted and hand the
    # attempt back as that infrastructure loss before its lease is expired here: either is the lost
    # attempt's one interruption, and nothing survives to adopt.
    expired="$(expire_claim_one "$lost")"
    case "$expired" in
    1) lost_reason="$EXPIRED" ;;
    0) lost_reason="$JOB_LOST" ;;
    *) lost_reason='' ;;
    esac
    [ -n "$lost_reason" ] && ok "the lost driver's attempt is released, by its lease or its own report" ||
        bad "the lost driver's attempt is released, by its lease or its own report" "$expired"
    lost_end="$(await_brief "$lost" 'succeeded*' 240)"
    case "$lost_end" in
    # Either release is the one interruption: the dying driver's report can land even after the expiry hit.
    "succeeded|1|1|1|$EXPIRED"* | "succeeded|1|1|1|$JOB_LOST"*) ok 'a replacement runner redoes the lost attempt: one attempt, one interruption' ;;
    *) bad 'a replacement runner redoes the lost attempt: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $lost_end" ;;
    esac
    lost_out="$(job_output "$lost")"
    expect_contains 'the replacement resumes the lost session' "$lost_out" "--resume $lost_session"
    expect_contains 'the replacement runs on the tree the lost runner left' "$lost_out" "mark kept from $lost_pod head: "
    expect_not_contains 'the replacement ran on the restored tree, not a synced one' "$lost_out" 'head: lane-upstream'
    expect_contains 'the replacement driver logs the resumed session' "$(driver_logs)" \
        "job $lost: attempt 1 resuming session $lost_session"
    expect_not_contains 'nothing was adopted' "$(driver_logs)" "job $lost: $ADOPTED"
fi

# e. The driver lost between its agent's exit and its supervisor's end. The pod-IP step
#    channel refuses once the driver is gone, so the supervisor serves on until its orphan bound
#    (30s, inside the lane lease) and only then reports and ends. A second replica is already up; the
#    dead driver's claim is expired inside that bound, so the survivor claims a Job whose agent
#    exited and whose supervisor still runs — the group it must wait out, never sweep.
begin_phase recovery-finalizing
kubectl scale "$DRIVER_DEPLOY" -n "$NAMESPACE" --replicas=2 >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
final="$(queue_job "factory-stub-wait-$final_release finalizing")"
if [ -n "$final" ]; then
    capped="$(last_attempt "$final")" && ok 'the finalizing job runs at max_attempts 1' ||
        bad 'the finalizing job runs at max_attempts 1' "job '$final': $capped"
fi
final_pod="$(await_runner_pod "$final")"
if [ -z "$final" ] || [ -z "$final_pod" ]; then
    bad 'the finalizing runner is running' "job '$final': $(job_brief "$final")"
else
    ok 'the finalizing runner is running'
    await_blocked "$final_pod" "$final_release" && ok 'the finalizing agent is blocked at its barrier' || give_up
    final_job="$(first_runner_job "$final")"
    final_driver=''
    for driver_pod in $(kubectl get pod -l "$DRIVER_SEL" -n "$NAMESPACE" -o name); do
        kubectl logs "$driver_pod" -n "$NAMESPACE" --tail=-1 2>/dev/null | grep "job $final" >/dev/null && final_driver="$driver_pod"
    done
    [ -n "$final_driver" ] && ok 'the driver holding the finalizing job is found' || {
        bad 'the driver holding the finalizing job is found' 'no driver pod logged the job'
        give_up
    }
    kill_driver_pods "$final_driver"
    release_stub "$final_release"
    agent_exit=''
    for _ in $(seq 1 20); do
        agent_exit="$(kubectl get pod "$final_pod" -n "$NAMESPACE" \
            -o jsonpath='{.status.containerStatuses[?(@.name=="agent")].state.terminated.exitCode}' 2>/dev/null)"
        [ -n "$agent_exit" ] && break
        sleep 1
    done
    final_active="$(kubectl get job "$final_job" -n "$NAMESPACE" -o jsonpath='{.status.active}' 2>/dev/null)"
    [ -n "$agent_exit" ] && [ "$final_active" = 1 ] && ok 'the agent exited while its supervisor still finalizes' ||
        bad 'the agent exited while its supervisor still finalizes' "agent exit '$agent_exit', job active '$final_active'"
    expired="$(expire_claim_one "$final")"
    [ "$expired" = 1 ] && ok 'the lost driver lease is expired while the supervisor finalizes' ||
        bad 'the lost driver lease is expired while the supervisor finalizes' "$expired"
    final_end="$(await_brief "$final" 'succeeded*' 240)"
    [ "$final_end" = "succeeded|1|1|1|$EXPIRED" ] &&
        ok 'the surviving driver takes over the run: one attempt, one interruption' ||
        bad 'the surviving driver takes over the run: one attempt, one interruption' \
            "status|attempts|count|claimSeq|reason: $final_end"
    expect_contains 'the adopted output is the finalizing runner pod output' "$(job_output "$final")" \
        "released in $final_pod"
    expect_contains 'the surviving driver logs the takeover' "$(driver_logs)" "job $final: $TOOK_OVER"
fi
kubectl scale "$DRIVER_DEPLOY" -n "$NAMESPACE" --replicas=1 >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1

# f. An executor image the registry does not have (issue #824 D11): the kubelet's own words name
#    the missing manifest, so the group's start is a configuration fault on the first attempt —
#    failed, no interruption refunded, the image named — never a lease burnt down to dead.
begin_phase recovery-unpullable
image_was="$(kubectl get "$DRIVER_DEPLOY" -n "$NAMESPACE" \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="CLAUDE_EXECUTOR_IMAGE")].value}')"
missing="$LANE_REGISTRY/factory-lane-missing:$RELEASE"
kubectl set env "$DRIVER_DEPLOY" -n "$NAMESPACE" "CLAUDE_EXECUTOR_IMAGE=$missing" >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
unpullable="$(queue_job 'factory-stub-unpullable')"
unpullable_end="$(await_brief "$unpullable" 'failed*' 240)"
[ "$unpullable_end" = 'failed|1|0||' ] && ok 'a missing executor image fails the job at once, nothing refunded' ||
    bad 'a missing executor image fails the job at once, nothing refunded' \
        "status|attempts|count|claimSeq|reason: $unpullable_end"
expect_contains 'the failure names the image the registry does not have' "$(job_output "$unpullable")" \
    "the executor image \"$missing\" cannot be pulled"
kubectl set env "$DRIVER_DEPLOY" -n "$NAMESPACE" "CLAUDE_EXECUTOR_IMAGE=$image_was" >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1

# f. Pinned org and workspace skills, on the real kubelet. An admin publishes an org skill and the member a
#    workspace skill; the task's runner pod holds both, installed by the same script and read from the same task volume
#    as the docker executor (the scripted model, the two real CLIs and the cross-member check are scripts/test-jobs.sh's
#    pinned-skills phase). The member then publishes a new version and the runner pod is deleted mid-run: the resumed run
#    reports the sha set the task was made with, not the live one.
begin_phase recovery-skills
skills_release="/task/.lane-skills"
skills_admin_token="fat_$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')"
skills_admin_hash="$(printf '%s' "$skills_admin_token" | openssl dgst -sha256 -hex | sed 's/^.* //')"
skills_admin="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    psql -qtA -v ON_ERROR_STOP=1 -v "org=$member" -v "login=$member-admin" -v "hash=$skills_admin_hash" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
with u as (
    insert into app_user (github_user_id, github_login)
    values ((1000000000 + floor(random() * 1000000000000))::bigint, :'login') returning id
), m as (
    insert into org_membership (org_id, github_login, user_id, role, claimed_at)
    select :'org', :'login', u.id, 'admin', now() from u
), t as (
    insert into access_token (org_id, kind, user_id, created_by, label, token_hash)
    select :'org', 'personal', u.id, u.id, 'test-k8s', decode(:'hash', 'hex') from u
)
select count(*) from u;
SQL
)"
[ "$skills_admin" = 1 ] && ok 'an org admin is minted' || bad 'an org admin is minted' "$skills_admin"
skills_org="$(node "$REPO/scripts/lane-skills.mjs" "$BASE" "$skills_admin_token" /api/org/skills lane-org-skill 'Lane org skill - use it never.' 'ref/helper.txt=org helper')"
skills_ws="$(node "$REPO/scripts/lane-skills.mjs" "$BASE" "$FACTORY_TOKEN" /api/workspace/skills lane-ws-skill 'Lane workspace skill v1 - use it never.' 'ref/helper.txt=workspace helper')"
skills_org_sha="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).sha256))' "$skills_org")"
skills_ws_sha="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).sha256))' "$skills_ws")"
skills_ws_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).id))' "$skills_ws")"
case "$skills_org$skills_ws" in
*'"status":201'*'"status":201'*) ok 'the org skill and the workspace skill are published' ;;
*) bad 'the org skill and the workspace skill are published' "org: $skills_org workspace: $skills_ws" ;;
esac
# the org switches a built-in off before the task is made, so the row carries a hidden built-in whatever the
# earlier phases bound (the connection phase leaves the member a Jira connection, which un-hides factory-jira).
skills_switch() { # skills_switch <true|false> — as the org admin minted above: only an admin manages org skills
    FACTORY_TOKEN="$skills_admin_token" node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "PUT", headers, body: JSON.stringify({ enabled: process.argv[2] === "true" }) })
    .then(async (r) => process.stdout.write(r.status + " " + (await r.text()).slice(0, 160)))
    .catch((e) => process.stdout.write("000 " + e.message));
' "$BASE/api/org/skills/builtin/factory-task-title/enabled" "$1"
}
skills_off="$(skills_switch false)"
case "$skills_off" in
200*) ok 'the org switches a built-in off before the skills task is made' ;;
*) bad 'the org switches a built-in off before the skills task is made' "status and body: $skills_off" ;;
esac
# The checkout holds a skill named like the pinned workspace skill (and two others), so the resumed pod's view
# is built against a real clash.
skills_clash="$(kubectl exec "$RELEASE-origin" -n "$NAMESPACE" -- sh -c "set -e; rm -rf /tmp/clash; git clone -q /origins/$SMOKE_REPO.git /tmp/clash; cd /tmp/clash
for d in .claude/skills/lane-ws-skill .claude/skills/lane-repo-other-claude .agents/skills/lane-repo-other; do mkdir -p \$d; printf '%s\n' '---' \"name: \${d##*/}\" 'description: Lane fixture repo skill - use it never.' '---' 'Nothing to do.' >\$d/SKILL.md; done
git -c user.name=test-k8s -c user.email=test-k8s@localhost add -A; git -c user.name=test-k8s -c user.email=test-k8s@localhost commit -q -m lane-repo-skills; git push -q origin HEAD:main; echo pushed" 2>&1 || true)"
case "$skills_clash" in *pushed*) ok 'the origin ships repo skills named like the workspace skill' ;; *) bad 'the origin ships repo skills named like the workspace skill' "$skills_clash" ;; esac
skills_job="$(queue_job "factory-stub-skills factory-stub-wait-$skills_release pinned skills")"
skills_pod="$(await_runner_pod "$skills_job")"
if [ -z "$skills_job" ] || [ -z "$skills_pod" ]; then
    bad 'the skills runner pod is running' "job '$skills_job': $(job_brief "$skills_job")"
else
    ok 'the skills runner pod is running'
    await_blocked "$skills_pod" "$skills_release" && ok 'the skills agent is blocked at its barrier' || give_up
    # The pin was taken when the task was made: a version published now is not the task's.
    skills_edit="$(node "$REPO/scripts/lane-skills.mjs" "$BASE" "$FACTORY_TOKEN" /api/workspace/skills lane-ws-skill 'Lane workspace skill v2 - use it never.' --id "$skills_ws_id" 'ref/helper.txt=workspace helper')"
    skills_ws_sha2="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).sha256))' "$skills_edit")"
    { [ -n "$skills_ws_sha2" ] && [ "$skills_ws_sha2" != "$skills_ws_sha" ]; } && ok 'the member publishes a new version of the workspace skill' ||
        bad 'the member publishes a new version of the workspace skill' "$skills_edit"
    kubectl delete pod "$skills_pod" -n "$NAMESPACE" --grace-period=5 --wait=false >/dev/null 2>&1
    skills_mid="$(await_brief "$skills_job" "*|1|1|$POD_LOST*" 45)" &&
        ok 'a deleted runner pod is an interruption for a task with pinned skills' ||
        bad 'a deleted runner pod is an interruption for a task with pinned skills' "status|attempts|count|claimSeq|reason: $skills_mid"
    release_stub "$skills_release"
    skills_end="$(await_brief "$skills_job" 'succeeded*' 120)"
    case "$skills_end" in
    "succeeded|1|1|1|$POD_LOST"*) ok 'the resumed run succeeds: one attempt, one interruption' ;;
    *) bad 'the resumed run succeeds: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $skills_end" ;;
    esac
    skills_out="$(job_output "$skills_job")"
    expect_contains 'the resumed run holds the org skill at the pinned sha' "$skills_out" "skills lane-org-skill $skills_org_sha"
    expect_contains 'the resumed run holds the workspace skill at the sha it was made with' "$skills_out" "skills lane-ws-skill $skills_ws_sha"
    expect_not_contains 'the resumed run does not hold the version published after the task was made' "$skills_out" "$skills_ws_sha2"
    # this output is the resumed run's (a new pod, the same row), so the hidden set survives the pod loss.
    expect_contains 'the resumed runner is told to hide the built-in the org switched off' "$skills_out" 'hidden factory-task-title'
    expect_contains "the org skill's helper file opens for the agent" "$skills_out" 'helper lane-org-skill/ref/helper.txt open'
    expect_contains "the workspace skill's helper file opens for the agent" "$skills_out" 'helper lane-ws-skill/ref/helper.txt open'
    # The executors' view builder, run by the stub on the resumed pod against the clashing checkout: the workspace
    # copy is the one entry of its name in both views, and opencode's view still holds the checkout's other skills.
    expect_contains 'the resumed pod links the workspace skill into the claude view' "$skills_out" 'view claude lane-ws-skill /task/.factory/skills-root/.claude/skills/lane-ws-skill'
    expect_contains 'the resumed pod links the workspace skill into the opencode view' "$skills_out" 'view opencode lane-ws-skill /task/.factory/skills-root/.claude/skills/lane-ws-skill'
    skills_view_ws="$(printf '%s\n' "$skills_out" | grep -c '^view opencode lane-ws-skill ' || true)"
    [ "$skills_view_ws" = 1 ] && ok 'the opencode view holds exactly one copy of the workspace skill' || bad 'the opencode view holds exactly one copy of the workspace skill' "$skills_view_ws lines"
    expect_contains "the opencode view still holds the checkout's .agents skill" "$skills_out" '/.agents/skills/lane-repo-other'
    expect_not_contains 'the control: the view builder did not refuse' "$skills_out" 'refused'
fi

# a task whose owner holds no Jira connection (the org admin minted above has none, so nothing binds by
# default) is made with factory-jira hidden: the row's skill_hidden is the stored decision the claim carries. The
# switched-off built-in is the control that the column was read at all.
skills_admin_exec="$(FACTORY_TOKEN="$skills_admin_token" http_status PUT "$BASE/api/workspace/executors" \
    '{"executors":[{"name":"claude","type":"claude-code","config":{}}]}')"
[ "$skills_admin_exec" = 200 ] && ok 'the connection-less admin stores the task executor' || bad 'the connection-less admin stores the task executor' "status $skills_admin_exec"
skills_nojira_job="$(FACTORY_TOKEN="$skills_admin_token" queue_job "factory-stub-skills factory-stub-wait-$skills_release pinned skills")"
skills_nojira_hidden="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    env PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' psql -qtA -v ON_ERROR_STOP=1 -v "job=$skills_nojira_job" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
select coalesce(string_agg(h->>'name', ',' order by h->>'name'), '') from job, jsonb_array_elements(skill_hidden) h where id = :'job';
SQL
)"
expect_contains 'the control: a task with no Jira connection has its stored hidden list read' "$skills_nojira_hidden" 'factory-task-title'
expect_contains 'a task with no Jira connection hides factory-jira' "$skills_nojira_hidden" 'factory-jira'

skills_switch true >/dev/null
for job in $hard $drained $evicted $lost $final $unpullable $skills_job $skills_nojira_job; do
    kubectl delete jobs -l "factory.job=$job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --ignore-not-found --wait=false >/dev/null 2>&1
done
fi
