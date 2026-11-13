#!/usr/bin/env bash
# The Kubernetes stack, end to end on a local kind cluster.
#
#   scripts/test-k8s.sh              # lint + template only (needs helm)
#   scripts/test-k8s.sh --cluster    # then the real thing (needs a kind cluster running)
#   scripts/test-k8s.sh --cluster --phase recovery # smoke prerequisites + recovery only
#
# Phase one is offline: helm lint, and helm template assertions that the rendered manifests carry
# the security-relevant decisions — credentials by secretKeyRef and never by value, a
# namespace-scoped Role, a runner pod with no service account, and an auth wall that no value can
# take down (the chart always renders AUTH_MODE=github). Phase one also renders an EKS-shaped value
# set: the cluster phase refuses every non-kind context, so the cloud shape is asserted
# where it can be — at render time — and exercised on a real cluster only by the by-hand walk in
# docs/eks-runbook.md. Phase two installs the chart into the
# local cluster with the stub executor image and the code-only no-fetch entry (dashboard.offline)
# behind that same wall, mints a member's personal access token straight into the database, queues
# a job through it, and watches it come back succeeded — real pods, no Claude, no GitHub, and the
# driver authenticating with its board token all the way. Every credential it uses is throwaway,
# generated per run; it never reads the repo's .env.
#
# Everything it creates it removes: two helm releases — the app and the local state it runs against
# (charts/factory-local-state: the database) — and the state's claim. The
# images it pushes stay in the cluster's local registry under a per-run tag, as the layer cache the
# next run's push skips; `make cleanup` removes the registry with the last cluster.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

MODE=''
PHASE=all
phase_requested=''
while [ "$#" -gt 0 ]; do
    case "$1" in
    --cluster|--netpol) [ -z "$MODE" ] || { echo 'choose --cluster or --netpol'; exit 2; }; MODE="$1" ;;
    --phase)
        phase_requested=1
        shift
        PHASE="${1:-}"
        case "$PHASE" in all|smoke|admission|workspace|recovery|services|takeover|control|acceptance|capacity|mcp|drain|bench) ;; *) echo 'invalid --phase'; exit 2 ;; esac
        ;;
    --help)
        echo 'Usage: scripts/test-k8s.sh [--cluster [--phase all|smoke|admission|workspace|recovery|services|takeover|control|acceptance|capacity|mcp|drain|bench] | --netpol]'
        echo 'All cluster phases run smoke prerequisites. The default cluster phase is all, which leaves out drain (it needs a LAYOUT=drain cluster) and bench (an hour or more on an idle host; writes <timings>.bench.tsv).'
        echo 'TIMINGS_FILE overrides artifacts/k8s/<release>.tsv (includes cleanup).'
        exit 0
        ;;
    *) echo "unknown argument: $1"; exit 2 ;;
    esac
    shift
done
if [ -n "$phase_requested" ] && [ "$MODE" != --cluster ]; then
    echo '--phase requires --cluster'
    exit 2
fi
selected_phase() { [ "$PHASE" = all ] || [ "$PHASE" = "$1" ]; }

RELEASE="factory-k8s-test-$(date +%s)"
# The app chart deploys no database; locally the state chart stands in for the managed one. Its
# object names are its release name plus a fixed suffix, so the app release is pointed at them the
# same way values-local.yaml points `dev` at `factory-state`.
STATE_RELEASE="$RELEASE-state"
STATE_SETS=(
    --set "database.url=postgres://factory:factory@$STATE_RELEASE-postgres:5432/factory_dev"
)
# The chart refuses to render without its auth values, and values-local.yaml carries none (they come
# from .env through scripts/k8s-local-values.mjs, which this script deliberately never runs). These
# are throwaway: fake OAuth client, no App. Phase one renders with fixed ones; the cluster phase
# refills AUTH_SETS with per-run random secrets.
SECRET32="$(printf '%032d' 0)"
# The secret store's keys (docs/secrets.md): required on every render, offline included. Phase one uses
# fixed throwaway keys of the right shape; the cluster phase refills them per run.
secret_store_sets() { # secret_store_sets <dataKey> <operationKey> <fingerprintKey> (base64, 32 bytes each) — (re)fills SECRET_STORE_SETS
    SECRET_STORE_SETS=(
        --set secretStore.backend=database
        --set-string "secretStore.dataKeys=k1:$1"
        --set secretStore.activeKeyId=k1
        --set-string "secretStore.operationKey=$2"
        --set-string "secretStore.fingerprintKey=$3"
    )
}
secret_store_sets "$(printf '%032d' 1 | base64)" "$(printf '%032d' 2 | base64)" "$(printf '%032d' 3 | base64)"
auth_sets() { # auth_sets <publicUrl> <sessionSecret> <jobBoardToken> — (re)fills AUTH_SETS (and carries SECRET_STORE_SETS)
    AUTH_SETS=(
        "${SECRET_STORE_SETS[@]}"
        --set "auth.publicUrl=$1"
        --set auth.oauthClientId=client
        --set secret.oauthClientSecret=secret
        --set "secret.sessionSecret=$2"
        --set "secret.jobBoardToken=$3"
    )
}
auth_sets https://factory.example "$SECRET32" "$SECRET32"
# The local profile as the cluster phase installs it: no App, so the code-only no-fetch entry.
LOCAL_SETS=(-f charts/factory/values-local.yaml "${STATE_SETS[@]}" --set dashboard.offline=true)
NAMESPACE="${NAMESPACE:-default}"
DASH_IMAGE="${DASH_IMAGE:-factory-ai}"
DRIVER_IMAGE="${DRIVER_IMAGE:-factory-driver}"
STUB_IMAGE="${STUB_IMAGE:-echo-executor}"
# The cluster phase deploys these refs: pushed to the registry scripts/kind-cluster.sh runs, a fresh
# tag per run so no node ever answers with a previous run's image. One fixed repository per role,
# whatever the *_IMAGE overrides name, so no two roles can share a ref.
LANE_REGISTRY=localhost:5001
DASH_REPO="$LANE_REGISTRY/factory-ai"
DRIVER_REPO="$LANE_REGISTRY/factory-driver"
DASH_REF="$DASH_REPO:$RELEASE"
DRIVER_REF="$DRIVER_REPO:$RELEASE"
STUB_REF="$LANE_REGISTRY/echo-executor:$RELEASE"
# The lane's database image, mirrored through the registry like the collector. Alpine, not the state
# chart's Debian default: a fresh node unpacks a third fewer bytes, and the lane's database is new
# every run, so the musl collation never meets a volume initialised under glibc.
POSTGRES_IMAGE=postgres:17-alpine
POSTGRES_REF="$LANE_REGISTRY/$POSTGRES_IMAGE"

pass=0
fail=0
work="$(mktemp -d)"
TIMINGS_FILE="${TIMINGS_FILE:-$REPO/artifacts/k8s/$RELEASE.tsv}"
mkdir -p "$(dirname "$TIMINGS_FILE")" && printf 'phase\tseconds\n' >"$TIMINGS_FILE" || exit 1
# Beside the phase totals, where the time inside a phase went: each check with the seconds since the
# check (or phase start) before it, and the pods the run started as kubelet saw them (cleanup).
CHECKS_FILE="${TIMINGS_FILE%.tsv}.checks.tsv"
PODS_FILE="${TIMINGS_FILE%.tsv}.pods.tsv"
# And what the processes said, kubelet-timestamped: the smoke driver before recovery replaces it, and
# the first smoke runner, streamed while it runs — the driver reaps a finished runner within seconds.
DRIVER_LOG="${TIMINGS_FILE%.tsv}.driver-smoke.log"
RUNNER_LOG="${TIMINGS_FILE%.tsv}.runner-smoke.log"
printf 'phase\tseconds\tresult\tcheck\n' >"$CHECKS_FILE" || exit 1
. "$REPO/scripts/lane-lib.sh"

save_logs() { # save_logs <label selector> <file> — every container's whole log; bounded, never fatal
    kubectl logs -l "$1" -n "$NAMESPACE" --all-containers --timestamps --prefix --tail=-1 \
        --max-log-requests=50 --request-timeout=20s >"$2" 2>&1 || true
}

lane_collect_evidence() { # lane_collect_evidence <dir> — the first FAIL's bundle: pods, events, every container's log, the job rows
    local dir="$1"
    kubectl get pods,events -n "$NAMESPACE" -o wide --request-timeout=20s >"$dir/kubectl-get.txt" 2>&1
    kubectl describe pods -n "$NAMESPACE" --request-timeout=20s >"$dir/kubectl-describe.txt" 2>&1
    save_logs "app.kubernetes.io/instance=$RELEASE" "$dir/release.log"
    # Every job row of the lane's database, as the board saw it when the check failed.
    bounded 20 kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        env PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' \
        psql -qtA postgres://factory:factory@127.0.0.1:5432/factory_dev \
        -c 'select to_jsonb(j) from job j order by created_at' </dev/null >"$dir/job-rows.jsonl" 2>&1
}

bounded() { # bounded <seconds> <command...> -> the command's status; killed, status 143, past the deadline (kubectl exec's request timeout does not bound a running stream)
    local secs="$1" pid watcher rc
    shift
    "$@" <&0 &
    pid=$!
    { sleep "$secs"; kill "$pid" 2>/dev/null; } >/dev/null 2>&1 &
    watcher=$!
    wait "$pid"
    rc=$?
    kill "$watcher" 2>/dev/null
    wait "$watcher" 2>/dev/null
    return "$rc"
}

cleanup() {
    local status=$?
    begin_phase cleanup
    local pid
    for pid in "${dash_build:-}" "${driver_build:-}" "${stub_build:-}" "${collector_pull:-}"; do
        [ -n "$pid" ] || continue
        kill "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
    done
    if [ -n "${runner_log_pid:-}" ]; then
        kill "$runner_log_pid" 2>/dev/null
        wait "$runner_log_pid" 2>/dev/null
        runner_log_pid=''
    fi
    if [ -n "${control_log_pid:-}" ]; then
        kill "$control_log_pid" 2>/dev/null
        wait "$control_log_pid" 2>/dev/null
        control_log_pid=''
    fi
    if [ -n "${capacity_sampler_pid:-}" ]; then
        kill "$capacity_sampler_pid" 2>/dev/null
        wait "$capacity_sampler_pid" 2>/dev/null
        capacity_sampler_pid=''
    fi
    if [ -n "${bench_sampler_pid:-}" ]; then
        kill "$bench_sampler_pid" 2>/dev/null
        wait "$bench_sampler_pid" 2>/dev/null
        bench_sampler_pid=''
    fi
    if [ -n "${pf_pid:-}" ]; then
        kill "$pf_pid" 2>/dev/null
        wait "$pf_pid" 2>/dev/null
        pf_pid=''
    fi
    # Before anything is uninstalled: events outlive their pods, not their namespace's cleanup.
    if [ -n "${deploy_started_at:-}" ]; then
        # This release's pods and the ones its driver names; bounded, so a stalled read never holds cleanup.
        kubectl get events -n "$NAMESPACE" -o json --request-timeout=20s 2>/dev/null |
            node scripts/k8s-pod-timeline.mjs "$deploy_started_at" \
                "^($RELEASE-|factory-(runner|reclaim|gate|orphan)-)" >"$PODS_FILE" 2>/dev/null
    fi
    if [ "${installed:-}" = '1' ]; then
        helm uninstall "$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1
        # The runner Jobs were created at runtime by the driver, not by the release, so the
        # uninstall leaves them — and their pods — behind. Only this release's: the cluster may
        # host another release in the namespace, and the driver stamps its release label on every
        # runner Job. They go BEFORE the claims: a runner pod that still mounts a
        # claim holds it under pvc-protection, and a waiting claim delete issued first blocks
        # forever on a pod whose delete it never reaches.
        kubectl delete jobs -l "factory.job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" >/dev/null 2>&1
        # The smoke origin pod and Service, and the task volumes the driver created for this
        # release (labelled factory.task-root and the release) — a claim a runner pod
        # still mounts is held under pvc-protection, so they follow the Jobs above.
        kubectl delete pod "$RELEASE-origin" fs-seed fs-probe -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1
        kubectl delete service "$RELEASE-origin" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1
        kubectl delete networkpolicy "$RELEASE-origin-egress" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1
        kubectl delete pvc -l "factory.task-root,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1
    fi
    if [ "${state_installed:-}" = '1' ]; then
        helm uninstall "$STATE_RELEASE" -n "$NAMESPACE" >/dev/null 2>&1
        kubectl delete pvc -l "app.kubernetes.io/instance=$STATE_RELEASE" -n "$NAMESPACE" --wait=false >/dev/null 2>&1
        # Block until the claims are really gone, not just terminating: the next run of this script
        # builds its own releases, and an RWO volume still attached to a dying pod would hold the
        # fresh dashboard pod in Pending for its whole timeout.
        kubectl wait --for=delete pvc -l "app.kubernetes.io/instance=$STATE_RELEASE" \
            -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
    fi
    # A drain still running in the background would re-cordon what is uncordoned next: it goes first.
    if [ -n "${drain_pid:-}" ]; then
        kill "$drain_pid" >/dev/null 2>&1
        wait "$drain_pid" >/dev/null 2>&1
    fi
    # Nodes this run cordoned or drained go back to scheduling.
    for node in $(cat "${cordoned_file:-/dev/null}" 2>/dev/null); do
        kubectl uncordon "$node" --request-timeout=20s >/dev/null 2>&1
    done
    rm -rf "$work"
    end_phase
    printf 'total\t%s\n' "$((SECONDS - lane_started))" >>"$TIMINGS_FILE"
    printf '[timing] total: %ss; timings: %s (beside it: .checks.tsv, .pods.tsv, .driver-smoke.log, .runner-smoke.log); exit: %s\n' \
        "$((SECONDS - lane_started))" "$TIMINGS_FILE" "$status"
}
trap cleanup EXIT

command -v helm >/dev/null || {
    echo 'test-k8s: helm is required'
    exit 1
}

# --- Phase one: offline ----------------------------------------------------------------------

echo '# chart'
begin_phase chart

# Linted with the local profile: the app chart's defaults carry no database.url, which is required,
# and no auth values, which are too.
helm lint charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" >/dev/null 2>&1 && ok 'helm lint passes' ||
    bad 'helm lint passes' "$(helm lint charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" 2>&1 | tail -3)"
helm lint charts/factory-local-state >/dev/null 2>&1 && ok 'helm lint passes on the local state chart' ||
    bad 'helm lint passes on the local state chart' 'lint failed'

# Rendered with the local profile, which is the shape the cluster phase installs: the no-fetch
# entry behind github auth, the state release's database and claim, stub executor.
render() {
    if [ "$#" -eq 0 ] && [ -f "$work/rendered.yaml" ]; then
        cat "$work/rendered.yaml"
        return
    fi
    helm template "$RELEASE" charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --namespace "$NAMESPACE" "$@"
}
render >"$work/rendered.tmp" && mv "$work/rendered.tmp" "$work/rendered.yaml" || {
    echo 'test-k8s: helm template failed'
    exit 1
}

expect_contains 'the driver selects the kubernetes executor'  "$(cat "$work/rendered.yaml")" 'value: kubernetes'
expect_contains 'the driver finds the board by service name'  "$(cat "$work/rendered.yaml")" "value: http://$RELEASE-factory:8080"
expect_contains 'the driver learns its namespace at runtime' "$(cat "$work/rendered.yaml")" 'fieldPath: metadata.namespace'

# Telemetry. The docker runner joins the compose network and its baked `collector:4318` resolves; a
# pod cannot join a network, so the chart ships a collector and names it in every runner spec the
# driver builds — the kubernetes form of RUNNER_NETWORK.
expect_contains 'the chart ships a collector service'         "$(cat "$work/rendered.yaml")" \
    "name: $RELEASE-factory-collector"
expect_contains 'the driver points runners at the in-chart collector' "$(cat "$work/rendered.yaml")" \
    "value: \"http://$RELEASE-factory-collector:4318\""
# The collector's config is rendered, not static: its exporter must target THIS release's dashboard
# ingest route, and the one line whose absence produces a flat 400 is pinned (docs/telemetry.md).
expect_contains 'the collector forwards to the release dashboard' "$(cat "$work/rendered.yaml")" \
    "endpoint: http://$RELEASE-factory:8080/api/otlp"
expect_contains 'the collector exports uncompressed, or the server answers 400' \
    "$(cat "$work/rendered.yaml")" 'compression: none'
# The config must render INSIDE the block scalar: content indented no deeper than the
# `config.yaml:` key (the chart's own 4-space children level) empties the scalar and leaks every
# top-level config key into data as maps — refused only by an install's apiserver validation,
# which helm template never runs. The needle is exactly 4 spaces + receivers:; the correct render
# carries 8.
expect_not_contains 'the collector config stays inside its block scalar' "$(cat "$work/rendered.yaml")" \
    $'\n    receivers:'

# Credentials by reference, checked STRUCTURALLY: the line after every credential env's name must
# be `valueFrom:` — the pod spec carries the reference and never the value, so anything readable in
# `kubectl get -o yaml` stays unreadable to whoever can list pods. (The runner-side half of the same
# rule — the executor reading its credentials from RUNNER_CREDENTIALS_SECRET — is pinned in
# driver/test/k8s/, where the runner spec lives.)
credentials_clean=1
for cred in GITHUB_APP_PRIVATE_KEY GITHUB_OAUTH_CLIENT_SECRET SESSION_SECRET INGEST_TOKEN DATABASE_URL \
    SECRETS_DATA_KEYS SECRETS_OPERATION_KEY SECRETS_FINGERPRINT_KEY; do
    next="$(grep -A1 -- "- name: $cred\$" "$work/rendered.yaml" | sed -n '2p' | tr -d ' ')"
    if [ "$next" = 'valueFrom:' ]; then
        continue
    fi
    credentials_clean=0
    bad "credentials travel by secretKeyRef" "$cred is not read from a Secret (next line: '$next')"
done
[ "$credentials_clean" = '1' ] && ok 'every credential env is a secretKeyRef'

# The secret store's keys reach the dashboard container and nothing else (docs/secrets.md): the
# -secret-store Secret is named only by that container, no SECRETS_ variable is rendered outside the
# dashboard Deployment, and the wait-db init container, driver, collector and runner specs carry none.
secret_store_doc="$(awk '/^# Source:/ { keep = ($0 ~ /templates\/deployment.yaml$/) } keep' "$work/rendered.yaml")"
dashboard_pod="$(awk '/^ +containers:$/ { on = 1 } on' <<<"$secret_store_doc" | awk '/^ +- name: dashboard$/ { on = 1 } /^ +volumes:$/ { on = 0 } on')"
init_pod="$(awk '/^ +containers:$/ { exit } { print }' <<<"$secret_store_doc")"
[ "$(grep -c -- "-secret-store" <<<"$dashboard_pod")" = 3 ] && [ "$(grep -c -- "-secret-store" "$work/rendered.yaml")" = 4 ] &&
    ok 'the secret-store Secret is referenced by the dashboard container alone' ||
    bad 'the secret-store Secret is referenced by the dashboard container alone' \
        "dashboard container: $(grep -c -- "-secret-store" <<<"$dashboard_pod"), whole render: $(grep -c -- "-secret-store" "$work/rendered.yaml")"
[ "$(grep -c 'SECRETS_' "$work/rendered.yaml")" = 5 ] && [ "$(grep -c 'SECRETS_' <<<"$dashboard_pod")" = 5 ] &&
    ok 'no SECRETS_ variable is rendered outside the dashboard container' ||
    bad 'no SECRETS_ variable is rendered outside the dashboard container' \
        "whole render: $(grep -c 'SECRETS_' "$work/rendered.yaml"), dashboard container: $(grep -c 'SECRETS_' <<<"$dashboard_pod")"
expect_not_contains 'the wait-db init container carries no secret-store key' "$init_pod" 'SECRETS_'
expect_contains 'the database backend is selected explicitly' "$dashboard_pod" 'value: "database"'
expect_not_contains 'the secret-store keys are not in a ConfigMap or the collector config' \
    "$(awk '/^# Source:/ { keep = ($0 ~ /configmap|collector/) } keep' "$work/rendered.yaml")" 'SECRETS_'

# The Role is namespace-scoped and no wider than the calls the runner makes: create a Job, read its
# status, delete it, list its pods, read one pod's log. Nothing watches; the jobs rule carries no
# watch, which the exact-verbs assertion pins.
rbac="$(awk '/^# Source: factory\/templates\/driver-rbac.yaml/,/^---/' "$work/rendered.yaml")"
# `list` on jobs and pods is the re-claim fence: its sweep is a collection GET, and a
# collection GET needs the list verb — a rule without it makes every fence round a 403.
expect_contains     'the driver role grants the runner calls' "$rbac" \
    "resources: ['jobs']
      verbs: ['create', 'get', 'delete', 'list', 'patch']"
# The claim env's per-job Secret: create before the Job, delete with it. No `get`, no `list` —
# the driver writes values it was handed and never reads one back.
expect_contains     'the driver role manages the per-job env Secret' "$rbac" \
    "resources: ['secrets']
      verbs: ['create', 'delete', 'patch']"
# The checkout claim that makes the re-claim fence atomic: POSTed to take the checkout, read to
# order the contenders, deleted to release or take over. `get` is safe on ConfigMaps and would not be on secrets — the claim carries no secret
# material.
expect_contains     'the driver role manages the checkout claim' "$rbac" \
    "resources: ['configmaps']
      verbs: ['create', 'get', 'delete']"
# Issue #773: the gate and the declared services are sidecars of the runner Job's pod, so the
# driver creates no pod, no Service and reads no event. Pods are listed to find a Job's pod and
# deleted by the re-claim fence's sweep, nothing more.
expect_contains     'the driver role lists and deletes pods, never creates one' "$rbac" \
    "resources: ['pods']
      verbs: ['delete', 'list']"
# Issue #775: the driver creates one task volume claim per root thread, reads it back and, from the
# slices that follow, deletes it, and labels one no pod can be scheduled onto (patch).
expect_contains     'the driver role manages the task volume claims' "$rbac" \
    "resources: ['persistentvolumeclaims']
      verbs: ['create', 'get', 'list', 'delete', 'patch']"
expect_not_contains 'the driver role creates no Service'    "$rbac" "resources: ['services']"
expect_not_contains 'the driver role reads no event'        "$rbac" "resources: ['events']"
# The gate sidecar's in-place resize: patch on the resize subresource and no more.
expect_contains     'the driver role resizes the gate sidecar' "$rbac" \
    "resources: ['pods/resize']
      verbs: ['patch']"
# Arbitrary exec into a running pod is the one escalation the design never needed: gates run in
# the gate sidecar this driver specs itself, never as exec calls into somebody else's container.
expect_not_contains 'the driver role never execs into pods' "$rbac" 'pods/exec'
expect_not_contains 'the driver role never watches'         "$rbac" 'watch'
# The runner vitals: a read-only get against the metrics API, which the metrics-server serves
# when the cluster runs one — absent it, the driver answers null ("no fresh sample").
expect_contains     'the driver role reads the runner vitals' "$rbac" \
    "apiGroups: ['metrics.k8s.io']
      resources: ['pods']
      verbs: ['get']"
expect_not_contains 'the driver role is never a ClusterRole' "$(cat "$work/rendered.yaml")" 'kind: ClusterRole'

# The dashboard mounts no workspaces claim (it checks nothing out), and the app release creates none of
# its own. The driver is told how to create a thread's task volume, not which claim to
# mount.
expect_not_contains 'the dashboard mounts no workspaces claim' "$(cat "$work/rendered.yaml")" \
    "claimName: $STATE_RELEASE-workspaces"
expect_not_contains 'the dashboard is told no workspace root' "$(cat "$work/rendered.yaml")" 'name: ORG_WORKSPACE_ROOT'
# The offline dashboard reads plans from the origin the driver clones from; the GitHub-backed one reads
# them through the API and is told no base.
base_sets=(--set driver.repoCloneBase=git://origin:9418)
offline_bases="$(render "${base_sets[@]}" | grep -c 'name: REPO_CLONE_BASE')"
[ "$offline_bases" = 2 ] && ok 'the offline dashboard is told the plan origin' ||
    bad 'the offline dashboard is told the plan origin' "REPO_CLONE_BASE rendered $offline_bases times, want 2"
github_bases="$(render "${base_sets[@]}" --set dashboard.offline=false --set github.appId=1 --set github.appPrivateKey=pem | grep -c 'name: REPO_CLONE_BASE')"
[ "$github_bases" = 1 ] && ok 'the GitHub-backed dashboard is told no plan origin' ||
    bad 'the GitHub-backed dashboard is told no plan origin' "REPO_CLONE_BASE rendered $github_bases times, want 1"
expect_not_contains 'the driver is told no workspaces claim' "$(cat "$work/rendered.yaml")" 'name: WORKSPACE_VOLUME'
expect_contains 'the driver is told the task volume access mode' "$(cat "$work/rendered.yaml")" \
    'name: TASK_VOLUME_ACCESS_MODE'
expect_contains 'the driver is told the task volume ttl' "$(cat "$work/rendered.yaml")" \
    "name: TASK_VOLUME_TTL_MS
                        value: \"86400000\""
expect_contains 'the driver is told the task volume bound' "$(cat "$work/rendered.yaml")" \
    "name: TASK_VOLUME_BOUND_MS
                        value: \"604800000\""
expect_contains 'the driver is told the task volume export attempts' "$(cat "$work/rendered.yaml")" \
    "name: TASK_VOLUME_EXPORT_ATTEMPTS
                        value: \"3\""
expect_not_contains 'the app release creates no claim' "$(cat "$work/rendered.yaml")" \
    'kind: PersistentVolumeClaim'

# The service selects the DASHBOARD and only the dashboard. The shared instance labels alone also
# match the driver pod, and a port-forward landing on the driver fails on a missing
# named port — or worse, on a probe against the wrong container.
service_selector="$(awk '/^# Source: factory\/templates\/service.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains    'the service selects the dashboard component' "$service_selector" 'component: dashboard'
expect_not_contains 'the service never selects the driver'       "$service_selector" 'component: driver'

# The gate endpoint is advertised at the driver POD's own IP: a Service name resolves to every
# driver replica — and, mid-rollout, to the old and new pod both — while the ephemeral port the
# driver appends is open on exactly one of them.
expect_contains 'the driver learns its pod IP'             "$(cat "$work/rendered.yaml")" 'fieldPath: status.podIP'
expect_contains 'the runner is told the driver pod IP'     "$(cat "$work/rendered.yaml")" 'value: http://$(POD_IP)'
expect_not_contains 'the chart ships no headless driver Service' "$(cat "$work/rendered.yaml")" 'clusterIP: None'
# The Secret carries the one shared key: the dashboard validates it, the driver presents it.
expect_contains 'the secret renders the shared board secret key' "$(cat "$work/rendered.yaml")" \
    'job-board-token:'
expect_contains 'the driver presents the shared secret' "$(cat "$work/rendered.yaml")" 'key: job-board-token'
# The URL is useless against the default loopback bind: inside the pod, nothing else can reach
# 127.0.0.1. Compose makes the same pairing.
expect_contains 'the gate listener binds all interfaces' "$(cat "$work/rendered.yaml")" 'value: 0.0.0.0'

# Numbers arrive as integers, not whatever helm's float stringifier felt like — a `1.8e+06` here
# would be refused by the driver's own integer check at boot.
render | grep 'value: "7200000"' >/dev/null && ok 'the job timeout renders as an integer' ||
    bad 'the job timeout renders as an integer' "$(render | grep -A1 DRIVER_JOB_TIMEOUT_MS)"
render | grep -A1 'name: GATE_TIMEOUT_MS' | grep 'value: "1800000"' >/dev/null && ok 'the gate timeout renders as an integer' ||
    bad 'the gate timeout renders as an integer' "$(render | grep -A1 GATE_TIMEOUT_MS)"

# The shared admission budgets reach the dashboard: empty is unlimited, a set one is an integer.
render | grep -A1 'name: ADMISSION_MAX_RUNNING$' | grep 'value: ""' >/dev/null && ok 'the admission budget defaults to unlimited' ||
    bad 'the admission budget defaults to unlimited' "$(render | grep -A1 ADMISSION_MAX_RUNNING)"
render --set-string dashboard.admission.maxRunningPerRepo=3 | grep -A1 'name: ADMISSION_MAX_RUNNING_PER_REPO' |
    grep 'value: "3"' >/dev/null && ok 'a per-repo admission budget renders' ||
    bad 'a per-repo admission budget renders' "$(render --set-string dashboard.admission.maxRunningPerRepo=3 | grep -A1 ADMISSION_MAX)"
# The commerce service is off by default; its token is a secretKeyRef, never a plain env value.
render | grep -A1 'name: COMMERCE_ENABLED$' | grep 'value: "false"' >/dev/null && ok 'commerce defaults to off' ||
    bad 'commerce defaults to off' "$(render | grep -A1 COMMERCE_ENABLED)"
render --set dashboard.commerce.enabled=true --set-string dashboard.commerce.url=https://commerce.example/ |
    grep -A1 'name: COMMERCE_URL$' | grep 'value: "https://commerce.example/"' >/dev/null && ok 'the commerce URL renders' ||
    bad 'the commerce URL renders' "$(render --set-string dashboard.commerce.url=https://commerce.example/ | grep -A1 COMMERCE_URL)"
render | grep -A4 'name: COMMERCE_TOKEN$' | grep 'key: commerce-token' >/dev/null && ok 'the commerce token is read from the Secret' ||
    bad 'the commerce token is read from the Secret' "$(render | grep -A4 COMMERCE_TOKEN)"
render --set-string secret.commerceToken=commerce-token-value | grep 'commerce-token: "commerce-token-value"' >/dev/null &&
    ok 'the secret renders the commerce token key' || bad 'the secret renders the commerce token key' 'no commerce-token key'

# Batches are off by default and the chart value renders to BATCHES_ENABLED.
render | grep -A1 'name: BATCHES_ENABLED$' | grep 'value: "false"' >/dev/null && ok 'batches default to off' ||
    bad 'batches default to off' "$(render | grep -A1 BATCHES_ENABLED)"
render --set batches.enabled=true | grep -A1 'name: BATCHES_ENABLED$' | grep 'value: "true"' >/dev/null &&
    ok 'batches.enabled renders BATCHES_ENABLED' ||
    bad 'batches.enabled renders BATCHES_ENABLED' "$(render --set batches.enabled=true | grep -A1 BATCHES_ENABLED)"

# Jira Cloud OAuth (docs/configuration.md): the client id is a plain value, the secret a secretKeyRef; unset, both are
# empty and the board reads Jira as unconfigured.
render --set-string integrations.jira.clientId=atl-client | grep -A1 'name: ATLASSIAN_CLIENT_ID$' |
    grep 'value: "atl-client"' >/dev/null && ok 'the Atlassian client id renders' ||
    bad 'the Atlassian client id renders' "$(render --set-string integrations.jira.clientId=atl-client | grep -A1 ATLASSIAN_CLIENT_ID)"
render | grep -A5 'name: ATLASSIAN_CLIENT_SECRET$' | grep 'key: atlassian-client-secret' >/dev/null &&
    render | grep -A5 'name: ATLASSIAN_CLIENT_SECRET$' | grep 'optional: true' >/dev/null &&
    ok 'the Atlassian client secret is an optional Secret reference' ||
    bad 'the Atlassian client secret is an optional Secret reference' "$(render | grep -A5 ATLASSIAN_CLIENT_SECRET)"
atl_render="$(render --set-string secret.atlassianClientSecret=atl-secret-value 2>&1)"
atl_status=$?
[ "$atl_status" -eq 0 ] && grep -q 'atlassian-client-secret: "atl-secret-value"' <<<"$atl_render" &&
    ok 'the generated Secret renders the Atlassian client secret key' ||
    bad 'the generated Secret renders the Atlassian client secret key' \
        "helm exit $atl_status; $(grep -n 'atlassian-client-secret\|Error' <<<"$atl_render" | sed -n '1,3p')"
render | grep 'atlassian-client-secret: ""' >/dev/null &&
    ok 'the generated Secret renders the Atlassian key empty by default' ||
    bad 'the generated Secret renders the Atlassian key empty by default' 'no atlassian-client-secret key'

# Runner pod resources: requests by default so Karpenter and the Cluster Autoscaler
# can size for the runner fleet — a zero-request pod schedules onto any free pod slot and
# provisions nothing. Limits only when set: a memory limit on an agent run OOM-kills a big build
# mid-work, the requests-only posture the dashboard pod above already carries deliberately.
runner_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the driver forwards the runner cpu request'       "$runner_resources" 'name: RUNNER_CPU_REQUEST'
expect_contains 'the cpu request renders from the chart value'     "$runner_resources" 'value: "500m"'
expect_contains 'the driver forwards the runner memory request'    "$runner_resources" 'name: RUNNER_MEMORY_REQUEST'
expect_contains 'the memory request renders from the chart value'  "$runner_resources" 'value: "1Gi"'
expect_contains 'the driver forwards a default cpu limit (issue #454)' "$runner_resources" 'name: RUNNER_CPU_LIMIT'
expect_contains 'the driver forwards a default memory limit'       "$runner_resources" 'name: RUNNER_MEMORY_LIMIT'
expect_contains 'the memory limit defaults to 8Gi'                 "$runner_resources" 'value: "8Gi"'
unlimited="$(render --set runner.resources.limits=null)"
unlimited_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$unlimited")"
expect_not_contains 'limits: null removes the cpu limit'           "$unlimited_resources" 'RUNNER_CPU_LIMIT'
expect_not_contains 'limits: null removes the memory limit'        "$unlimited_resources" 'RUNNER_MEMORY_LIMIT'
# The namespace LimitRange hands a pod created without limits its defaults.
expect_contains 'a LimitRange renders by default'                  "$(cat "$work/rendered.yaml")" 'kind: LimitRange'
expect_contains 'the LimitRange defaults the container memory limit' "$(cat "$work/rendered.yaml")" 'type: Container'
expect_not_contains 'limitRange.enabled=false renders no LimitRange' "$(render --set limitRange.enabled=false)" 'kind: LimitRange'
limited="$(render --set runner.resources.limits.memory=4Gi)"
limited_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$limited")"
expect_contains 'a configured memory limit forwards'               "$limited_resources" 'name: RUNNER_MEMORY_LIMIT'
expect_contains 'the limit renders as the operator spelled it'     "$limited_resources" 'value: "4Gi"'
emptied="$(render --set runner.resources.requests.cpu= --set runner.resources.requests.memory=)"
emptied_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$emptied")"
expect_not_contains 'empty cpu requests forward nothing'           "$emptied_resources" 'RUNNER_CPU_REQUEST'
expect_not_contains 'empty memory requests forward nothing'        "$emptied_resources" 'RUNNER_MEMORY_REQUEST'
# Gate pod resources: a gate runs the whole suite, so it requests more than a runner.
expect_contains 'the driver forwards the gate cpu request'         "$runner_resources" 'name: GATE_CPU_REQUEST'
# values-local.yaml lowers the gate request to fit one node; the chart default is pinned on the
# EKS shape below, which renders without it.
expect_contains 'the local gate cpu request renders from values-local' "$(grep -A1 'name: GATE_CPU_REQUEST' <<<"$runner_resources")" 'value: "1"'
expect_contains 'the driver forwards the gate memory request'      "$runner_resources" 'name: GATE_MEMORY_REQUEST'
expect_contains 'the local gate memory request renders from values-local' "$(grep -A1 'name: GATE_MEMORY_REQUEST' <<<"$runner_resources")" 'value: "1Gi"'
expect_not_contains 'gate limits default to the runner limits'     "$runner_resources" 'GATE_CPU_LIMIT'
gate_limited="$(render --set runner.gateResources.limits.memory=6Gi)"
gate_limited_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$gate_limited")"
expect_contains 'a configured gate memory limit forwards'          "$gate_limited_resources" 'name: GATE_MEMORY_LIMIT'
expect_contains 'the gate limit renders as the operator spelled it' "$(grep -A1 'name: GATE_MEMORY_LIMIT' <<<"$gate_limited_resources")" 'value: "6Gi"'
gate_unsized="$(render --set runner.gateResources.requests=null)"
gate_unsized_resources="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$gate_unsized")"
expect_not_contains 'gate requests: null forwards no gate cpu request' "$gate_unsized_resources" 'GATE_CPU_REQUEST'
expect_not_contains 'gate requests: null forwards no gate memory request' "$gate_unsized_resources" 'GATE_MEMORY_REQUEST'

# The runner's branch attribution credential is attempt-scoped: the driver mints nothing here and
# forwards no deployment-wide ingest token — the runner presents the job id and lease token of the
# attempt it runs for, forwarded at runtime into the per-attempt runner Secret. The chart must not
# wire RUNNER_INGEST_TOKEN: the driver does not read it, and a deployment-wide ingest token has no
# org binding, which is exactly what branch attribution may not run on.
driver="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' "$work/rendered.yaml")"
if grep -q 'RUNNER_INGEST_TOKEN' <<<"$driver"; then
    bad 'the driver forwards no ingest token' \
        'RUNNER_INGEST_TOKEN is still wired in the rendered driver deployment'
else
    ok 'the driver forwards no ingest token'
fi

# The auth wall is a literal, not a value: the dashboard holds checkouts and serves a route that
# runs shell commands, so there is no open mode to select and no public-bind hatch to except one.
auth_mode_of() { grep -A1 -- '- name: AUTH_MODE$' | sed -n '2p' | tr -d ' '; }
mode="$(auth_mode_of <"$work/rendered.yaml")"
[ "$mode" = 'value:github' ] && ok 'the dashboard renders AUTH_MODE=github' ||
    bad 'the dashboard renders AUTH_MODE=github' "next line after AUTH_MODE: '$mode'"
expect_not_contains 'no AUTH_ALLOW_PUBLIC_BIND renders' "$(cat "$work/rendered.yaml")" 'AUTH_ALLOW_PUBLIC_BIND'
# The removed values are inert: a stale override cannot reopen the board.
if reopened="$(render --set auth.mode=none --set auth.allowPublicBind=true 2>&1)"; then
    mode="$(auth_mode_of <<<"$reopened")"
    [ "$mode" = 'value:github' ] && ok '--set auth.mode=none has no effect' ||
        bad '--set auth.mode=none has no effect' "next line after AUTH_MODE: '$mode'"
    expect_not_contains '--set auth.allowPublicBind=true has no effect' "$reopened" 'AUTH_ALLOW_PUBLIC_BIND'
else
    bad '--set auth.mode=none has no effect' "render failed: ${reopened:0:200}"
fi
# The driver's board token is required: a driver started without it would poll into 401s forever,
# where a missing key fails the pod visibly.
board_ref="$(grep -A1 -- 'key: job-board-token' <<<"$driver")"
if [ -z "$board_ref" ]; then
    bad "the driver's board token ref is not optional" 'no job-board-token ref in the driver deployment'
else
    expect_not_contains "the driver's board token ref is not optional" "$(sed -n '2p' <<<"$board_ref")" 'optional'
fi

# The dashboard pod must not start its server until the database accepts connections: the server's
# migration retry gives up after ~45s and then serves every DB-backed route as a 500 forever — a
# state no amount of client-side polling recovers. On a cold cluster the database image pulls for
# minutes, and a managed database can be mid-failover, so the wait has to live in the pod spec, as
# an init container running pg_isready against the very URL the server reads.
dashboard="$(awk '/^# Source: factory\/templates\/deployment.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the dashboard waits for the database before starting' "$dashboard" \
    'wait-for-database'
expect_contains 'the wait is an init container, not a sidecar' "$dashboard" 'initContainers:'
expect_contains 'the wait probes the URL the server reads' "$dashboard" 'pg_isready -q -d "$DATABASE_URL"'

# Production runs no database in the cluster: the app chart has no database objects to switch on,
# and without a URL it refuses to render rather than boot a server with nowhere to write.
expect_not_contains 'the app chart deploys no database' "$(cat "$work/rendered.yaml")" 'component: postgres'
if helm template "$RELEASE" charts/factory >/dev/null 2>&1; then
    bad 'the app chart refuses to render without database.url' 'helm template succeeded with no database.url'
else
    ok 'the app chart refuses to render without database.url'
fi

# The state chart: one database writer on one claim, held by a StatefulSet so the claim belongs to
# the pod identity and no update can put a second writer on it.
state="$(helm template "$STATE_RELEASE" charts/factory-local-state --namespace "$NAMESPACE")"
expect_contains 'the state chart names the database service'  "$state" "name: $STATE_RELEASE-postgres"
expect_contains 'the state database is a StatefulSet'         "$state" 'kind: StatefulSet'
expect_contains 'the database claim is the set’s own'         "$state" 'volumeClaimTemplates:'
expect_contains 'the set is addressed by the database service' "$state" "serviceName: $STATE_RELEASE-postgres"
expect_contains 'the set runs one writer'                     "$state" '
    replicas: 1
    serviceName:'
# The claim a volumeClaimTemplate mints is named after the template, not the release, so the
# instance label is the only handle `make reset` and this script's cleanup have on it — and a
# volumeClaimTemplate's PVC carries only the labels written in its own metadata. Asserted against
# the template block alone: every other object in this chart renders that label too, so the whole
# document as a haystack would pass with the block deleted.
vct="$(printf '%s\n' "$state" | sed -n '/^    volumeClaimTemplates:/,$p')"
expect_contains 'the database claim is the template’s own'      "$vct" 'name: data'
expect_contains 'the database claim carries the instance label' "$vct" \
    "app.kubernetes.io/instance: $STATE_RELEASE"
# No standalone claim at all. The database's is the set's, so a `kind: PersistentVolumeClaim` would
# mean the old Deployment-era claim came back beside it and helm would delete the data on uninstall again.
claims="$(printf '%s\n' "$state" | grep -c '^kind: PersistentVolumeClaim' || true)"
if [ "$claims" = 0 ]; then
    ok 'the state chart renders no standalone claim'
else
    bad 'the state chart renders no standalone claim' "found $claims"
fi

# --- The review hardening: every item pinned so a revert fails here, not in production ---------

# A complete value set on the chart's own defaults, App included, which is what production renders.
GH_SETS=(
    --set database.url=postgres://u:p@db:5432/factory
    "${AUTH_SETS[@]}"
    --set github.appId=1
    --set github.appPrivateKey=pem
    --set artifacts.s3.bucket=factory-artifacts
    --set artifacts.s3.region=us-east-1
)
gh_render() { helm template "$RELEASE" charts/factory "${GH_SETS[@]}" --namespace "$NAMESPACE" "$@" 2>&1; }
gh="$(gh_render)"

# Images carry a tag: the chart's appVersion by default, so an upgrade to a new build changes the
# pod spec and rolls the pods. The collector is pinned — its config keys move between releases.
app_version="$(awk '/^appVersion:/ { gsub(/[^0-9.]/, "", $2); print $2 }' charts/factory/Chart.yaml)"
expect_contains 'the dashboard image defaults to the appVersion tag' "$gh" "image: factory-ai:$app_version"
expect_contains 'the driver image defaults to the appVersion tag'    "$gh" "image: factory-driver:$app_version"
expect_not_contains 'no chart image is untagged or :latest'           "$gh" 'opentelemetry-collector-contrib:latest'
# A digest in the values reaches the pod spec: tag and digest together, so the tag still reads as the
# version and the digest is what the node resolves. The collector, the one image this chart does not
# build, carries one in the chart's defaults; the local profile blanks it (values-local.yaml).
gh_collector="$(awk '$1 == "image:" && /opentelemetry-collector-contrib/ { print $2; exit }' <<<"$gh")"
if [[ "$gh_collector" =~ :[0-9][^@]*@sha256:[0-9a-f]{64}$ ]]; then
    ok 'the collector image is pinned by digest in the chart defaults'
else
    bad 'the collector image is pinned by digest in the chart defaults' "got '$gh_collector'"
fi
zero_digest="sha256:$(printf '%064d' 0)"
expect_contains 'an image digest is appended to the tag' \
    "$(gh_render --set-string "dashboard.image.digest=$zero_digest")" "image: factory-ai:$app_version@$zero_digest"
expect_not_contains 'a blank digest leaves the tag alone' "$gh" "image: factory-ai:$app_version@"
COLLECTOR_IMAGE="$(awk '$1 == "image:" && /opentelemetry-collector-contrib/ { print $2; exit }' "$work/rendered.yaml")"
COLLECTOR_REF="$LANE_REGISTRY/$COLLECTOR_IMAGE"
case "$COLLECTOR_IMAGE" in
*:[0-9]*) ok 'the collector image is pinned to a version' ;;
*) bad 'the collector image is pinned to a version' "got '$COLLECTOR_IMAGE'" ;;
esac

# A changed Secret or collector config rolls the pods that read it at start.
expect_contains 'pods roll on a Secret change'        "$gh" 'checksum/secret:'
expect_contains 'the collector rolls on a config change' "$gh" 'checksum/config:'

# One dashboard by default, replaced not rolled at any count: no mixed-version rollout coverage
# (deployment.yaml). Above one, the filesystem artifact backend (one pod's /tmp) is refused.
gh_dashboard="$(awk '/^# Source: factory\/templates\/deployment.yaml/,/^---/' <<<"$gh")"
expect_contains 'the dashboard runs one replica by default' "$gh_dashboard" 'replicas: 1'
expect_contains 'the dashboard is recreated, never rolled' "$gh_dashboard" 'type: Recreate'
gh_dashboard_two="$(awk '/^# Source: factory\/templates\/deployment.yaml/,/^---/' <<<"$(gh_render --set dashboard.replicas=2)")"
expect_contains 'dashboard.replicas sets the dashboard replica count' "$gh_dashboard_two" 'replicas: 2'
expect_contains 'two dashboards are still recreated, never rolled' "$gh_dashboard_two" 'type: Recreate'
# Above one, a stopping pod keeps serving while the load balancer drains it; at one there is no
# other pod to drain to, so the sleep would only lengthen the Recreate gap.
expect_contains 'two dashboards drain before SIGTERM' "$gh_dashboard_two" 'seconds: 15'
expect_not_contains 'one dashboard has no drain sleep' "$gh_dashboard" 'preStop:'
expect_contains 'the drain sleep is configurable' \
    "$(gh_render --set dashboard.replicas=2 --set dashboard.preStopSeconds=5)" 'seconds: 5'
# The grace period covers the drain sleep plus the server's 10 s close deadline (server/src/shutdown.ts).
expect_contains 'one dashboard gets the close deadline plus slack' "$gh_dashboard" 'terminationGracePeriodSeconds: 15'
expect_contains 'two dashboards add the drain sleep to the grace period' "$gh_dashboard_two" 'terminationGracePeriodSeconds: 30'
# Readiness is the migrations; liveness is the process. A database outage must not restart-loop.
expect_contains 'the dashboard starts on /api/ready'  "$gh_dashboard" 'startupProbe:'
expect_contains 'readiness reads the migrations'      "$gh_dashboard" 'path: /api/ready'
expect_contains 'liveness reads the process only'     "$gh_dashboard" 'path: /api/health'
expect_contains 'the database wait gives up visibly'  "$gh_dashboard" 'WAIT_TIMEOUT_SECONDS'

# Every chart pod runs unprivileged on a read-only root, and only the driver holds a token.
[ "$(grep -c 'runAsNonRoot: true' <<<"$gh")" -ge 3 ] && ok 'every chart pod runs as non-root' ||
    bad 'every chart pod runs as non-root' "$(grep -c 'runAsNonRoot: true' <<<"$gh") of 3"
[ "$(grep -c 'readOnlyRootFilesystem: true' <<<"$gh")" -ge 4 ] && ok 'every chart container has a read-only root' ||
    bad 'every chart container has a read-only root' "$(grep -c 'readOnlyRootFilesystem: true' <<<"$gh") of 4"
[ "$(grep -c 'automountServiceAccountToken: false' <<<"$gh")" -ge 2 ] &&
    ok 'the dashboard and collector mount no ServiceAccount token' ||
    bad 'the dashboard and collector mount no ServiceAccount token' 'fewer than 2'
gh_driver="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$gh")"
expect_contains 'the driver has a liveness probe'      "$gh_driver" 'livenessProbe:'
expect_contains 'the driver writes the heartbeat it reads' "$gh_driver" 'DRIVER_HEARTBEAT_FILE'
expect_contains 'the driver drains before SIGKILL'     "$gh_driver" 'terminationGracePeriodSeconds: 600'
expect_contains 'the driver hands over a minute before SIGKILL' "$(grep -A1 'name: DRIVER_HANDOVER_MS' <<<"$gh_driver")" 'value: "540000"'
expect_contains 'the driver gives a released group the default rebind grace' "$(grep -A1 'name: DRIVER_REBIND_GRACE_MS' <<<"$gh_driver")" 'value: "240000"'
expect_contains 'the driver keeps the production orphan floor' "$(grep -A1 'name: DRIVER_ORPHAN_MIN_MS' <<<"$gh_driver")" 'value: "30000"'
expect_contains 'the driver keeps the production step long poll' "$(grep -A1 'name: DRIVER_STEP_WAIT_MS' <<<"$gh_driver")" 'value: "15000"'
gh_driver_lane="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$(gh_render --set-string driver.orphanMinMs=10000 --set-string driver.stepWaitMs=2000)")"
expect_contains 'a lane lowers the orphan floor' "$(grep -A1 'name: DRIVER_ORPHAN_MIN_MS' <<<"$gh_driver_lane")" 'value: "10000"'
expect_contains 'a lane lowers the step long poll' "$(grep -A1 'name: DRIVER_STEP_WAIT_MS' <<<"$gh_driver_lane")" 'value: "2000"'
# The driver's scrape listener: on by default behind the board token, and '' turns it off.
expect_contains 'the driver scrape port defaults to 9464' "$(grep -A1 'name: DRIVER_METRICS_PORT' <<<"$gh_driver")" 'value: "9464"'
expect_contains 'the driver names its scrape container port' "$(grep -B1 -A1 'name: metrics' <<<"$gh_driver")" 'containerPort: 9464'
gh_driver_off="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$(gh_render --set driver.metricsPort='')")"
expect_not_contains 'an empty scrape port renders no listener env' "$gh_driver_off" 'DRIVER_METRICS_PORT'
expect_not_contains 'an empty scrape port renders no container port' "$gh_driver_off" 'name: metrics'

# Selectors hold only name/instance/component: they are immutable, so a chart-version label in
# one would make every upgrade an apiserver refusal.
selectors="$(grep -A4 'matchLabels:' <<<"$gh_dashboard$gh_driver")"
expect_not_contains 'selectors carry no version label'  "$selectors" 'app.kubernetes.io/version'
expect_not_contains 'selectors carry no managed-by'     "$selectors" 'managed-by'

# The collector always sends the ingest header by reference: with secret.existingSecret the token
# is in the Secret while telemetry.ingestToken is empty, and a header gated on the value would
# leave an authenticated board answering every export 401.
byo="$(helm template "$RELEASE" charts/factory --set secret.create=false --set secret.existingSecret=mine \
    --set auth.publicUrl=https://f.example --set auth.oauthClientId=c --set github.appId=1 \
    --set artifacts.s3.bucket=factory-artifacts --set artifacts.s3.region=us-east-1 \
    --set secretStore.backend=database --set secretStore.existingSecret=managed-keys --set secretStore.activeKeyId=k1 2>&1)"
expect_contains 'the collector sends the ingest header with a managed Secret' "$byo" \
    'X-Factory-Ingest-Token: ${env:INGEST_TOKEN}'
expect_contains 'a managed Secret is read for the Atlassian client secret' "$byo" 'key: atlassian-client-secret'
expect_not_contains 'a managed Secret is not generated alongside' "$byo" 'atlassian-client-secret: '
# Every dashboard key but database-url is optional, so a missing one reads as the server's own boot
# message; the driver's job-board-token is the exception (pinned above), so 7 rather than 8.
[ "$(grep -c 'optional: true' <<<"$byo")" -ge 7 ] && ok 'managed-Secret keys are optional' ||
    bad 'managed-Secret keys are optional' "$(grep -c 'optional: true' <<<"$byo") optional refs"

# Render-time refusals: half-configured values fail here, not as a crash loop.
refuses() { # refuses <name> <needle> <helm args...>
    local name="$1" needle="$2"
    shift 2
    local out
    if out="$(helm template "$RELEASE" charts/factory "$@" 2>&1)"; then
        bad "$name" 'helm template succeeded'
    else
        expect_contains "$name" "$out" "$needle"
    fi
}
refuses 'a missing publicUrl is refused' 'auth.publicUrl is required' "${GH_SETS[@]}" --set auth.publicUrl=
# The board-hosted MCP server: off by default, https-only when on, origins rendered as one comma list.
mcp_off="$(gh_render)"
expect_contains 'MCP is off by default' "$(grep -A1 'name: MCP_ENABLED$' <<<"$mcp_off")" 'value: "false"'
expect_contains 'no MCP origins render by default' "$(grep -A1 'name: MCP_TRUSTED_ORIGINS$' <<<"$mcp_off")" 'value: ""'
refuses 'MCP over a non-https publicUrl is refused' 'mcp.enabled requires an https auth.publicUrl' \
    "${GH_SETS[@]}" --set-string auth.publicUrl=http://board.example --set mcp.enabled=true
mcp_on="$(gh_render --set-string auth.publicUrl=https://board.example --set mcp.enabled=true \
    --set 'mcp.trustedOrigins={https://a.example,https://b.example}')"
expect_contains 'MCP renders on under an https publicUrl' "$(grep -A1 'name: MCP_ENABLED$' <<<"$mcp_on")" 'value: "true"'
expect_contains 'the trusted origins render as a comma list' "$(grep -A1 'name: MCP_TRUSTED_ORIGINS$' <<<"$mcp_on")" \
    'value: "https://a.example,https://b.example"'
# The deployment mode: self-hosted by default; cloud refuses to render without the telemetry ingest token.
expect_contains 'the deployment mode defaults to self-hosted' "$(grep -A1 'name: DEPLOYMENT_MODE$' <<<"$mcp_off")" \
    'value: "self-hosted"'
refuses 'an unknown deployment mode is refused' 'deploymentMode must be self-hosted or cloud' \
    "${GH_SETS[@]}" --set deploymentMode=saas
refuses 'cloud mode without an ingest token is refused' 'deploymentMode cloud requires telemetry.ingestToken' \
    "${GH_SETS[@]}" --set deploymentMode=cloud --set-string telemetry.ingestToken=
# Cloud also refuses to render with an empty admission cap or Free plan limit: no cloud org is unlimited.
CLOUD_SETS=(--set deploymentMode=cloud --set-string telemetry.ingestToken=ingest-token-for-the-render-test
    --set-string dashboard.admission.maxRunning=20 --set-string dashboard.admission.maxRunningPerOrg=4
    --set-string dashboard.planDefaults.maxRunning=1 --set-string dashboard.planDefaults.maxQueued=10
    --set-string dashboard.planDefaults.maxWallSeconds=3600)
for cap in admission.maxRunning admission.maxRunningPerOrg planDefaults.maxRunning planDefaults.maxQueued \
    planDefaults.maxWallSeconds; do
    refuses "cloud mode with an empty dashboard.$cap is refused" "deploymentMode cloud requires dashboard.$cap" \
        "${GH_SETS[@]}" "${CLOUD_SETS[@]}" --set-string "dashboard.$cap="
done
cloud="$(gh_render "${CLOUD_SETS[@]}")"
expect_contains 'cloud mode renders DEPLOYMENT_MODE' "$(grep -A1 'name: DEPLOYMENT_MODE$' <<<"$cloud")" 'value: "cloud"'
expect_contains 'cloud mode renders the Free plan limits' "$(grep -A1 'name: PLAN_DEFAULT_MAX_QUEUED$' <<<"$cloud")" \
    'value: "10"'
# The artifact store: the dashboard runs as its own ServiceAccount, which carries the IRSA
# annotation, and the s3 backend refuses to render without a bucket.
expect_contains 'the dashboard has its own ServiceAccount' "$gh" "serviceAccountName: $RELEASE-factory-dashboard"
irsa="$(gh_render --set 'dashboard.serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::1:role/factory')"
expect_contains 'the IRSA role annotation lands on the dashboard ServiceAccount' "$irsa" \
    'eks.amazonaws.com/role-arn: arn:aws:iam::1:role/factory'
[ "$(grep -c '^kind: ServiceAccount' <<<"$(gh_render --set dashboard.serviceAccount.create=false)")" -lt \
    "$(grep -c '^kind: ServiceAccount' <<<"$gh")" ] && ok 'serviceAccount.create=false renders no dashboard ServiceAccount' ||
    bad 'serviceAccount.create=false renders no dashboard ServiceAccount' 'the ServiceAccount count did not drop'
expect_contains 'the s3 backend reaches the dashboard as environment' "$gh" 'name: ARTIFACTS_S3_BUCKET'
expect_contains 'the attachment draft TTL reaches the dashboard as environment' "$gh" 'name: ATTACHMENTS_DRAFT_TTL_HOURS'
expect_contains 'a configured attachment draft TTL is rendered' \
    "$(gh_render --set artifacts.attachmentDraftTtlHours=6)" 'value: "6"'
expect_contains 'a credentials Secret becomes the static keys' \
    "$(gh_render --set artifacts.credentialsExistingSecret=store-keys)" 'key: secret-access-key'
expect_not_contains 'no credentials Secret leaves Pod Identity and IRSA to the credential chain' "$gh" 'ARTIFACTS_ACCESS_KEY_ID'
refuses 'an s3 backend with no bucket is refused' 'artifacts.s3.bucket is required' \
    "${GH_SETS[@]}" --set artifacts.s3.bucket=
refuses 'an unknown artifacts backend is refused' 'artifacts.backend must be' \
    "${GH_SETS[@]}" --set artifacts.backend=azure
GCS_SETS=("${GH_SETS[@]}" --set artifacts.backend=gcs --set artifacts.s3.bucket= --set artifacts.s3.region= \
    --set artifacts.gcs.bucket=factory-artifacts-gcs)
gcs_render() { helm template "$RELEASE" charts/factory "${GCS_SETS[@]}" --namespace "$NAMESPACE" "$@" 2>&1; }
gcs="$(gcs_render)"
expect_contains 'the gcs backend reaches the dashboard as environment' "$gcs" 'name: ARTIFACTS_GCS_BUCKET'
expect_contains 'the gcs bucket is rendered' "$gcs" 'value: "factory-artifacts-gcs"'
expect_contains 'the gcs prefix defaults to factory/' "$(grep -A1 'name: ARTIFACTS_GCS_PREFIX$' <<<"$gcs")" 'value: "factory/"'
expect_not_contains 'the gcs backend renders no s3 setting' "$gcs" 'ARTIFACTS_S3_BUCKET'
expect_not_contains 'the gcs backend renders no storage key' "$gcs" 'ARTIFACTS_ACCESS_KEY_ID'
expect_contains 'the Workload Identity annotation lands on the dashboard ServiceAccount' \
    "$(gcs_render --set 'dashboard.serviceAccount.annotations.iam\.gke\.io/gcp-service-account=dash@proj.iam.gserviceaccount.com')" \
    'iam.gke.io/gcp-service-account: dash@proj.iam.gserviceaccount.com'
expect_contains 'the gcs backend renders above one dashboard replica' \
    "$(gcs_render --set dashboard.replicas=2)" 'replicas: 2'
refuses 'a gcs backend with no bucket is refused' 'artifacts.gcs.bucket is required' \
    "${GCS_SETS[@]}" --set artifacts.gcs.bucket=
refuses 'an s3 setting with the gcs backend is refused' 'only valid with artifacts.backend=s3' \
    "${GCS_SETS[@]}" --set artifacts.s3.bucket=leftover
refuses 'a storage key Secret with the gcs backend is refused' 'only valid with artifacts.backend=s3' \
    "${GCS_SETS[@]}" --set artifacts.credentialsExistingSecret=store-keys
refuses 'a gcs setting with the s3 backend is refused' 'only valid with artifacts.backend=gcs' \
    "${GH_SETS[@]}" --set artifacts.gcs.bucket=leftover
refuses 'the filesystem backend is refused above one dashboard replica' \
    'dashboard.replicas above 1 requires artifacts.backend=s3 or gcs' \
    "${GH_SETS[@]}" --set artifacts.backend=filesystem --set dashboard.replicas=2
refuses 'zero dashboard replicas are refused' 'dashboard.replicas must be a whole number of at least 1' \
    "${GH_SETS[@]}" --set dashboard.replicas=0
refuses 'a fractional dashboard replica count is refused' 'dashboard.replicas must be a whole number of at least 1' \
    "${GH_SETS[@]}" --set dashboard.replicas=1.5
refuses 'a drain sleep at or past the grace period is refused' \
    'dashboard.preStopSeconds must be a whole number from 0 below 30 s' \
    "${GH_SETS[@]}" --set dashboard.replicas=2 --set dashboard.preStopSeconds=30
expect_contains 'the filesystem backend renders at one dashboard replica' \
    "$(gh_render --set artifacts.backend=filesystem)" 'kind: Deployment'
refuses 'a missing OAuth client id is refused' 'auth.oauthClientId is required' \
    "${GH_SETS[@]}" --set auth.oauthClientId=
refuses 'a missing OAuth client secret is refused' 'secret.oauthClientSecret is required' \
    "${GH_SETS[@]}" --set secret.oauthClientSecret=
refuses 'a short session secret is refused' 'secret.sessionSecret of at least 32 characters is required' \
    "${GH_SETS[@]}" --set secret.sessionSecret=short
refuses 'a missing board token is refused' 'secret.jobBoardToken of at least 32 characters is required' \
    "${GH_SETS[@]}" --set secret.jobBoardToken=
refuses 'a missing App id is refused unless offline' 'github.appId is required' "${GH_SETS[@]}" --set github.appId=
# Offline waives the App, never the wall: the no-fetch entry still needs every auth value.
refuses 'offline still refuses a missing OAuth client id' 'auth.oauthClientId is required' \
    "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --set auth.oauthClientId=
refuses 'offline still refuses a missing board token' 'secret.jobBoardToken of at least 32 characters is required' \
    "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --set secret.jobBoardToken=
refuses 'no Secret at all is refused' 'secret.existingSecret is empty' "${GH_SETS[@]}" --set secret.create=false
# The secret store's keys are required on every render, the no-fetch entry included.
refuses 'a missing backend is refused' 'secretStore.backend is required' "${GH_SETS[@]}" --set secretStore.backend=
refuses 'an unknown backend is refused' 'secretStore.backend is required' "${GH_SETS[@]}" --set secretStore.backend=nonsense
refuses 'offline still refuses a missing backend' 'secretStore.backend is required' \
    "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --set secretStore.backend=
refuses 'aws settings under the database backend are refused' 'are for secretStore.backend aws' \
    "${GH_SETS[@]}" --set secretStore.aws.region=eu-west-1
refuses 'a missing data key is refused' 'secretStore.dataKeys is required' "${GH_SETS[@]}" --set-string secretStore.dataKeys=
refuses 'a missing active key id is refused' 'secretStore.activeKeyId is required' "${GH_SETS[@]}" --set secretStore.activeKeyId=
refuses 'a missing operation key is refused' 'secretStore.operationKey is required' "${GH_SETS[@]}" --set-string secretStore.operationKey=
refuses 'a missing fingerprint key is refused' 'secretStore.fingerprintKey is required' "${GH_SETS[@]}" --set-string secretStore.fingerprintKey=
refuses 'offline still refuses a missing data key' 'secretStore.dataKeys is required' \
    "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --set-string secretStore.dataKeys=
refuses 'a managed dashboard Secret alone does not cover the secret-store keys' 'secretStore.existingSecret is empty' \
    "${GH_SETS[@]}" --set secret.create=false --set secret.existingSecret=managed
byo_store="$(gh_render --set secretStore.existingSecret=managed-keys --set-string secretStore.dataKeys= --set-string secretStore.operationKey= --set-string secretStore.fingerprintKey=)"
expect_contains 'a managed secret-store Secret is the one the dashboard references' "$byo_store" 'name: managed-keys'
expect_not_contains 'a managed secret-store Secret is not also created' "$byo_store" "name: $RELEASE-factory-secret-store"

# The aws backend (docs/secrets.md): the provider settings reach the dashboard container alone, the Secret
# holds no data key, and workload identity comes from the dashboard ServiceAccount's annotations.
AWS_SETS=(
    --set secretStore.backend=aws --set secretStore.aws.region=eu-west-1 --set secretStore.aws.prefix=factory/test
    --set-string secretStore.dataKeys= --set secretStore.activeKeyId=
)
aws_render="$(gh_render "${AWS_SETS[@]}" --set 'dashboard.serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::000000000000:role/example')"
aws_doc="$(awk '/^# Source:/ { keep = ($0 ~ /templates\/deployment.yaml$/) } keep' <<<"$aws_render")"
aws_dashboard="$(awk '/^ +containers:$/ { on = 1 } on' <<<"$aws_doc" | awk '/^ +- name: dashboard$/ { on = 1 } /^ +volumes:$/ { on = 0 } on')"
expect_contains 'the aws backend is selected explicitly' "$aws_dashboard" 'value: "aws"'
expect_contains 'the dashboard container gets the aws region' "$aws_dashboard" 'value: "eu-west-1"'
expect_contains 'the dashboard container gets the aws prefix' "$aws_dashboard" 'value: "factory/test"'
[ "$(grep -c 'SECRETS_' <<<"$aws_render")" = 5 ] && [ "$(grep -c 'SECRETS_' <<<"$aws_dashboard")" = 5 ] &&
    ok 'every aws-mode SECRETS_ variable is in the dashboard container alone' ||
    bad 'every aws-mode SECRETS_ variable is in the dashboard container alone' \
        "whole render: $(grep -c 'SECRETS_' <<<"$aws_render"), dashboard container: $(grep -c 'SECRETS_' <<<"$aws_dashboard")"
expect_not_contains 'an aws store renders no data-key variable' "$aws_render" 'SECRETS_DATA_KEYS'
expect_not_contains 'an aws store renders no active-key-id variable' "$aws_render" 'SECRETS_ACTIVE_KEY_ID'
expect_not_contains 'an aws store references no data-keys entry' "$aws_render" 'data-keys'
expect_contains 'an aws store still holds the operation and fingerprint keys' "$aws_render" 'fingerprint-key:'
expect_not_contains 'no init container carries a provider setting' "$(awk '/^ +containers:$/ { exit } { print }' <<<"$aws_doc")" 'SECRETS_'
expect_not_contains 'no ConfigMap or collector config carries a provider setting' \
    "$(awk '/^# Source:/ { keep = ($0 ~ /configmap|collector/) } keep' <<<"$aws_render")" 'SECRETS_'
expect_not_contains 'the driver deployment carries no provider setting' \
    "$(awk '/^# Source:/ { keep = ($0 ~ /driver-deployment.yaml$/) } keep' <<<"$aws_render")" 'SECRETS_'
aws_pod_annotations="$(awk '/^ +template:$/ { on = 1 } /^ +spec:$/ { on = 0 } on' <<<"$aws_doc")"
expect_contains 'the IRSA webhook skips the wait-for-database init container, so the role token reaches the dashboard container only' \
    "$aws_pod_annotations" 'eks.amazonaws.com/skip-containers: wait-for-database'
skip_override="$(gh_render "${AWS_SETS[@]}" --set 'podAnnotations.eks\.amazonaws\.com/skip-containers=dashboard' |
    awk '/^# Source:/ { keep = ($0 ~ /templates\/deployment.yaml$/) } keep')"
[ "$(grep -c 'eks.amazonaws.com/skip-containers' <<<"$skip_override")" = 1 ] &&
    expect_contains 'a user pod annotation cannot widen the container exclusion' "$skip_override" 'skip-containers: wait-for-database' ||
    bad 'a user pod annotation cannot widen the container exclusion' 'the key is rendered more than once'
aws_account="$(awk '/^# Source:.*dashboard-serviceaccount.yaml$/ { keep = 1; next } /^# Source:/ { keep = 0 } keep' <<<"$aws_render")"
expect_contains 'the IRSA role rides the dashboard ServiceAccount' "$aws_account" 'eks.amazonaws.com/role-arn'
[ "$(grep -c 'eks.amazonaws.com/role-arn' <<<"$aws_render")" = 1 ] && ok 'the IRSA role is on one ServiceAccount only' ||
    bad 'the IRSA role is on one ServiceAccount only' "found $(grep -c 'eks.amazonaws.com/role-arn' <<<"$aws_render")"
refuses 'an aws store without a region is refused' 'secretStore.aws.region is required' \
    "${GH_SETS[@]}" "${AWS_SETS[@]}" --set secretStore.aws.region=
refuses 'an aws store without a prefix is refused' 'secretStore.aws.prefix is required' \
    "${GH_SETS[@]}" "${AWS_SETS[@]}" --set secretStore.aws.prefix=
refuses 'data keys under the aws backend are refused' 'are for secretStore.backend database' \
    "${GH_SETS[@]}" "${AWS_SETS[@]}" --set-string secretStore.dataKeys=k1:AAAA
refuses 'an aws store without an operation key is refused' 'secretStore.operationKey is required' \
    "${GH_SETS[@]}" "${AWS_SETS[@]}" --set-string secretStore.operationKey=
aws_byo="$(gh_render "${AWS_SETS[@]}" --set secretStore.existingSecret=managed-keys --set-string secretStore.operationKey= --set-string secretStore.fingerprintKey=)"
expect_contains 'a managed secret-store Secret serves the aws backend too' "$aws_byo" 'name: managed-keys'

# The vault backend (docs/secrets.md): the provider settings and the projected Vault token reach the dashboard
# container alone, the Secret holds no data key, and no AWS role is involved.
VAULT_SETS=(
    --set secretStore.backend=vault --set secretStore.vault.addr=https://vault.example.test:8200
    --set secretStore.vault.mount=secret --set secretStore.vault.prefix=factory/test --set secretStore.vault.role=factory
    --set-string secretStore.dataKeys= --set secretStore.activeKeyId=
)
vault_render="$(gh_render "${VAULT_SETS[@]}")"
vault_doc="$(awk '/^# Source:/ { keep = ($0 ~ /templates\/deployment.yaml$/) } keep' <<<"$vault_render")"
vault_dashboard="$(awk '/^ +containers:$/ { on = 1 } on' <<<"$vault_doc" | awk '/^ +- name: dashboard$/ { on = 1 } /^ +volumes:$/ { on = 0 } on')"
expect_contains 'the vault backend is selected explicitly' "$vault_dashboard" 'value: "vault"'
expect_contains 'the dashboard container gets the vault address' "$vault_dashboard" 'value: "https://vault.example.test:8200"'
expect_contains 'the dashboard container gets the vault mount' "$vault_dashboard" 'value: "secret"'
expect_contains 'the dashboard container gets the vault prefix' "$vault_dashboard" 'value: "factory/test"'
expect_contains 'the dashboard container logs in with Kubernetes auth' "$vault_dashboard" 'value: kubernetes'
expect_contains 'the dashboard container gets the vault role' "$vault_dashboard" 'value: "factory"'
expect_contains 'the dashboard container reads the projected token file' "$vault_dashboard" 'value: /var/run/secrets/vault/token'
[ "$(grep -c 'SECRETS_' <<<"$vault_render")" = 9 ] && [ "$(grep -c 'SECRETS_' <<<"$vault_dashboard")" = 9 ] &&
    ok 'every vault-mode SECRETS_ variable is in the dashboard container alone' ||
    bad 'every vault-mode SECRETS_ variable is in the dashboard container alone' \
        "whole render: $(grep -c 'SECRETS_' <<<"$vault_render"), dashboard container: $(grep -c 'SECRETS_' <<<"$vault_dashboard")"
expect_not_contains 'a vault store renders no data-key variable' "$vault_render" 'SECRETS_DATA_KEYS'
expect_not_contains 'a vault store renders no active-key-id variable' "$vault_render" 'SECRETS_ACTIVE_KEY_ID'
expect_not_contains 'a vault store references no data-keys entry' "$vault_render" 'data-keys'
expect_not_contains 'a vault store renders no AWS setting' "$vault_render" 'SECRETS_AWS_'
expect_contains 'a vault store still holds the operation and fingerprint keys' "$vault_render" 'fingerprint-key:'
[ "$(grep -c 'serviceAccountToken:' <<<"$vault_render")" = 1 ] && ok 'one projected service-account token in the whole render' ||
    bad 'one projected service-account token in the whole render' "found $(grep -c 'serviceAccountToken:' <<<"$vault_render")"
expect_contains 'the projected token carries the vault audience' "$vault_doc" 'audience: "vault"'
[ "$(grep -c 'name: vault-token' <<<"$vault_dashboard")" = 1 ] && [ "$(grep -c 'vault-token' <<<"$vault_render")" = 2 ] &&
    ok 'the Vault token volume is mounted in the dashboard container alone' ||
    bad 'the Vault token volume is mounted in the dashboard container alone' \
        "dashboard container: $(grep -c 'name: vault-token' <<<"$vault_dashboard"), whole render: $(grep -c 'vault-token' <<<"$vault_render")"
expect_not_contains 'no init container mounts the Vault token or carries a provider setting' \
    "$(awk '/^ +containers:$/ { exit } { print }' <<<"$vault_doc")" 'vault-token'
expect_not_contains 'no init container carries a vault setting' "$(awk '/^ +containers:$/ { exit } { print }' <<<"$vault_doc")" 'SECRETS_'
expect_not_contains 'no ConfigMap or collector config carries a provider setting' \
    "$(awk '/^# Source:/ { keep = ($0 ~ /configmap|collector/) } keep' <<<"$vault_render")" 'SECRETS_'
vault_driver="$(awk '/^# Source:/ { keep = ($0 ~ /driver-deployment.yaml$/) } keep' <<<"$vault_render")"
expect_not_contains 'the driver deployment carries no vault setting' "$vault_driver" 'SECRETS_'
expect_not_contains 'the driver deployment mounts no Vault token' "$vault_driver" 'vault-token'
expect_not_contains 'the driver deployment projects no service-account token' "$vault_driver" 'serviceAccountToken'
vault_custom="$(gh_render "${VAULT_SETS[@]}" --set secretStore.vault.audience=https://vault.internal)"
expect_contains 'the projected token audience follows secretStore.vault.audience' "$vault_custom" 'audience: "https://vault.internal"'
for field in addr mount prefix role audience; do
    refuses "a vault store without ${field} is refused" "secretStore.vault.${field} is required" \
        "${GH_SETS[@]}" "${VAULT_SETS[@]}" --set "secretStore.vault.${field}="
done
refuses 'data keys under the vault backend are refused' 'are for secretStore.backend database' \
    "${GH_SETS[@]}" "${VAULT_SETS[@]}" --set-string secretStore.dataKeys=k1:AAAA
refuses 'aws settings under the vault backend are refused' 'are for secretStore.backend aws, not vault' \
    "${GH_SETS[@]}" "${VAULT_SETS[@]}" --set secretStore.aws.region=eu-west-1
refuses 'vault settings under the database backend are refused' 'secretStore.vault.* is for secretStore.backend vault, not database' \
    "${GH_SETS[@]}" --set secretStore.vault.addr=https://vault.example.test
refuses 'vault settings under the aws backend are refused' 'secretStore.vault.* is for secretStore.backend vault, not aws' \
    "${GH_SETS[@]}" "${AWS_SETS[@]}" --set secretStore.vault.role=factory
refuses 'a vault store without an operation key is refused' 'secretStore.operationKey is required' \
    "${GH_SETS[@]}" "${VAULT_SETS[@]}" --set-string secretStore.operationKey=
vault_byo="$(gh_render "${VAULT_SETS[@]}" --set secretStore.existingSecret=managed-keys --set-string secretStore.operationKey= --set-string secretStore.fingerprintKey=)"
expect_contains 'a managed secret-store Secret serves the vault backend too' "$vault_byo" 'name: managed-keys'

# The gcp backend (docs/secrets.md): the provider settings reach the dashboard container alone, the Secret holds no
# data key, and no credential is rendered (Workload Identity is the service-account annotation).
GCP_SETS=(
    --set secretStore.backend=gcp --set secretStore.gcp.project=example-project
    --set secretStore.gcp.prefix=acme- --set secretStore.gcp.location=europe-west1
    --set secretStore.gcp.kmsKey=projects/example-project/locations/europe-west1/keyRings/ring/cryptoKeys/key
    --set-string secretStore.dataKeys= --set secretStore.activeKeyId=
)
gcp_render="$(gh_render "${GCP_SETS[@]}")"
gcp_doc="$(awk '/^# Source:/ { keep = ($0 ~ /templates\/deployment.yaml$/) } keep' <<<"$gcp_render")"
gcp_dashboard="$(awk '/^ +containers:$/ { on = 1 } on' <<<"$gcp_doc" | awk '/^ +- name: dashboard$/ { on = 1 } /^ +volumes:$/ { on = 0 } on')"
expect_contains 'the gcp backend is selected explicitly' "$gcp_dashboard" 'value: "gcp"'
expect_contains 'the dashboard container gets the gcp project' "$gcp_dashboard" 'value: "example-project"'
expect_contains 'the dashboard container gets the gcp prefix' "$gcp_dashboard" 'value: "acme-"'
expect_contains 'the dashboard container gets the gcp location' "$gcp_dashboard" 'value: "europe-west1"'
expect_contains 'the dashboard container gets the gcp key' "$gcp_dashboard" 'cryptoKeys/key'
[ "$(grep -c 'SECRETS_' <<<"$gcp_render")" = 7 ] && [ "$(grep -c 'SECRETS_' <<<"$gcp_dashboard")" = 7 ] &&
    ok 'every gcp-mode SECRETS_ variable is in the dashboard container alone' ||
    bad 'every gcp-mode SECRETS_ variable is in the dashboard container alone' \
        "whole render: $(grep -c 'SECRETS_' <<<"$gcp_render"), dashboard container: $(grep -c 'SECRETS_' <<<"$gcp_dashboard")"
expect_not_contains 'a gcp store renders no data-key variable' "$gcp_render" 'SECRETS_DATA_KEYS'
expect_not_contains 'a gcp store renders no active-key-id variable' "$gcp_render" 'SECRETS_ACTIVE_KEY_ID'
expect_not_contains 'a gcp store references no data-keys entry' "$gcp_render" 'data-keys'
expect_not_contains 'a gcp store renders no AWS setting' "$gcp_render" 'SECRETS_AWS_'
expect_not_contains 'a gcp store renders no Vault setting' "$gcp_render" 'SECRETS_VAULT_'
expect_not_contains 'a gcp store renders no credential file variable' "$gcp_render" 'GOOGLE_APPLICATION_CREDENTIALS'
expect_contains 'a gcp store still holds the operation and fingerprint keys' "$gcp_render" 'fingerprint-key:'
expect_not_contains 'no configmap or collector carries a gcp setting' \
    "$(awk '/^# Source:/ { keep = ($0 ~ /configmap|collector/) } keep' <<<"$gcp_render")" 'SECRETS_'
gcp_driver="$(awk '/^# Source:/ { keep = ($0 ~ /driver-deployment.yaml$/) } keep' <<<"$gcp_render")"
expect_not_contains 'the driver deployment carries no gcp setting' "$gcp_driver" 'SECRETS_'
gcp_minimal="$(gh_render --set secretStore.backend=gcp --set secretStore.gcp.project=example-project --set-string secretStore.dataKeys= --set secretStore.activeKeyId=)"
expect_not_contains 'an unset gcp prefix renders no variable, so the app default applies' "$gcp_minimal" 'SECRETS_GCP_PREFIX'
expect_not_contains 'an unset gcp location renders no variable, so the app default applies' "$gcp_minimal" 'SECRETS_GCP_LOCATION'
expect_not_contains 'an unset gcp key renders no variable' "$gcp_minimal" 'SECRETS_GCP_KMS_KEY'
refuses 'a gcp store without a project is refused' 'secretStore.gcp.project is required' \
    "${GH_SETS[@]}" "${GCP_SETS[@]}" --set secretStore.gcp.project=
refuses 'data keys under the gcp backend are refused' 'are for secretStore.backend database' \
    "${GH_SETS[@]}" "${GCP_SETS[@]}" --set-string secretStore.dataKeys=k1:AAAA
refuses 'aws settings under the gcp backend are refused' 'are for secretStore.backend aws, not gcp' \
    "${GH_SETS[@]}" "${GCP_SETS[@]}" --set secretStore.aws.region=eu-west-1
refuses 'vault settings under the gcp backend are refused' 'secretStore.vault.* is for secretStore.backend vault, not gcp' \
    "${GH_SETS[@]}" "${GCP_SETS[@]}" --set secretStore.vault.role=factory
refuses 'gcp settings under the database backend are refused' 'secretStore.gcp.* is for secretStore.backend gcp, not database' \
    "${GH_SETS[@]}" --set secretStore.gcp.project=example-project
refuses 'gcp settings under the aws backend are refused' 'secretStore.gcp.* is for secretStore.backend gcp, not aws' \
    "${GH_SETS[@]}" "${AWS_SETS[@]}" --set secretStore.gcp.prefix=acme-
refuses 'gcp settings under the vault backend are refused' 'secretStore.gcp.* is for secretStore.backend gcp, not vault' \
    "${GH_SETS[@]}" "${VAULT_SETS[@]}" --set secretStore.gcp.location=europe-west1
gcp_byo="$(gh_render "${GCP_SETS[@]}" --set secretStore.existingSecret=managed-keys --set-string secretStore.operationKey= --set-string secretStore.fingerprintKey=)"
expect_contains 'a managed secret-store Secret serves the gcp backend too' "$gcp_byo" 'name: managed-keys'

# --- The optional ingress: off by default, never disagreeing with auth.publicUrl --------

# Off by default in both profiles: the ClusterIP is the perimeter until the operator says
# otherwise (docs/security.md), and the local profile fronts it with a port-forward.
expect_not_contains 'no Ingress renders by default (local profile)' "$(cat "$work/rendered.yaml")" 'kind: Ingress'
expect_not_contains 'no Ingress renders by default (production defaults)' "$gh" 'kind: Ingress'

# On: the Ingress fronts the release's dashboard service — class, annotations, host and tls all
# verbatim from the values, the backend pinned to the Service the driver already uses.
ing="$(gh_render --set ingress.enabled=true --set ingress.className=alb \
    --set 'ingress.hosts={factory.example}' \
    --set 'ingress.tls[0].secretName=factory-tls' --set 'ingress.tls[0].hosts[0]=factory.example' \
    --set 'ingress.annotations.alb\.ingress\.kubernetes\.io/target-type=ip')"
ingress_doc="$(awk '/^# Source: factory\/templates\/ingress.yaml/,/^---/' <<<"$ing")"
expect_contains 'the enabled ingress carries the ingress class' "$ingress_doc" 'ingressClassName: alb'
expect_contains 'the enabled ingress carries the host' "$ingress_doc" 'host: "factory.example"'
expect_contains 'annotations pass through verbatim' "$ingress_doc" 'alb.ingress.kubernetes.io/target-type: ip'
expect_contains 'tls passes through verbatim' "$ingress_doc" 'secretName: factory-tls'
expect_contains 'the ingress backs the dashboard service by name' "$ingress_doc" "service:
                            name: $RELEASE-factory"
expect_contains 'the ingress backs the dashboard port' "$ingress_doc" 'number: 8080'
expect_contains 'the ingress is the dashboard component' "$ingress_doc" 'app.kubernetes.io/component: dashboard'
helm lint charts/factory "${GH_SETS[@]}" --set ingress.enabled=true --set 'ingress.hosts={factory.example}' \
    >/dev/null 2>&1 && ok 'helm lint passes with the ingress enabled' \
    || bad 'helm lint passes with the ingress enabled' 'lint failed'

# The enabled-with-defaults shape: no className, no annotations, no tls keys render at all — an
# empty `ingressClassName: ""` would be an apiserver refusal — and the range covers every host.
bare_ingress="$(gh_render --set ingress.enabled=true --set 'ingress.hosts={factory.example,b.example}' |
    awk '/^# Source: factory\/templates\/ingress.yaml/,/^---/')"
expect_contains     'the ingress renders one rule per host' "$bare_ingress" 'host: "b.example"'
expect_not_contains 'an empty className renders no ingressClassName' "$bare_ingress" 'ingressClassName'
expect_not_contains 'empty annotations render no annotations key' "$bare_ingress" 'annotations:'
expect_not_contains 'empty tls renders no tls key' "$bare_ingress" 'tls:'

# MCP behind the ingress: the OAuth discovery documents (/.well-known/oauth-*) and the endpoint (/api/mcp)
# live on the dashboard service, so the one `/` Prefix rule per host is the whole routing. A second, more specific
# path rule would be a shadow that could send them elsewhere, and a host answering MCP must be the https origin.
mcp_ingress_render="$(gh_render --set-string auth.publicUrl=https://factory.example --set mcp.enabled=true \
    --set ingress.enabled=true --set 'ingress.hosts={factory.example}')"
mcp_ingress="$(awk '/^# Source: factory\/templates\/ingress.yaml/,/^---/' <<<"$mcp_ingress_render")"
expect_contains 'MCP and the ingress render together' "$(grep -A1 'name: MCP_ENABLED$' <<<"$mcp_ingress_render")" 'value: "true"'
[ "$(grep -c -- '- path:' <<<"$mcp_ingress")" = 1 ] && ok 'the MCP ingress has one path rule per host: nothing shadows /.well-known/oauth-* or /api/mcp' ||
    bad 'the MCP ingress has one path rule per host: nothing shadows /.well-known/oauth-* or /api/mcp' "$(grep -- '- path:' <<<"$mcp_ingress")"
expect_contains 'the one rule is the / prefix, which carries /.well-known/oauth-* and /api/mcp' "$mcp_ingress" '- path: /
                    pathType: Prefix'
expect_contains 'the MCP paths reach the dashboard service' "$mcp_ingress" "service:
                            name: $RELEASE-factory"
refuses 'MCP behind an ingress over a non-https publicUrl is refused' 'mcp.enabled requires an https auth.publicUrl' \
    "${GH_SETS[@]}" --set-string auth.publicUrl=http://factory.example --set mcp.enabled=true \
    --set ingress.enabled=true --set 'ingress.hosts={factory.example}'

# The refusals: the hosts list is the authority, and auth.publicUrl must be an origin it answers.
refuses 'an enabled ingress with no hosts is refused' 'ingress.hosts is required when ingress.enabled' \
    "${GH_SETS[@]}" --set ingress.enabled=true
refuses 'an auth.publicUrl the ingress does not answer is refused' 'is not among ingress.hosts' \
    "${GH_SETS[@]}" --set ingress.enabled=true --set 'ingress.hosts={elsewhere.example}'
refuses 'a scheme-less auth.publicUrl is refused under ingress' 'auth.publicUrl must be an absolute origin' \
    "${GH_SETS[@]}" --set auth.publicUrl=factory.example --set ingress.enabled=true \
    --set 'ingress.hosts={factory.example}'
refuses 'a port-forward origin is refused as an ingress host' 'is not among ingress.hosts' \
    "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" --set auth.publicUrl=http://127.0.0.1:18080 \
    --set ingress.enabled=true --set 'ingress.hosts={factory.example}'

# --- The registry prefix: one value, every image the release names ---------------------

# Bare image names are the kind story: `kind load docker-image` side-loads them and IfNotPresent
# resolves. On a remote cluster a bare name resolves to docker.io/library/* and every pod lands in
# ImagePullBackOff — and the executor images reach the driver as opaque env strings, so setting two
# of four values by hand is exactly the half-applied state one prefix value closes. With the
# prefix empty (the default, the local story) the image assertions above pin the verbatim render
# for the chart's own images and the pin below for the executor values, so a prefix that applied
# unconditionally fails here first.
expect_contains 'the executor values render verbatim with no prefix' "$gh" 'value: "claude-executor"'
prefixed="$(gh_render --set global.imageRegistry=ghcr.io/example)"
expect_contains 'the prefix reaches the dashboard image' "$prefixed" \
    "image: ghcr.io/example/factory-ai:$app_version"
expect_contains 'the prefix reaches the driver image' "$prefixed" \
    "image: ghcr.io/example/factory-driver:$app_version"
# The needle is the values.yaml pin verbatim; move it with the pin.
expect_contains 'the prefix reaches the collector image' "$prefixed" \
    'image: ghcr.io/example/otel/opentelemetry-collector-contrib:0.161.0'
expect_contains 'the prefix reaches the claude executor image'   "$prefixed" 'value: "ghcr.io/example/claude-executor"'
expect_contains 'the prefix reaches the opencode executor image' "$prefixed" 'value: "ghcr.io/example/opencode-executor"'
# The exclusion the values comment states: the wait image is a full reference, never prefixed.
expect_contains 'the prefix leaves the database wait image whole' "$prefixed" 'image: postgres:17-alpine'

# A tag on an executor value survives the prefix; tagless reads :latest, which the pinning
# assertions above already refuse for the chart's own images.
tagged="$(gh_render --set global.imageRegistry=ghcr.io/example \
    --set driver.executorImages.claudeCode=claude-executor:v1.2.3)"
expect_contains 'a tag on the executor value survives the prefix' "$tagged" \
    'value: "ghcr.io/example/claude-executor:v1.2.3"'

# The prefix composes with a bare repository only: a value that already names a registry would
# render a double prefix no registry serves. The tag-carrying shape is pinned too — the regex's
# colon rule has to catch it before the tag, not false-positive on the tag itself.
refuses 'an absolute repository is refused under the prefix' 'already names a registry' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example \
    --set dashboard.image.repository=ghcr.io/other/factory-ai
refuses 'a tagged absolute executor value is refused under the prefix' 'already names a registry' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example \
    --set driver.executorImages.claudeCode=ghcr.io/other/claude-executor:v1.2.3
refuses 'a trailing slash on the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example/
refuses 'a pasted URL as the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set global.imageRegistry=https://ghcr.io/example
refuses 'a doubled slash in the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io//example
refuses 'surrounding whitespace on the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set 'global.imageRegistry=ghcr.io/example '
refuses 'an uppercase prefix is refused' 'lowercase registry path' \
    "${GH_SETS[@]}" --set global.imageRegistry=Ghcr.io/Example
refuses 'a scheme:/ typo as the prefix is refused' 'no trailing or doubled slash' \
    "${GH_SETS[@]}" --set global.imageRegistry=https:/ghcr.io/example

# The colon in a prefix is a registry port, not a tag: a bare host:port prefix renders whole.
port="$(gh_render --set global.imageRegistry=registry:5000)"
expect_contains 'a colon-bearing prefix renders as a host port' "$port" \
    "image: registry:5000/factory-ai:$app_version"
# The `:` and `localhost` alternations of the registry rule, pinned like the `.` one above.
refuses 'a host:port repository is refused under the prefix' 'already names a registry' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example \
    --set driver.image.repository=registry:5000/factory-driver
refuses 'a localhost repository is refused under the prefix' 'already names a registry' \
    "${GH_SETS[@]}" --set global.imageRegistry=ghcr.io/example \
    --set driver.image.repository=localhost/factory-driver

# Names stay valid DNS labels however long the release name: truncation leaves room for suffixes.
long="$(helm template "release-name-that-is-deliberately-far-too-long-for-a-dns-label" charts/factory \
    "${GH_SETS[@]}" 2>&1)"
too_long="$(grep -E '^    name: ' <<<"$long" | awk '{ if (length($2) > 63) print $2 }' | grep -v 'admission' || true)"
[ -z "$too_long" ] && ok 'every object name fits a DNS label' || bad 'every object name fits a DNS label' "$too_long"

# Pull secrets reach the chart's pods and every pod the driver specs.
pulled="$(gh_render --set 'imagePullSecrets={regcred}')"
expect_contains 'chart pods name the pull secret'      "$pulled" 'name: "regcred"'
expect_contains 'the driver forwards the pull secret'  "$pulled" 'value: "regcred"'

# The runner group's scheduling knobs: forwarded to the driver as JSON, which is how
# they reach every pod it specs. Unset, nothing renders — an untainted cluster sees the same spec
# as before.
expect_not_contains 'no runner scheduling var renders on defaults' "$gh" 'name: RUNNER_NODE_SELECTOR'
expect_not_contains 'no runner tolerations var renders on defaults' "$gh" 'name: RUNNER_TOLERATIONS'
expect_not_contains 'no runner affinity var renders on defaults' "$gh" 'name: RUNNER_AFFINITY'
scheduled="$(gh_render --set runner.nodeSelector.dedicated=factory-runners \
    --set 'runner.tolerations[0].key=dedicated' --set 'runner.tolerations[0].operator=Equal' \
    --set 'runner.tolerations[0].value=factory-runners' --set 'runner.tolerations[0].effect=NoSchedule' \
    --set 'runner.affinity.podAntiAffinity.preferredDuringSchedulingIgnoredDuringExecution[0].weight=1')"
expect_contains 'the driver is handed the runner node selector as JSON' "$scheduled" \
    'value: "{\"dedicated\":\"factory-runners\"}"'
expect_contains 'the driver is handed the runner tolerations as JSON' "$scheduled" \
    'value: "[{\"effect\":\"NoSchedule\",\"key\":\"dedicated\",\"operator\":\"Equal\",\"value\":\"factory-runners\"}]"'
expect_contains 'the driver is handed the runner affinity as JSON' "$scheduled" 'name: RUNNER_AFFINITY'
expect_contains 'the driver is handed the runner affinity as JSON' "$scheduled" \
    'value: "{\"podAntiAffinity\":{\"preferredDuringSchedulingIgnoredDuringExecution\":[{\"weight\":1}]}}"'

# Dashboard Service annotations: a load balancer's per-Service knobs (a GKE BackendConfig for Cloud
# Armor, NEG settings). None by default.
service_doc() { awk '/^# Source: factory\/templates\/service.yaml/,/^---/' <<<"$1"; }
expect_not_contains 'the dashboard Service carries no annotations by default' "$(service_doc "$gh")" 'annotations:'
printf '%s\n' 'dashboard:' '    service:' '        annotations:' \
    "            cloud.google.com/backend-config: '{\"default\":\"bellows-dashboard\"}'" >"$work/service-annotations.yaml"
annotated="$(gh_render -f "$work/service-annotations.yaml")"
expect_contains 'the dashboard Service carries its annotations' "$(service_doc "$annotated")" \
    'cloud.google.com/backend-config: '"'"'{"default":"bellows-dashboard"}'"'"''

# The runner RuntimeClass: forwarded to the driver and required by admission when set;
# unset, neither renders.
expect_not_contains 'no runner RuntimeClass var renders on defaults' "$gh" 'name: RUNNER_RUNTIME_CLASS'
expect_not_contains 'no RuntimeClass admission rule renders on defaults' "$gh" 'variables.spec.runtimeClassName'
sandboxed="$(gh_render --set runner.runtimeClassName=gvisor)"
expect_contains 'the driver is handed the runner RuntimeClass' "$sandboxed" 'value: "gvisor"'
expect_contains 'admission requires the runner RuntimeClass' "$sandboxed" \
    "variables.spec.runtimeClassName == 'gvisor'"
expect_contains 'the refusal names the RuntimeClass' "$sandboxed" 'runner pods must run under the gvisor RuntimeClass'
refuses 'a RuntimeClass that is no DNS name is refused' 'runner.runtimeClassName must be a RuntimeClass name' \
    "${GH_SETS[@]}" --set "runner.runtimeClassName=gvisor' || true"

# The runner Secret has a key for every forwarded name, valued or not.
runner_secret="$(gh_render --set-string "runner.env=ONE\,TWO" --set runner.credentials.ONE=x)"
expect_contains 'the runner Secret keys every forwarded name' "$runner_secret" 'TWO: ""'

# Isolation. The Role cannot scope by name, so an admission policy bound to the driver's identity
# does: pod specs may reference only per-attempt Secrets, deletes reach only factory.job objects.
admission="$(awk '/^# Source: factory\/templates\/driver-admission.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the admission policy binds the driver identity' "$admission" \
    "system:serviceaccount:$NAMESPACE:$RELEASE-factory-driver"
expect_contains 'the admission policy names the per-attempt Secret pattern' "$admission" \
    '^factory-job-[a-z0-9-]+-env$'
expect_contains 'the admission policy fences deletes by label' "$admission" "'factory.job' in variables.target.metadata.labels"
# The gate sidecar's resize changes the `gate` container alone.
expect_contains 'the admission policy matches the gate resize' "$admission" "operations: ['UPDATE']
              resources: ['pods/resize']"
expect_contains 'the admission policy lets a resize change only the gate' "$admission" "c.name == 'gate'"
# Issue #775: the claim's one update is its unschedulable label (the Role's `patch`), never its spec.
expect_contains 'the admission policy matches the task volume claim update' "$admission" "operations: ['CREATE', 'UPDATE', 'DELETE']
              resources: ['persistentvolumeclaims']"
expect_contains 'the admission policy lets a claim change only its unschedulable label' "$admission" \
    'the driver changes a task volume claim by its unschedulable label alone'
expect_contains 'the admission policy holds a claim spec fixed on update' "$admission" 'object.spec == oldObject.spec'
expect_contains 'the admission policy holds a claim annotations fixed on update' "$admission" \
    '(!has(object.metadata.annotations) || object.metadata.annotations == oldObject.metadata.annotations)'
expect_contains 'the admission policy holds a claim finalizers fixed on update' "$admission" \
    '(!has(object.metadata.finalizers) || object.metadata.finalizers == oldObject.metadata.finalizers)'
expect_contains 'the admission policy holds a claim ownerReferences fixed on update' "$admission" \
    '(!has(object.metadata.ownerReferences) || object.metadata.ownerReferences == oldObject.metadata.ownerReferences)'
expect_not_contains 'the admission policy admits no checkout claim update' "$admission" 'factory.revoked'
# The Role's namespace-wide secrets `patch` reaches only a per-attempt Secret, and only its
# binding key: labels, type and owner kept, no other data key changed.
expect_contains 'the admission policy matches secret updates' "$admission" "operations: ['UPDATE']
              resources: ['secrets']"
expect_contains 'the admission policy lets a Secret update change only its binding' "$admission" \
    "k == 'binding.json'"
expect_contains 'the admission policy words the Secret binding refusal' "$admission" \
    'an attempt Secret update changes only its binding'
expect_contains 'the admission policy denies' "$admission" 'validationActions: [Deny]'
expect_not_contains 'the admission policy never admits the dashboard Secret' "$admission" "$RELEASE-factory-dashboard"
expect_contains 'the admission policy refuses subPathExpr on task volume mounts' "$admission" '!has(m.subPathExpr)'
expect_contains 'the admission policy keeps the reviewer to the credentials Secret' "$admission" \
    'a driver-specced reviewer references the credentials Secret alone'
# A pull secret is for the kubelet only: it may appear under imagePullSecrets, never where a
# container can read it (volumes, env, envFrom).
pulled="$(gh_render --set 'imagePullSecrets={probe-regcred}' |
    awk '/^# Source: factory\/templates\/driver-admission.yaml/,/^---/')"
expect_contains 'the admission policy lets pods pull with a configured pull secret' \
    "$(grep -A1 'name: pullSecrets' <<<"$pulled")" 'probe-regcred'
expect_not_contains 'the admission policy never lets a container read a pull secret' \
    "$(grep -A1 'name: allowed' <<<"$pulled")" 'probe-regcred'
netpol="$(awk '/^# Source: factory\/templates\/runner-networkpolicy.yaml/,/^---/' "$work/rendered.yaml")"
expect_contains 'the runner policy selects this release only' "$netpol" "app.kubernetes.io/instance: $RELEASE"
expect_contains 'the runner policy blocks the metadata endpoint' "$netpol" '169.254.0.0/16'
expect_contains 'the runner policy is both directions' "$netpol" 'policyTypes: [Ingress, Egress]'
expect_contains 'the runner policy sends DNS to kube-dns in kube-system' "$netpol" \
    $'- namespaceSelector:\n                    matchLabels:\n                        kubernetes.io/metadata.name: kube-system\n                podSelector:\n                    matchLabels:\n                        k8s-app: kube-dns'
expect_contains 'the runner policy sends DNS to the NodeLocal DNSCache address' "$netpol" 'cidr: 169.254.20.10/32'
# GKE runs NodeLocal DNSCache as pod-networked node-local-dns pods; Dataplane V2 redirects the
# kube-dns Service address to them, so kube-dns alone leaves runners without DNS.
expect_contains 'the runner policy sends DNS to node-local-dns pods in kube-system' "$netpol" \
    $'- namespaceSelector:\n                    matchLabels:\n                        kubernetes.io/metadata.name: kube-system\n                podSelector:\n                    matchLabels:\n                        k8s-app: node-local-dns'
expect_not_contains 'the runner policy never allows port 53 to any destination' "$netpol" '        - ports:'
# Issue #773: a run's services are on its own pod's loopback, so no runner pod takes a connection
# from anything and none dials another runner pod.
expect_contains 'the runner policy admits no ingress' "$netpol" 'ingress: []'
expect_not_contains 'the runner policy opens no runner-to-runner rule' "$netpol" \
    $'        - to:\n              - podSelector:\n                    matchLabels:\n                        app.kubernetes.io/instance:'

# Issue #382. The hardening the driver sets on every pod is also REQUIRED by admission, which is a
# different control: a driver that silently stopped setting the fields satisfies every "may not be
# privileged" expression and would be admitted. The rendered CEL is pinned here; that a REAL
# apiserver refuses a pod missing each field is phase two, because a policy that renders and does
# not compile refuses everything (failurePolicy: Fail).
expect_contains 'the admission policy requires the RuntimeDefault seccomp profile' "$admission" \
    "variables.spec.securityContext.seccompProfile.type == 'RuntimeDefault'"
expect_contains 'the admission policy requires allowPrivilegeEscalation false' "$admission" \
    'c.securityContext.allowPrivilegeEscalation == false'
# A container-level seccomp profile overrides the pod-level one, so requiring it on the pod alone
# would admit the exact shape it forbids. The needle names the container field, because
# `c.securityContext.seccompProfile` is a SUBSTRING of the pod expression's
# `variables.spec.securityContext.seccompProfile` and would match a template without this rule.
expect_contains 'the admission policy refuses a container-level seccomp override' "$admission" \
    '!has(c.securityContext.seccompProfile)'
expect_contains 'the admission policy requires every capability dropped' "$admission" \
    "'ALL' in c.securityContext.capabilities.drop"
expect_not_contains 'the admission policy exempts no container from the capability drop' "$admission" \
    'factory.unhardened'
# Issue #773: the driver creates pods only through Jobs, no Service at all; a service is a `svc-`
# sidecar of the task pod, named on its loopback by hostAliases.
expect_not_contains 'the admission policy matches no bare pod create' "$admission" "operations: ['CREATE']
              resources: ['pods']"
expect_not_contains 'the admission policy admits no Service' "$admission" 'headless Services'
expect_contains 'the admission policy maps hostAliases only to loopback' "$admission" \
    "variables.spec.hostAliases.all(h, h.ip == '127.0.0.1')"
expect_contains 'the admission policy keeps svc- containers out of the main containers' "$admission" \
    "variables.spec.containers.all(c, !c.name.startsWith('svc-'))"
expect_contains 'the admission policy restarts only the gate, reviewer and svc- sidecars' "$admission" \
    "(c.name == 'gate' || c.name == 'reviewer' || c.name.startsWith('svc-'))"
expect_contains 'the admission policy pins the reviewer to its own uid' "$admission" \
    "c.securityContext.runAsUser == 1002"
expect_contains 'the admission policy lets the reviewer write only its home on the volume' "$admission" \
    "(m.name == 'task' && has(m.subPath) && m.subPath == '.factory/reviewer')"
expect_contains 'the admission policy admits a task volume only whole or at the reviewer home' "$admission" \
    "m.subPath in ['', '.factory/reviewer']"
expect_contains 'the admission policy names a task volume claim for its thread root and generation' "$admission" \
    "'factory-task-' + variables.target.metadata.labels['factory.task-root']"
expect_contains 'the admission policy refuses a ReadWriteMany task volume claim' "$admission" \
    "a in ['ReadWriteOnce', 'ReadWriteOncePod']"
# Issue #814: the one capability add admitted, the agent's launch pair, on a runner Job's agent alone.
expect_contains 'the admission policy admits the launch pair on a runner Job agent alone' "$admission" \
    "request.kind.kind == 'Job' && c.name == 'agent' &&"
expect_contains 'the admission policy admits no capability past the launch pair' "$admission" \
    "c.securityContext.capabilities.add.all(a, a in ['SETUID', 'SETGID'])"

# The chart-pod egress, split per component and port-scoped. A runner reached every port on
# all three before; now the dashboard is its serving port and the collector its two OTLP ports.
# The driver stays portless — the gate endpoint is ephemeral, so no number exists to name — and
# that rule's CONTINUED EXISTENCE is asserted too: dropping it would break every gate run, which
# is a failure no isolation assertion would have caught.
expect_contains 'the runner policy reaches the dashboard on its serving port only' "$netpol" \
    $'app.kubernetes.io/component: dashboard\n          ports:\n              - protocol: TCP\n                port: 8080'
expect_contains 'the runner policy reaches the collector on the OTLP ports only' "$netpol" \
    $'app.kubernetes.io/component: collector\n          ports:\n              - protocol: TCP\n                port: 4317\n              - protocol: TCP\n                port: 4318'
expect_contains 'the runner policy still reaches the driver on any port, for the ephemeral gate endpoint' \
    "$netpol" $'app.kubernetes.io/component: driver\n        - to:'

# Node churn vs long runs. The do-not-disrupt opt-out is off by default in both
# profiles — an undisruptable runner pod pins its node for as long as its job runs — and the
# PDBs are always on: the dashboard drains with at most one unavailable, the driver is protected
# only above one replica, where a single-replica minAvailable would block drains forever.
expect_not_contains 'no do-not-disrupt switch renders by default (local profile)' \
    "$(cat "$work/rendered.yaml")" 'RUNNER_DO_NOT_DISRUPT'
expect_not_contains 'no do-not-disrupt switch renders by default (production defaults)' "$gh" 'RUNNER_DO_NOT_DISRUPT'
dnd="$(gh_render --set driver.runnerDoNotDisrupt=1)"
expect_contains 'the opt-in forwards the do-not-disrupt switch' "$dnd" 'name: RUNNER_DO_NOT_DISRUPT'
expect_contains 'the opt-in carries the value the operator set' "$dnd" 'value: "1"'

[ "$(grep -c 'kind: PodDisruptionBudget' <<<"$(cat "$work/rendered.yaml")")" -eq 1 ] &&
    ok 'the dashboard PDB renders in the local profile' ||
    bad 'the dashboard PDB renders in the local profile' 'expected exactly one PDB'
[ "$(grep -c 'kind: PodDisruptionBudget' <<<"$gh")" -eq 1 ] &&
    ok 'the dashboard PDB renders at the production defaults' ||
    bad 'the dashboard PDB renders at the production defaults' "$(grep -c 'kind: PodDisruptionBudget' <<<"$gh") PDBs"
expect_contains 'the dashboard PDB allows one unavailable' "$gh" 'maxUnavailable: 1'
expect_not_contains 'no driver PDB below two replicas' "$gh" 'minAvailable: 1'
two="$(gh_render --set driver.replicas=2)"
[ "$(grep -c 'kind: PodDisruptionBudget' <<<"$two")" -eq 2 ] &&
    ok 'the driver PDB renders above one replica' ||
    bad 'the driver PDB renders above one replica' "$(grep -c 'kind: PodDisruptionBudget' <<<"$two") PDBs"
expect_contains 'the driver PDB keeps one replica through a drain' "$two" 'minAvailable: 1'
driver_pdb="$(awk '/^# Source: factory\/templates\/pdb.yaml/ { n++ } n == 2 && /^---$/ { exit } n == 2 { print }' <<<"$two")"
expect_contains 'the driver PDB selects the driver component' "$driver_pdb" 'component: driver'
helm lint charts/factory "${GH_SETS[@]}" --set driver.replicas=2 >/dev/null 2>&1 &&
    ok 'helm lint passes above one driver replica' ||
    bad 'helm lint passes above one driver replica' 'lint failed'

# --- The EKS-shaped render lane: the cloud shape, rendered offline ----------------------
#
# The cluster phase refuses every non-kind context on purpose — it deletes runner Jobs — so no
# automated lane ever installs this chart against a cloud cluster. What CAN be asserted without
# one is the value shape an EKS install sets: the same set docs/eks-runbook.md walks by hand, and
# the two must not drift — a mismatch is a bug in one of them. The needles below are read off the
# COMBINED render, every runbook feature in one release, which is itself the assertion: no two
# values the runbook sets may be mutually exclusive. The annotation values go through --set-string,
# where plain --set would parse the JSON-shaped ones as structured data and mangle the render.
EKS_SETS=(
    "${GH_SETS[@]}"
    --set global.imageRegistry=ghcr.io/example
    --set taskVolume.storageClass=ebs-gp3
    --set ingress.enabled=true --set ingress.className=alb
    --set 'ingress.hosts={factory.example}'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/scheme=internet-facing'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/target-type=ip'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/certificate-arn=arn:aws:acm:eu-west-1:000000000000:certificate/00000000-0000-0000-0000-000000000000'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/listen-ports=[{"HTTP":80}\,{"HTTPS":443}]'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/ssl-redirect=443'
    --set-string 'ingress.annotations.alb\.ingress\.kubernetes\.io/healthcheck-path=/api/health'
    --set runner.nodeSelector.dedicated=factory-runners
    --set 'runner.tolerations[0].key=dedicated' --set 'runner.tolerations[0].operator=Equal'
    --set 'runner.tolerations[0].value=factory-runners' --set 'runner.tolerations[0].effect=NoSchedule'
    --set driver.runnerDoNotDisrupt=1
    --set 'isolation.allowedCidrs={10.5.5.5/32}'
)
eks_render() { helm template "$RELEASE" charts/factory "${EKS_SETS[@]}" --namespace "$NAMESPACE" "$@" 2>&1; }

if ! eks="$(eks_render)"; then
    bad 'the EKS-shaped values render as one shape' "${eks:0:400}"
else
    ok 'the EKS-shaped values render as one shape'
fi
# The chart renders no claim of its own; the class reaches the driver, which mints each task volume.
expect_not_contains 'the EKS shape renders no claim' "$eks" 'kind: PersistentVolumeClaim'
expect_contains 'the EKS shape names the EBS task volume class' "$(grep -A1 'name: TASK_VOLUME_STORAGE_CLASS' <<<"$eks")" 'value: "ebs-gp3"'
# The chart's gate request: a gate runs the whole suite, so it requests more than a runner.
expect_contains 'the gate cpu request renders from the chart value' "$(grep -A1 'name: GATE_CPU_REQUEST' <<<"$eks")" 'value: "2"'
expect_contains 'the gate memory request renders from the chart value' "$(grep -A1 'name: GATE_MEMORY_REQUEST' <<<"$eks")" 'value: "2Gi"'
# The registry prefix composes with every image, and the wait image stays whole — the two rules
# the prefix's own block pins separately, pinned together here because the runbook sets both.
expect_contains 'the EKS shape prefixes the dashboard image' "$eks" "image: ghcr.io/example/factory-ai:$app_version"
expect_contains 'the EKS shape prefixes the executor values' "$eks" 'value: "ghcr.io/example/claude-executor"'
expect_contains 'the wait image stays whole under the EKS prefix' "$eks" 'image: postgres:17-alpine'
# The ingress, scoped to its own document: class and the two annotations that carry behaviour
# (where traffic lands, what the ALB health check reads).
eks_ingress="$(awk '/^# Source: factory\/templates\/ingress.yaml/,/^---/' <<<"$eks")"
expect_contains 'the ALB class fronts the EKS ingress' "$eks_ingress" 'ingressClassName: alb'
expect_contains 'the ALB target type routes to pod IPs' "$eks_ingress" 'alb.ingress.kubernetes.io/target-type: ip'
expect_contains 'the ALB healthcheck path is the liveness route' "$eks_ingress" \
    'alb.ingress.kubernetes.io/healthcheck-path: /api/health'
# The runner group's scheduling: the driver is handed the node selector and tolerations as JSON,
# the tainted node group's contract, in the same render that names the storage class.
expect_contains 'the EKS shape hands the driver the runner node selector as JSON' "$eks" \
    'value: "{\"dedicated\":\"factory-runners\"}"'
expect_contains 'the EKS shape hands the driver the runner tolerations as JSON' "$eks" \
    'value: "[{\"effect\":\"NoSchedule\",\"key\":\"dedicated\",\"operator\":\"Equal\",\"value\":\"factory-runners\"}]"'
eks_driver="$(awk '/^# Source: factory\/templates\/driver-deployment.yaml/,/^---/' <<<"$eks")"
# Name and value asserted adjacent: `value: "1"` alone is satisfied by RUNNER_SERVICES' default in
# the same document, so the second needle could never fail on its own.
expect_contains 'the EKS shape forwards the do-not-disrupt switch, value set' "$eks_driver" \
    $'- name: RUNNER_DO_NOT_DISRUPT\n                        value: "1"'
# The VPC-endpoint escape hatch (docs/kubernetes.md, "EKS prerequisites"): a /32 in allowedCidrs
# renders as its own ipBlock beside the except-carving 0.0.0.0/0 rule — the only way a runner
# reaches a private host, and never asserted anywhere until now.
eks_netpol="$(awk '/^# Source: factory\/templates\/runner-networkpolicy.yaml/,/^---/' <<<"$eks")"
expect_contains 'an allowed VPC endpoint cidr reaches the runner policy' "$eks_netpol" 'cidr: 10.5.5.5/32'
# The port scoping survives the cloud value set: an EKS install must not quietly go back to
# reaching every port on the dashboard and collector.
expect_contains 'the EKS shape keeps the dashboard port scoping' "$eks_netpol" \
    $'app.kubernetes.io/component: dashboard\n          ports:'
expect_contains 'the EKS shape keeps the collector OTLP port scoping' "$eks_netpol" \
    $'app.kubernetes.io/component: collector\n          ports:'
# ...and keeps the driver rule PORTLESS. Asserted in the same breath as the two above: the cloud
# shape can drift in either direction, and a driver rule that grew a port list would break every
# gate run on EKS while every port-scoping assertion still passed.
expect_contains 'the EKS shape keeps the driver egress portless for the ephemeral gate endpoint' \
    "$eks_netpol" $'app.kubernetes.io/component: driver\n        - to:'
helm lint charts/factory "${EKS_SETS[@]}" >/dev/null 2>&1 && ok 'helm lint passes on the EKS shape' \
    || bad 'helm lint passes on the EKS shape' 'lint failed'

# --- Phase three: the enforcing-CNI lane -------------------------------------------
#
#   scripts/test-k8s.sh --netpol
#
# Everything the runner NetworkPolicy claims is inert without a CNI that enforces NetworkPolicy,
# and kind's default CNI (kindnet) does NOT enforce it. That makes this the one lane that cannot
# borrow phase two's cluster: an "access denied" assertion against a non-enforcing CNI passes
# while proving nothing, which is strictly worse than having no test. So this lane CREATES its own
# cluster — kindnet disabled, Calico installed — runs an enforcement self-check that fails the
# whole lane if a known-denied address turns out reachable, and deletes the cluster on the way
# out. It never touches the caller's current context or any cluster it did not create, which is
# why phase two's guard (which refuses every context it has not fingerprinted, because it deletes
# Jobs) is left exactly as it was.
#
# This is also the one lane that needs the NETWORK: Calico's manifest and the probe image are
# pulled. Everything else in this file is offline.

if [ "$MODE" = '--netpol' ]; then
    begin_phase netpol
    for tool in kind kubectl docker; do
        command -v "$tool" >/dev/null || {
            echo "test-k8s: $tool is required for the --netpol lane"
            exit 1
        }
    done

    echo
    echo '# enforcing-CNI isolation'

    NETPOL_CLUSTER="factory-netpol-$$"
    NETPOL_KUBECONFIG="$work/netpol.kubeconfig"
    NETPOL_NS=factory-netpol
    # Pinned, not `latest`: a CNI that changed its manifest layout under us would fail this lane
    # with a download error rather than a policy verdict, and the two must never look alike.
    CALICO_VERSION=v3.28.2
    CALICO_URL="https://raw.githubusercontent.com/projectcalico/calico/$CALICO_VERSION/manifests/calico.yaml"

    kn() { kubectl --kubeconfig "$NETPOL_KUBECONFIG" "$@"; }

    # Chained onto the file's own cleanup, never replacing it: that one owns $work (and the
    # releases phase two installs, which this lane never does). A trap that dropped it would leave
    # the work directory behind on every --netpol run.
    netpol_cleanup() { kind delete cluster --name "$NETPOL_CLUSTER" >/dev/null 2>&1 || true; }
    trap 'netpol_cleanup; cleanup' EXIT

    cat >"$work/kind-netpol.yaml" <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
    # The whole point of this lane. kindnet ships with kind and does not enforce NetworkPolicy, so
    # it is turned off and Calico installed in its place; until Calico is up the cluster has no pod
    # network at all, which is why the node readiness wait below is not optional.
    disableDefaultCNI: true
    podSubnet: "192.168.0.0/16"
EOF
    echo "creating kind cluster $NETPOL_CLUSTER (no default CNI)"
    kind create cluster --name "$NETPOL_CLUSTER" --kubeconfig "$NETPOL_KUBECONFIG" \
        --config "$work/kind-netpol.yaml" >/dev/null 2>&1 || {
        echo 'test-k8s: could not create the kind cluster for the --netpol lane'
        exit 1
    }

    echo "installing Calico $CALICO_VERSION"
    kn apply -f "$CALICO_URL" >/dev/null 2>&1 || {
        echo "test-k8s: could not apply the Calico manifest ($CALICO_URL) — this lane needs network"
        exit 1
    }
    kn wait --for=condition=Ready node --all --timeout=300s >/dev/null 2>&1 || {
        echo 'test-k8s: nodes never became Ready — Calico did not come up'
        exit 1
    }
    kn wait --for=condition=Available deployment/calico-kube-controllers -n kube-system \
        --timeout=300s >/dev/null 2>&1 || true

    kn create namespace "$NETPOL_NS" >/dev/null 2>&1 || true

    # One pod per role, each exactly as the policy's selectors see it. The runner pods carry
    # `factory.job` and the release instance label and NOT `app.kubernetes.io/name`, which is what
    # the policy's podSelector is written against; the chart pods carry both.
    netpol_pod() { # netpol_pod <name> <labels json> [<args>]
        kn run "$1" -n "$NETPOL_NS" --image=alpine:3 --restart=Never \
            --overrides="{\"metadata\":{\"labels\":$2},\"spec\":{\"automountServiceAccountToken\":false,\"containers\":[{\"name\":\"$1\",\"image\":\"alpine:3\",\"command\":[\"sh\",\"-c\",\"${3:-sleep 3600}\"]}]}}" \
            --command -- sh >/dev/null 2>&1
    }
    # busybox `nc`, which alpine already has, rather than `apk add socat`: the install needs the
    # network from inside the pod and takes an unbounded amount of time, and a listener that is not
    # up yet reads to every probe exactly like a listener the policy blocked. Re-listening in a
    # loop because busybox nc serves one connection and exits.
    LISTEN='while :; do nc -l -p 8080 >/dev/null 2>&1; done & while :; do nc -l -p 9999 >/dev/null 2>&1; done & sleep 3600'

    netpol_pod attempt-a "{\"factory.job\":\"aaaa\",\"factory.lease\":\"la\",\"app.kubernetes.io/instance\":\"$RELEASE\"}"
    netpol_pod attempt-b "{\"factory.job\":\"bbbb\",\"factory.lease\":\"lb\",\"app.kubernetes.io/instance\":\"$RELEASE\"}" "$LISTEN"
    netpol_pod unrelated '{"role":"unrelated"}' "$LISTEN"
    netpol_pod dashboard \
        "{\"app.kubernetes.io/name\":\"factory\",\"app.kubernetes.io/instance\":\"$RELEASE\",\"app.kubernetes.io/component\":\"dashboard\"}" \
        "$LISTEN"

    # The node itself, as a probeable address. "A runner may not reach its node" needs something
    # LISTENING on the node for the denial to mean anything — a kind node runs no sshd, and a
    # closed port answers `denied` with or without a policy. This pod binds the host network
    # directly, so 31999 is open on the node's own InternalIP: inside blockedCidrs (172.16/12 on
    # kind), reachable before the policy and dropped after it. It is the only pod here that needs
    # host access, it exists purely to be a target, and it is deleted with the cluster.
    kn run node-listener -n "$NETPOL_NS" --image=alpine:3 --restart=Never \
        --overrides="{\"spec\":{\"hostNetwork\":true,\"automountServiceAccountToken\":false,\"containers\":[{\"name\":\"node-listener\",\"image\":\"alpine:3\",\"command\":[\"sh\",\"-c\",\"while :; do nc -l -p 31999 >/dev/null 2>&1; done\"]}]}}" \
        --command -- sh >/dev/null 2>&1

    for p in attempt-a attempt-b unrelated dashboard node-listener; do
        kn wait --for=condition=Ready "pod/$p" -n "$NETPOL_NS" --timeout=180s >/dev/null 2>&1 || {
            echo "test-k8s: probe pod $p never became Ready"
            exit 1
        }
    done
    ip_of() { kn get pod "$1" -n "$NETPOL_NS" -o jsonpath='{.status.podIP}'; }
    IP_B="$(ip_of attempt-b)"
    IP_UNRELATED="$(ip_of unrelated)"
    IP_DASH="$(ip_of dashboard)"
    NODE_IP="$(kn get node -o jsonpath='{.items[0].status.addresses[?(@.type=="InternalIP")].address}')"
    API_IP="$(kn get service kubernetes -n default -o jsonpath='{.spec.clusterIP}')"

    # `reaches` answers one question and prints one word, so every assertion below reads the same
    # way round. A denied connection is a DROPPED packet, so it costs the full timeout — which is
    # also why the timeout is short.
    reaches() { # reaches <from pod> <host> <port>
        if kn exec "$1" -n "$NETPOL_NS" -- sh -c "nc -z -w 4 $2 $3 >/dev/null 2>&1" >/dev/null 2>&1; then
            echo reachable
        else
            echo denied
        fi
    }

    # THE DENIAL TARGETS, and the rule that keeps every one of them honest: each is probed BEFORE
    # the policy is applied and must answer `reachable` there. An address that was already
    # unreachable — no listener, no responder, wrong IP — would answer `denied` afterwards no
    # matter what the policy said, and the lane would report a pass having proved nothing. That is
    # the single failure mode this whole lane exists to avoid, so it is checked per target rather
    # than once.
    #
    # Each target is `<name>|<host>|<port>`, and each is a REAL listener on this cluster:
    #   - the unrelated pod on both its ports (an unrelated workload), and another attempt's runner pod,
    #   - the kubernetes API's ClusterIP (the service network, inside blockedCidrs 10/8),
    #   - the kubelet on the node's own address (inside blockedCidrs 172.16/12 on kind),
    #   - a hostNetwork pod bound to a high port on that same node address — the node itself,
    #     reachable only because something is actually listening there. There is deliberately no
    #     `:22` probe: a kind node runs no sshd, so that assertion could only ever be vacuous.
    DENIALS="unrelated pod|$IP_UNRELATED|8080
another port on an unrelated pod|$IP_UNRELATED|9999
the kubernetes API|$API_IP|443
the kubelet on its node|$NODE_IP|10250
the node itself|$NODE_IP|31999
another port on the dashboard|$IP_DASH|9999
another attempt's runner pod|$IP_B|8080"

    # Ready means ANSWERING, not Running: the kubelet calls a pod Ready as soon as its process
    # starts, which is before the listener inside it has bound. Polled rather than slept, because
    # a fixed sleep is either too short (and the honest-probe controls below fail for a reason
    # that has nothing to do with the policy) or wasted on every run. EVERY probe target is
    # polled, not just the first: `node-listener` is a separate pod with its own image pull and is
    # the likeliest laggard, and a target that is merely slow would otherwise fail its own
    #
    # The first target that never comes up abandons the whole wait rather than letting each
    # remaining one burn its own budget: the lane is already going to fail its honest-probe
    # control, and six targets each waiting out 30 attempts would delay that verdict by a
    # quarter of an hour for no extra information.
    poll_ready=1
    while IFS='|' read -r what host port; do
        [ -n "$what" ] || continue
        [ "$poll_ready" = '1' ] || continue
        ready=0
        for _ in $(seq 1 30); do
            if [ "$(reaches attempt-a "$host" "$port")" = 'reachable' ]; then
                ready=1
                break
            fi
            sleep 2
        done
        [ "$ready" = '1' ] || poll_ready=0
    done <<EOF
$DENIALS
EOF

    while IFS='|' read -r what host port; do
        [ -n "$what" ] || continue
        expect_contains "before any policy, a runner reaches $what (so the probe is honest)" \
            "$(reaches attempt-a "$host" "$port")" 'reachable'
    done <<EOF
$DENIALS
EOF

    awk '/^# Source: factory\/templates\/runner-networkpolicy.yaml/,/^---/' "$work/rendered.yaml" |
        grep -v '^---$' | kn apply -n "$NETPOL_NS" -f - >/dev/null 2>&1 || {
        echo 'test-k8s: the rendered runner NetworkPolicy would not apply'
        exit 1
    }
    sleep 5

    while IFS='|' read -r what host port; do
        [ -n "$what" ] || continue
        expect_contains "a runner may not reach $what" "$(reaches attempt-a "$host" "$port")" 'denied'
    done <<EOF
$DENIALS
EOF

    # NOT probed, and said out loud rather than left as a gap: the cloud metadata endpoint
    # (169.254.169.254). Nothing answers on it in a kind cluster, so a probe would report `denied`
    # whether or not the policy covered it — exactly the vacuous pass the controls above exist to
    # prevent, and worse here because metadata access is the highest-value denial in the issue.
    # What IS proved is the mechanism it depends on: 169.254.0.0/16 and 172.16.0.0/12 are both
    # `blockedCidrs` entries excluded from the same `0.0.0.0/0` egress rule, and the node probe
    # above shows that rule actually dropping traffic to a blocked private range. The endpoint's
    # own defence is a node-level setting the chart cannot make either way
    # (`httpPutResponseHopLimit: 1`, docs/kubernetes.md). Recorded in docs/executor-testing.md
    # under "What no lane covers".

    # The port scoping, positive half: the dashboard stays reachable where it actually
    # serves. The negative half — 9999 on that same pod — is in DENIALS above rather than here,
    # precisely because it is the assertion this whole change exists for: asserted standalone it
    # would report `denied` if the dashboard's second listener had simply failed to bind, which is
    # the vacuous pass every other denial is already protected from.
    expect_contains 'a runner reaches the dashboard on its serving port' "$(reaches attempt-a "$IP_DASH" 8080)" 'reachable'

    # The positive probes: a run that cannot resolve a name or reach its own fleet is a run that
    # does not work, and an isolation change that breaks them has not hardened anything.
    dns="$(kn exec attempt-a -n "$NETPOL_NS" -- sh -c 'nslookup kubernetes.default.svc.cluster.local >/dev/null 2>&1 && echo resolves || echo broken' 2>/dev/null)"
    expect_contains 'a runner still resolves cluster DNS' "$dns" 'resolves'

    netpol_cleanup
    trap cleanup EXIT
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    [ "$fail" -eq 0 ]
    exit
fi

# --- Phase two: the cluster -------------------------------------------------------------------

if [ "$MODE" != '--cluster' ]; then
    printf '\n%d passed, %d failed (cluster phase skipped — pass --cluster or --netpol)\n' "$pass" "$fail"
    [ "$fail" -eq 0 ]
    exit
fi

begin_phase cluster-preflight
for tool in kubectl docker openssl; do
    command -v "$tool" >/dev/null || {
        echo "test-k8s: $tool is required for the cluster phase"
        exit 1
    }
done

# The cluster phase installs a release and deletes runner Jobs in its namespace — and "runner Job"
# is identified only by the factory.job label, which any release in the namespace shares. This
# script is built for a disposable local kind cluster; anything else has to say so twice: the
# context must be shaped `kind-<name>` (how kind always names them) AND that name's cluster must
# be the one actually serving the context. Those two facts are BOUND, not checked independently:
# kind publishes the control-plane API on host 127.0.0.1:<port> and writes that same `server:`
# into the kubeconfig, so the guard reads the context's server address and requires a control-plane
# container labelled `io.x-k8s.kind.cluster=<name>` (the same label `kind load --name` resolves
# below; k8s node objects carry no kind label) to be publishing that port. Two independent
# fingerprints — a docker label on this daemon, node objects over the wire — could each pass
# against a different cluster and admit a context aimed anywhere; the endpoint cannot. There is
# no override — a context outside both has no image-load path here anyway.
context="$(kubectl config current-context 2>/dev/null || true)"
case "$context" in
kind-*)
    kind_name="${context#kind-}"
    command -v kind >/dev/null || {
        echo "test-k8s: kind is required for the cluster phase (context is $context)"
        exit 1
    }
    server="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}' 2>/dev/null || true)"
    [ -n "$server" ] || {
        echo "test-k8s: refusing to run the cluster phase against '$context'."
        echo "  It deletes every runner Job in the namespace, and the context's API server"
        echo "  address could not be read — the context may be dangling or not a kind"
        echo "  cluster's. Create one (make cluster CLUSTER=<name>) and aim kubectl at it."
        exit 1
    }
    serving=0
    for container in $(docker ps -q --filter "label=io.x-k8s.kind.cluster=$kind_name" \
        --filter 'label=io.x-k8s.kind.role=control-plane'); do
        host_port="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "6443/tcp") 0).HostPort}}' \
            "$container" 2>/dev/null || true)"
        case "$server" in
        "https://127.0.0.1:$host_port" | "https://localhost:$host_port")
            serving=1
            break
            ;;
        esac
    done
    [ "$serving" = '1' ] || {
        echo "test-k8s: refusing to run the cluster phase against '$context'."
        echo "  It deletes every runner Job in the namespace, and no kind cluster named"
        echo "  '$kind_name' is serving the context's endpoint ($server): no control-plane"
        echo "  container of that cluster publishes the port the context points at. It"
        echo "  may not be a disposable kind cluster."
        echo '  Create one (`make cluster CLUSTER=<name>`) and aim kubectl at it.'
        exit 1
    }
    # The images reach the node through the cluster's local registry, so a cluster without it is
    # refused before the build rather than after.
    sh scripts/kind-cluster.sh check "$kind_name" || exit 1
    # The kubelet's pod sync bounds how fast a rebound Secret reaches the supervisor. An unset (0s) or
    # unreadable value is the kubelet's one-minute default, never a fast sync.
    sync="$(docker exec "$kind_name-control-plane" sed -n 's/^syncFrequency: *\([0-9][0-9]*\)s$/\1/p' \
        /var/lib/kubelet/config.yaml 2>/dev/null)"
    case "$sync" in '' | 0) KUBELET_SYNC_S=60 ;; *) KUBELET_SYNC_S="$sync" ;; esac
    ;;
*)
    echo "test-k8s: refusing to run the cluster phase against '$context'."
    echo '  It deletes every runner Job in the namespace. Create a disposable kind cluster'
    echo '  (`make cluster CLUSTER=<name>`) and aim kubectl at it — its context is'
    echo '  kind-<name>.'
    exit 1
    ;;
esac

echo
echo '# cluster'

kubectl cluster-info >/dev/null 2>&1 || {
    echo "test-k8s: no reachable cluster (is the kind cluster $kind_name running?)"
    exit 1
}

command -v node >/dev/null || {
    echo 'test-k8s: node is required for the cluster phase'
    exit 1
}

echo 'building the images on the host daemon'
begin_phase images
# The stub echoes the claude config content and its argv; `factory-stub-wait-<path>` holds it
# until the harness releases that file, so disruption tests observe a running agent, and with
# `factory-stub-kill-tools` its one tool signals everything it may (the tool-isolation section). It stands on
# node + git as the uid-1000 `node` user, like the executor images: the startup sync and the other
# supervised steps run IN the job's executor image (the task supervisor's container,
# `driver/src/scripts/supervisor.cjs`), and every task has a checkout to sync. It
# starts through scripts/stub-agent.sh, beside ctl-agent.cjs, over the node-owned mailbox mount
# points: the task supervisor's agent contract (driver/test/lane-stubs.test.ts), which the real
# entrypoints honor.
cp docker/executor-common/ctl-agent.cjs docker/executor-common/factory-launch.sh docker/executor-common/factory-tool.cjs \
    docker/executor-common/tool-bash.sh scripts/stub-agent.sh scripts/lane-gh.sh scripts/stub-runner.Dockerfile "$work/"
cp docker/executor-common/github-credential.cjs docker/executor-common/credential-broker.cjs docker/executor-common/attempt-pair.cjs docker/executor-common/connection-ask.cjs docker/executor-common/skill-view.cjs docker/skills/factory-jira/jira.cjs docker/skills/factory-task-title/task-title.cjs "$work/"
cp scripts/k8s-stub.sh "$work/stub.sh"
printf 'FROM %s\nCOPY stub.sh /stub.sh\nCOPY github-credential.cjs credential-broker.cjs attempt-pair.cjs connection-ask.cjs skill-view.cjs jira.cjs task-title.cjs /usr/local/bin/\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","/stub.sh"]\n' "$STUB_IMAGE-base" >"$work/stub.Dockerfile"
# Two Docker builds at once. Each process owns its log and is joined even if a sibling fails.
docker build -f docker/Dockerfile --target runtime -q -t "$DASH_IMAGE" . >"$work/dashboard-build.log" 2>&1 &
dash_build=$!
docker build -f docker/driver.Dockerfile -q -t "$DRIVER_IMAGE" . >"$work/driver-build.log" 2>&1 &
driver_build=$!
build_failed=0
wait "$dash_build" || { tail -30 "$work/dashboard-build.log"; build_failed=1; }
dash_build=''
wait "$driver_build" || { tail -30 "$work/driver-build.log"; build_failed=1; }
driver_build=''
[ "$build_failed" -eq 0 ] || exit 1
{
    docker build -q -t "$STUB_IMAGE-base" -f "$work/stub-runner.Dockerfile" "$work" &&
        docker build -q -t "$STUB_IMAGE" -f "$work/stub.Dockerfile" "$work"
} >"$work/stub-build.log" 2>&1 &
stub_build=$!
for image in "$COLLECTOR_IMAGE" "$POSTGRES_IMAGE"; do
    docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" || exit 1
done >"$work/collector-pull.log" 2>&1 &
collector_pull=$!
wait "$stub_build" || { tail -30 "$work/stub-build.log"; build_failed=1; }
stub_build=''
wait "$collector_pull" || { tail -30 "$work/collector-pull.log"; build_failed=1; }
collector_pull=''
[ "$build_failed" -eq 0 ] || exit 1

echo "loading the images into the kind cluster $kind_name"
begin_phase image-load
# Pushed one after another, so the shared base layers go once and only layers the registry lacks
# go at all; the node pulls what it lacks when the pods start. The per-run tag is dropped from the
# host daemon at once, leaving the plain name the next build reuses.
push_ref() { # push_ref <image> <ref>
    { docker tag "$1" "$2" && docker push -q "$2" >/dev/null && docker image rm "$2" >/dev/null; } || {
        echo "test-k8s: could not push $1 to the kind cluster registry as $2"
        exit 1
    }
}
push_ref "$DASH_IMAGE" "$DASH_REF"
push_ref "$DRIVER_IMAGE" "$DRIVER_REF"
push_ref "$STUB_IMAGE" "$STUB_REF"
# The pinned upstream images go through the registry too: side-loading imports a whole copy into
# every node, and a node pulling from the registry fetches only the layers it lacks.
push_ref "$COLLECTOR_IMAGE" "$COLLECTOR_REF"
push_ref "$POSTGRES_IMAGE" "$POSTGRES_REF"

echo "installing the releases $STATE_RELEASE and $RELEASE"
begin_phase deploy
deploy_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# A cluster made with LAYOUT=drain (scripts/kind-cluster-drain.yaml) carries nodes, the control plane too,
# labelled factory.lane/shared, which the drain phase and the board placement below key on. An unreadable
# node list refuses the run: it is never "no such nodes".
shared_nodes="$(kubectl get nodes -l factory.lane/shared=true -o name --request-timeout=10s)" || {
    echo 'test-k8s: could not list the cluster nodes'
    exit 1
}
cordoned_file="$work/cordoned"
: >"$cordoned_file"
lane_cordon() { # lane_cordon <node> -> cordoned and recorded, so cleanup uncordons it whatever happens
    kubectl cordon "$1" --request-timeout=20s >/dev/null && echo "$1" >>"$cordoned_file"
}
lane_uncordon() { # lane_uncordon <node> -> schedulable again and dropped from the record
    kubectl uncordon "$1" --request-timeout=20s >/dev/null && {
        grep -vx "$1" "$cordoned_file" >"$cordoned_file.next" || true
        mv "$cordoned_file.next" "$cordoned_file"
    }
}
if [ -n "$shared_nodes" ]; then
    # State and app land on the control plane: a drain case moves the driver and the runner, never the board.
    workers="$(kubectl get nodes -l '!node-role.kubernetes.io/control-plane' -o name --request-timeout=10s)" || {
        echo 'test-k8s: could not list the worker nodes'
        exit 1
    }
    for node in $workers; do
        lane_cordon "${node#node/}" || {
            echo "test-k8s: could not cordon $node"
            exit 1
        }
    done
fi
helm install "$STATE_RELEASE" charts/factory-local-state \
    --set "postgres.image=$POSTGRES_REF" -n "$NAMESPACE" >/dev/null || {
    echo 'test-k8s: helm install of the state chart failed'
    exit 1
}
state_installed=1
# The lease outlasts the orphan bound (a lost driver's group ends inside it) plus one heartbeat period
# (a third of the lease): L >= orphan + L/3, so the bound is L - L/3 and the lease can be as short as the
# bound allows. The orphan floor and the GET /step long poll are lowered with it (driver.orphanMinMs /
# driver.stepWaitMs): the floor outlasts the long poll by 5 s, and the driver refuses a pair the lease
# cannot hold. 15 s: a 10 s bound over a 2 s long poll. Production keeps 30 s / 15 s.
LANE_LEASE_S=15
LANE_ORPHAN_S=$((LANE_LEASE_S - LANE_LEASE_S / 3))
LANE_STEP_WAIT_MS=$((LANE_ORPHAN_S * 200))
# A rebind reaches the supervisor through the kubelet's Secret refresh (64 s measured on the kind nodes
# at the default one-minute sync, docs/kubernetes.md): the grace outlasts two syncs, or the group ends
# before it can follow the new holder. scripts/kind-cluster.yaml syncs every 5 s: the 30 s floor below.
LANE_REBIND_GRACE_S=$((2 * ${KUBELET_SYNC_S:-60} + 10))
# Measured on the kind lane: a 5 s sync (a 20 s grace) leaves the hard-kill case's rebind undelivered
# (the supervisor ends before it polls the new endpoint, three runs in three), a 30 s grace delivers it.
[ "$LANE_REBIND_GRACE_S" -ge 30 ] || LANE_REBIND_GRACE_S=30
LANE_MARGIN_S=40
# Fresh throwaway secrets per run; the board token is what the driver presents on every claim, so a
# job that comes back succeeded proves it end to end. The origin is the port-forward's below.
PORT=18080
BASE="http://127.0.0.1:$PORT"
secret_store_sets "$(openssl rand -base64 32)" "$(openssl rand -base64 32)" "$(openssl rand -base64 32)"
auth_sets "$BASE" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)"
helm install "$RELEASE" charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" \
    --set "dashboard.image.repository=$DASH_REPO" --set-string "dashboard.image.tag=$RELEASE" \
    --set "driver.image.repository=$DRIVER_REPO" --set-string "driver.image.tag=$RELEASE" \
    --set "driver.executorImages.claudeCode=$STUB_REF" \
    --set "driver.executorImages.opencode=$STUB_REF" \
    --set "collector.image.repository=$LANE_REGISTRY/${COLLECTOR_IMAGE%:*}" \
    --set "database.waitImage=$POSTGRES_REF" \
    --set driver.reapIntervalMs=3000 --set driver.reapGraceMs=1000 \
    --set "driver.repoCloneBase=git://$RELEASE-origin:9418" \
    --set-string driver.leaseSeconds="$LANE_LEASE_S" --set driver.terminationGracePeriodSeconds=70 \
    --set-string driver.orphanMinMs="$((LANE_ORPHAN_S * 1000))" --set-string driver.stepWaitMs="$LANE_STEP_WAIT_MS" \
    --set-string driver.rebindGraceMs="$((LANE_REBIND_GRACE_S * 1000))" \
    -n "$NAMESPACE" >/dev/null || {
    echo 'test-k8s: helm install failed'
    exit 1
}
installed=1

# The postgres StatefulSet is waited for deliberately: the dashboard listens the moment its
# process is up — health answers, availability reports — but its migrations only start landing
# once the database accepts connections, and the server gives up retrying after ~45s. On a cold
# kind node the database image is still being pulled through containerd in that window, so
# queueing before it is available fails every POST no matter how long the queue step polls.
# A StatefulSet carries no `available` condition, so the database is waited for by rollout
# status rather than being folded into the condition wait with the three Deployments.
kubectl wait --for=condition=available \
    "deployment/$RELEASE-factory" "deployment/$RELEASE-factory-driver" \
    "deployment/$RELEASE-factory-collector" \
    -n "$NAMESPACE" --timeout=600s >/dev/null 2>&1 &&
    kubectl rollout status "statefulset/$STATE_RELEASE-postgres" \
        -n "$NAMESPACE" --timeout=600s >/dev/null 2>&1 &&
    ok 'the dashboard, driver, database and collector come up' || \
    bad 'the dashboard, driver, database and collector come up' \
        "$(kubectl get pods -n "$NAMESPACE" | tail -5)"
# Key isolation, live (docs/secrets.md): the dashboard container holds all five secret-store variables (the
# backend and four keys) and no container of the driver pod holds one.
dash_vars="$(kubectl exec "deploy/$RELEASE-factory" -c dashboard -n "$NAMESPACE" --request-timeout=20s -- env 2>/dev/null | grep -c '^SECRETS_')"
[ "$dash_vars" = 5 ] && ok 'the dashboard pod has the five secret-store variables' ||
    bad 'the dashboard pod has the five secret-store variables' "found $dash_vars"
driver_vars=0
for container in $(kubectl get "deploy/$RELEASE-factory-driver" -n "$NAMESPACE" -o jsonpath='{.spec.template.spec.containers[*].name}'); do
    driver_vars=$((driver_vars + $(kubectl exec "deploy/$RELEASE-factory-driver" -c "$container" -n "$NAMESPACE" --request-timeout=20s -- env 2>/dev/null | grep -c '^SECRETS_')))
done
[ "$driver_vars" = 0 ] && ok 'no driver container holds a secret-store variable' ||
    bad 'no driver container holds a secret-store variable' "found $driver_vars"
# The workers were cordoned only so the board landed on the control plane.
for node in $(cat "$cordoned_file"); do
    lane_uncordon "$node" || bad "$node is schedulable again" 'kubectl uncordon failed'
done

# Through the dashboard, so the assertion is the user's own path: queue, then poll the board.
begin_phase smoke
PF_LOG="$work/portforward.log"
kubectl port-forward "svc/$RELEASE-factory" "$PORT:8080" -n "$NAMESPACE" >"$PF_LOG" 2>&1 &
pf_pid=$!

# Every human route needs a member behind it. The node calls below read the member's personal
# access token from FACTORY_TOKEN — the environment, not argv, so it never shows in a process
# listing — and send it as a bearer when it is set.
JS_HEADERS='const headers = { "content-type": "application/json" };
if (process.env.FACTORY_TOKEN) headers.authorization = "Bearer " + process.env.FACTORY_TOKEN;
const unbounded = fetch;
// A board that never answers is a refusal like any other, never a lane that hangs.
globalThis.fetch = (url, init = {}) => unbounded(url, { signal: AbortSignal.timeout(10000), ...init });'
http_status() { # http_status <method> <url> [json body] — the status code, 000 when nothing answered
    node -e "$JS_HEADERS"'
fetch(process.argv[2], { method: process.argv[1], headers, body: process.argv[3] })
    .then((r) => process.stdout.write(String(r.status)))
    .catch(() => process.stdout.write("000"));
' "$@"
}
give_up() {
    kill "$pf_pid" 2>/dev/null
    # What the lane was standing on when it stopped: the port-forward and this release's pods.
    echo '--- port-forward'
    tail -5 "$PF_LOG" 2>/dev/null
    echo '--- pods'
    bounded 30 kubectl get pods -l "app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --request-timeout=20s 2>&1 | sed -n '1,20p'
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    exit 1
}

first_runner_job() { # first_runner_job <id> -> the name of the runner Job claim 1 created
    kubectl get jobs -l "factory.job=$1,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --request-timeout=10s \
        -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.annotations.factory\.claim-seq}{"\n"}{end}' \
        2>/dev/null | awk '$2 == "1" && !found { print $1; found = 1 }'
}

await_runner_pod() { # await_runner_pod <id> -> the claim-1 runner pod's name once it runs, empty on timeout
    local name="" pod="" until=$(($(date +%s) + 120))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ -n "$name" ] || name="$(first_runner_job "$1")"
        [ -n "$name" ] && pod="$(kubectl get pods -l "job-name=$name" -n "$NAMESPACE" --request-timeout=10s \
            -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{end}' 2>/dev/null)"
        [ -n "$pod" ] && break
        sleep 1
    done
    printf '%s' "$pod"
}

await_blocked() { # await_blocked <runner pod> <release file> -> the agent is running behind its barrier
    # Pod Running and even `go` can precede the agent: observe the stub itself before disrupting it.
    local until=$(($(date +%s) + 60))
    while [ "$(date +%s)" -lt "$until" ]; do
        # From the supervisor, on the same task volume: the agent container runs as root without
        # DAC_OVERRIDE.
        bounded 20 kubectl exec "$1" -c supervisor -n "$NAMESPACE" --request-timeout=10s -- test -f "$2.ready-$1" \
            >/dev/null 2>&1 && return 0
        sleep 1
    done
    bad 'the stub agent reached its barrier' 'no ready marker within 60s'
    return 1
}

release_stub() { # release_stub <release file> -> touched through a pod that has reached its barrier
    # The task volume survives pod deletion, so a replacement agent sees the same release — but only
    # a pod of the thread mounts it, so the release goes through the one standing at this barrier
    # (its ready marker). Polled: a replacement pod may not have reached the barrier yet.
    local until=$(($(date +%s) + 120)) pod
    while [ "$(date +%s)" -lt "$until" ]; do
        for pod in $(kubectl get pods -n "$NAMESPACE" --request-timeout=10s \
            -o jsonpath='{range .items[?(@.status.phase=="Running")]}{.metadata.name}{"\n"}{end}' 2>/dev/null); do
            bounded 20 kubectl exec "$pod" -c supervisor -n "$NAMESPACE" --request-timeout=10s -- test -f "$1.ready-$pod" \
                >/dev/null 2>&1 || continue
            bounded 20 kubectl exec "$pod" -c supervisor -n "$NAMESPACE" --request-timeout=10s -- touch "$1" \
                >/dev/null 2>&1 && return 0
        done
        sleep 1
    done
    give_up
}

up=""
for _ in $(seq 1 30); do
    [ "$(http_status GET "$BASE/api/health")" = '200' ] && {
        up=1
        break
    }
    sleep 1
done
[ -n "$up" ] && ok 'the board answers through the service' || {
    bad 'the board answers through the service' "$(cat "$PF_LOG")"
    give_up
}

# The rows below go straight into the tables the migrations create, so wait for them: /api/ready
# answers 200 only once every migration has landed.
ready=""
for _ in $(seq 1 120); do
    [ "$(http_status GET "$BASE/api/ready")" = '200' ] && {
        ready=1
        break
    }
    sleep 1
done
[ -n "$ready" ] && ok 'the board reports its migrations applied' || {
    bad 'the board reports its migrations applied' 'GET /api/ready never answered 200'
    give_up
}

SMOKE_REPO='factory-smoke/demo'
JOB_BODY='{"command":"hello from the cluster","executor":"claude","repo":"factory-smoke/demo"}'
# The wall is up: no credential, no job.
anon="$(http_status POST "$BASE/api/jobs" "$JOB_BODY")"
[ "$anon" = '401' ] && ok 'an unauthenticated POST /api/jobs is refused 401' ||
    bad 'an unauthenticated POST /api/jobs is refused 401' "got $anon"

# A member, minted where sign-in would have put one. With no App nobody can sign in, so the rows go
# in directly: an organization, a user, the membership that binds them, and a personal access token
# — `fat_` + 32 CSPRNG bytes base64url, stored only as the sha-256 of the whole token
# (server/src/auth/access-token.ts, hashToken in session.ts). Every id is generated here or by the
# database; psql variables carry the values, so nothing is spliced into the SQL text.
read -r FACTORY_TOKEN token_hash < <(node -e '
const c = require("node:crypto");
const t = "fat_" + c.randomBytes(32).toString("base64url");
process.stdout.write(t + " " + c.createHash("sha256").update(t).digest("hex"));
')
member="k8s-test-$(openssl rand -hex 6)"
minted="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    psql -q -v ON_ERROR_STOP=1 -v "member=$member" -v "hash=$token_hash" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
with o as (
    insert into organization (id, name) values (:'member', :'member') returning id
), u as (
    insert into app_user (github_user_id, github_login)
    values ((1000000000 + floor(random() * 1000000000000))::bigint, :'member') returning id
), m as (
    insert into org_membership (org_id, github_login, user_id, role, claimed_at)
    select o.id, :'member', u.id, 'member', now() from o, u
)
insert into access_token (org_id, kind, user_id, created_by, label, token_hash)
select o.id, 'personal', u.id, u.id, 'test-k8s', decode(:'hash', 'hex') from o, u;
SQL
)" && ok 'a member and a personal access token are minted' || {
    bad 'a member and a personal access token are minted' "$minted"
    give_up
}
export FACTORY_TOKEN

# The tracked repo: POST /api/jobs refuses a create whose repo the board does not track, and the
# offline board's tracked list is its session_branch rows. With no GitHub the fixture is one such
# row — and, for the runner's own clone, an origin served inside the
# cluster: a git daemon pod and Service named for REPO_CLONE_BASE (`driver.repoCloneBase` above)
# whose `<owner>/<name>.git` is a bare repository with one commit, so every task clones and
# publishes with no network. scripts/test-jobs.sh serves its origin the same way, from a container.
member_user="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    psql -qtA -v ON_ERROR_STOP=1 -v "member=$member" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
select user_id from org_membership where org_id = :'member';
SQL
)"
case "$member_user" in
????????-????-????-????-????????????) ;;
*) bad 'the member has a user id' "$member_user"
    give_up
    ;;
esac
selected="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    psql -q -v ON_ERROR_STOP=1 -v "member=$member" \
    -v "owner=${SMOKE_REPO%%/*}" -v "name=${SMOKE_REPO#*/}" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
insert into session_branch (org_id, agent, session_id, repo, branch, first_seen, last_seen)
values (:'member', 'claude-code', 'test-k8s-fixture', :'owner' || '/' || :'name', 'main', now(), now())
on conflict do nothing;
SQL
)" && ok 'the board tracks the smoke repository' || {
    bad 'the board tracks the smoke repository' "$selected"
    give_up
}
# One line, no double quotes or backslashes: it is interpolated into the JSON override below.
origin_script="set -e; mkdir -p /origins/${SMOKE_REPO%%/*}; git init -q --bare -b main /origins/$SMOKE_REPO.git;
git init -q -b main /tmp/seed;
git -C /tmp/seed -c user.name=test-k8s -c user.email=test-k8s@localhost commit -q --allow-empty -m init;
git -C /tmp/seed push -q /origins/$SMOKE_REPO.git main;
exec git daemon --reuseaddr --base-path=/origins --export-all --enable=receive-pack --listen=0.0.0.0 --port=9418 /origins"
origin_script="$(printf '%s' "$origin_script" | tr '\n' ' ')"
# On the multi-node layout the origin sits with the board on the control plane: a drain case moves the
# driver and the runner, and a bare pod on a drained node is neither evicted nor kept (emptyDir).
origin_place=''
[ -z "$shared_nodes" ] || origin_place='"nodeSelector":{"node-role.kubernetes.io/control-plane":""},
"tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Exists","effect":"NoSchedule"}],'
kubectl run "$RELEASE-origin" -n "$NAMESPACE" --image="$STUB_REF" --restart=Never --command \
    --overrides="$(
        cat <<EOF
{"spec":{$origin_place"automountServiceAccountToken":false,
"volumes":[{"name":"o","emptyDir":{}}],
"containers":[{"name":"origin","image":"$STUB_REF","imagePullPolicy":"IfNotPresent",
"command":["sh","-c","$origin_script"],
"readinessProbe":{"tcpSocket":{"port":9418}},
"volumeMounts":[{"name":"o","mountPath":"/origins"}]}]}}
EOF
    )" -- sh >/dev/null 2>&1
kubectl expose pod "$RELEASE-origin" -n "$NAMESPACE" --port=9418 >/dev/null 2>&1
# The runner policy blocks the pod network (10.0.0.0/8 on kind), where this origin lives, so a task
# pod could not reach it: the lane alone admits this release's runner pods to the origin's git port.
origin_policy="$(kubectl apply -n "$NAMESPACE" -f - 2>&1 <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
    name: $RELEASE-origin-egress
spec:
    podSelector:
        matchLabels:
            app.kubernetes.io/instance: $RELEASE
        matchExpressions:
            - {key: factory.job, operator: Exists}
    policyTypes: [Egress]
    egress:
        - to:
              - podSelector:
                    matchLabels:
                        run: $RELEASE-origin
          ports:
              - {protocol: TCP, port: 9418}
EOF
)" || bad 'the lane admits runner pods to the smoke origin' "$origin_policy"
kubectl wait --for=condition=Ready --timeout=180s "pod/$RELEASE-origin" -n "$NAMESPACE" >/dev/null 2>&1
repo_seeded="$(kubectl exec "$RELEASE-origin" -n "$NAMESPACE" -- git ls-remote "git://127.0.0.1:9418/$SMOKE_REPO.git" 2>&1 || true)"
case "$repo_seeded" in
*refs/heads/main*) ok 'the smoke origin is served inside the cluster' ;;
*) bad 'the smoke origin is served inside the cluster' "$repo_seeded"
    give_up
    ;;
esac

# A task runs only under an executor from its author's own list — there is no global fallback, and
# a claim whose label matches nothing is failed by the driver — so the fresh member needs one
# before anything is queued. The PUT replaces the whole list, so repeating it is harmless: it
# retries through the same grace the queue loop below allows.
configured=""
for _ in $(seq 1 60); do
    [ "$(http_status PUT "$BASE/api/workspace/executors" \
        '{"executors":[{"name":"claude","type":"claude-code","config":{}}]}')" = '200' ] && {
        configured=1
        break
    }
    sleep 1
done
[ -n "$configured" ] && ok 'the board stores the task executor' ||
    bad 'the board stores the task executor' 'PUT /api/workspace/executors never answered 200'

# The organization-scope leg (issue 391): an org profile seeded straight into the table — the
# admin-created shape, with this lane's member only ever a selector — and a task stamped
# `executorScope: 'org'`. The stub prints the claude config content, so the org model marker in
# the output is the proof the claim resolved the ORG row: the member's personal list is empty.
org_seeded="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    psql -q -v ON_ERROR_STOP=1 -v "member=$member" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
insert into executor_profile (org_id, user_id, name, type, config)
select id, null, 'team', 'claude-code', '{"model":"org-team-model"}'::jsonb from organization where id = :'member';
SQL
)" && ok 'an org executor profile is seeded' || {
    bad 'an org executor profile is seeded' "$org_seeded"
    give_up
}
ORG_BODY="{\"command\":\"hello from the org scope\",\"executor\":\"team\",\"executorScope\":\"org\",\"repo\":\"$SMOKE_REPO\"}"
smoke_release="/task/.lane-smoke"
SMOKE_COMMAND="hello from the cluster factory-stub-wait-$smoke_release"
JOB_BODY="{\"command\":\"$SMOKE_COMMAND\",\"executor\":\"claude\",\"repo\":\"$SMOKE_REPO\"}"

# The wait above covers the cold case (database image still pulling); this poll covers the
# residual one — migrations retry on a backoff, so the first POST after the database is up can
# still land inside it. The server adopts the database on the attempt that works; the script
# gives it the same grace. No rejection is proof the job was not created: the route wraps store
# calls in `guard`, which answers 503 to ANY throw — including one raised by the postgres client
# while awaiting the result of an INSERT that has already committed — and a 000 means no response
# came back, not that nothing was processed. Repeating the non-idempotent POST on either would
# queue a duplicate the test does not track. So on 000 and on 5xx the loop reconciles first: it
# reads GET /api/jobs (limit 200, the endpoint's cap) and, if a job whose command is this test's
# command exists, adopts its id and carries on with the normal flow. A list read that FAILS is no
# evidence either way, so only a read that SUCCEEDS and shows no such job re-arms the POST; a
# failed read keeps waiting here (the loop has 60 iterations) rather than re-POSTing blind. Any
# other answer — a 2xx whose body will not parse into an id, say — may have created a job, so
# the loop stops and lets the check below report, rather than re-POSTing the same command into a
# duplicate. Same shape as the status poll below.
id=""
reconcile=0
for _ in $(seq 1 60); do
    if [ "$reconcile" = '0' ]; then
        response="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "POST", headers, body: process.argv[2] })
    .then(async (r) => { const b = await r.text(); let id = ""; try { id = String(JSON.parse(b).id ?? ""); } catch {} process.stdout.write(r.status + "|" + id); })
    .catch(() => process.stdout.write("000|"));
' "$BASE/api/jobs" "$JOB_BODY")"
        status="${response%%|*}"
        id="${response#*|}"
        case "$status" in
        000 | 5*) reconcile=1 ;;
        *) break ;;
        esac
    else
        adopted="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => {
        if (r.status !== 200) { process.stdout.write("no"); return; }
        const b = await r.json().catch(() => null);
        if (!b || !Array.isArray(b.jobs)) { process.stdout.write("no"); return; }
        const hit = b.jobs.find((j) => j.command === process.argv[2]);
        process.stdout.write(hit ? "id " + String(hit.id) : "none");
    })
    .catch(() => process.stdout.write("no"));
' "$BASE/api/jobs?limit=200" "$SMOKE_COMMAND")"
        case "$adopted" in
        'id '*)
            id="${adopted#id }"
            break
            ;;
        none) reconcile=0 ;; # the read succeeded and showed no such job: re-POST is safe
        esac
    fi
    sleep 1
done
case "$id" in
*-*) ok 'a job was queued' ;;
*) bad 'a job was queued' "no id came back (last status: ${status:-none})"
    give_up
    ;;
esac

# Observe this task's real Job while its agent is held alive, before normal teardown can remove it.
smoke_pod="$(await_runner_pod "$id")"
if [ -n "$smoke_pod" ]; then
    kubectl logs -f "$smoke_pod" -n "$NAMESPACE" --all-containers --timestamps --prefix >"$RUNNER_LOG" 2>&1 &
    runner_log_pid=$!
fi
job_object="$(first_runner_job "$id")"
if [ -n "$smoke_pod" ] && [ -n "$job_object" ]; then
    ok 'a runner Job object exists for the queued task'
    release_stub "$smoke_release"
else
    bad 'a runner Job object exists for the queued task' 'none found while the agent was blocked'
    give_up
fi

# The stub image echoes its arguments, so the output is the proof the prompt reached the pod — the
# same assertion scripts/test-jobs.sh makes against docker.
result=""
for _ in $(seq 1 120); do
    result="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write(j.status + "\t" + String(j.exitCode ?? "") + "\t" + String(j.output ?? "")); })
    .catch(() => process.stdout.write("queued\t\t"));
' "$BASE/api/jobs/$id")"
    case "$result" in
    queued* | running*) sleep 1 ;;
    *) break ;;
    esac
done
expect_contains 'the job ran to completion' "$result" 'succeeded'
expect_contains 'the prompt reached the pod' "$result" 'hello from the cluster'

# A normal run's claim ends `observed` (the runner proved the agent started) with its end stamped:
# only observed|adopted claims count as run segments, so `unknown` here is a launch-proof bug.
exec_rows="$(kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
    env PGOPTIONS='-c statement_timeout=5000 -c lock_timeout=5000' psql -qtA -v ON_ERROR_STOP=1 -v "job=$id" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
select launch || '|' || (ended_at is not null) || '|' || (created_at <= ended_at) from job_execution where job_id = :'job';
SQL
)"
if [ "$exec_rows" = 'observed|true|true' ]; then ok 'the finished claim ends observed'
else bad 'the finished claim ends observed' "job_execution rows (launch|ended|ordered): $exec_rows"; fi

# The organization-scope run (issue 391), the kubernetes counterpart of test-jobs.sh's leg: the
# task stamps `executorScope: 'org'`, the claim resolves the ORG row seeded above, and the stub's
# config echo carries the org model marker no personal row on this board could produce.
org_id=""
for _ in $(seq 1 60); do
    response="$(node -e "$JS_HEADERS"'
// `node -e` has no script path in argv: the first argument is argv[1].
const [url, body] = process.argv.slice(1);
fetch(url, { method: "POST", headers, body })
    .then(async (r) => { const b = await r.json().catch(() => ({})); process.stdout.write(r.status + "|" + String(b.id ?? "")); })
    .catch(() => process.stdout.write("000|"));
' "$BASE/api/jobs" "$ORG_BODY")"
    status="${response%%|*}"
    org_id="${response#*|}"
    case "$status" in
    000 | 5*) sleep 1 ;;
    201) break ;;
    *) break ;;
    esac
done
case "$org_id" in
*-*) ok 'an org-scoped job was queued' ;;
*) bad 'an org-scoped job was queued' "no id came back (last status: ${status:-none})"
    give_up
    ;;
esac
org_result=""
for _ in $(seq 1 120); do
    org_result="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write(j.status + "\t" + String(j.executorScope ?? "") + "\t" + String(j.output ?? "")); })
    .catch(() => process.stdout.write("queued\t\t"));
' "$BASE/api/jobs/$org_id")"
    case "$org_result" in
    queued* | running*) sleep 1 ;;
    *) break ;;
    esac
done
expect_contains 'the org-scoped job ran to completion' "$org_result" 'succeeded'
# The read model's second tab field is the stamped scope: matched strictly, because the output
# itself is full of the substring "org" (the prompt, the marker).
expect_contains 'the org scope is stamped on the read' "$org_result" "$(printf 'succeeded\torg\t')"
expect_contains 'the org config reached the pod' "$org_result" 'org-team-model'

# --- The runner's GitHub token (docs/connections.md) --------------------------------------------
#
# The cluster's board is the offline entry, which holds no App: the runner pod's image helper asks
# the credential route with the attempt pair and is told so (409 GITHUB_UNAVAILABLE), saying it on
# stderr. The same pod shows the helper's cache is a Memory emptyDir (tmpfs) and that no GitHub
# token rides its env. Renewal across an expiry is the docker lane's (scripts/test-jobs.sh), whose
# host-side board can carry the stand-in mint.

echo
echo '# github credential'

gh_id="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "POST", headers, body: JSON.stringify({ command: "factory-stub-github", executor: "claude", repo: process.argv[2] }) })
    .then(async (r) => { const b = await r.json().catch(() => ({})); process.stdout.write(r.status === 201 ? String(b.id ?? "") : ""); })
    .catch(() => {});
' "$BASE/api/jobs" "$SMOKE_REPO")"
gh_result=""
for _ in $(seq 1 120); do
    gh_result="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write(j.status + "\t" + String(j.output ?? "")); })
    .catch(() => process.stdout.write("queued\t"));
' "$BASE/api/jobs/$gh_id")"
    case "$gh_result" in
    queued* | running*) sleep 1 ;;
    *) break ;;
    esac
done
expect_contains 'the github helper job ran to completion'          "$gh_result" 'succeeded'
expect_contains 'the helper reaches the credential route and is refused' "$gh_result" 'github exit 1'
expect_contains 'the refusal is the App-less board, said on stderr'  "$gh_result" 'no GitHub App installation'
expect_contains "the helper's cache is a Memory emptyDir"           "$gh_result" 'github cache tmpfs'
expect_contains 'the runner pod carries no GitHub token in its env'  "$gh_result" 'github no env token'

# --- The agent's task title --------------------------------------------------
#
# The task-title helper in the runner pod names its task on the board's attempt-pair route: the same image,
# pair env and control socket as the docker executor. The board's task carries the title with origin `agent`.

echo
echo '# task title'

title_id="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "POST", headers, body: JSON.stringify({ command: "factory-stub-title", executor: "claude", repo: process.argv[2] }) })
    .then(async (r) => { const b = await r.json().catch(() => ({})); process.stdout.write(r.status === 201 ? String(b.id ?? "") : ""); })
    .catch(() => {});
' "$BASE/api/jobs" "$SMOKE_REPO")"
title_result=""
for _ in $(seq 1 120); do
    title_result="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write(j.status + "\t" + String(j.output ?? "") + "\ttitle=" + String(j.title) + "\torigin=" + String(j.titleOrigin)); })
    .catch(() => process.stdout.write("queued\t"));
' "$BASE/api/jobs/$title_id")"
    case "$title_result" in
    queued* | running*) sleep 1 ;;
    *) break ;;
    esac
done
expect_contains 'the title helper job ran to completion'        "$title_result" 'succeeded'
expect_contains 'the helper reaches the title route and succeeds' "$title_result" 'title exit 0'
expect_contains "the board's task carries the agent's title"      "$title_result" 'title=Lane agent title'
expect_contains 'the title is marked as set by the agent'         "$title_result" 'origin=agent'

# --- The runtime connection requirement -----------------------------------------------
#
# A task with no Jira connection runs the Jira helper in its pod: the helper asks on the supervisor's
# control socket, the driver relays the ask to the board, the board holds the task queued behind an open
# requirement, and the driver ends the run as a hand-back, not a failure. The member's bind through the API
# releases it and the next run ends. The stub keeps no session, so the resumed prompt is the docker lane's (`connection_roundtrip_lane`). The connection is made only once
# the task waits: a member with a lone Jira connection would have it bound at the claim.

echo
echo '# runtime connection requirement'

conn_id="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "POST", headers, body: JSON.stringify({ command: "factory-stub-connect lane", executor: "claude", repo: process.argv[2] }) })
    .then(async (r) => { const b = await r.json().catch(() => ({})); process.stdout.write(r.status === 201 ? String(b.id ?? "") : ""); })
    .catch(() => {});
' "$BASE/api/jobs" "$SMOKE_REPO")"
conn_state=''
for _ in $(seq 1 180); do
    conn_state="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write([j.status, (j.integrationRequirements || []).length, j.bindingRevision, j.attempts].join(" ")); })
    .catch(() => process.stdout.write("queued 0 0 0"));
' "$BASE/api/jobs/$conn_id")"
    case "$conn_state" in
    'queued 1 '* | failed* | dead* | succeeded*) break ;;
    esac
    sleep 1
done
expect_contains 'the asking task is queued behind one open requirement, not failed' "$conn_state" 'queued 1 '
[ "${conn_state##* }" = 0 ] && ok 'the hand-back refunds the attempt' || bad 'the hand-back refunds the attempt' "state: $conn_state"
conn_rev="$(printf '%s' "$conn_state" | cut -d' ' -f3)"
conn_connection="$(kubectl exec -n "$NAMESPACE" "deploy/$RELEASE-factory" -c dashboard --request-timeout=60s -- \
    env LANE_ORG="$member" LANE_USER="$member_user" node --input-type=module -e '
import postgres from "postgres";
import { createConnectionGrants } from "./server/dist/db/connection-grants.js";
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
const made = await createConnectionGrants({ sql, orgId: process.env.LANE_ORG }).attachGrantConnection({
    principal: { kind: "user", userId: process.env.LANE_USER },
    provider: "jira",
    externalAccountId: "lane-account",
    authority: { scopes: ["read:jira-work"] },
    resource: { id: "lane-cloud", label: "example.atlassian.net" },
    access: "read",
});
await sql.end();
process.stdout.write(made.ok ? made.connectionId : "");
' 2>&1)"
case "$conn_connection" in
????????-????-????-????-????????????) ok 'a Jira connection is made for the task owner' ;;
*) bad 'a Jira connection is made for the task owner' "$conn_connection" ;;
esac
conn_bound="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "POST", headers, body: JSON.stringify({ connectionId: process.argv[2], bindingRevision: Number(process.argv[3]) }) })
    .then((r) => process.stdout.write(String(r.status)))
    .catch(() => process.stdout.write("000"));
' "$BASE/api/jobs/$conn_id/connections" "$conn_connection" "${conn_rev:-0}")"
[ "$conn_bound" = 200 ] && ok 'the owner binds the connection to the waiting task' ||
    bad 'the owner binds the connection to the waiting task' "status $conn_bound"
conn_result=''
for _ in $(seq 1 180); do
    conn_result="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write(j.status + "\t" + String(j.output ?? "")); })
    .catch(() => process.stdout.write("queued\t"));
' "$BASE/api/jobs/$conn_id")"
    case "$conn_result" in
    queued* | running*) sleep 1 ;;
    *) break ;;
    esac
done
expect_contains 'the released task runs again and succeeds' "$conn_result" 'succeeded'
conn_after="$(node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); process.stdout.write(String((j.integrationRequirements || []).length)); })
    .catch(() => process.stdout.write("unread"));
' "$BASE/api/jobs/$conn_id")"
[ "$conn_after" = 0 ] && ok 'the requirement is closed once the connection is bound' ||
    bad 'the requirement is closed once the connection is bound' "open requirements: $conn_after"

# --- The orphan reaper, against the real apiserver ---------------------------------
#
# An attempt's leftover the way a crashed attempt would have left it: a Job (suspended, so nothing
# runs), labelled with the job id of the job that just succeeded — the board answers `succeeded`,
# the reaper's table says gone. A declared service is a sidecar of its attempt's pod,
# so the Jobs are all the arm scans. The driver was installed with a 3s cadence, so one round must
# do it. The release label rides the Job, because that is the selector the arm scans by.

echo
echo '# orphan reaper'

orphan_lease='33333333-3333-4333-8333-333333333333'
cat <<EOF | kubectl apply -n "$NAMESPACE" -f - >/dev/null 2>&1
apiVersion: batch/v1
kind: Job
metadata:
    name: factory-orphan-reaper-probe
    labels:
        factory.job: $id
        factory.lease: $orphan_lease
        app.kubernetes.io/instance: $RELEASE
spec:
    suspend: true
    backoffLimit: 0
    template:
        spec:
            restartPolicy: Never
            automountServiceAccountToken: false
            containers: [{name: probe, image: $STUB_REF}]
EOF
kubectl get job/factory-orphan-reaper-probe -n "$NAMESPACE" >/dev/null 2>&1 &&
    ok "the synthetic orphan attempt's Job is up" ||
    bad "the synthetic orphan attempt's Job is up" 'the seed Job was not created'

kubectl wait --for=delete job/factory-orphan-reaper-probe -n "$NAMESPACE" --timeout=60s >/dev/null 2>&1 &&
    ok 'the reaper removes the orphan Job' ||
    bad 'the reaper removes the orphan Job' 'the Job survived the reaper'
save_logs "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=driver" "$DRIVER_LOG"
if [ -n "${runner_log_pid:-}" ]; then
    kill "$runner_log_pid" 2>/dev/null
    wait "$runner_log_pid" 2>/dev/null
    runner_log_pid=''
fi

# The board's jobs, as the admission and recovery phases queue and read them.
queue_job() { # queue_job <command> -> the new job's id, empty when the board refused it or answered without a string id
    local id
    id="$(ACC_AUTH="${FACTORY_TOKEN:+Bearer $FACTORY_TOKEN}" node "$REPO/scripts/acceptance-job.mjs" POST "$BASE/api/jobs" id \
        "$(node -e 'process.stdout.write(JSON.stringify({ command: process.argv[1], executor: "claude", repo: process.argv[2] }))' "$1" "$SMOKE_REPO")")"
    case "$id" in unread:* | refused:*) ;; *) printf '%s' "$id" ;; esac
}

job_brief() { # job_brief <id> -> "status|attempts|interruptions|first claimSeq|first reason"; "unread: ..." for a failed or misshapen read
    # scripts/acceptance-job.mjs validates the shape; a body without its fields is never a brief a check can pass on.
    ACC_AUTH="${FACTORY_TOKEN:+Bearer $FACTORY_TOKEN}" node "$REPO/scripts/acceptance-job.mjs" GET "$BASE/api/jobs/$1" brief
}

job_output() { # job_output <id>
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers }).then(async (r) => process.stdout.write(String((await r.json()).output ?? ""))).catch(() => {});
' "$BASE/api/jobs/$1"
}

kind_dump_stall() { # kind_dump_stall <id> — what a job that never settled was still running, once per job
    # Pods and Jobs of the job with their nodes, a describe (events included) and every container's
    # log tail, beside the timings: a stall names its own stuck pod instead of costing a re-run.
    # Diagnostics only; a kubectl error lands in the dump as text and is never a verdict.
    local file="${TIMINGS_FILE%.tsv}.stall-$1.log" sel="factory.job=$1,app.kubernetes.io/instance=$RELEASE"
    [ -e "$file" ] && return 0
    {
        echo "== job $1 at $(date -u +%T)"
        kubectl get pods,jobs -l "$sel" -n "$NAMESPACE" -o wide --request-timeout=10s 2>&1
        kubectl describe pods -l "$sel" -n "$NAMESPACE" --request-timeout=10s 2>&1
        kubectl logs --all-containers --tail=40 -l "$sel" -n "$NAMESPACE" --request-timeout=10s 2>&1
    } >"$file" 2>&1
    echo "test-k8s: job $1 did not settle; its pods: $file" >&2
}

await_brief() { # await_brief <id> <case pattern> <seconds> -> the last brief; returns 0 once it matched
    # Wall-clock seconds, not polls: each poll's request may itself take up to its own timeout.
    local until=$(($(date +%s) + $3)) b=""
    while [ "$(date +%s)" -lt "$until" ]; do
        b="$(job_brief "$1")"
        # shellcheck disable=SC2254 # the pattern is the point
        case "$b" in $2) printf '%s' "$b"; return 0 ;; esac
        sleep 1
    done
    kind_dump_stall "$1"
    printf '%s' "$b"
    return 1
}

DRIVER_DEPLOY="deployment/$RELEASE-factory-driver"
DRIVER_SEL="app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=driver"

# A forced delete removes the pod object at once, but the kubelet still stops the driver's containers on
# its node afterwards; a driver process that outlives the delete can still complete the job under its
# expired lease. kill_driver_pods [pod/<name>] deletes the driver pods hard (all of them without an
# argument) and returns once the node reports no container of theirs left running.
kill_driver_pods() {
    local rows pod node out deleted=0 confirmed=0 read=0
    if [ -n "${1:-}" ]; then
        rows="$(bounded 30 kubectl get "$1" -n "$NAMESPACE" --request-timeout=10s \
            -o jsonpath='{.metadata.name} {.spec.nodeName}{"\n"}' 2>/dev/null)" || read=1
        # A named pod must answer with its own name and node: a failed, empty or malformed read confirms nothing.
        [ "$read" = 0 ] && ! printf '%s\n' "$rows" | grep -E '^[^ ]+ [^ ]+$' >/dev/null && read=1
        bounded 60 kubectl delete "$1" -n "$NAMESPACE" --grace-period=0 --force --request-timeout=30s >/dev/null 2>&1 || deleted=1
    else
        rows="$(bounded 30 kubectl get pods -l "$DRIVER_SEL" -n "$NAMESPACE" --request-timeout=10s \
            -o jsonpath='{range .items[*]}{.metadata.name} {.spec.nodeName}{"\n"}{end}' 2>/dev/null)" || read=1
        [ "$read" = 0 ] && [ -n "$rows" ] && ! printf '%s\n' "$rows" | grep -E '^[^ ]+ [^ ]+$' >/dev/null && read=1
        bounded 60 kubectl delete pod -l "$DRIVER_SEL" -n "$NAMESPACE" --grace-period=0 --force --request-timeout=30s >/dev/null 2>&1 || deleted=1
    fi
    # Returns non-zero when the identity read failed, the delete failed or the node never confirmed the containers
    # stopped: the caller's crash check fails on that.
    [ "$read" = 0 ] || deleted=1
    [ -n "${kind_name:-}" ] || return "$deleted"
    while read -r pod node; do
        [ -n "$pod" ] || continue
        confirmed=0
        for _ in $(seq 1 60); do
            out="$(bounded 20 docker exec "$node" crictl ps -q --state running --label "io.kubernetes.pod.name=$pod" 2>/dev/null)" &&
                [ -z "$out" ] && {
                confirmed=1
                break
            }
            sleep 1
        done
        [ "$confirmed" = 1 ] || deleted=1
    done <<<"$rows"
    return "$deleted"
}
driver_logs() { kubectl logs -l "$DRIVER_SEL" -n "$NAMESPACE" --tail=-1 --request-timeout=20s 2>/dev/null; }

. "$REPO/scripts/lanes/k8s/admission.sh"

. "$REPO/scripts/lanes/k8s/workspace.sh"

. "$REPO/scripts/lanes/k8s/recovery.sh"

. "$REPO/scripts/lanes/k8s/services.sh"

. "$REPO/scripts/lanes/k8s/takeover.sh"

. "$REPO/scripts/lanes/k8s/drain.sh"

. "$REPO/scripts/lanes/k8s/control.sh"

. "$REPO/scripts/lanes/k8s/acceptance.sh"

. "$REPO/scripts/lanes/k8s/capacity.sh"

. "$REPO/scripts/lanes/k8s/mcp.sh"

. "$REPO/scripts/lanes/k8s/bench.sh"

kill "$pf_pid" 2>/dev/null
wait "$pf_pid" 2>/dev/null
pf_pid=''

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
