#!/bin/sh
# Runs scripts/gate-diag.sh in a standalone pod shaped like a gate's: the task volume's storage class
# at /task, fsGroup 1000, the gate image as 1000:1000, a postgres:17 native sidecar with no data volume,
# and a padding container whose limits bring the pod's limit total to a real runner's envelope, since a
# Kata microVM sizes its guest from the limits of every container. --mode microvm sets the microvm
# RuntimeClass; plain leaves it out. The main container's memory-backed /diag-tmp holds the tmpfs copy,
# so --gate-mem must leave room for the whole checkout.
#
#   sh scripts/gate-diag-pod.sh --context <ctx> --namespace <ns> --mode microvm|plain --node-pool <name>
#       --storage-class <sc> --repo <url> --ref <sha> --gate-cpu <q> --gate-mem <q> --service-cpu <q>
#       --service-mem <q> --pad-cpu <q> --pad-mem <q> [--deadline <seconds, default 3600>]
#
# It creates the namespace, labelled as its own, refuses one that already exists, and deletes it once on
# every exit path. Exit 0: the pass ran and passed; 1: it ran and failed; 2: refused, or never finished
# by the deadline; 3: the API rejected what it applied.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# Unique per run: a namespace another launcher created under the same name is never this run's to delete.
OWNER="gate-diag-$(date +%s)-$$"
POD=gate-diag

usage() {
    sed -n '9,11p' "$0" >&2
    exit 2
}

ctx= ns= mode= pool= sc= repo= ref= gate_cpu= gate_mem= service_cpu= service_mem= pad_cpu= pad_mem= limit=3600
while [ $# -gt 0 ]; do
    [ $# -ge 2 ] || usage
    case $1 in
    --context) ctx=$2 ;;
    --namespace) ns=$2 ;;
    --mode) mode=$2 ;;
    --node-pool) pool=$2 ;;
    --storage-class) sc=$2 ;;
    --repo) repo=$2 ;;
    --ref) ref=$2 ;;
    --gate-cpu) gate_cpu=$2 ;;
    --gate-mem) gate_mem=$2 ;;
    --service-cpu) service_cpu=$2 ;;
    --service-mem) service_mem=$2 ;;
    --pad-cpu) pad_cpu=$2 ;;
    --pad-mem) pad_mem=$2 ;;
    --deadline) limit=$2 ;;
    *) usage ;;
    esac
    shift 2
done
if [ -z "$ctx" ] || [ -z "$ns" ]; then
    echo 'refusing: --context and --namespace are both required' >&2
    usage
fi
for value in "$pool" "$sc" "$repo" "$ref" "$gate_cpu" "$gate_mem" "$service_cpu" "$service_mem" "$pad_cpu" "$pad_mem"; do
    [ -n "$value" ] || usage
done
case $mode in microvm | plain) ;; *) usage ;; esac
case $limit in '' | *[!0-9]*) usage ;; esac

# milli <cpu quantity> and mebi <memory quantity>: the quantity in millicores and in MiB, nothing when
# unparsable.
milli() {
    printf '%s\n' "$1" | awk '/^[0-9]+(\.[0-9]+)?m$/ { sub(/m$/, ""); printf "%d", $0 + 0.5; exit }
        /^[0-9]+(\.[0-9]+)?$/ { printf "%d", $0 * 1000 + 0.5 }'
}
mebi() {
    printf '%s\n' "$1" | awk 'BEGIN { u["Ki"] = 2^10; u["Mi"] = 2^20; u["Gi"] = 2^30; u["Ti"] = 2^40;
            u["k"] = 1e3; u["M"] = 1e6; u["G"] = 1e9; u["T"] = 1e12; u[""] = 1 }
        /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti|k|M|G|T)?$/ { n = $0; s = $0; sub(/[A-Za-z]+$/, "", n); sub(/^[0-9.]+/, "", s);
            printf "%d", n * u[s] / 2^20 + 0.5 }'
}
cpu_sum=0 mem_sum=0
for q in "$gate_cpu" "$service_cpu" "$pad_cpu"; do
    m=$(milli "$q")
    [ -n "$m" ] || { echo "unparsable cpu quantity: $q" >&2; exit 2; }
    cpu_sum=$((cpu_sum + m))
done
for q in "$gate_mem" "$service_mem" "$pad_mem"; do
    m=$(mebi "$q")
    [ -n "$m" ] || { echo "unparsable memory quantity: $q" >&2; exit 2; }
    mem_sum=$((mem_sum + m))
done

image=$(awk '/^environment:/ { e = 1 } e && $1 == "image:" { print $2; exit }' "$here/../.bellows.yaml")
[ -n "$image" ] || { echo "no environment image in $here/../.bellows.yaml" >&2; exit 2; }

# One absolute deadline: every request and every pause gets what is left of it.
deadline=$(($(date +%s) + limit))
left() { echo $((deadline - $(date +%s))); }
timeout=30
k() { kubectl --context "$ctx" --namespace "$ns" --request-timeout="${timeout}s" "$@"; }
# kd <kubectl arguments>: a request bounded by the deadline as well; fails once the deadline has passed.
kd() {
    l=$(left)
    [ "$l" -gt 0 ] || return 1
    timeout=$((l < 30 ? l : 30))
    k "$@"
}
# refused <message>: a create or apply failed. Past the deadline nothing was asked, so the pod never
# started (exit 2); otherwise the API refused it (exit 3).
refused() {
    if [ "$(left)" -le 0 ]; then
        echo "the deadline passed before the pod was applied" >&2
        exit 2
    fi
    echo "$1" >&2
    exit 3
}
pause() {
    l=$(left)
    [ "$l" -gt 0 ] || return 0
    sleep $((l < 5 ? l : 5)) >/dev/null 2>&1 &
    wait $! || true
}

# owner: the namespace's owner label. Exit 0 when the namespace exists, 1 when the server says it is
# NotFound, 2 when the read failed any other way: an error is never absence.
owner() {
    # The label goes to stdout through fd 3, the error text into $err.
    if { err=$(k get namespace "$ns" -o 'jsonpath={.metadata.labels.app\.kubernetes\.io/managed-by}' 2>&1 >&3 3>&-); } 3>&1; then
        return 0
    fi
    case $err in *'(NotFound)'*) return 1 ;; esac
    echo "could not read namespace $ns: $err" >&2
    return 2
}

tmp=$(mktemp -d)
created=0 cleaned=0
cleanup() {
    [ "$cleaned" = 0 ] || return 0
    cleaned=1
    timeout=30
    if [ "$created" = 1 ]; then
        # Re-read the label before deleting: only a namespace this launcher owns is ever deleted.
        if label=$(owner) && [ "$label" = "$OWNER" ]; then
            k delete namespace "$ns" --wait=false >&2 || echo "could not delete namespace $ns" >&2
        else
            echo "not deleting namespace $ns: its owner could not be confirmed" >&2
        fi
    fi
    rm -rf "$tmp"
}
trap 'rc=$?; cleanup; exit "$rc"' EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

status=0
label=$(owner) || status=$?
case $status in
0)
    echo "refusing: namespace $ns already exists (owner: ${label:-none}); this launcher only uses one it creates" >&2
    exit 2
    ;;
1) ;;
*) exit 2 ;;
esac

created=1
if ! printf 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: %s\n  labels:\n    app.kubernetes.io/managed-by: %s\n' \
    "$ns" "$OWNER" | kd create -f - >&2; then
    refused "the API refused namespace $ns"
fi
if ! kd create configmap gate-diag-scripts --from-file="gate-diag.sh=$here/gate-diag.sh" \
    --from-file="gate-pg-fast.sh=$here/gate-pg-fast.sh" >&2; then
    refused 'the API refused the scripts ConfigMap'
fi

runtime=
[ "$mode" = plain ] || runtime='  runtimeClassName: microvm'
run=$(
    cat <<'EOF'
set -eu
git init -q /task/work
cd /task/work
git fetch -q --depth 1 "$GATE_DIAG_REPO" "$GATE_DIAG_REF"
git checkout -q FETCH_HEAD
start=$(node -p 'Date.now()')
if npm ci --no-audit --no-fund >&2; then
    printf 'npm_ci_seconds\t%s\n' "$(node -p "((Date.now() - $start) / 1000).toFixed(3)")"
else
    printf 'npm_ci_seconds\tunmeasured\n'
    exit 1
fi
GATE_DIAG_TMP_COPY=/diag-tmp/work sh /diag/gate-diag.sh postgres://factory:factory@127.0.0.1:5432/postgres
EOF
)
cat >"$tmp/manifest.yaml" <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: gate-diag-task
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: $sc
  resources:
    requests:
      storage: 20Gi
---
apiVersion: v1
kind: Pod
metadata:
  name: $POD
  labels:
    app.kubernetes.io/managed-by: $OWNER
spec:
  restartPolicy: Never
  activeDeadlineSeconds: $limit
$runtime
  nodeSelector:
    cloud.google.com/gke-nodepool: $pool
  tolerations:
    - key: sandbox.gke.io/runtime
      operator: Equal
      value: microvm
      effect: NoSchedule
  securityContext:
    fsGroup: 1000
    fsGroupChangePolicy: OnRootMismatch
  volumes:
    - name: task
      persistentVolumeClaim:
        claimName: gate-diag-task
    - name: diag-tmp
      emptyDir:
        medium: Memory
    - name: scripts
      configMap:
        name: gate-diag-scripts
  initContainers:
    - name: postgres
      image: postgres:17
      restartPolicy: Always
      securityContext:
        runAsUser: 999
        runAsGroup: 999
      env:
        - name: POSTGRES_USER
          value: factory
        - name: POSTGRES_PASSWORD
          value: factory
        - name: POSTGRES_DB
          value: factory_test
      resources:
        requests:
          cpu: 500m
          memory: 1Gi
        limits:
          cpu: "$service_cpu"
          memory: "$service_mem"
      startupProbe:
        exec:
          command: [pg_isready, -h, 127.0.0.1, -U, factory]
        periodSeconds: 2
        failureThreshold: 150
  containers:
    - name: pad
      image: $image
      command: [sleep, infinity]
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
      resources:
        requests:
          cpu: 10m
          memory: 16Mi
        limits:
          cpu: "$pad_cpu"
          memory: "$pad_mem"
    - name: diag
      image: $image
      command: [sh, -c]
      args:
        - |
$(printf '%s\n' "$run" | sed 's/^/          /')
      env:
        - name: HOME
          value: /task/home
        - name: GATE_DIAG_REPO
          value: "$repo"
        - name: GATE_DIAG_REF
          value: "$ref"
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: "$gate_cpu"
          memory: "$gate_mem"
      volumeMounts:
        - name: task
          mountPath: /task
        - name: diag-tmp
          mountPath: /diag-tmp
        - name: scripts
          mountPath: /diag
EOF

if ! err=$(kd apply -f - <"$tmp/manifest.yaml" 2>&1 >/dev/null); then
    refused "the API rejected the pod: $err"
fi
printf 'pod_limits_cpu\t%sm\npod_limits_mem\t%sMi\n' "$cpu_sum" "$mem_sum"

# The diag container's state: `<pod name>|<running since>|<exit code>`. A read that fails or lacks the
# pod's name is inconclusive; only an integer exit code means the pass finished.
STATE='jsonpath={.metadata.name}|{.status.containerStatuses[?(@.name=="diag")].state.running.startedAt}|{.status.containerStatuses[?(@.name=="diag")].state.terminated.exitCode}'
code= followed=0
while [ "$(left)" -gt 0 ]; do
    if state=$(kd get pod "$POD" -o "$STATE" 2>/dev/null); then
        case $state in
        "$POD|"*)
            rest=${state#"$POD|"}
            started=${rest%%|*}
            exit_code=${rest#*|}
            case $exit_code in
            '' | *[!0-9]*) ;;
            *)
                code=$exit_code
                break
                ;;
            esac
            if [ -n "$started" ] && [ "$followed" = 0 ]; then
                # Live progress only: the end of this stream proves nothing, so the pod is re-read.
                followed=1
                kd logs -f "$POD" -c diag >&2 || true
                continue
            fi
            ;;
        esac
    fi
    pause
done

if [ -z "$code" ]; then
    echo "the pass did not finish within ${limit}s; events:" >&2
    timeout=30
    k get events --field-selector "involvedObject.name=$POD" >&2 || echo 'could not read the events' >&2
    k logs "$POD" -c diag >&2 2>/dev/null || true
    exit 2
fi
timeout=30
if ! k logs "$POD" -c diag; then
    echo 'could not read the pass logs' >&2
    exit 1
fi
printf 'diag_exit\t%s\n' "$code"
[ "$code" = 0 ] || exit 1
