if selected_phase admission; then
begin_phase admission
# The admission policy, against the real apiserver. The job above proves it admits what the driver
# specs; these prove it refuses what the Role alone would allow. Server-side dry runs as the
# driver's own ServiceAccount: admission runs in full, nothing is persisted.
DRIVER_SA="system:serviceaccount:$NAMESPACE:$RELEASE-factory-driver"

# The executor hardening, in the two spellings these probes need. HARD_C goes INSIDE a
# container's flow mapping; the pod half is in probe_pod's own body. Every probe below carries
# both, because the policy now REQUIRES them — a probe shaped like the driver's own pod is a probe
# that is hardened, and the ones that deliberately are not are the four at the end.
HARD_C='securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}'
# The pod half, as a VARIABLE rather than a quoted default inside the heredoc: `${4:-'{…}'}`
# expands the quotes literally, and the apiserver then reads a YAML string where it wants a
# securityContext — a BadRequest that never reaches admission, so every probe fails with the same
# unrelated message and none of them tests anything.
HARD_POD='{seccompProfile: {type: RuntimeDefault}}'
# The runner class label every pod template carries: admission pins the pod's RuntimeClass to its
# class's. The kind install declares the one `standard` class, which names no RuntimeClass. Set it
# empty before a probe_pod call to send a template without the label.
CLASS_LABEL='factory.runner-class: standard'

# The driver creates pods only through Jobs: the Role grants no pod create and the
# policy matches Jobs alone, so each probe is a Job whose pod template carries the spec lines.
probe_pod() { # probe_pod <name> <extra spec lines> [<extra labels>] [<pod securityContext>]
    # TEMPLATE_ANNOTATIONS, when set, is the template's annotations (flow-mapping entries). Built
    # here: a brace inside a `${…:+…}` word closes the expansion early.
    local notes=''
    [ -z "${TEMPLATE_ANNOTATIONS:-}" ] || notes=", annotations: {$TEMPLATE_ANNOTATIONS}"
    cat <<EOF
apiVersion: batch/v1
kind: Job
metadata:
    name: admission-probe-$1
    labels: {factory.job: admission-probe}
spec:
    template:
        metadata: {labels: {factory.job: admission-probe${CLASS_LABEL:+, $CLASS_LABEL}${3:+, $3}}$notes}
        spec:
            automountServiceAccountToken: false
            restartPolicy: Never
            securityContext: ${4:-$HARD_POD}
$(printf '%s\n' "$2" | sed 's/^/        /')
EOF
}
as_driver() { kubectl create --as="$DRIVER_SA" -n "$NAMESPACE" --dry-run=server -f - 2>&1; }
# A refusal counts only when the POLICY gave it. The apiserver's field validation answers before
# admission does, also as "is invalid:", so a probe it rejects never tests a rule; the denial frame
# below is what only a ValidatingAdmissionPolicy writes.
expect_refused() { # expect_refused <name> <dry-run output> <the policy's message>
    case "$2" in
    *"ValidatingAdmissionPolicy '"*"' denied request: "*"$3"*) ok "$1" ;;
    *) bad "$1" "wanted the policy's refusal '$3' in: $2" ;;
    esac
}

allowed="$(probe_pod ok "    containers: [{name: c, image: alpine, $HARD_C, envFrom: [{secretRef: {name: factory-job-probe-env}}]}]" | as_driver)"
expect_contains 'the policy admits a pod reading a per-attempt Secret' "$allowed" 'created (server dry run)'
stolen="$(probe_pod steal "    containers: [{name: c, image: alpine, $HARD_C, envFrom: [{secretRef: {name: $RELEASE-factory-dashboard}}]}]" | as_driver)"
expect_refused 'the policy refuses a pod reading the dashboard Secret' "$stolen" 'may read only its own per-attempt Secrets'
mounted="$(probe_pod mount "    containers: [{name: c, image: alpine, $HARD_C}]
    volumes: [{name: s, secret: {secretName: $RELEASE-factory-dashboard}}]" | as_driver)"
expect_refused 'the policy refuses a pod mounting the dashboard Secret' "$mounted" 'may mount only a task volume claim'
host="$(probe_pod host "    containers: [{name: c, image: alpine, $HARD_C}]
    volumes: [{name: h, hostPath: {path: /}}]" | as_driver)"
expect_refused 'the policy refuses a hostPath pod' "$host" 'may mount only a task volume claim'
TASK_CLAIM=factory-task-44444444-4444-4444-8444-444444444444-1
task="$(probe_pod task "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: task, mountPath: /task}]}]
    volumes: [{name: task, persistentVolumeClaim: {claimName: $TASK_CLAIM}}]" | as_driver)"
expect_contains 'the policy admits a pod mounting a task volume whole' "$task" 'created (server dry run)'
reviewer_home="$(probe_pod reviewerhome "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: task, mountPath: /h, subPath: .factory/reviewer}]}]
    volumes: [{name: task, persistentVolumeClaim: {claimName: $TASK_CLAIM}}]" | as_driver)"
expect_contains 'the policy admits a pod mounting the reviewer home of a task volume' "$reviewer_home" 'created (server dry run)'
foreign="$(probe_pod foreign "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: w, mountPath: /w}]}]
    volumes: [{name: w, persistentVolumeClaim: {claimName: $RELEASE-not-a-task}}]" | as_driver)"
expect_refused 'the policy refuses a pod mounting a claim that is no task volume' "$foreign" 'may mount only a task volume claim'
other="$(probe_pod othersub "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: task, mountPath: /w, subPath: other}]}]
    volumes: [{name: task, persistentVolumeClaim: {claimName: $TASK_CLAIM}}]" | as_driver)"
expect_refused 'the policy refuses a task volume mounted at any other subPath' "$other" 'only whole or at the reviewer home'
expr="$(probe_pod expr "    containers: [{name: c, image: alpine, $HARD_C, volumeMounts: [{name: task, mountPath: /w, subPathExpr: '\$(HOME)'}]}]
    volumes: [{name: task, persistentVolumeClaim: {claimName: $TASK_CLAIM}}]" | as_driver)"
expect_refused 'the policy refuses a subPathExpr task volume mount' "$expr" 'only whole or at the reviewer home'
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
expect_refused 'the policy refuses a ReadWriteMany task volume claim' "$task_rwx" 'is never ReadWriteMany'
task_name="$(task_claim factory-task-55555555-5555-4555-8555-555555555555-1 ReadWriteOnce | as_driver)"
expect_refused 'the policy refuses a task volume claim not named for its labelled root' "$task_name" \
    'named for their labelled thread root and generation'
task_other="$(task_claim scratch ReadWriteOnce | as_driver)"
expect_refused 'the policy refuses a claim that is not a task volume' "$task_other" \
    'named for their labelled thread root and generation'
deleted="$(kubectl delete secret "$RELEASE-factory-dashboard" --as="$DRIVER_SA" -n "$NAMESPACE" --dry-run=server 2>&1)"
expect_refused 'the policy refuses deleting an unlabelled Secret' "$deleted" 'only objects labelled factory.job'

# The holder binding: a per-attempt Secret's binding key is the one thing the driver may
# update on a Secret.
PROBE_ENV="factory-job-00000000-0000-4000-8000-000000000829-env"
kubectl create secret generic "$PROBE_ENV" -n "$NAMESPACE" --from-literal=KEEP=1 >/dev/null
kubectl label secret "$PROBE_ENV" -n "$NAMESPACE" factory.job=admission-probe >/dev/null
# The driver has no `get` on Secrets and `kubectl patch` reads the object first, so the merge patch
# goes straight to the apiserver through an impersonating proxy, as the driver's own PATCH does.
as_driver_secret() {
    local plog pid port out
    plog="$(mktemp)"
    kubectl proxy --port=0 --as="$DRIVER_SA" >"$plog" 2>&1 &
    pid=$!
    for _ in $(seq 1 100); do grep -q 'Starting to serve' "$plog" && break; sleep 0.1; done
    port="$(sed -n 's/.*127\.0\.0\.1:\([0-9]*\).*/\1/p' "$plog")"
    out="$(curl -sS -w '\n%{http_code}' -X PATCH -H 'Content-Type: application/merge-patch+json' -d "$2" \
        "http://127.0.0.1:$port/api/v1/namespaces/$NAMESPACE/secrets/$1?dryRun=All" 2>&1)"
    kill "$pid" 2>/dev/null
    wait "$pid" 2>/dev/null
    rm -f "$plog"
    case "${out##*$'\n'}" in
        2??) echo "secret/$1 patched (server dry run)" ;;
        *) echo "$out" ;;
    esac
}
bound="$(as_driver_secret "$PROBE_ENV" '{"data":{"binding.json":"e30="}}')"
expect_contains 'the policy admits a binding patch on an attempt Secret' "$bound" 'patched'
other_key="$(as_driver_secret "$PROBE_ENV" '{"data":{"KEEP":"eA=="}}')"
expect_refused 'the policy refuses a Secret patch of another key' "$other_key" 'changes only its binding'
relabelled_secret="$(as_driver_secret "$PROBE_ENV" '{"metadata":{"labels":{"factory.lease":"thief"}}}')"
expect_refused 'the policy refuses relabelling an attempt Secret' "$relabelled_secret" 'changes only its binding'
retyped_secret="$(as_driver_secret "$PROBE_ENV" '{"type":"kubernetes.io/basic-auth"}')"
# A Secret's type is immutable in the apiserver itself, which refuses the change before admission runs.
expect_contains 'the apiserver refuses retyping an attempt Secret' "$retyped_secret" 'field is immutable'
reowned_secret="$(as_driver_secret "$PROBE_ENV" '{"metadata":{"ownerReferences":[{"apiVersion":"v1","kind":"ConfigMap","name":"thief","uid":"00000000-0000-0000-0000-000000000000"}]}}')"
expect_refused 'the policy refuses re-owning an attempt Secret' "$reowned_secret" 'changes only its binding'
dropped_key="$(as_driver_secret "$PROBE_ENV" '{"data":{"KEEP":null}}')"
expect_refused 'the policy refuses deleting an existing Secret data key' "$dropped_key" 'changes only its binding'
immutable_secret="$(as_driver_secret "$PROBE_ENV" '{"immutable":true}')"
expect_refused 'the policy refuses freezing an attempt Secret' "$immutable_secret" 'changes only its binding'
finalized_secret="$(as_driver_secret "$PROBE_ENV" '{"metadata":{"finalizers":["factory/probe"]}}')"
expect_refused 'the policy refuses adding a finalizer to an attempt Secret' "$finalized_secret" 'changes only its binding'
dashboard_patch="$(as_driver_secret "$RELEASE-factory-dashboard" '{"data":{"binding.json":"e30="}}')"
expect_refused 'the policy refuses patching the dashboard Secret' "$dashboard_patch" 'only objects labelled factory.job'
kubectl delete secret "$PROBE_ENV" -n "$NAMESPACE" >/dev/null

# Issue #382, the half that cannot be asserted by rendering. Phase one proved the CEL is in the
# document; this proves a real apiserver COMPILES it and refuses on it. The distinction matters
# more here than anywhere else in this script: `failurePolicy: Fail` means an expression that does
# not compile refuses every pod the driver creates, so a policy that renders and does not work is
# a total outage — and one that compiles but matches nothing passes phase one unchanged. Each
# probe below removes exactly one field from the shape the probes above all carry.
no_seccomp="$(probe_pod noseccomp "    containers: [{name: c, image: alpine, $HARD_C}]" '' '{}' | as_driver)"
expect_refused 'the policy refuses a pod with no seccomp profile' "$no_seccomp" 'RuntimeDefault seccomp profile'
wrong_seccomp="$(probe_pod unconfined "    containers: [{name: c, image: alpine, $HARD_C}]" '' \
    '{seccompProfile: {type: Unconfined}}' | as_driver)"
expect_refused 'the policy refuses an Unconfined seccomp profile' "$wrong_seccomp" 'RuntimeDefault seccomp profile'
no_sc="$(probe_pod nosc '    containers: [{name: c, image: alpine}]' | as_driver)"
expect_refused 'the policy refuses a container with no securityContext at all' "$no_sc" 'allowPrivilegeEscalation: false'
escalating="$(probe_pod escalate \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: true, capabilities: {drop: [ALL]}}}]' |
    as_driver)"
expect_refused 'the policy refuses a container that may escalate' "$escalating" 'allowPrivilegeEscalation: false'
# The container-level override, against the real apiserver: the pod keeps RuntimeDefault and the
# CONTAINER asks for Unconfined. Admitted, this is a runner with no syscall filter at all while
# every pod-level assertion still reads green — which is why it is probed rather than reasoned about.
container_unconfined="$(probe_pod cseccomp \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}, seccompProfile: {type: Unconfined}}}]' |
    as_driver)"
expect_refused 'the policy refuses a container that overrides the pod seccomp profile' \
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
        metadata: {labels: {factory.job: admission-probe, $CLASS_LABEL}}
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
expect_refused 'the policy refuses any other capability on the agent' "$launch_more" 'may not be privileged or add capabilities'
launch_other="$(probe_job launchother supervisor 'SETUID' | as_driver)"
expect_refused 'the policy refuses the launch pair on any other container' "$launch_other" 'may not be privileged or add capabilities'
# A bare Pod is refused before admission: the Role grants no pod create at all.
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
expect_refused 'the policy refuses a container that drops nothing' "$no_drop" 'must drop ALL capabilities'
# There is no opt-out: the label a declared unhardened service once carried buys a
# container nothing.
opted_out="$(probe_pod optout \
    '    containers: [{name: c, image: alpine, securityContext: {allowPrivilegeEscalation: false}}]' \
    'factory.unhardened: "true"' | as_driver)"
expect_refused 'the policy refuses the retired unhardened label its capabilities' "$opted_out" 'must drop ALL capabilities'

# Runner classes: a pod runs under its class's RuntimeClass — none for `standard` — and carries the
# label of a class the chart declares. A mismatch, an unknown class and a missing label are refused.
classless="$(CLASS_LABEL='' probe_pod classless "    containers: [{name: c, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a pod without a runner class label' "$classless" 'label of a declared runner class'
unknown_class="$(CLASS_LABEL='factory.runner-class: nope' probe_pod unknownclass \
    "    containers: [{name: c, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a pod naming an undeclared runner class' "$unknown_class" \
    'label of a declared runner class'
mismatched="$(probe_pod mismatch "    runtimeClassName: kata
    containers: [{name: c, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a RuntimeClass its runner class does not name' "$mismatched" \
    'its runner class RuntimeClass'

# The task pod's shape: its declared services are `svc-` sidecars named on its
# loopback. The driver's own shape is the runner Job's dry run above; these refuse each way out.
sidecar="$(probe_pod sidecar "    initContainers: [{name: svc-db, image: alpine, restartPolicy: Always, $HARD_C}]
    containers: [{name: c, image: alpine, $HARD_C}]
    hostAliases: [{ip: 127.0.0.1, hostnames: [db]}]" | as_driver)"
expect_contains 'the policy admits a svc- sidecar named on loopback' "$sidecar" 'created (server dry run)'
aliased="$(probe_pod alias "    containers: [{name: c, image: alpine, $HARD_C}]
    hostAliases: [{ip: 10.0.0.1, hostnames: [db]}]" | as_driver)"
expect_refused 'the policy refuses a hostAlias off loopback' "$aliased" 'hostAliases only to 127.0.0.1'
main_svc="$(probe_pod mainsvc "    containers: [{name: svc-db, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a svc- main container' "$main_svc" 'only as restartable init containers'
once_svc="$(probe_pod oncesvc "    initContainers: [{name: svc-db, image: alpine, $HARD_C}]
    containers: [{name: c, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a svc- init container that is not restartable' "$once_svc" \
    'only as restartable init containers'
proxy="$(probe_pod proxy "    initContainers: [{name: proxy, image: alpine, restartPolicy: Always, $HARD_C}]
    containers: [{name: c, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a restartable init container that is neither gate nor svc-' "$proxy" \
    'only as restartable init containers'

# A docker class's `dockerd` sidecar. The install declares `dind`, a docker class under the
# `$KATA_RC` RuntimeClass (handler kata; a Job's dry run never resolves it). There alone, a
# restartable `dockerd` may run privileged — the class's microVM is the boundary — adding no
# capability, keeping no drop ALL and setting no allowPrivilegeEscalation (the apiserver refuses
# `false` beside privileged). Every other rule still holds for it, every other container still
# never escalates, and the socket volume is the agent's, the gate's and dockerd's alone.
DIND_RC="$KATA_RC"
DOCKERD_C='securityContext: {privileged: true, runAsUser: 0}'
SOCK_VOL='volumes: [{name: docker-sock, emptyDir: {}}]'
SOCK_MOUNT='volumeMounts: [{name: docker-sock, mountPath: /run/factory-docker}]'
dind_pod() { # dind_pod <name> <extra spec lines> [<pod securityContext>] — a pod of the dind class, under its RuntimeClass
    CLASS_LABEL='factory.runner-class: dind' probe_pod "$1" "    runtimeClassName: $DIND_RC
$2" '' "${3:-}"
}
dockerd_ok="$(dind_pod dockerd "    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, $DOCKERD_C, $SOCK_MOUNT}, {name: gate, image: alpine, restartPolicy: Always, $HARD_C, $SOCK_MOUNT}]
    containers: [{name: agent, image: alpine, $HARD_C, $SOCK_MOUNT}]
    $SOCK_VOL" | as_driver)"
expect_contains 'the policy admits the privileged dockerd sidecar of a docker class under its RuntimeClass' "$dockerd_ok" \
    'created (server dry run)'
dockerd_other="$(dind_pod dockerdother "    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, $DOCKERD_C}, {name: gate, image: alpine, restartPolicy: Always, securityContext: {privileged: true, capabilities: {drop: [ALL]}}}]
    containers: [{name: agent, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses privileged on any other container of a docker class pod' "$dockerd_other" \
    'may not be privileged or add capabilities'
dockerd_standard="$(probe_pod dockerdstandard "    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, $DOCKERD_C}]
    containers: [{name: agent, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a privileged dockerd in a class that is no docker class' "$dockerd_standard" \
    'may not be privileged or add capabilities'
dockerd_rc="$(CLASS_LABEL='factory.runner-class: dind' probe_pod dockerdrc "    runtimeClassName: other-sandbox
    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, $DOCKERD_C}]
    containers: [{name: agent, image: alpine, $HARD_C}]" | as_driver)"
# The class's own RuntimeClass rule answers first; the dockerd waiver reads the same pin again.
expect_refused 'the policy refuses a privileged dockerd under a RuntimeClass its docker class does not name' "$dockerd_rc" \
    'its runner class RuntimeClass'
dockerd_main="$(dind_pod dockerdmain "    containers: [{name: dockerd, image: docker, $DOCKERD_C}]" | as_driver)"
expect_refused 'the policy refuses a privileged dockerd as a main container' "$dockerd_main" \
    'may not be privileged or add capabilities'
dockerd_caps="$(dind_pod dockerdcaps "    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, securityContext: {privileged: true, capabilities: {add: [NET_ADMIN]}}}]
    containers: [{name: agent, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a capability added to the privileged dockerd' "$dockerd_caps" \
    'may not be privileged or add capabilities'
gate_escalate="$(dind_pod gateescalate "    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, $DOCKERD_C}, {name: gate, image: alpine, restartPolicy: Always, securityContext: {allowPrivilegeEscalation: true, capabilities: {drop: [ALL]}}}]
    containers: [{name: agent, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy still requires no escalation of every other container in a docker class pod' "$gate_escalate" \
    'allowPrivilegeEscalation: false'
dockerd_seccomp="$(dind_pod dockerdseccomp "    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, $DOCKERD_C}]
    containers: [{name: agent, image: alpine, $HARD_C}]" '{}' | as_driver)"
expect_refused 'the policy still requires the pod RuntimeDefault profile of a dockerd pod' "$dockerd_seccomp" \
    'RuntimeDefault seccomp profile'
dockerd_once="$(dind_pod dockerdonce "    initContainers: [{name: dockerd, image: docker, $HARD_C}]
    containers: [{name: agent, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a dockerd that is not restartable' "$dockerd_once" \
    'only as restartable init containers'
sock_svc="$(dind_pod socksvc "    initContainers: [{name: svc-db, image: alpine, restartPolicy: Always, $HARD_C, $SOCK_MOUNT}]
    containers: [{name: agent, image: alpine, $HARD_C}]
    $SOCK_VOL" | as_driver)"
expect_refused 'the policy refuses a svc- service mounting the docker socket volume' "$sock_svc" \
    'docker socket volume in the agent, the gate and dockerd alone'

# Pod Security baseline, held by the policy: a docker class's namespace enforces `privileged`,
# which checks nothing. Each probe is a dind pod, the privileged dockerd beside it, so a refusal
# also proves dockerd's waiver reaches no further than privileged and capabilities.
DIND_SPEC="    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, $DOCKERD_C}]
    containers: [{name: agent, image: alpine, $HARD_C}]"
baseline_dockerd() { # baseline_dockerd <name> <extra dockerd securityContext fields> — dind pod, dockerd changed
    dind_pod "$1" "    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, securityContext: {privileged: true, runAsUser: 0, $2}}]
    containers: [{name: agent, image: alpine, $HARD_C}]"
}
pod_ctx() { printf '{seccompProfile: {type: RuntimeDefault}, %s}' "$1"; }
apparmor_pod="$(dind_pod apparmorpod "$DIND_SPEC" "$(pod_ctx 'appArmorProfile: {type: Unconfined}')" | as_driver)"
expect_refused 'the policy refuses an unconfined AppArmor pod' "$apparmor_pod" 'no container AppArmor unconfined'
apparmor_dockerd="$(baseline_dockerd apparmordockerd 'appArmorProfile: {type: Unconfined}' | as_driver)"
expect_refused 'the policy refuses an unconfined AppArmor dockerd' "$apparmor_dockerd" 'no container AppArmor unconfined'
apparmor_note="$(TEMPLATE_ANNOTATIONS='container.apparmor.security.beta.kubernetes.io/agent: unconfined' \
    dind_pod apparmornote "$DIND_SPEC" | as_driver)"
expect_refused 'the policy refuses the unconfined AppArmor annotation' "$apparmor_note" 'no container AppArmor unconfined'
apparmor_default="$(TEMPLATE_ANNOTATIONS='container.apparmor.security.beta.kubernetes.io/agent: runtime/default' \
    dind_pod apparmordefault "$DIND_SPEC" | as_driver)"
expect_contains 'the policy admits the RuntimeDefault AppArmor annotation' "$apparmor_default" 'created (server dry run)'
sysctl_safe="$(dind_pod sysctl "$DIND_SPEC" \
    "$(pod_ctx 'sysctls: [{name: net.ipv4.ip_unprivileged_port_start, value: "0"}]')" | as_driver)"
expect_refused 'the policy refuses even a safe sysctl' "$sysctl_safe" 'sets no sysctls'
selinux_type="$(baseline_dockerd selinuxtype 'seLinuxOptions: {type: spc_t}' | as_driver)"
expect_refused 'the policy refuses an SELinux type outside the container ones on dockerd' "$selinux_type" \
    'set no SELinux user or role'
selinux_user="$(dind_pod selinuxuser "$DIND_SPEC" "$(pod_ctx 'seLinuxOptions: {user: system_u}')" | as_driver)"
expect_refused 'the policy refuses an SELinux user on the pod' "$selinux_user" 'set no SELinux user or role'
selinux_ok="$(dind_pod selinuxok "$DIND_SPEC" "$(pod_ctx 'seLinuxOptions: {type: container_t, level: "s0:c1,c2"}')" | as_driver)"
expect_contains 'the policy admits a container SELinux type and level' "$selinux_ok" 'created (server dry run)'
# The apiserver admits an unmasked /proc only in a user namespace, which in turn forbids a
# privileged container, so this probe is the agent's (dockerd's is driver/test/k8s-admission.test.ts).
proc_mount="$(probe_pod procmount "    hostUsers: false
    containers: [{name: agent, image: alpine, securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}, procMount: Unmasked}}]" | as_driver)"
expect_refused 'the policy refuses an unmasked /proc' "$proc_mount" 'keeps the default /proc mount'
host_network="$(dind_pod hostnet "    hostNetwork: true
$DIND_SPEC" | as_driver)"
expect_refused 'the policy refuses the host network' "$host_network" 'may not share host namespaces'
host_pid="$(dind_pod hostpid "    hostPID: true
$DIND_SPEC" | as_driver)"
expect_refused 'the policy refuses the host PID namespace' "$host_pid" 'may not share host namespaces'
host_ipc="$(dind_pod hostipc "    hostIPC: true
$DIND_SPEC" | as_driver)"
expect_refused 'the policy refuses the host IPC namespace' "$host_ipc" 'may not share host namespaces'
host_port="$(dind_pod hostport "    initContainers: [{name: dockerd, image: docker, restartPolicy: Always, $DOCKERD_C, ports: [{containerPort: 2375, hostPort: 2375}]}]
    containers: [{name: agent, image: alpine, $HARD_C}]" | as_driver)"
expect_refused 'the policy refuses a host port on dockerd' "$host_port" 'may not bind a host port'
host_path="$(dind_pod hostpath "$DIND_SPEC
    volumes: [{name: h, hostPath: {path: /}}]" | as_driver)"
expect_refused 'the policy refuses a hostPath volume in a docker class pod' "$host_path" 'may mount only a task volume claim'
# A HostProcess pod needs the host network, which the apiserver checks first and the policy refuses.
host_process="$(dind_pod hostprocess "    hostNetwork: true
$DIND_SPEC" "$(pod_ctx 'windowsOptions: {hostProcess: true}')" | as_driver)"
expect_refused 'the policy refuses a Windows HostProcess pod' "$host_process" 'may not share host namespaces'

# The sandbox-pool guard (isolation.sandboxPools, charts/factory/templates/sandbox-admission.yaml):
# cluster-wide, every caller, every non-exempt namespace. The install declares one pool, tainted
# factory.test/sandbox=kata, whose one RuntimeClass is the dind class's; exempt are kube-system,
# local-path-storage and the prefix lane-exempt-. Bare pods, dry-run as the lane's own admin.
SANDBOX_NS="$RELEASE-sandbox"
EXEMPT_NS="lane-exempt-$RELEASE"
kubectl create namespace "$SANDBOX_NS" >/dev/null 2>&1 && kubectl create namespace "$EXEMPT_NS" >/dev/null 2>&1 ||
    bad 'the sandbox-pool probe namespaces are created' "$SANDBOX_NS, $EXEMPT_NS"
sandbox_namespaces_created=1
SANDBOX_TOLERATION='tolerations: [{key: factory.test/sandbox, operator: Equal, value: kata, effect: NoSchedule}]'
bare_pod() { # bare_pod <name> [<extra spec lines>]
    cat <<EOF
apiVersion: v1
kind: Pod
metadata: {name: sandbox-probe-$1}
spec:
    containers: [{name: c, image: alpine}]
${2:+    $2}
EOF
}
in_ns() { kubectl create -n "$1" --dry-run=server -f - 2>&1; }
unsandboxed="$(bare_pod plain "$SANDBOX_TOLERATION" | in_ns "$SANDBOX_NS")"
expect_refused 'the sandbox-pool policy refuses a pod tolerating the pool taint without its RuntimeClass' \
    "$unsandboxed" 'a pod that tolerates the sandbox taint factory.test/sandbox must run under one of its RuntimeClasses'
sandboxed="$(bare_pod sandboxed "$SANDBOX_TOLERATION
    runtimeClassName: $KATA_RC" | in_ns "$SANDBOX_NS")"
expect_contains 'the sandbox-pool policy admits that pod under the pool RuntimeClass' "$sandboxed" 'created (server dry run)'
untolerating="$(bare_pod untolerating | in_ns "$SANDBOX_NS")"
expect_contains 'the sandbox-pool policy admits a pod without the toleration' "$untolerating" 'created (server dry run)'
wildcard="$(bare_pod wildcard 'tolerations: [{operator: Exists}]' | in_ns "$SANDBOX_NS")"
expect_refused 'the sandbox-pool policy refuses a tolerate-everything pod' "$wildcard" \
    'tolerates the sandbox taint factory.test/sandbox'
exempt_exact="$(bare_pod wildcard 'tolerations: [{operator: Exists}]' | in_ns kube-system)"
expect_contains 'the sandbox-pool policy admits a tolerate-everything pod in an exempt namespace' \
    "$exempt_exact" 'created (server dry run)'
exempt_prefix="$(bare_pod wildcard 'tolerations: [{operator: Exists}]' | in_ns "$EXEMPT_NS")"
expect_contains 'the sandbox-pool policy admits a tolerate-everything pod in a prefix-exempt namespace' \
    "$exempt_prefix" 'created (server dry run)'
lane_node="$(kubectl get nodes -o jsonpath='{.items[0].metadata.name}' --request-timeout=10s 2>/dev/null)"
pinned="$(bare_pod pinned "nodeName: ${lane_node:-unread}" | in_ns "$SANDBOX_NS")"
expect_refused 'the sandbox-pool policy refuses a pod pinned by spec.nodeName without a sandbox RuntimeClass' \
    "$pinned" 'a pod that sets spec.nodeName skips the sandbox pool taints'
kubectl delete namespace "$SANDBOX_NS" "$EXEMPT_NS" --ignore-not-found --wait=false >/dev/null 2>&1

# --- The agent's tool isolation, on the real kubelet ----------------------------------
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

# --- The workspace boundary, probed from inside a pod ------------------------------
fi
