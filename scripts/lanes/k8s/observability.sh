if selected_phase observability; then
begin_phase observability
# --- The ops collector: spans from a real run reach a file exporter ------------------------
#
# Turns the ops collector on in the running release with the lane's debug file exporter (a reader sidecar shares
# its emptyDir: the collector image is distroless), runs one task, and reads the trace file back until a
# bellows-board span and a bellows-driver span share a trace and carry their pod attributes
# (scripts/k8s-ops-spans.mjs). The backend is an address nothing answers on: its export failures are expected and
# are not what is asserted. Then the collector is scaled to zero and a second task must still succeed (the SDK
# exporters only enqueue, so a lost collector drops telemetry, never a task). The release is ALWAYS restored to
# observability off at the end — no step above returns or exits — because bench upgrades with --reuse-values and
# would otherwise inherit these values. Enforcement of the collector's ingress policy is not proved here (kindnet
# does not enforce NetworkPolicy): `--netpol` does that.

echo
echo '# observability'

OBS_OPS_DEPLOY="deployment/$RELEASE-factory-ops-collector"
OBS_OPS_SEL="app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=ops-collector"
OBS_HEADERS_SECRET=ops-headers
OBS_ERR="$work/observability-exec.err"

obs_rollout() { # obs_rollout <resource> -> the rollout settled within its own timeout
    bounded 210 kubectl rollout status "$1" -n "$NAMESPACE" --request-timeout=20s --timeout=180s >/dev/null 2>&1
}
obs_ready() { # obs_ready <what> -> the board answering through a fresh port-forward, on an absolute deadline
    local until
    kill "$pf_pid" 2>/dev/null
    wait "$pf_pid" 2>/dev/null
    start_port_forward
    until=$(($(date +%s) + 120))
    while [ "$(date +%s)" -lt "$until" ]; do
        [ "$(http_status GET "$BASE/api/ready")" = '200' ] && return 0
        sleep 1
    done
    bad "observability: $1: the board answers through the port-forward" "$(tail -3 "$PF_LOG")"
    return 1
}
obs_roll_all() { # obs_roll_all <what> [with the ops collector] -> the board and the driver rolled out and answering
    local resource
    for resource in "deployment/$RELEASE-factory" "$DRIVER_DEPLOY" ${2:+"$OBS_OPS_DEPLOY"}; do
        obs_rollout "$resource" || {
            bad "observability: $1: $resource rolls out" "$(bounded 20 kubectl get pods -l "app.kubernetes.io/instance=$RELEASE" -n "$NAMESPACE" --request-timeout=10s 2>&1 | tail -6)"
            return 1
        }
    done
    obs_ready "$1"
}
obs_run_task() { # obs_run_task <what> <command> -> the task queued and settled succeeded, with the attempt its brief carries
    local id brief
    id="$(queue_job "$2")"
    [ -n "$id" ] || {
        bad "observability: $1 is queued" 'the board refused the task'
        return 1
    }
    brief="$(await_brief "$id" 'succeeded*' 300)" && ok "observability: $1 succeeds" || {
        bad "observability: $1 succeeds" "$brief"
        return 1
    }
}

obs_ok=1

# 1-2. The headers Secret, and the release with the collector on.
if [ "$obs_ok" = 1 ]; then
    out="$(bounded 40 kubectl create secret generic "$OBS_HEADERS_SECRET" -n "$NAMESPACE" --request-timeout=20s \
        --from-literal='headers={"x-lane":"1"}' 2>&1)" || {
        bad 'observability: the headers Secret is created' "${out:0:300}"
        obs_ok=0
    }
fi
if [ "$obs_ok" = 1 ]; then
    out="$(bounded 300 helm upgrade "$RELEASE" charts/factory --reuse-values -n "$NAMESPACE" \
        --set observability.enabled=true --set-string observability.endpoint=http://127.0.0.1:9 \
        --set observability.headersSecret.name="$OBS_HEADERS_SECRET" --set observability.headersSecret.key=headers \
        --set observability.debugFile=true --set observability.sampling.tailPercent=100 2>&1)" || {
        bad 'observability: the release is upgraded with the ops collector on' "${out:0:300}"
        obs_ok=0
    }
fi

# 3. Rollouts: the collector Ready proves the headers map parsed and the overlay merged.
if [ "$obs_ok" = 1 ]; then
    obs_roll_all 'collector on' with-ops && ok 'observability: the ops collector, the board and the driver roll out' || obs_ok=0
fi

# 4-5. One task, then the trace file until a board and a driver span join. An unreadable file (exec failed, not
# written yet, a cut stream) is retried to the deadline and is never "no spans".
if [ "$obs_ok" = 1 ]; then
    obs_run_task 'the first task' 'factory-stub-ops-spans' || obs_ok=0
fi
if [ "$obs_ok" = 1 ]; then
    obs_verdict=''
    obs_until=$(($(date +%s) + 240))
    while [ "$(date +%s)" -lt "$obs_until" ]; do
        obs_verdict="$(bounded 20 kubectl exec -n "$NAMESPACE" --request-timeout=15s "$OBS_OPS_DEPLOY" -c debug-reader -- \
            cat /var/ops-debug/traces.jsonl 2>"$OBS_ERR" | node "$REPO/scripts/k8s-ops-spans.mjs")" || true
        case "$obs_verdict" in joined*) break ;; esac
        sleep 2
    done
    case "$obs_verdict" in
    joined*) ok 'observability: a board span and a driver span join in the ops collector output' ;;
    *) bad 'observability: a board span and a driver span join in the ops collector output' "last verdict: ${obs_verdict:-none}; last exec stderr: $(tail -c 300 "$OBS_ERR" 2>/dev/null)" ;;
    esac
fi

# 6. A lost collector drops telemetry, never a task. "Gone" needs three successful reads.
if [ "$obs_ok" = 1 ]; then
    out="$(bounded 60 kubectl scale "$OBS_OPS_DEPLOY" --replicas=0 -n "$NAMESPACE" --request-timeout=30s 2>&1)" || {
        bad 'observability: the ops collector is scaled to zero' "${out:0:300}"
        obs_ok=0
    }
fi
if [ "$obs_ok" = 1 ]; then
    obs_gone=''
    obs_until=$(($(date +%s) + 90))
    while [ "$(date +%s)" -lt "$obs_until" ]; do
        # An error or an unparsable answer is inconclusive: another poll, never "gone".
        spec="$(bounded 20 kubectl get "$OBS_OPS_DEPLOY" -n "$NAMESPACE" --request-timeout=10s -o jsonpath='{.spec.replicas}' 2>/dev/null)" &&
            [ "$spec" = 0 ] &&
            replicas="$(bounded 20 kubectl get "$OBS_OPS_DEPLOY" -n "$NAMESPACE" --request-timeout=10s -o jsonpath='{.status.replicas}' 2>/dev/null)" &&
            case "$replicas" in '' | 0) true ;; *) false ;; esac &&
            pods="$(bounded 20 kubectl get pods -l "$OBS_OPS_SEL" -n "$NAMESPACE" --request-timeout=10s -o name 2>/dev/null)" &&
            [ -z "$pods" ] && {
            obs_gone=1
            break
        }
        sleep 2
    done
    [ "$obs_gone" = 1 ] && ok 'observability: the ops collector is gone (spec, status and pod list agree)' || {
        bad 'observability: the ops collector is gone (spec, status and pod list agree)' 'no three successful reads showed zero replicas and zero pods'
        obs_ok=0
    }
fi
if [ "$obs_ok" = 1 ]; then
    obs_run_task 'a task with the ops collector gone' 'factory-stub-ops-spans' || obs_ok=0
fi

# 7. Always reached: observability off again, then the lane Secret is deleted once.
out="$(bounded 300 helm upgrade "$RELEASE" charts/factory --reuse-values -n "$NAMESPACE" \
    --set observability.enabled=false --set observability.debugFile=false \
    --set-string observability.endpoint= --set-string observability.headersSecret.name= \
    --set-string observability.headersSecret.key= 2>&1)" || bad 'observability: the release is restored with the ops collector off' "${out:0:300}"
obs_roll_all 'restored' && ok 'observability: the release is restored with the ops collector off' ||
    bad 'observability: the release is restored with the ops collector off' 'the board or the driver did not come back'
bounded 40 kubectl delete secret "$OBS_HEADERS_SECRET" -n "$NAMESPACE" --ignore-not-found --request-timeout=20s >/dev/null 2>&1 ||
    bad 'observability: the lane Secret is deleted' 'kubectl delete failed'
fi

