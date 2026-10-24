# EKS runbook — a cloud install, by hand

The cloud twin of [the chart README's kind commands](../charts/factory/README.md#commands); no lane validates this
chart against a cloud cluster. **Last walked 2026-10-01** (a production EKS cluster,
eu-central-1, v1.34, chart `v0.0.0`, offline entry): steps 3, 4 and 7's
ingress half held; 1, 2 (the EBS task volume class), 6 and 7's job half were not walked.

## 1. Cluster prerequisites

Reasoning: [docs/kubernetes.md](kubernetes.md), "EKS prerequisites".

- EKS ≥ 1.33, EC2 Linux nodes. **Fargate is out entirely** — no NetworkPolicy, no metrics API.
- VPC CNI add-on with `enableNetworkPolicy: true`.
- `httpPutResponseHopLimit: 1` (or IMDS disabled) on the runner node group.
- The metrics-server add-on, or a running job's vitals degrade to null.
- The AWS Load Balancer Controller (step 7 uses it).
- A tainted **runner node group**, so agent-written code never shares a node with the dashboard pod
  holding the App key.

## 2. Storage: an EBS class for the task volumes

Prerequisites: [docs/kubernetes.md](kubernetes.md#the-task-volume). Install the EBS CSI driver add-on, create this
StorageClass, then set `taskVolume.storageClass: ebs-gp3`:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
    name: ebs-gp3
provisioner: ebs.csi.aws.com
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
parameters:
    type: gp3
```

Observe: a task's claim binds once its first pod is scheduled. An install that predates this chart keeps its
`<release>-workspaces` claim; delete it and its EFS file system by hand.

## 3. Images: one registry prefix

Bare defaults resolve to `docker.io/library/*` and every pod lands in `ImagePullBackOff`. Push a
`v*` tag ([ci.md](ci.md)), make the five GHCR packages public — the first push creates them
private — then set `global.imageRegistry` once.

- `database.waitImage` is the one reference the prefix never touches: mirror it, set it whole.
- **Tag the two executor values.** They are bare repository strings, so a packaged chart cannot
  resolve them from `AppVersion`; tagless reads `:latest` and the node reuses its first cached pull.
- The same tag publishes the chart to `oci://ghcr.io/<owner>/charts/factory`, versioned with the
  tag minus its leading `v` — what a GitOps controller resolves.

Observe: a wrong executor reference fails the run fast naming the image (`readImagePullStatus`).

## 4. Database: any managed PostgreSQL 17

Set `database.url` — RDS and Aurora both work, the schema loads no extension
([persistence.md](persistence.md)). Observe: the `pg_isready` init container passes and
`GET /api/ready` answers 200 once migrations land.

**`charts/factory-local-state` cannot back a cloud install.** It mounts its claim at
`/var/lib/postgresql/data`; a real ext4 volume carries a `lost+found`, `initdb` refuses, and the
StatefulSet crash-loops — kind's hostPath provisioner hides this. Use a managed instance, or set
`PGDATA=/var/lib/postgresql/data/pgdata`, which the next `helm upgrade` reverts. A private-address
database sits inside `isolation.blockedCidrs` and the runner never needs it; a runner that must
reach another private host needs it as a /32 in `isolation.allowedCidrs`.

## 5. Install: the values shape

`scripts/test-k8s.sh`'s offline EKS lane renders this shape as assertions (`EKS_SETS`); a mismatch
is a bug in one of them.

- `runner.nodeSelector` / `runner.tolerations` — onto step 1's tainted group.
- `driver.runnerDoNotDisrupt` — off by default; an undisruptable pod pins its node for up to
  `driver.jobTimeoutMs`.
- `auth.publicUrl` — the real public origin, with `auth.cookieSecure: 'true'`.
- `secret.existingSecret` or the chart-created Secret, carrying `database-url` and
  `job-board-token`. On the External Secrets path: a remote path outside the controller's IAM
  scope fails with `could not get secret data from provider` and the `AccessDeniedException` is in
  the controller's events, not the ExternalSecret's status; a missing remote key fails the whole
  sync, so spell optional keys `{{ default "" (index . "SOME_KEY") }}`; and one remote per owner,
  since Terraform owns an entire `SecretString` and its next apply deletes a hand-written key
  beside it. `GITHUB_APP_PRIVATE_KEY` may be raw or base64 (`loadConfig` discriminates on
  `-----BEGIN`), and a tool reading that secret must do the same.

## 6. Isolation: enforced, not just admitted

Observe from inside a runner pod: no egress to `169.254.169.254`, none to the private ranges, DNS
only through kube-dns, the dashboard, collector and driver reachable by podSelector, no other runner
pod reachable, and a declared service reached by its declared name on `127.0.0.1`.

## 7. Exposing the dashboard, and a job end to end

```yaml
ingress:
    enabled: true
    className: alb
    hosts:
        - factory.example.com
    annotations:
        alb.ingress.kubernetes.io/scheme: internet-facing
        alb.ingress.kubernetes.io/target-type: ip
        alb.ingress.kubernetes.io/certificate-arn: arn:aws:acm:eu-west-1:…:certificate/…
        alb.ingress.kubernetes.io/listen-ports: '[{"HTTP":80},{"HTTPS":443}]'
        alb.ingress.kubernetes.io/ssl-redirect: '443'
        alb.ingress.kubernetes.io/healthcheck-path: /api/health
auth:
    publicUrl: https://factory.example.com
    cookieSecure: 'true'
```

`listen-ports` needs the HTTP listener or `ssl-redirect` has nothing to redirect. The ACM certificate and Route53
record are outside the chart; `ingress.hosts` must contain the host of `auth.publicUrl` or the render is refused.

Observe: the ALB provisions, `http://` redirects to `https://`, `/api/health` passes, sign-in
completes. Then add an executor and queue a task — the runner pod schedules onto the runner node
group, `kubectl get pod -o yaml` carries no credential values, vitals render, output and status
arrive, a follow-up resumes the session. Stop one mid-run if you can afford the redo: the lease
expires, the board re-offers, the replacement fences the checkout and resumes the session; one
interruption is the trace.
An offline deployment's driver 503s with `JOBS_UNAVAILABLE` (no org materialized yet); a 401 there
would be the credential instead.

## 8. The failure matrix, no EFS

The cloud half of `scripts/test-k8s.sh --phase acceptance`. `CLI` is
`npm run dev -w cli --`, `NS` the release namespace, `T` a task id. Record each row's outcome in the header.

Walked 2026-10-23 on a staging EKS deployment (v0.0.9-rc), runner nodes shared with other workloads:
1–6 and 8 pass; 7 passes mid-run, during publish not walked; 9 not walked (#954); 10 survival passes,
TTL expiry not walked. A runner pod lost during gates stalls the task until the step timeout (#967).

1. No shared file system anywhere — every claim is the state DB's or a task's, none `ReadWriteMany`:
   `kubectl -n $NS get pvc -o custom-columns=NAME:.metadata.name,MODES:.spec.accessModes,CLASS:.spec.storageClassName`
   and `kubectl get pv -o custom-columns=NAME:.metadata.name,DRIVER:.spec.csi.driver` (no `efs.csi.aws.com`).
2. One task end to end: `CLI job create …`, `CLI job wait $T`, then after its runner Job is gone
   (`kubectl -n $NS get jobs`), `CLI job streams $T` and `CLI job read $T` still return the transcript.
3. Failure, retry, follow-up: a task that fails → `CLI job retry $T` succeeds; `CLI job follow-up $T …` on
   a succeeded one resumes its session on the same task claim (same `factory.task-root` claim, same generation).
4. Agent kill, as the CLI's own uid (root holds no `CAP_KILL` there and would hit the tool broker):
   `kubectl -n $NS exec <runner pod> -c agent -- /usr/bin/setpriv --reuid=1000 --regid=1000 --clear-groups /bin/sh -c 'kill -KILL -1'`
   (the image ships no `kill` binary)
   mid-run; confirm the agent container's CLI is gone. Observe the attempt
   ends with the agent killed, `CLI job retry $T` (or a follow-up) runs on the surviving task claim, and
   `CLI job read $T` holds every record the agent wrote before the kill.
5. Pod loss: `kubectl -n $NS delete pod <runner pod> --grace-period=0 --force` mid-run. Same observation as 4.
6. Node loss: `kubectl drain <runner node> --ignore-daemonsets --delete-emptydir-data` mid-run. One
   interruption, never a failure; the replacement adopts the claim.
7. Driver restart: `kubectl -n $NS rollout restart deploy -l app.kubernetes.io/instance=<release>,app.kubernetes.io/component=driver` mid-run and again during the
   publish step. The new driver takes the run over; at most one pull request or push results.
8. Upload outage: `kubectl -n $NS scale deploy -l app.kubernetes.io/instance=<release>,app.kubernetes.io/component=dashboard --replicas=0` for under the lease,
   then back. The run continues and the transcript read is whole afterwards.
9. Cross-AZ restore: scale **every** runner node in the task claim's zone to zero — not a cordon; the
   restore fires only when every node the scheduler weighed reports `volume node affinity conflict`, so
   a tainted node in another group blocks it today. Queue a follow-up. Observe a new
   `factory.task-root` claim generation in another zone, the session resumed and the checkout restored.
10. Cleanup protection: after 2, the task claim survives its run; it goes only after the idle TTL.

## 9. Teardown

Runner Jobs first, then `helm uninstall`, then the release's task claims — they have no owner, and the reaper
stops with the driver: `kubectl -n <ns> delete pvc -l app.kubernetes.io/instance=<release>,factory.task-root`
(the class's `reclaimPolicy: Delete` takes the EBS volumes with them) — then the ACM certificate and the DNS record.

**Stated limit:** this catches nothing about EBS volume attachment, add-on enforcement or policy
behaviour on any cluster but the one walked, and `scripts/test-k8s.sh`'s render lane only keeps the
value shape from drifting. Gaps: [docs/executor-testing.md](executor-testing.md), "What no lane covers".
