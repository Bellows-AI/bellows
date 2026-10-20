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
# set (#364): the cluster phase refuses every non-kind context, so the cloud shape is asserted
# where it can be — at render time — and exercised on a real cluster only by the by-hand walk in
# docs/eks-runbook.md. Phase two installs the chart into the
# local cluster with the stub executor image and the code-only no-fetch entry (dashboard.offline)
# behind that same wall, mints a member's personal access token straight into the database, queues
# a job through it, and watches it come back succeeded — real pods, no Claude, no GitHub, and the
# driver authenticating with its board token all the way. Every credential it uses is throwaway,
# generated per run; it never reads the repo's .env.
#
# Everything it creates it removes: two helm releases — the app and the local state it runs against
# (charts/factory-local-state: the database and the workspaces claim) — and the state's claims. The
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
        case "$PHASE" in all|smoke|admission|workspace|recovery|services|control) ;; *) echo 'invalid --phase'; exit 2 ;; esac
        ;;
    --help)
        echo 'Usage: scripts/test-k8s.sh [--cluster [--phase all|smoke|admission|workspace|recovery|services|control] | --netpol]'
        echo 'All cluster phases run smoke prerequisites. The default cluster phase is all.'
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
    --set "workspaces.existingClaim=$STATE_RELEASE-workspaces"
)
# The chart refuses to render without its auth values, and values-local.yaml carries none (they come
# from .env through scripts/k8s-local-values.mjs, which this script deliberately never runs). These
# are throwaway: fake OAuth client, no App. Phase one renders with fixed ones; the cluster phase
# refills AUTH_SETS with per-run random secrets.
SECRET32="$(printf '%032d' 0)"
auth_sets() { # auth_sets <publicUrl> <sessionSecret> <jobBoardToken> — (re)fills AUTH_SETS
    AUTH_SETS=(
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

save_logs() { # save_logs <label selector> <file> — every container's whole log; bounded, never fatal
    kubectl logs -l "$1" -n "$NAMESPACE" --all-containers --timestamps --prefix --tail=-1 \
        --max-log-requests=50 --request-timeout=20s >"$2" 2>&1 || true
}

ok() {
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
    check_timing ok "$1"
}

bad() {
    printf 'FAIL %s\n     %s\n' "$1" "${2:0:400}"
    fail=$((fail + 1))
    check_timing FAIL "$1"
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
        # run's org (labelled factory.task-org, issue #775) — a claim a runner pod still mounts is
        # held under pvc-protection, so they follow the Jobs above.
        kubectl delete pod "$RELEASE-origin" fs-seed fs-probe -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1
        kubectl delete service "$RELEASE-origin" -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1
        [ -z "${member:-}" ] ||
            kubectl delete pvc -l "factory.task-org=$member" -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1
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
# driver/test/k8s.test.ts, where the runner spec lives.)
credentials_clean=1
for cred in GITHUB_APP_PRIVATE_KEY GITHUB_OAUTH_CLIENT_SECRET SESSION_SECRET INGEST_TOKEN DATABASE_URL; do
    next="$(grep -A1 -- "- name: $cred\$" "$work/rendered.yaml" | sed -n '2p' | tr -d ' ')"
    if [ "$next" = 'valueFrom:' ]; then
        continue
    fi
    credentials_clean=0
    bad "credentials travel by secretKeyRef" "$cred is not read from a Secret (next line: '$next')"
done
[ "$credentials_clean" = '1' ] && ok 'every credential env is a secretKeyRef'

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
      verbs: ['create', 'delete']"
# The checkout claim that makes the re-claim fence atomic: POSTed to take the checkout, read to
# order the contenders, patched to revoke an orphaned claim before its reap, deleted to release or
# take over. `get` is safe on ConfigMaps and would not be on secrets — the claim carries no secret
# material.
expect_contains     'the driver role manages the checkout claim' "$rbac" \
    "resources: ['configmaps']
      verbs: ['create', 'get', 'delete', 'patch']"
# Issue #773: the gate and the declared services are sidecars of the runner Job's pod, so the
# driver creates no pod, no Service and reads no event. Pods are listed to find a Job's pod and
# deleted by the re-claim fence's sweep, nothing more.
expect_contains     'the driver role lists and deletes pods, never creates one' "$rbac" \
    "resources: ['pods']
      verbs: ['delete', 'list']"
# Issue #775: the driver creates one task volume claim per root thread, reads it back and, from the
# slices that follow, deletes it.
expect_contains     'the driver role manages the task volume claims' "$rbac" \
    "resources: ['persistentvolumeclaims']
      verbs: ['create', 'get', 'list', 'delete']"
expect_not_contains 'the driver role creates no Service'    "$rbac" "resources: ['services']"
expect_not_contains 'the driver role reads no event'        "$rbac" "resources: ['events']"
# The gate sidecar's in-place resize (issue #773): patch on the resize subresource and no more.
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

# The dashboard writes checkouts into the state release's claim, so an app reinstall keeps them —
# and the app release creates no claim of its own. The driver is told how to create a thread's task
# volume (issue #775), not which claim to mount.
expect_contains 'the dashboard mounts the workspaces claim' "$(cat "$work/rendered.yaml")" \
    "claimName: $STATE_RELEASE-workspaces"
expect_not_contains 'the driver is told no workspaces claim' "$(cat "$work/rendered.yaml")" 'name: WORKSPACE_VOLUME'
expect_contains 'the driver is told the task volume access mode' "$(cat "$work/rendered.yaml")" \
    'name: TASK_VOLUME_ACCESS_MODE'
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
render | grep -q 'value: "7200000"' && ok 'the job timeout renders as an integer' ||
    bad 'the job timeout renders as an integer' "$(render | grep -A1 DRIVER_JOB_TIMEOUT_MS)"
render | grep -A1 'name: GATE_TIMEOUT_MS' | grep -q 'value: "1800000"' && ok 'the gate timeout renders as an integer' ||
    bad 'the gate timeout renders as an integer' "$(render | grep -A1 GATE_TIMEOUT_MS)"

# Runner pod resources (issue #360): requests by default so Karpenter and the Cluster Autoscaler
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
# Gate pod resources (issue #507): a gate runs the whole suite, so it requests more than a runner.
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
expect_contains 'the state chart names the workspaces claim'  "$state" "name: $STATE_RELEASE-workspaces"
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
# Exactly one standalone claim — the workspaces one. The database's is the set's, so a second
# `kind: PersistentVolumeClaim` would mean the old Deployment-era claim came back beside it and
# helm would delete the data on uninstall again.
claims="$(printf '%s\n' "$state" | grep -c '^kind: PersistentVolumeClaim' || true)"
if [ "$claims" = 1 ]; then
    ok 'the workspaces claim is the only standalone claim'
else
    bad 'the workspaces claim is the only standalone claim' "found $claims"
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
COLLECTOR_IMAGE="$(awk '$1 == "image:" && /opentelemetry-collector-contrib/ { print $2; exit }' "$work/rendered.yaml")"
case "$COLLECTOR_IMAGE" in
*:[0-9]*) ok 'the collector image is pinned to a version' ;;
*) bad 'the collector image is pinned to a version' "got '$COLLECTOR_IMAGE'" ;;
esac

# A changed Secret or collector config rolls the pods that read it at start.
expect_contains 'pods roll on a Secret change'        "$gh" 'checksum/secret:'
expect_contains 'the collector rolls on a config change' "$gh" 'checksum/config:'

# One dashboard, replaced not rolled: an in-process workspace writer, unlocked migrations, and an
# RWO claim that cannot attach twice.
gh_dashboard="$(awk '/^# Source: factory\/templates\/deployment.yaml/,/^---/' <<<"$gh")"
expect_contains 'the dashboard runs exactly one replica' "$gh_dashboard" 'replicas: 1'
expect_contains 'the dashboard is recreated, never rolled' "$gh_dashboard" 'type: Recreate'
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

# Selectors hold only name/instance/component: they are immutable, so a chart-version label in
# one would make every upgrade an apiserver refusal.
selectors="$(grep -A4 'matchLabels:' <<<"$gh_dashboard$gh_driver")"
expect_not_contains 'selectors carry no version label'  "$selectors" 'app.kubernetes.io/version'
expect_not_contains 'selectors carry no managed-by'     "$selectors" 'managed-by'

# The checkouts survive `helm uninstall` when the chart created their claim.
expect_contains 'the chart-created claim is kept on uninstall' "$gh" 'helm.sh/resource-policy: keep'

# The collector always sends the ingest header by reference: with secret.existingSecret the token
# is in the Secret while telemetry.ingestToken is empty, and a header gated on the value would
# leave an authenticated board answering every export 401.
byo="$(helm template "$RELEASE" charts/factory --set secret.create=false --set secret.existingSecret=mine \
    --set auth.publicUrl=https://f.example --set auth.oauthClientId=c --set github.appId=1 \
    --set artifacts.s3.bucket=factory-artifacts --set artifacts.s3.region=us-east-1 2>&1)"
expect_contains 'the collector sends the ingest header with a managed Secret' "$byo" \
    'X-Factory-Ingest-Token: ${env:INGEST_TOKEN}'
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
# The artifact store (#764): the dashboard runs as its own ServiceAccount, which carries the IRSA
# annotation, and the s3 backend refuses to render without a bucket.
expect_contains 'the dashboard has its own ServiceAccount' "$gh" "serviceAccountName: $RELEASE-factory-dashboard"
irsa="$(gh_render --set 'dashboard.serviceAccount.annotations.eks\.amazonaws\.com/role-arn=arn:aws:iam::1:role/factory')"
expect_contains 'the IRSA role annotation lands on the dashboard ServiceAccount' "$irsa" \
    'eks.amazonaws.com/role-arn: arn:aws:iam::1:role/factory'
[ "$(grep -c '^kind: ServiceAccount' <<<"$(gh_render --set dashboard.serviceAccount.create=false)")" -lt \
    "$(grep -c '^kind: ServiceAccount' <<<"$gh")" ] && ok 'serviceAccount.create=false renders no dashboard ServiceAccount' ||
    bad 'serviceAccount.create=false renders no dashboard ServiceAccount' 'the ServiceAccount count did not drop'
expect_contains 'the s3 backend reaches the dashboard as environment' "$gh" 'name: ARTIFACTS_S3_BUCKET'
expect_contains 'a credentials Secret becomes the static keys' \
    "$(gh_render --set artifacts.credentialsExistingSecret=store-keys)" 'key: secret-access-key'
expect_not_contains 'no credentials Secret leaves Pod Identity and IRSA to the credential chain' "$gh" 'ARTIFACTS_ACCESS_KEY_ID'
refuses 'an s3 backend with no bucket is refused' 'artifacts.s3.bucket is required' \
    "${GH_SETS[@]}" --set artifacts.s3.bucket=
refuses 'an unknown artifacts backend is refused' 'artifacts.backend must be' \
    "${GH_SETS[@]}" --set artifacts.backend=gcs
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

# --- The optional ingress (#359): off by default, never disagreeing with auth.publicUrl --------

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
expect_contains 'the ingress backs the dashboard service by name' "$ingress_doc" "name: $RELEASE-factory"
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

# --- The registry prefix (#358): one value, every image the release names ---------------------

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

# The runner group's scheduling knobs (issue #361): forwarded to the driver as JSON, which is how
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
# The gate sidecar's resize (issue #773) changes the `gate` container alone.
expect_contains 'the admission policy matches the gate resize' "$admission" "operations: ['UPDATE']
              resources: ['pods/resize']"
expect_contains 'the admission policy lets a resize change only the gate' "$admission" "c.name == 'gate'"
# The Role's namespace-wide configmaps `patch` (issue #821) reaches only a checkout claim, and only
# to revoke it: labels and data kept, no annotation but factory.revoked changed.
expect_contains 'the admission policy matches configmap updates' "$admission" "operations: ['UPDATE']
              resources: ['configmaps']"
expect_contains 'the admission policy updates only checkout claims' "$admission" \
    "oldObject.metadata.name.matches('^factory-job-[0-9a-f-]+-claim\$')"
expect_contains 'the admission policy keeps a claim update to its data' "$admission" 'object.data == oldObject.data'
expect_contains 'the admission policy keeps a claim update to its labels' "$admission" \
    'object.metadata.labels == oldObject.metadata.labels'
expect_contains 'the admission policy lets a claim update change only factory.revoked' "$admission" \
    "k == 'factory.revoked'"
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

# The chart-pod egress, split per component and port-scoped (#382). A runner reached every port on
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

# Node churn vs long runs (issue #362). The do-not-disrupt opt-out is off by default in both
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

# --- The EKS-shaped render lane (#364): the cloud shape, rendered offline ----------------------
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
    --set workspaces.storageClass=efs-ap
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
# The claim and its class: the EFS decision, pinned so a values regression cannot silently drop
# the cloud install back onto a default class that cannot serve ReadWriteMany.
expect_contains 'the EKS shape names the EFS storage class on the claim' "$eks" 'storageClassName: "efs-ap"'
expect_contains 'the EFS claim stays ReadWriteMany' "$eks" '- ReadWriteMany'
# The chart's gate request (issue #507): a gate runs the whole suite, so it requests more than a runner.
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
# The runner group's scheduling: the driver is handed the node selector and tolerations as JSON
# (issue #361), the tainted node group's contract, in the same render that names the storage class.
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
# The port scoping (#382) survives the cloud value set: an EKS install must not quietly go back to
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

# --- Phase three: the enforcing-CNI lane (issue #382) -------------------------------------------
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

    # The port scoping (#382), positive half: the dashboard stays reachable where it actually
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
# `driver/src/scripts/supervisor.cjs`), and every task has a checkout to sync (issue #263). It
# starts through scripts/stub-agent.sh, beside ctl-agent.cjs, over the node-owned mailbox mount
# points: the task supervisor's agent contract (driver/test/lane-stubs.test.ts), which the real
# entrypoints honor.
cp docker/claude-executor/ctl-agent.cjs docker/claude-executor/factory-launch.sh docker/claude-executor/factory-tool.cjs \
    docker/claude-executor/tool-bash.sh scripts/stub-agent.sh scripts/stub-runner.Dockerfile "$work/"
cp docker/claude-executor/github-credential.cjs "$work/"
cp scripts/k8s-stub.sh "$work/stub.sh"
printf 'FROM %s\nCOPY stub.sh /stub.sh\nCOPY github-credential.cjs /usr/local/bin/\nENTRYPOINT ["/usr/local/bin/factory-launch","sh","/usr/local/bin/stub-agent.sh","sh","/stub.sh"]\n' "$STUB_IMAGE-base" >"$work/stub.Dockerfile"
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
docker image inspect "$COLLECTOR_IMAGE" >/dev/null 2>&1 || docker pull -q "$COLLECTOR_IMAGE" >"$work/collector-pull.log" 2>&1 &
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
# The collector is a pinned upstream image, not rebuilt: kind skips it once the node holds it.
kind load docker-image "$COLLECTOR_IMAGE" --name "$kind_name" >/dev/null || {
    echo "test-k8s: could not load $COLLECTOR_IMAGE into the kind cluster $kind_name"
    exit 1
}

echo "installing the releases $STATE_RELEASE and $RELEASE"
begin_phase deploy
deploy_started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
helm install "$STATE_RELEASE" charts/factory-local-state -n "$NAMESPACE" >/dev/null || {
    echo 'test-k8s: helm install of the state chart failed'
    exit 1
}
state_installed=1
# Fresh throwaway secrets per run; the board token is what the driver presents on every claim, so a
# job that comes back succeeded proves it end to end. The origin is the port-forward's below.
PORT=18080
BASE="http://127.0.0.1:$PORT"
auth_sets "$BASE" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)"
helm install "$RELEASE" charts/factory "${LOCAL_SETS[@]}" "${AUTH_SETS[@]}" \
    --set "dashboard.image.repository=$DASH_REPO" --set-string "dashboard.image.tag=$RELEASE" \
    --set "driver.image.repository=$DRIVER_REPO" --set-string "driver.image.tag=$RELEASE" \
    --set "driver.executorImages.claudeCode=$STUB_REF" \
    --set "driver.executorImages.opencode=$STUB_REF" \
    --set driver.reapIntervalMs=3000 --set driver.reapGraceMs=1000 \
    --set "driver.repoCloneBase=git://$RELEASE-origin:9418" \
    --set-string driver.leaseSeconds=120 --set driver.terminationGracePeriodSeconds=70 \
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
    kubectl get pods -l "app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" 2>&1 | head -20
    printf '\n%d passed, %d failed\n' "$pass" "$fail"
    exit 1
}

first_runner_job() { # first_runner_job <id> -> the name of the runner Job claim 1 created
    kubectl get jobs -l "factory.job=$1,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --request-timeout=10s \
        -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.metadata.annotations.factory\.claim-seq}{"\n"}{end}' \
        2>/dev/null | awk '$2 == "1" { print $1; exit }'
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
        # DAC_OVERRIDE (issue #814).
        kubectl exec "$1" -c supervisor -n "$NAMESPACE" --request-timeout=10s -- test -f "$2.ready-$1" \
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
            kubectl exec "$pod" -c supervisor -n "$NAMESPACE" --request-timeout=10s -- test -f "$1.ready-$pod" \
                >/dev/null 2>&1 || continue
            kubectl exec "$pod" -c supervisor -n "$NAMESPACE" --request-timeout=10s -- touch "$1" \
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

# The member's selection (issue #263): POST /api/jobs refuses a create whose repo is not the author's
# own ready selection. With no GitHub there is nothing to clone, so the fixture is the ready
# user_repo row — and, for the runner's own clone (issue #775), an origin served inside the
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
    psql -q -v ON_ERROR_STOP=1 -v "member=$member" -v "user=$member_user" \
    -v "owner=${SMOKE_REPO%%/*}" -v "name=${SMOKE_REPO#*/}" \
    postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
insert into user_repo (org_id, user_id, repo_owner, repo_name, status, ready_at)
values (:'member', :'user', :'owner', :'name', 'ready', now());
SQL
)" && ok 'the member selects a ready repository' || {
    bad 'the member selects a ready repository' "$selected"
    give_up
}
# One line, no double quotes or backslashes: it is interpolated into the JSON override below.
origin_script="set -e; mkdir -p /origins/${SMOKE_REPO%%/*}; git init -q --bare -b main /origins/$SMOKE_REPO.git;
git init -q -b main /tmp/seed;
git -C /tmp/seed -c user.name=test-k8s -c user.email=test-k8s@localhost commit -q --allow-empty -m init;
git -C /tmp/seed push -q /origins/$SMOKE_REPO.git main;
exec git daemon --reuseaddr --base-path=/origins --export-all --enable=receive-pack --listen=0.0.0.0 --port=9418 /origins"
origin_script="$(printf '%s' "$origin_script" | tr '\n' ' ')"
kubectl run "$RELEASE-origin" -n "$NAMESPACE" --image="$STUB_REF" --restart=Never --command \
    --overrides="$(
        cat <<EOF
{"spec":{"automountServiceAccountToken":false,
"volumes":[{"name":"o","emptyDir":{}}],
"containers":[{"name":"origin","image":"$STUB_REF","imagePullPolicy":"IfNotPresent",
"command":["sh","-c","$origin_script"],
"readinessProbe":{"tcpSocket":{"port":9418}},
"volumeMounts":[{"name":"o","mountPath":"/origins"}]}]}}
EOF
    )" -- sh >/dev/null 2>&1
kubectl expose pod "$RELEASE-origin" -n "$NAMESPACE" --port=9418 >/dev/null 2>&1
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

# --- The orphan reaper (issue #301), against the real apiserver ---------------------------------
#
# An attempt's leftover the way a crashed attempt would have left it: a Job (suspended, so nothing
# runs), labelled with the job id of the job that just succeeded — the board answers `succeeded`,
# the reaper's table says gone. A declared service is a sidecar of its attempt's pod (issue #773),
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
queue_job() { # queue_job <command> -> the new job's id, empty when the board refused it
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { method: "POST", headers, body: JSON.stringify({ command: process.argv[2], executor: "claude", repo: process.argv[3] }) })
    .then(async (r) => { const b = await r.json().catch(() => ({})); process.stdout.write(r.status === 201 ? String(b.id ?? "") : ""); })
    .catch(() => {});
' "$BASE/api/jobs" "$1" "$SMOKE_REPO"
}

job_brief() { # job_brief <id> -> "status|attempts|interruptions|first claimSeq|first reason"
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const j = await r.json(); const l = j.interruptions ?? []; process.stdout.write([j.status, j.attempts, l.length, l[0]?.claimSeq ?? "", l[0]?.reason ?? ""].join("|")); })
    .catch(() => process.stdout.write("unread"));
' "$BASE/api/jobs/$1"
}

job_output() { # job_output <id>
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers }).then(async (r) => process.stdout.write(String((await r.json()).output ?? ""))).catch(() => {});
' "$BASE/api/jobs/$1"
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
    printf '%s' "$b"
    return 1
}

DRIVER_DEPLOY="deployment/$RELEASE-factory-driver"
DRIVER_SEL="app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=driver"
driver_logs() { kubectl logs -l "$DRIVER_SEL" -n "$NAMESPACE" --tail=-1 --request-timeout=20s 2>/dev/null; }

if selected_phase admission; then
begin_phase admission
# The admission policy, against the real apiserver. The job above proves it admits what the driver
# specs; these prove it refuses what the Role alone would allow. Server-side dry runs as the
# driver's own ServiceAccount: admission runs in full, nothing is persisted.
DRIVER_SA="system:serviceaccount:$NAMESPACE:$RELEASE-factory-driver"

# The executor hardening (#382), in the two spellings these probes need. HARD_C goes INSIDE a
# container's flow mapping; the pod half is in probe_pod's own body. Every probe below carries
# both, because the policy now REQUIRES them — a probe shaped like the driver's own pod is a probe
# that is hardened, and the ones that deliberately are not are the four at the end.
HARD_C='securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}'
# The pod half, as a VARIABLE rather than a quoted default inside the heredoc: `${4:-'{…}'}`
# expands the quotes literally, and the apiserver then reads a YAML string where it wants a
# securityContext — a BadRequest that never reaches admission, so every probe fails with the same
# unrelated message and none of them tests anything.
HARD_POD='{seccompProfile: {type: RuntimeDefault}}'

# The driver creates pods only through Jobs (issue #773): the Role grants no pod create and the
# policy matches Jobs alone, so each probe is a Job whose pod template carries the spec lines.
probe_pod() { # probe_pod <name> <extra spec lines> [<extra labels>] [<pod securityContext>]
    cat <<EOF
apiVersion: batch/v1
kind: Job
metadata:
    name: admission-probe-$1
    labels: {factory.job: admission-probe}
spec:
    template:
        metadata: {labels: {factory.job: admission-probe${3:+, $3}}}
        spec:
            automountServiceAccountToken: false
            restartPolicy: Never
            securityContext: ${4:-$HARD_POD}
$(printf '%s\n' "$2" | sed 's/^/        /')
EOF
}
as_driver() { kubectl create --as="$DRIVER_SA" -n "$NAMESPACE" --dry-run=server -f - 2>&1; }

allowed="$(probe_pod ok "    containers: [{name: c, image: alpine, $HARD_C, envFrom: [{secretRef: {name: factory-job-probe-env}}]}]" | as_driver)"
expect_contains 'the policy admits a pod reading a per-attempt Secret' "$allowed" 'created (server dry run)'
stolen="$(probe_pod steal "    containers: [{name: c, image: alpine, $HARD_C, envFrom: [{secretRef: {name: $RELEASE-factory-dashboard}}]}]" | as_driver)"
expect_contains 'the policy refuses a pod reading the dashboard Secret' "$stolen" 'may read only its own per-attempt Secrets'
mounted="$(probe_pod mount "    containers: [{name: c, image: alpine, $HARD_C}]
    volumes: [{name: s, secret: {secretName: $RELEASE-factory-dashboard}}]" | as_driver)"
expect_contains 'the policy refuses a pod mounting the dashboard Secret' "$mounted" 'may mount only a task volume claim'
host="$(probe_pod host "    containers: [{name: c, image: alpine, $HARD_C}]
    volumes: [{name: h, hostPath: {path: /}}]" | as_driver)"
expect_contains 'the policy refuses a hostPath pod' "$host" 'may mount only a task volume claim'
TASK_CLAIM=factory-task-44444444-4444-4444-8444-444444444444-1
task="$(probe_pod task "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: task, mountPath: /task}]}]
    volumes: [{name: task, persistentVolumeClaim: {claimName: $TASK_CLAIM}}]" | as_driver)"
expect_contains 'the policy admits a pod mounting a task volume whole' "$task" 'created (server dry run)'
reviewer_home="$(probe_pod reviewerhome "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: task, mountPath: /h, subPath: .factory/reviewer}]}]
    volumes: [{name: task, persistentVolumeClaim: {claimName: $TASK_CLAIM}}]" | as_driver)"
expect_contains 'the policy admits a pod mounting the reviewer home of a task volume' "$reviewer_home" 'created (server dry run)'
workspaces="$(probe_pod workspaces "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: w, mountPath: /w}]}]
    volumes: [{name: w, persistentVolumeClaim: {claimName: $STATE_RELEASE-workspaces}}]" | as_driver)"
expect_contains 'the policy refuses a pod mounting the workspaces claim' "$workspaces" 'may mount only a task volume claim'
other="$(probe_pod othersub "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: task, mountPath: /w, subPath: other}]}]
    volumes: [{name: task, persistentVolumeClaim: {claimName: $TASK_CLAIM}}]" | as_driver)"
expect_contains 'the policy refuses a task volume mounted at any other subPath' "$other" 'only whole or at the reviewer home'
expr="$(probe_pod expr "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: task, mountPath: /w, subPathExpr: '\$(HOME)'}]}]
    volumes: [{name: task, persistentVolumeClaim: {claimName: $TASK_CLAIM}}]" | as_driver)"
expect_contains 'the policy refuses a subPathExpr task volume mount' "$expr" 'only whole or at the reviewer home'
task_claim() { # task_claim <name> <access mode> — the PersistentVolumeClaim the driver creates
    cat <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
    name: $1
    labels: {factory.task-root: 44444444-4444-4444-8444-444444444444, factory.task-generation: "1"}
spec:
    accessModes: [$2]
    resources: {requests: {storage: 1Gi}}
EOF
}
task_ok="$(task_claim "$TASK_CLAIM" ReadWriteOnce | as_driver)"
expect_contains 'the policy admits a task volume claim' "$task_ok" 'created (server dry run)'
task_rwx="$(task_claim "$TASK_CLAIM" ReadWriteMany | as_driver)"
expect_contains 'the policy refuses a ReadWriteMany task volume claim' "$task_rwx" 'is never ReadWriteMany'
task_name="$(task_claim factory-task-55555555-5555-4555-8555-555555555555-1 ReadWriteOnce | as_driver)"
expect_contains 'the policy refuses a task volume claim not named for its labelled root' "$task_name" \
    'named for their labelled thread root and generation'
task_other="$(task_claim scratch ReadWriteOnce | as_driver)"
expect_contains 'the policy refuses a claim that is not a task volume' "$task_other" \
    'named for their labelled thread root and generation'
deleted="$(kubectl delete secret "$RELEASE-factory-dashboard" --as="$DRIVER_SA" -n "$NAMESPACE" --dry-run=server 2>&1)"
expect_contains 'the policy refuses deleting an unlabelled Secret' "$deleted" 'only objects labelled factory.job'

# The checkout claim's revoke (issue #821): the one update the driver may make, to a claim alone.
# The probe objects are made as the test's own identity, which no driver policy matches.
PROBE_CLAIM="factory-job-00000000-0000-4000-8000-000000000821-claim"
kubectl create configmap "$PROBE_CLAIM" -n "$NAMESPACE" --from-literal=holder=probe --from-literal=claimSeq=1 >/dev/null
kubectl label configmap "$PROBE_CLAIM" -n "$NAMESPACE" factory.job=admission-probe >/dev/null
kubectl create configmap admission-probe-plain -n "$NAMESPACE" --from-literal=k=v >/dev/null
kubectl label configmap admission-probe-plain -n "$NAMESPACE" factory.job=admission-probe >/dev/null
as_driver_patch() { kubectl patch configmap "$1" --as="$DRIVER_SA" -n "$NAMESPACE" --type=merge -p "$2" --dry-run=server 2>&1; }
revoked="$(as_driver_patch "$PROBE_CLAIM" '{"metadata":{"annotations":{"factory.revoked":"probe"}}}')"
expect_contains 'the policy admits revoking a checkout claim' "$revoked" 'patched'
rewritten="$(as_driver_patch "$PROBE_CLAIM" '{"data":{"holder":"thief"}}')"
expect_contains 'the policy refuses a claim patch that changes its data' "$rewritten" 'changes only factory.revoked'
relabelled="$(as_driver_patch "$PROBE_CLAIM" '{"metadata":{"labels":{"factory.lease":"thief"}}}')"
expect_contains 'the policy refuses a claim patch that changes its labels' "$relabelled" 'changes only factory.revoked'
annotated="$(as_driver_patch "$PROBE_CLAIM" '{"metadata":{"annotations":{"other":"x"}}}')"
expect_contains 'the policy refuses a claim patch that adds another annotation' "$annotated" 'changes only factory.revoked'
plain="$(as_driver_patch admission-probe-plain '{"metadata":{"annotations":{"factory.revoked":"probe"}}}')"
expect_contains 'the policy refuses patching a configmap that is not a checkout claim' "$plain" 'updates only checkout claims'
kubectl delete configmap "$PROBE_CLAIM" admission-probe-plain -n "$NAMESPACE" >/dev/null

# Issue #382, the half that cannot be asserted by rendering. Phase one proved the CEL is in the
# document; this proves a real apiserver COMPILES it and refuses on it. The distinction matters
# more here than anywhere else in this script: `failurePolicy: Fail` means an expression that does
# not compile refuses every pod the driver creates, so a policy that renders and does not work is
# a total outage — and one that compiles but matches nothing passes phase one unchanged. Each
# probe below removes exactly one field from the shape the probes above all carry.
no_seccomp="$(probe_pod noseccomp "    containers: [{name: c, image: alpine, $HARD_C}]" '' '{}' | as_driver)"
expect_contains 'the policy refuses a pod with no seccomp profile' "$no_seccomp" 'RuntimeDefault seccomp profile'
wrong_seccomp="$(probe_pod unconfined "    containers: [{name: c, image: alpine, $HARD_C}]" '' \
    '{seccompProfile: {type: Unconfined}}' | as_driver)"
expect_contains 'the policy refuses an Unconfined seccomp profile' "$wrong_seccomp" 'RuntimeDefault seccomp profile'
no_sc="$(probe_pod nosc '    containers: [{name: c, image: alpine}]' | as_driver)"
expect_contains 'the policy refuses a container with no securityContext at all' "$no_sc" 'allowPrivilegeEscalation: false'
escalating="$(probe_pod escalate \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: true, capabilities: {drop: [ALL]}}}]' |
    as_driver)"
expect_contains 'the policy refuses a container that may escalate' "$escalating" 'allowPrivilegeEscalation: false'
# The container-level override, against the real apiserver: the pod keeps RuntimeDefault and the
# CONTAINER asks for Unconfined. Admitted, this is a runner with no syscall filter at all while
# every pod-level assertion still reads green — which is why it is probed rather than reasoned about.
container_unconfined="$(probe_pod cseccomp \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}, seccompProfile: {type: Unconfined}}}]' |
    as_driver)"
expect_contains 'the policy refuses a container that overrides the pod seccomp profile' \
    "$container_unconfined" 'may not override the pod seccomp profile'

# Issue #814: the one capability add the policy admits — SETUID and SETGID, on a runner Job's
# `agent` — and nothing past it: another capability, another container, or a bare Pod.
probe_job() { # probe_job <name> <container name> <capabilities to add>
    cat <<EOF
apiVersion: batch/v1
kind: Job
metadata:
    name: admission-probe-$1
    labels: {factory.job: admission-probe}
spec:
    template:
        metadata: {labels: {factory.job: admission-probe}}
        spec:
            automountServiceAccountToken: false
            restartPolicy: Never
            securityContext: $HARD_POD
            containers: [{name: $2, image: alpine, securityContext: {allowPrivilegeEscalation: false, runAsUser: 0, capabilities: {drop: [ALL], add: [$3]}}}]
EOF
}
launch="$(probe_job launch agent 'SETUID, SETGID' | as_driver)"
expect_contains 'the policy admits the agent launch pair on a runner Job' "$launch" 'created (server dry run)'
launch_more="$(probe_job launchmore agent 'SETUID, NET_RAW' | as_driver)"
expect_contains 'the policy refuses any other capability on the agent' "$launch_more" 'may not be privileged or add capabilities'
launch_other="$(probe_job launchother supervisor 'SETUID' | as_driver)"
expect_contains 'the policy refuses the launch pair on any other container' "$launch_other" 'may not be privileged or add capabilities'
# A bare Pod is refused before admission: the Role grants no pod create at all (issue #773).
bare_pod="$(as_driver <<EOF
apiVersion: v1
kind: Pod
metadata:
    name: admission-probe-bare
    labels: {factory.job: admission-probe}
spec:
    automountServiceAccountToken: false
    restartPolicy: Never
    securityContext: $HARD_POD
    containers: [{name: agent, image: alpine, $HARD_C}]
EOF
)"
expect_contains 'the driver may not create a bare Pod' "$bare_pod" 'cannot create resource "pods"'

no_drop="$(probe_pod nodrop \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: []}}}]' |
    as_driver)"
expect_contains 'the policy refuses a container that drops nothing' "$no_drop" 'must drop ALL capabilities'
# There is no opt-out (issue #773): the label a declared unhardened service once carried buys a
# container nothing.
opted_out="$(probe_pod optout \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: false}}]' \
    'factory.unhardened: "true"' | as_driver)"
expect_contains 'the policy refuses the retired unhardened label its capabilities' "$opted_out" 'must drop ALL capabilities'

# The task pod's shape (issue #773): its declared services are `svc-` sidecars named on its
# loopback. The driver's own shape is the runner Job's dry run above; these refuse each way out.
sidecar="$(probe_pod sidecar "    initContainers: [{name: svc-db, image: alpine, restartPolicy: Always, $HARD_C}]
    containers: [{name: c, image: alpine, $HARD_C}]
    hostAliases: [{ip: 127.0.0.1, hostnames: [db]}]" | as_driver)"
expect_contains 'the policy admits a svc- sidecar named on loopback' "$sidecar" 'created (server dry run)'
aliased="$(probe_pod alias "    containers: [{name: c, image: alpine, $HARD_C}]
    hostAliases: [{ip: 10.0.0.1, hostnames: [db]}]" | as_driver)"
expect_contains 'the policy refuses a hostAlias off loopback' "$aliased" 'hostAliases only to 127.0.0.1'
main_svc="$(probe_pod mainsvc "    containers: [{name: svc-db, image: alpine, $HARD_C}]" | as_driver)"
expect_contains 'the policy refuses a svc- main container' "$main_svc" 'only as restartable init containers'
once_svc="$(probe_pod oncesvc "    initContainers: [{name: svc-db, image: alpine, $HARD_C}]
    containers: [{name: c, image: alpine, $HARD_C}]" | as_driver)"
expect_contains 'the policy refuses a svc- init container that is not restartable' "$once_svc" \
    'only as restartable init containers'
proxy="$(probe_pod proxy "    initContainers: [{name: proxy, image: alpine, restartPolicy: Always, $HARD_C}]
    containers: [{name: c, image: alpine, $HARD_C}]" | as_driver)"
expect_contains 'the policy refuses a restartable init container that is neither gate nor svc-' "$proxy" \
    'only as restartable init containers'

# --- The agent's tool isolation (issue #814), on the real kubelet ----------------------------------
#
# The stub's one tool runs through the CLI's shell — the tool broker — and signals everything its
# uid may: `kill -TERM 1; kill -KILL -1`. Under the agent container's own securityContext (root, the
# launch pair, factory-launch's drop), it reaches only its own processes, and the run succeeds.

echo
echo '# tool isolation'
begin_phase tool-isolation

isolated="$(queue_job 'factory-stub-kill-tools')"
isolated_end="$(await_brief "$isolated" 'succeeded|*' 180)"
case "$isolated_end" in
"succeeded|1|"*) ok 'a run whose tool signals everything it may succeeds in one attempt' ;;
*) bad 'a run whose tool signals everything it may succeeds in one attempt' "status|attempts|…: $isolated_end" ;;
esac
expect_contains 'the agent survived its tool' "$(job_output "$isolated")" 'agent survived'
expect_contains 'the tool ran as the tool uid' "$(job_output "$isolated")" 'the tool ran as 1001'
kubectl delete jobs -l "factory.job=$isolated,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
    --ignore-not-found --wait=false >/dev/null 2>&1

# --- The workspace boundary, probed from inside a pod (issue #382) ------------------------------
fi

if selected_phase workspace; then
begin_phase workspace
#
# The admission probes above prove the driver cannot SPEC a pod that mounts a claim that is not a
# task volume. This proves a pod that mounted its own thread's task volume (issue #775) cannot
# REACH another thread's — the other half, and the half a policy cannot give you. Each thread has
# its own claim, so the other volume is not merely unreadable, it is absent from the pod:
# traversal and symlinks have nothing to resolve against. That is a property worth proving rather
# than asserting, because the failure mode if it were wrong is silent.
#
# No CNI involvement, no NetworkPolicy: this lane runs on the plain kind cluster.
echo
echo '# the task volume boundary'

uuid4() { # a legal thread-root uuid, fresh per run — two runs never share a volume
    printf '%s-%s-4%s-8%s-%s\n' "$(openssl rand -hex 4)" "$(openssl rand -hex 2)" \
        "$(openssl rand -hex 2 | cut -c2-)" "$(openssl rand -hex 2 | cut -c2-)" "$(openssl rand -hex 6)"
}
VOLUME_A="factory-task-$(uuid4)-1"
VOLUME_B="factory-task-$(uuid4)-1"
for volume in "$VOLUME_A" "$VOLUME_B"; do
    kubectl apply -n "$NAMESPACE" -f - >/dev/null 2>&1 <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
    name: $volume
    labels: {factory.task-org: $member}
spec:
    accessModes: [ReadWriteOnce]
    resources: {requests: {storage: 1Gi}}
EOF
done

# The seeder mounts both volumes, which one pod of the driver's could not: it runs as this script's
# kubeconfig identity, which the policy's matchConditions do not select.
kubectl run fs-seed -n "$NAMESPACE" --image=alpine:3 --restart=Never --command \
    --overrides="$(
        cat <<EOF
{"spec":{"automountServiceAccountToken":false,
"volumes":[{"name":"a","persistentVolumeClaim":{"claimName":"$VOLUME_A"}},{"name":"b","persistentVolumeClaim":{"claimName":"$VOLUME_B"}}],
"containers":[{"name":"fs-seed","image":"alpine:3",
"command":["sh","-c","echo mine > /a/secret.txt && echo theirs > /b/secret.txt && echo seeded"],
"volumeMounts":[{"name":"a","mountPath":"/a"},{"name":"b","mountPath":"/b"}]}]}}
EOF
    )" -- sh >/dev/null 2>&1
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s pod/fs-seed -n "$NAMESPACE" >/dev/null 2>&1
seeded="$(kubectl logs fs-seed -n "$NAMESPACE" 2>&1 || true)"
expect_contains 'two task volumes are seeded through a two-claim mount' "$seeded" 'seeded'

# The probe mounts ONLY thread A's volume, at /task as the driver specs it. Every check prints a
# labelled line, so a check that never ran is a missing line rather than a silent pass.
#
# One line, single quotes only, no backslashes: the script is interpolated into a JSON override,
# and a `\n` or a `"` here would have to be JSON-escaped by something. Keeping the script free of
# both is cheaper than carrying an encoder, and it is why `ls` output is read space-separated
# (command substitution already collapses it) instead of through `tr`.
probe_script="cd /task;
echo own=\$(cat secret.txt 2>/dev/null || echo UNREADABLE);
echo files=\$(ls -A /task 2>/dev/null);
echo found=\$(find / -name secret.txt 2>/dev/null);
echo relative=\$(cat ../b/secret.txt 2>/dev/null && echo LEAKED || echo denied);
ln -sf / escape 2>/dev/null;
echo symlink=\$(cat escape/b/secret.txt 2>/dev/null && echo LEAKED || echo denied);
rm -f escape"
probe_script="$(printf '%s' "$probe_script" | tr '\n' ' ')"
kubectl run fs-probe -n "$NAMESPACE" --image=alpine:3 --restart=Never --command \
    --overrides="$(
        cat <<EOF
{"spec":{"automountServiceAccountToken":false,
"securityContext":{"seccompProfile":{"type":"RuntimeDefault"}},
"volumes":[{"name":"task","persistentVolumeClaim":{"claimName":"$VOLUME_A"}}],
"containers":[{"name":"fs-probe","image":"alpine:3",
"securityContext":{"allowPrivilegeEscalation":false,"capabilities":{"drop":["ALL"]}},
"command":["sh","-c","$probe_script"],
"volumeMounts":[{"name":"task","mountPath":"/task"}]}]}}
EOF
    )" -- sh >/dev/null 2>&1
kubectl wait --for=jsonpath='{.status.phase}'=Succeeded --timeout=120s pod/fs-probe -n "$NAMESPACE" >/dev/null 2>&1
probe_out="$(kubectl logs fs-probe -n "$NAMESPACE" 2>&1 || true)"

# The positive control FIRST. Without it every "denied" below could be a pod that failed to start,
# a wrong path or an empty log — the vacuous pass an isolation test must never be able to report.
expect_contains 'the probe reads its OWN file on its task volume' "$probe_out" 'own=mine'
expect_contains 'only the probe own file is on its task volume' "$probe_out" 'files=secret.txt'
expect_contains 'the only secret the probe can find is its own' "$probe_out" 'found=/task/secret.txt'
expect_contains 'a relative traversal to another thread is denied' "$probe_out" 'relative=denied'
expect_contains 'a symlink to / cannot reach another thread' "$probe_out" 'symlink=denied'
expect_not_contains 'nothing in the probe leaked' "$probe_out" 'LEAKED'
expect_not_contains 'the other thread volume is not reachable' "$probe_out" 'theirs'

kubectl delete pod fs-seed fs-probe -n "$NAMESPACE" --ignore-not-found --wait=false >/dev/null 2>&1

# --- Node disruption (issue #796) ---------------------------------------------------------------
fi

if selected_phase recovery; then
#
# Infrastructure loss interrupts a task, it never loses one — on a real apiserver. The release was
# installed with a 120s lease and a 70s drain grace, so the chart's handover (grace minus 60s) is
# 10s. a: the driver pod deleted hard while its runner runs to the end — the replacement driver
# adopts the finished runner Job, and its reaper spares that Job while the job is live. b: the
# driver drained (scaled to 0) — the handover queues the job with an interruption and leaves the
# runner running; the driver scaled back adopts it. c: the runner pod deleted mid-run (an eviction
# stand-in) — an interruption, then the next attempt, in its session. d: the driver pod and its
# runner Job deleted together — a replacement runner redoes the attempt in the lost session, on the
# restored tree. e: the driver lost after its agent exited, while the supervisor still finalizes —
# the surviving replica's claim waits that out and adopts the run, never sweeps it (issue #824).
# Each job refunds its interrupted attempt and records exactly one interruption; an expired lease
# is that interruption (issue #822). Only this release's objects are touched, by label.

echo
echo '# node disruption'

ADOPTED='adopted the finished runner of claim 1, whose driver was lost'
DRAINED='the driver was drained'
POD_LOST='infrastructure loss: the runner pod was deleted'
JOB_LOST='infrastructure loss: the runner job '
# The interruption the next claim records for an attempt whose lease expired (issue #822).
EXPIRED='the lease expired: its driver went silent'

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

expire_claim_one() { # expire_claim_one <id> -> "1" once claim 1's live lease is expired, as waiting it out would
    kubectl exec -i -n "$NAMESPACE" "statefulset/$STATE_RELEASE-postgres" -- \
        psql -qtA -v ON_ERROR_STOP=1 -v "job=$1" \
        postgres://factory:factory@127.0.0.1:5432/factory_dev -f - 2>&1 <<'SQL'
with expired as (
    update job set lease_expires_at = now() - interval '1 second'
    where id = :'job' and status = 'running' and claim_seq = 1 and lease_expires_at > now()
    returning id
)
select count(*) from expired;
SQL
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
#    that. The 120s lease keeps the job live, under the dead driver's claim, through the reaper check.
#    At max_attempts 1: the claim records the expiry as claim 1's interruption and adopts.
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
    kubectl delete pod -l "$DRIVER_SEL" -n "$NAMESPACE" --grace-period=0 --force >/dev/null 2>&1
    kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
    release_stub "$hard_release"
    await_job_complete "$hard_job" 60 && ok 'the runner of a deleted driver runs to its end' ||
        bad 'the runner of a deleted driver runs to its end' "$(kubectl get job "$hard_job" -n "$NAMESPACE" 2>&1)"
    # Two and more 3s reaper rounds of the replacement driver while the job is still live under the
    # dead driver's lease: the finished runner Job is unread, and stays.
    sleep 8
    hard_live="$(job_brief "$hard")"
    case "$hard_live" in
    running*) ok 'the job is still live after the runner finished' ;;
    *) bad 'the job is still live after the runner finished' "$hard_live (the window closed before the reaper check)" ;;
    esac
    kubectl get job "$hard_job" -n "$NAMESPACE" >/dev/null 2>&1 && ok 'the reaper spares the unread finished runner Job' ||
        bad 'the reaper spares the unread finished runner Job' 'the runner Job is gone before its adoption'
    expect_not_contains 'the reaper logs nothing for the live job' "$(driver_logs)" "reaper: job $hard"
    # The live-lease window above is the proof. Expire only this dead driver's claim after it,
    # instead of spending the remaining lease budget idle; reclaim still uses the real board SQL.
    expired="$(expire_claim_one "$hard")"
    [ "$expired" = 1 ] && ok 'the dead driver lease is expired after the reaper observation' || {
        bad 'the dead driver lease is expired after the reaper observation' "$expired"
        give_up
    }
    hard_end="$(await_brief "$hard" 'succeeded*' 240)"
    [ "$hard_end" = "succeeded|1|1|1|$EXPIRED" ] && ok 'the replacement driver adopts the run: one attempt, one interruption' ||
        bad 'the replacement driver adopts the run: one attempt, one interruption' "status|attempts|count|claimSeq|reason: $hard_end"
    expect_contains 'the adopted output is the first runner pod output' "$(job_output "$hard")" "released in $hard_pod"
    expect_contains 'the replacement driver logs the adoption' "$(driver_logs)" "job $hard: $ADOPTED"
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
    await_job_complete "$drained_job" 90 && ok 'the handed-over runner Job completes on its own' ||
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
    *"|1|1|$POD_LOST"*) [ "$took" -lt 30 ] && ok "a deleted runner pod is an interruption (${took}s, inside the 120s lease)" ||
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

# d. The driver and its runner lost together (issue #822): nothing survives to adopt, so the next
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
    kubectl delete pod -l "$DRIVER_SEL" -n "$NAMESPACE" --grace-period=0 --force >/dev/null 2>&1
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
    "succeeded|1|1|1|$lost_reason"*) ok 'a replacement runner redoes the lost attempt: one attempt, one interruption' ;;
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

# e. The driver lost between its agent's exit and its supervisor's end (issue #824). The pod-IP step
#    channel refuses once the driver is gone, so the supervisor serves on until its orphan bound
#    (30s under the 120s lease) and only then reports and ends. A second replica is already up; the
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
        kubectl logs "$driver_pod" -n "$NAMESPACE" --tail=-1 2>/dev/null | grep -q "job $final" && final_driver="$driver_pod"
    done
    [ -n "$final_driver" ] && ok 'the driver holding the finalizing job is found' || {
        bad 'the driver holding the finalizing job is found' 'no driver pod logged the job'
        give_up
    }
    kubectl delete "$final_driver" -n "$NAMESPACE" --grace-period=0 --force >/dev/null 2>&1
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
        ok 'the surviving driver waits the supervisor out and adopts the run: one attempt, one interruption' ||
        bad 'the surviving driver waits the supervisor out and adopts the run: one attempt, one interruption' \
            "status|attempts|count|claimSeq|reason: $final_end"
    expect_contains 'the adopted output is the finalizing runner pod output' "$(job_output "$final")" \
        "released in $final_pod"
    expect_contains 'the surviving driver logs the adoption' "$(driver_logs)" "job $final: $ADOPTED"
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

for job in $hard $drained $evicted $lost $final $unpullable; do
    kubectl delete jobs -l "factory.job=$job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --ignore-not-found --wait=false >/dev/null 2>&1
done
fi

if selected_phase services; then
begin_phase services
# --- Declared services and gates in the task pod (issue #773) -----------------------------------
#
# The first lane with a `.bellows.yaml` plan. The offline board reads a plan at claim time from a
# bare mirror under its workspace root (server/src/github/local-origin-plan.ts), so `commit_plan`
# commits the file — and the lane's gate scripts under lane/ — to the member's origin, which every
# startup sync fetches, and mirrors that origin to `.origins/<repo>.git`. The services are native
# sidecars of the task pod, named on its loopback by hostAliases: the agent (the stub's
# `factory-stub-services`) and the gate container (lane/reach.sh, the stub image as the gate image)
# reach `postgres:5432` and `s3:9000` there by name.

echo
echo '# declared services'

# The gate scripts every plan commits beside it. reach.sh: both names on 127.0.0.1, then a TCP
# connect to each, retried while a service still boots. leave.sh: a background write the gate loop's
# `kill -KILL -1` must stop before the next gate runs (the `isolated` gate checks it never landed).
LANE_REACH="$(
    cat <<'SH'
#!/bin/sh
for name in postgres s3; do
    awk '$1 == "127.0.0.1" { for (i = 2; i <= NF; i++) print $i }' /etc/hosts | grep -qx "$name" || {
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

commit_plan() { # commit_plan <label> <.bellows.yaml contents, empty to remove it> -> 0 once committed and mirrored
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
rm -rf /workspaces/.origins/$SMOKE_REPO.git; git clone -q --bare git://$RELEASE-origin:9418/$SMOKE_REPO.git /workspaces/.origins/$SMOKE_REPO.git;
echo committed"
    script="$(printf '%s' "$script" | tr '\n' ' ')"
    kubectl run "$RELEASE-plan-$1" -n "$NAMESPACE" --image="$STUB_REF" --restart=Never --command \
        --overrides="$(
            cat <<EOF
{"spec":{"automountServiceAccountToken":false,
"volumes":[{"name":"w","persistentVolumeClaim":{"claimName":"$STATE_RELEASE-workspaces"}}],
"initContainers":[{"name":"own","image":"alpine:3",
"command":["sh","-c","mkdir -p /workspaces/.origins/${SMOKE_REPO%%/*} && chown -R 1000:1000 /workspaces/.origins"],
"volumeMounts":[{"name":"w","mountPath":"/workspaces"}]}],
"containers":[{"name":"plan","image":"$STUB_REF","imagePullPolicy":"IfNotPresent",
"command":["sh","-c","$script"],
"volumeMounts":[{"name":"w","mountPath":"/workspaces"}]}]}}
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

sidecar_restarts() { # sidecar_restarts <pod> <container> -> its restartCount, empty when unread
    kubectl get pod "$1" -n "$NAMESPACE" \
        -o jsonpath="{.status.initContainerStatuses[?(@.name==\"$2\")].restartCount}" 2>/dev/null
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
$LANE_GATES" && ok 'a plan with declared services and gates is committed and mirrored' ||
    bad 'a plan with declared services and gates is committed and mirrored' 'the plan pod did not commit'

# a. Both sides by name: the agent sees both names on 127.0.0.1 and reaches each service there,
#    and the gates (reach, then the isolation pair) pass in the gate sidecar.
begin_phase services-reach
reached="$(queue_job 'factory-stub-services')"
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
restarted="$(queue_job "factory-stub-wait-$svc_release services restart")"
restart_pod="$(await_runner_pod "$restarted")"
if [ -z "$restarted" ] || [ -z "$restart_pod" ]; then
    bad 'the restart runner is running' "job '$restarted': $(job_brief "$restarted")"
else
    ok 'the restart runner is running'
    await_blocked "$restart_pod" "$svc_release" && ok 'the restart agent is blocked at its barrier' || give_up
    kubectl exec "$restart_pod" -c svc-postgres -n "$NAMESPACE" -- sh -c 'kill 1' >/dev/null 2>&1
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
    timeout: 5' && ok 'a plan declaring a reviewer is committed and mirrored' ||
    bad 'a plan declaring a reviewer is committed and mirrored' 'the plan pod did not commit'

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
    # Usage, when the cluster has a metrics API; the request is the number that is always known.
    sleep 20
    idle_top="$(kubectl top pod "$review_idle_pod" -n "$NAMESPACE" --containers 2>&1 | awk '$2 == "reviewer" { print $3 " / " $4 }')"
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

# The origin and its mirror carry no plan again: a later phase runs as it always did.
commit_plan restore '' && ok 'the plan is removed again' || bad 'the plan is removed again' 'the plan pod did not commit'
for job in $reached $restarted $crashed $ghost $ghost_gate $review_idle $review_task; do
    kubectl delete jobs -l "factory.job=$job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --ignore-not-found --wait=false >/dev/null 2>&1
done
fi

if selected_phase control; then
#
# The supervisor's control routes on a real apiserver (issue #770). a: a cooperative Stop — the
# supervisor relays it to the agent, which ends on its own; the run is cancelled, never verified or
# published. b: a question, then the run budget — the budget pauses while the question waits (the
# runner Job's deadline lifted and saved), resumes on the answer with what was left of it, and the
# supervisor ends the run at the budget. Each case reads the supervisor's own final report, logged
# after the board settles, and its acknowledgement, streamed beside the timings so a failure keeps
# its evidence. Only this release's objects are touched.

echo
echo '# supervisor control'

stream_supervisor() { # stream_supervisor <pod> <file> -> streams the supervisor's log under control_log_pid
    kubectl logs -f "$1" -c supervisor -n "$NAMESPACE" >"$2" 2>&1 &
    control_log_pid=$!
}

end_stream() {
    [ -n "${control_log_pid:-}" ] || return 0
    kill "$control_log_pid" 2>/dev/null
    wait "$control_log_pid" 2>/dev/null
    control_log_pid=''
}

await_report() { # await_report <log file> -> the supervisor's final report line, empty after 60s
    # The board settles before `finish`: the report is the supervisor's last line, written after it.
    local until=$(($(date +%s) + 60)) line=''
    while [ "$(date +%s)" -lt "$until" ]; do
        line="$(grep -F 'FACTORY_SUPERVISOR_REPORT ' "$1" 2>/dev/null | tail -1)"
        [ -n "$line" ] && break
        sleep 1
    done
    printf '%s' "$line"
}

expect_report() { # expect_report <case> <report line> <field>...
    local name="$1" line="${2:-no report line}" want
    shift 2
    for want in "$@"; do expect_contains "$name: the supervisor reports $want" "$line" "$want"; done
}

expect_unpublished() { # expect_unpublished <case> <job id>
    local out
    out="$(job_output "$2")"
    case "$out" in
    '') bad "$1: publishes nothing" 'the output could not be read' ;;
    *'[driver] published'*) bad "$1: publishes nothing" "$out" ;;
    *) ok "$1: publishes nothing" ;;
    esac
}

runner_deadline() { # runner_deadline <pod> -> "<activeDeadlineSeconds>|<paused annotation>" of its Job
    kubectl get "job/${1%-*}" -n "$NAMESPACE" --request-timeout=10s \
        -o jsonpath='{.spec.activeDeadlineSeconds}|{.metadata.annotations.bellows\.ai/paused-deadline}' 2>/dev/null
}

await_deadline() { # await_deadline <pod> <case pattern> -> the last reading; 0 once it matched within 30s
    local until=$(($(date +%s) + 30)) d=''
    while [ "$(date +%s)" -lt "$until" ]; do
        d="$(runner_deadline "$1")"
        # shellcheck disable=SC2254 # the pattern is the point
        case "$d" in $2) printf '%s' "$d"; return 0 ;; esac
        sleep 1
    done
    printf '%s' "$d"
    return 1
}

pending_question() { # pending_question <job id> -> the board's pending question id, empty when none
    node -e "$JS_HEADERS"'
fetch(process.argv[1], { headers })
    .then(async (r) => { const q = ((await r.json()).questions ?? []).find((x) => x.status === "pending"); process.stdout.write(q ? String(q.id) : ""); })
    .catch(() => {});
' "$BASE/api/jobs/$1"
}

# a. The cooperative Stop: the agent waits behind a barrier nobody releases, and ends on the Stop.
begin_phase control-stop
stop_release="/task/.lane-control-stop"
stopping="$(queue_job "factory-stub-stop factory-stub-wait-$stop_release stop")"
stop_pod=''
[ -n "$stopping" ] && stop_pod="$(await_runner_pod "$stopping")"
if [ -z "$stop_pod" ]; then
    bad 'the stop job runs' "job '$stopping' has no running runner pod"
else
    stream_supervisor "$stop_pod" "${TIMINGS_FILE%.tsv}.control-stop.supervisor.log"
    if await_blocked "$stop_pod" "$stop_release"; then
        # Past the supervisor's first /control poll (RUN_CONTROL_POLL_MS, 5s): before it, the
        # driver kills the runner instead of asking.
        sleep 6
        stop_status="$(http_status POST "$BASE/api/jobs/$stopping/stop" '{}')"
        [ "$stop_status" = 202 ] && ok 'the running job accepts the stop' ||
            bad 'the running job accepts the stop' "HTTP $stop_status"
        stop_end="$(await_brief "$stopping" 'stopped*' 120)" && ok 'the stopped run settles stopped' ||
            bad 'the stopped run settles stopped' "status|attempts|count|claimSeq|reason: $stop_end"
        expect_contains 'the agent ended itself on the stop' "$(job_output "$stopping")" "stopped in $stop_pod"
        expect_unpublished 'the stopped run' "$stopping"
        stop_driver_log="$(driver_logs | grep -F "job $stopping: stop requested")"
        expect_contains 'the driver asked the supervisor, never killed the runner' "$stop_driver_log" \
            'letting the agent finish its current step'
        case "$stop_driver_log" in
        *'killing the runner'*) bad 'the runner was not killed' "$stop_driver_log" ;;
        *) ok 'the runner was not killed' ;;
        esac
        expect_report 'the stop' "$(await_report "${TIMINGS_FILE%.tsv}.control-stop.supervisor.log")" \
            '"outcome":"cancelled"' '"agentEnd":"exit"' '"delegated":["setup"]' '"acknowledged":true'
    fi
    end_stream
fi

# b. The question, then the budget. A 60s budget; the agent asks after 40s of it and then waits
#    behind a barrier nobody releases. The question is held 30s, longer than the 20s left: a budget
#    that did not pause ends the run while it waits. After the answer the run must end within what
#    was left — not at once (no pause taken), not a whole budget later (the budget reset).
begin_phase control-question-deadline
BUDGET_MS=60000
HOLD=30
timeout_was="$(kubectl get "$DRIVER_DEPLOY" -n "$NAMESPACE" --request-timeout=10s \
    -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="DRIVER_JOB_TIMEOUT_MS")].value}')"
kubectl set env "$DRIVER_DEPLOY" -n "$NAMESPACE" "DRIVER_JOB_TIMEOUT_MS=$BUDGET_MS" >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1
ask_release="/task/.lane-control-ask"
asking="$(queue_job "factory-stub-ask-40 factory-stub-wait-$ask_release ask")"
ask_pod=''
[ -n "$asking" ] && ask_pod="$(await_runner_pod "$asking")"
if [ -z "$ask_pod" ]; then
    bad 'the asking job runs' "job '$asking' has no running runner pod"
else
    stream_supervisor "$ask_pod" "${TIMINGS_FILE%.tsv}.control-question.supervisor.log"
    qid=''
    until=$(($(date +%s) + 120))
    while [ -z "$qid" ] && [ "$(date +%s)" -lt "$until" ]; do
        qid="$(pending_question "$asking")"
        [ -n "$qid" ] || sleep 1
    done
    if [ -z "$qid" ]; then
        bad 'the board shows the question as pending' "job '$asking': $(job_brief "$asking")"
    else
        ok 'the board shows the question as pending'
        held_at=$SECONDS
        paused="$(await_deadline "$ask_pod" '|{*')" && ok 'a waiting question lifts the runner deadline and saves it' ||
            bad 'a waiting question lifts the runner deadline and saves it' "activeDeadlineSeconds|annotation: $paused"
        sleep $((HOLD - (SECONDS - held_at)))
        held_brief="$(job_brief "$asking")"
        case "$held_brief" in
        running*) ok 'the run outlives what was left of its budget while the question waits' ;;
        *) bad 'the run outlives what was left of its budget while the question waits' "$held_brief" ;;
        esac
        held=$((SECONDS - held_at))
        answer_status="$(http_status POST "$BASE/api/jobs/$asking/questions/$qid/answer" \
            '{"answers":{"Which colour should the report use?":"Blue"}}')"
        answered_at=$SECONDS
        [ "$answer_status" = 200 ] && ok 'a member answers the question' ||
            bad 'a member answers the question' "HTTP $answer_status"
        resumed="$(await_deadline "$ask_pod" '[0-9]*|')" && ok 'the answer restores the runner deadline' ||
            bad 'the answer restores the runner deadline' "activeDeadlineSeconds|annotation: $resumed"
        ask_end="$(await_brief "$asking" 'failed*' 120)" && ok 'the run fails at its resumed budget' ||
            bad 'the run fails at its resumed budget' "status|attempts|count|claimSeq|reason: $ask_end"
        after=$((SECONDS - answered_at))
        # 20s were left; the answer's way back to the supervisor and the settle add some.
        [ "$after" -ge 10 ] && [ "$after" -lt 45 ] && ok 'the budget resumed with what was left of it' ||
            bad 'the budget resumed with what was left of it' "settled ${after}s after the answer, 20s were left"
        ask_out="$(job_output "$asking")"
        expect_contains 'the agent read the answer' "$ask_out" 'Blue'
        killed_ms="$(printf '%s' "$ask_out" | sed -n 's/.*\[driver\] killed after \([0-9]*\)ms.*/\1/p' | tail -1)"
        # The note's budget is the run's plus the time the question held it.
        [ -n "$killed_ms" ] && [ "$killed_ms" -ge $((BUDGET_MS + held * 1000 - 2000)) ] &&
            [ "$killed_ms" -le $((BUDGET_MS + held * 1000 + 15000)) ] &&
            ok 'the timeout note counts the paused wait' ||
            bad 'the timeout note counts the paused wait' "killed after ${killed_ms:-?}ms; held ${held}s on ${BUDGET_MS}ms"
        expect_unpublished 'the timed-out run' "$asking"
        expect_report 'the deadline' "$(await_report "${TIMINGS_FILE%.tsv}.control-question.supervisor.log")" \
            '"outcome":"timed_out"' '"cause":"timeout"' '"agentEnd":"exit"' '"delegated":["setup"]' \
            '"acknowledged":true'
    fi
    end_stream
fi
kubectl set env "$DRIVER_DEPLOY" -n "$NAMESPACE" "DRIVER_JOB_TIMEOUT_MS=$timeout_was" >/dev/null 2>&1
kubectl rollout status "$DRIVER_DEPLOY" -n "$NAMESPACE" --timeout=120s >/dev/null 2>&1

for job in $stopping $asking; do
    kubectl delete jobs -l "factory.job=$job,app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" \
        --ignore-not-found --wait=false >/dev/null 2>&1
done
fi

kill "$pf_pid" 2>/dev/null
wait "$pf_pid" 2>/dev/null
pf_pid=''

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
