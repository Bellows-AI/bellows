# Bellows Helm chart

The Bellows stack on Kubernetes: dashboard, driver, and OTLP collector. Every value is
commented in `values.yaml`; the executor, EKS prerequisites and isolation residuals are in
[docs/kubernetes.md](../../docs/kubernetes.md).

| Concern | Code | Test |
| --- | --- | --- |
| Every value, with its comment | `values.yaml` | `driver/test/k8s-docs.test.ts` |
| Dashboard, driver, collector | `templates/deployment.yaml`, `templates/driver-deployment.yaml`, `templates/collector.yaml` | `scripts/test-k8s.sh` |
| Refusals at render time | `templates/validate.yaml` | `scripts/test-k8s.sh` |
| Runner RBAC and the admission fence | `templates/driver-rbac.yaml`, `templates/driver-admission.yaml` | `driver/test/k8s-admission.test.ts`, `scripts/test-k8s.sh` |
| Runner egress | `templates/runner-networkpolicy.yaml` | `scripts/test-k8s.sh` |
| Runner `LimitRange` defaults | `templates/limitrange.yaml` | `scripts/test-k8s.sh` |
| PDBs, Service, Ingress, Secrets | `templates/pdb.yaml`, `templates/service.yaml`, `templates/ingress.yaml`, `templates/secret.yaml` | `scripts/test-k8s.sh` |
| Local-cluster values from `.env` | `scripts/k8s-local-values.mjs`, `values-local.yaml` | `scripts/test-k8s.sh` |

## Invariants

- The chart deploys **no database**. `database.url` is required, or `secret.existingSecret` must carry
  `database-url`. Any managed PostgreSQL 17 works; no extension is needed.
- Requires **Kubernetes ≥ 1.33** (native sidecars, `pods/resize`) and an installer allowed to create
  cluster-scoped `ValidatingAdmissionPolicy` objects (`isolation.admissionPolicy`).
- `AUTH_MODE` is always `github`; the Service is ClusterIP. An unauthenticated `POST /api/jobs` is RCE —
  [docs/security.md](../../docs/security.md).
- `global.imageRegistry` prefixes every rendered reference, both executor images included; `database.waitImage` is
  the full reference it never touches.
- `NetworkPolicy` is inert without a CNI that enforces it — on EKS, `enableNetworkPolicy: true` on the VPC CNI
  add-on ([docs/kubernetes.md](../../docs/kubernetes.md)).
- `driver.runnerDoNotDisrupt` (default off) pins a runner's node up to `driver.jobTimeoutMs`; it does not survive
  spot interruption or `kubectl drain`.

## The task volume

`taskVolume.storageClass` names the class each thread's volume is created with; empty is the cluster default.
On EKS: the EBS CSI driver add-on and a class with `provisioner: ebs.csi.aws.com` and
`volumeBindingMode: WaitForFirstConsumer`. Recipe: [docs/kubernetes.md](../../docs/kubernetes.md#the-task-volume).
The chart has **never been installed on EKS**.

## Commands

```bash
make cluster                   # kind cluster + the local registry test:k8s --cluster pushes to
make start                     # kind cluster, build, load, install factory-state + factory
make stop                      # helm uninstall; keeps factory-state and the claim
make reset                     # also uninstalls factory-state and deletes its claims
make cleanup                   # kind delete cluster; the registry goes with the last one
npm run test:k8s               # helm lint/template offline; --cluster installs into kind
git tag v1.2.3 && git push origin v1.2.3   # publishes all images (docs/ci.md)
```

The cloud walkthrough — EKS, EBS, a registry prefix, an ALB, a managed database — is
[docs/eks-runbook.md](../../docs/eks-runbook.md).
