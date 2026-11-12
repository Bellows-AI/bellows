# The plan committer the services and takeover phases share (issues #773, #829): a plan, or none, lands
# in the member's origin, where the offline board reads it at claim time.
# The gate scripts every plan commits beside it. reach.sh: both names on 127.0.0.1, then a TCP
# connect to each, retried while a service still boots. leave.sh: a background write the gate loop's
# `kill -KILL -1` must stop before the next gate runs (the `isolated` gate checks it never landed).
LANE_REACH="$(
    cat <<'SH'
#!/bin/sh
for name in postgres s3; do
    awk '$1 == "127.0.0.1" { for (i = 2; i <= NF; i++) print $i }' /etc/hosts | grep -x "$name" >/dev/null || {
        echo "$name is not on 127.0.0.1"
        exit 1
    }
done
reach() {
    node -e '
const [host, port] = process.argv.slice(1);
const until = Date.now() + 60000;
const once = () => {
    const socket = require("net").connect(Number(port), host);
    socket.on("connect", () => { console.log(`reached ${host}`); process.exit(0); });
    socket.on("error", (e) => {
        if (Date.now() > until) { console.error(`${host}:${port} ${e.message}`); process.exit(1); }
        setTimeout(once, 1000);
    });
};
once();' "$1" "$2"
}
reach postgres 5432 && reach s3 9000
SH
)"
LANE_LEAVE="$(
    cat <<'SH'
#!/bin/sh
dir="$(pwd)"
(sleep 3; touch "$dir/.lane-forged") >/dev/null 2>&1 &
exit 0
SH
)"

commit_plan() { # commit_plan <label> <.bellows.yaml contents, empty to remove it> -> 0 once committed and pushed
    local plan reach leave script out
    plan="$(printf '%s' "$2" | base64 | tr -d '\n')"
    reach="$(printf '%s\n' "$LANE_REACH" | base64 | tr -d '\n')"
    leave="$(printf '%s\n' "$LANE_LEAVE" | base64 | tr -d '\n')"
    # One line, no double quotes or backslashes: it is interpolated into the JSON override below.
    script="set -e; rm -rf /tmp/plan; git clone -q git://$RELEASE-origin:9418/$SMOKE_REPO.git /tmp/plan;
echo $plan | base64 -d > /tmp/plan/.bellows.yaml;
[ -s /tmp/plan/.bellows.yaml ] || rm -f /tmp/plan/.bellows.yaml;
mkdir -p /tmp/plan/lane; echo $reach | base64 -d > /tmp/plan/lane/reach.sh; echo $leave | base64 -d > /tmp/plan/lane/leave.sh;
git -C /tmp/plan add -A;
git -C /tmp/plan -c user.name=test-k8s -c user.email=test-k8s@localhost commit -q --allow-empty -m lane-plan-$1;
git -C /tmp/plan push -q origin HEAD:main;
echo committed"
    script="$(printf '%s' "$script" | tr '\n' ' ')"
    kubectl run "$RELEASE-plan-$1" -n "$NAMESPACE" --image="$STUB_REF" --restart=Never --command \
        --overrides="$(
            cat <<EOF
{"spec":{"automountServiceAccountToken":false,
"containers":[{"name":"plan","image":"$STUB_REF","imagePullPolicy":"IfNotPresent",
"command":["sh","-c","$script"]}]}}
EOF
        )" -- sh >/dev/null 2>&1
    kubectl wait --for=jsonpath='{.status.phase}'=Succeeded --timeout=180s "pod/$RELEASE-plan-$1" \
        -n "$NAMESPACE" >/dev/null 2>&1
    out="$(kubectl logs "$RELEASE-plan-$1" -n "$NAMESPACE" --all-containers 2>&1 || true)"
    kubectl delete pod "$RELEASE-plan-$1" -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1
    case "$out" in
    *committed*) return 0 ;;
    *) printf '%s' "$out" >&2; return 1 ;;
    esac
}

if selected_phase services; then
begin_phase services
# --- Declared services and gates in the task pod (issue #773) -----------------------------------
#
# The first lane with a `.bellows.yaml` plan. The offline board reads a plan at claim time from the
# origin over git (REPO_CLONE_BASE; server/src/github/local-origin-plan.ts), so `commit_plan`
# commits the file — and the lane's gate scripts under lane/ — to the member's origin. The services are native
# sidecars of the task pod, named on its loopback by hostAliases: the agent (the stub's
# `factory-stub-services`) and the gate container (lane/reach.sh, the stub image as the gate image)
# reach `postgres:5432` and `s3:9000` there by name.

echo
echo '# declared services'


sidecar_restarts() { # sidecar_restarts <pod> <container> -> its restartCount, empty when unread
    kubectl get pod "$1" -n "$NAMESPACE" \
        -o jsonpath="{.status.initContainerStatuses[?(@.name==\"$2\")].restartCount}" 2>/dev/null
}

# Ends the postgres sidecar the way a crash would, but only once it serves: pid 1 is the image's
# entrypoint until postgres is up, and it drops a SIGTERM it has no handler for. TCP, not the socket:
# the init-time server listens on the socket alone. Bounded by wall clock (PG_READY_SECONDS) well
# inside the stub agent's 120s lifetime: an iteration costs at most the 5s request timeout plus 1s.
end_postgres_sidecar() { # end_postgres_sidecar <pod> -> 1 (after a FAIL) when postgres never became ready
    local until=$(($(date +%s) + ${PG_READY_SECONDS:-30}))
    while [ "$(date +%s)" -lt "$until" ]; do
        if kubectl exec "$1" -c svc-postgres -n "$NAMESPACE" --request-timeout=5s -- pg_isready -q -h 127.0.0.1 \
            >/dev/null 2>&1; then
            kubectl exec "$1" -c svc-postgres -n "$NAMESPACE" -- sh -c 'kill 1' >/dev/null 2>&1
            return 0
        fi
        sleep 1
    done
    bad 'the postgres sidecar accepts connections before it is ended' "not ready within ${PG_READY_SECONDS:-30}s"
    return 1
}

LANE_SERVICES="services:
    - name: postgres
      image: postgres:17
      user: \"999:999\"
      environment:
          POSTGRES_PASSWORD: lane
    - name: s3
      image: rustfs/rustfs:1.0.1
      user: \"10001:10001\""
LANE_GATES="environment:
    image: $STUB_REF
    gates:
        - name: reach
          command: sh lane/reach.sh
        - name: leave
          command: sh lane/leave.sh
        - name: isolated
          command: \"sleep 6 && test ! -e .lane-forged\""

commit_plan services "$LANE_SERVICES
$LANE_GATES" && ok 'a plan with declared services and gates is committed' ||
    bad 'a plan with declared services and gates is committed' 'the plan pod did not commit'

# a. Both sides by name: the agent sees both names on 127.0.0.1 and reaches each service there,
#    and the gates (reach, then the isolation pair) pass in the gate sidecar.
begin_phase services-reach
reached="$(queue_job 'factory-stub-change factory-stub-services')"
reached_end="$(await_brief "$reached" 'succeeded*' 420)" && ok 'a run with declared services and gates succeeds' ||
    bad 'a run with declared services and gates succeeds' "status|attempts|count|claimSeq|reason: $reached_end; $(job_output "$reached")"
reached_out="$(job_output "$reached")"
expect_contains 'the agent finds both declared names on 127.0.0.1' "$reached_out" 'postgres s3'
expect_contains 'the agent reaches postgres by name'               "$reached_out" 'reached postgres'
expect_contains 'the agent reaches s3 by name'                     "$reached_out" 'reached s3'
runner_job="$(first_runner_job "$reached")"
pod_spec="$(kubectl get jobs "$runner_job" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec}' 2>/dev/null)"
expect_contains 'the names are the pod’s hostAliases on 127.0.0.1' "$pod_spec" '"ip":"127.0.0.1"'
expect_contains 'the services are svc- sidecars of the task pod'   "$pod_spec" '"name":"svc-postgres"'
expect_not_contains 'no service pod or headless Service is created' \
    "$(kubectl get pods,services -l "factory.job=$reached" -n "$NAMESPACE" -o name 2>/dev/null)" 'service/'

# b. The pre-gate restart: the harness ends postgres while the agent holds; the kubelet brings it
#    back with its restart count past the baseline, so the driver finds it dead before the gates and
#    restarts the fleet by the generation bump — one more kubelet restart — and the gates pass.
begin_phase services-restart
svc_release="/task/.lane-services"
restarted="$(queue_job "factory-stub-change factory-stub-wait-$svc_release services restart")"
restart_pod="$(await_runner_pod "$restarted")"
if [ -z "$restarted" ] || [ -z "$restart_pod" ]; then
    bad 'the restart runner is running' "job '$restarted': $(job_brief "$restarted")"
else
    ok 'the restart runner is running'
    await_blocked "$restart_pod" "$svc_release" && ok 'the restart agent is blocked at its barrier' || give_up
    end_postgres_sidecar "$restart_pod" || give_up
    died=""
    for _ in $(seq 1 60); do
        [ "$(sidecar_restarts "$restart_pod" svc-postgres)" -ge 1 ] 2>/dev/null && {
            died=1
            break
        }
        sleep 1
    done
    [ -n "$died" ] && ok 'the kubelet restarts the ended postgres sidecar' ||
        bad 'the kubelet restarts the ended postgres sidecar' "restartCount $(sidecar_restarts "$restart_pod" svc-postgres)"
    release_stub "$svc_release"
    most=0
    restart_end=""
    for _ in $(seq 1 300); do
        count="$(sidecar_restarts "$restart_pod" svc-postgres)"
        [ -n "$count" ] && [ "$count" -gt "$most" ] 2>/dev/null && most="$count"
        restart_end="$(job_brief "$restarted")"
        case "$restart_end" in succeeded* | failed* | stopped* | dead*) break ;; esac
        sleep 1
    done
    case "$restart_end" in
    succeeded*) ok 'the gates pass after the pre-gate restart' ;;
    *) bad 'the gates pass after the pre-gate restart' "$restart_end; $(job_output "$restarted")" ;;
    esac
    expect_contains 'the verdict notes the restart before the gates' "$(job_output "$restarted")" \
        'restarted before the declared gates'
    [ "$most" -ge 2 ] && ok 'the generation bump restarts the sidecar once more' ||
        bad 'the generation bump restarts the sidecar once more' "restartCount reached $most"
fi

# c. A service that crashes on every start fails the run `services`, naming it — never a run left
#    to wait out the lease.
begin_phase services-crash
commit_plan crash 'services:
    - name: crash
      image: alpine:3' && ok 'a plan with a crashing service is committed' ||
    bad 'a plan with a crashing service is committed' 'the plan pod did not commit'
crashed="$(queue_job 'hello from a crashing fleet')"
crash_end="$(await_brief "$crashed" 'failed*' 900)" && ok 'a crashing service fails the run' ||
    bad 'a crashing service fails the run' "status|attempts|count|claimSeq|reason: $crash_end"
expect_contains 'the failure names the crashing service' "$(job_output "$crashed")" 'service "crash"'

# d. An image the registry does not have, for a service and for the gate (#773 D10): the kubelet's
#    words name the held sidecar, so the group's start is a configuration fault on the first
#    attempt, the role and the image named — never a lease burnt down to dead.
begin_phase services-unpullable
missing_svc="$LANE_REGISTRY/factory-lane-missing-service:$RELEASE"
commit_plan ghost "services:
    - name: ghost
      image: $missing_svc" && ok 'a plan with an unpullable service image is committed' ||
    bad 'a plan with an unpullable service image is committed' 'the plan pod did not commit'
ghost="$(queue_job 'hello from a ghost service')"
ghost_end="$(await_brief "$ghost" 'failed*' 300)"
[ "$ghost_end" = 'failed|1|0||' ] && ok 'a missing service image fails the job at once, nothing refunded' ||
    bad 'a missing service image fails the job at once, nothing refunded' "status|attempts|count|claimSeq|reason: $ghost_end"
expect_contains 'the failure names the service and its image' "$(job_output "$ghost")" \
    "the service \"ghost\" image \"$missing_svc\" cannot be pulled"

missing_gate="$LANE_REGISTRY/factory-lane-missing-gate:$RELEASE"
commit_plan ghost-gate "environment:
    image: $missing_gate
    gates:
        - name: test
          command: \"true\"" && ok 'a plan with an unpullable gate image is committed' ||
    bad 'a plan with an unpullable gate image is committed' 'the plan pod did not commit'
ghost_gate="$(queue_job 'hello from a ghost gate')"
ghost_gate_end="$(await_brief "$ghost_gate" 'failed*' 300)"
[ "$ghost_gate_end" = 'failed|1|0||' ] && ok 'a missing gate image fails the job at once, nothing refunded' ||
    bad 'a missing gate image fails the job at once, nothing refunded' "status|attempts|count|claimSeq|reason: $ghost_gate_end"
expect_contains 'the failure names the gate image' "$(job_output "$ghost_gate")" \
    "the gate image \"$missing_gate\" cannot be pulled"

# e. The reviewer in the task pod (issue #774). A plan declaring a reviewer gives the pod a `reviewer`
#    sidecar. Idle, a task that never asks holds only the configured idle request, measured here on
#    the live pod. Then a task asks for a review and its pod is deleted while the first reviewer holds:
#    the caller is re-claimed, asks the same key again, the review row is re-leased (claim 2), and the
#    verdict reaches the caller from the new pod.
begin_phase services-review
review_idle_release="/task/.lane-review-idle"
commit_plan review 'reviewers:
  - name: audit
    instructions: "Audit the tree. STUB-REVIEW-HOLD-90"
    timeout: 5' && ok 'a plan declaring a reviewer is committed' ||
    bad 'a plan declaring a reviewer is committed' 'the plan pod did not commit'

review_rows() { # review_rows <caller id> -> "status|claim_seq" of each rv-k review row, comma-joined
    kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        psql -qtA -v ON_ERROR_STOP=1 -v "id=$1" postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
select coalesce(string_agg(status || '|' || claim_seq, ','), '') from job where review_of = :'id' and review_key = 'rv-k';
SQL
}
await_review_rows() { # await_review_rows <caller id> <rows> <seconds> -> 0 once the review rows read exactly <rows>
    local until=$(($(date +%s) + $3)) r=''
    while [ "$(date +%s)" -lt "$until" ]; do
        r="$(review_rows "$1")"
        [ "$r" = "$2" ] && return 0
        sleep 1
    done
    printf '%s' "$r"
    return 1
}
review_why() { # review_why <caller id> -> why the review rows ended as they did, for a failure message
    kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        psql -qtA -v ON_ERROR_STOP=1 -v "id=$1" postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
select coalesce(string_agg(coalesce(failure_kind, '-') || ' ' || left(coalesce(output, ''), 600), ' ;; '), '') from job where review_of = :'id' and review_key = 'rv-k';
SQL
}
reviewer_field() { # reviewer_field <pod> <jsonpath under the reviewer init container>
    kubectl get pod "$1" -n "$NAMESPACE" -o jsonpath="{.spec.initContainers[?(@.name==\"reviewer\")]$2}" 2>/dev/null
}

review_idle="$(queue_job "factory-stub-wait-$review_idle_release reviewer idle")"
review_idle_pod="$(await_runner_pod "$review_idle")"
if [ -z "$review_idle" ] || [ -z "$review_idle_pod" ]; then
    bad 'the pod to measure the idle reviewer on is running' "job '$review_idle': $(job_brief "$review_idle")"
else
    await_blocked "$review_idle_pod" "$review_idle_release" && ok 'the idle-reviewer task is blocked at its barrier' || give_up
    idle_cpu="$(reviewer_field "$review_idle_pod" .resources.requests.cpu)"
    idle_mem="$(reviewer_field "$review_idle_pod" .resources.requests.memory)"
    [ -n "$idle_cpu" ] && [ -n "$idle_mem" ] && ok "the reviewer sidecar idles at a request of $idle_cpu / $idle_mem" ||
        bad 'the pod carries a reviewer sidecar with a request' "pod containers: $(kubectl get pod "$review_idle_pod" -n "$NAMESPACE" -o jsonpath='{.spec.initContainers[*].name}')"
    # Usage, when the cluster has a metrics API; the request is the number that is always known. A
    # scrape takes up to 20 s to carry the pod, so poll that long, and not at all without the API.
    idle_top=''
    for _ in $(seq 1 20); do
        top_out="$(kubectl top pod "$review_idle_pod" -n "$NAMESPACE" --containers 2>&1)"
        idle_top="$(awk '$2 == "reviewer" { print $3 " / " $4 }' <<<"$top_out")"
        [ -n "$idle_top" ] && break
        case "$top_out" in *'Metrics API not available'*) break ;; esac
        sleep 1
    done
    echo "MEASURED reviewer idle request: ${idle_cpu:-?} cpu / ${idle_mem:-?} memory; usage: ${idle_top:-no metrics API}"
    release_stub "$review_idle_release"
fi

review_lost='infrastructure loss: the runner pod was deleted'
review_task="$(queue_job 'factory-stub-review lane review')"
review_pod="$(await_runner_pod "$review_task")"
if [ -z "$review_task" ] || [ -z "$review_pod" ]; then
    bad 'the reviewing task pod is running' "job '$review_task': $(job_brief "$review_task")"
else
    ok 'the reviewing task pod is running'
    if rows="$(await_review_rows "$review_task" 'running|1' 240)"; then
        ok 'the review row is created running in the caller pod'
    else
        bad 'the review row is created running in the caller pod' "rows: '$rows'"
    fi
    kubectl delete pod "$review_pod" -n "$NAMESPACE" --grace-period=5 --wait=false >/dev/null 2>&1
    review_mid="$(await_brief "$review_task" "*|1|1|$review_lost*" 60)"
    case "$review_mid" in
    *"|1|1|$review_lost"*) ok 'the pod lost mid-review is an interruption of the caller' ;;
    *) bad 'the pod lost mid-review is an interruption of the caller' "status|attempts|count|claimSeq|reason: $review_mid" ;;
    esac
    review_end="$(await_brief "$review_task" 'succeeded*' 300)"
    case "$review_end" in
    "succeeded|1|1|1|$review_lost"*) ok 'the re-claimed caller completes: one attempt, one interruption' ;;
    *) bad 'the re-claimed caller completes: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $review_end" ;;
    esac
    review_out="$(job_output "$review_task")"
    expect_contains 'the verdict reaches the caller in the new pod' "$review_out" 'verdict":"clean'
    expect_contains 'the reviewer ran as uid 1002'                  "$review_out" 'uid=1002'
    expect_contains 'the reviewer could not write the shared tree'  "$review_out" 'tree-write=denied'
    rows="$(review_rows "$review_task")"
    [ "$rows" = 'succeeded|2' ] && ok 'one review row, re-leased once, succeeded' ||
        bad 'one review row, re-leased once, succeeded' "status|claim_seq: '$rows'; $(review_why "$review_task")"
fi

# The origin carries no plan again: a later phase runs as it always did.
commit_plan restore '' && ok 'the plan is removed again' || bad 'the plan is removed again' 'the plan pod did not commit'
for job in $reached $restarted $crashed $ghost $ghost_gate $review_idle $review_task; do
    kubectl delete jobs -l "factory.job=$job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --ignore-not-found --wait=false >/dev/null 2>&1
done
fi
