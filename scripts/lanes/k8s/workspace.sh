if selected_phase workspace; then
begin_phase workspace
#
# The admission probes above prove the driver cannot SPEC a pod that mounts a claim that is not a
# task volume. This proves a pod that mounted its own thread's task volume cannot
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

# --- Node disruption ---------------------------------------------------------------
fi
