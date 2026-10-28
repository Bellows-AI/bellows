# Secret storage

The one contract that environment secrets, managed connection grants and executor credentials store their
payload bytes through; the interface, the conformance suite and three PostgreSQL-coordinated backends (AES-256-GCM database, AWS Secrets Manager, HashiCorp Vault KV v2) ship here, and `main.ts` composes the one `SECRETS_BACKEND` selects on every boot.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| The contract: identity, versions, operations, closed error codes and reasons | `server/src/secrets/secret-store.ts` | `server/test/secrets.boundary.test.ts` |
| Shared validators: 0..32768 bytes, identity, references, retention window | `server/src/secrets/secret-input.ts` | `server/test/secrets.input.test.ts` |
| Injection point: `AppDeps.secrets`, supplied by `main.ts` after `loadSecretBackend(process.env)` and before `postgres(`; the collector loop (`SECRET_COLLECT_INTERVAL_MS`, every replica) | `server/src/main.ts`, `server/src/app.ts`, `server/src/secrets/secret-collector.ts` | `server/test/secrets.boundary.test.ts`, `server/test/secrets.boot.test.ts`, `server/test/secrets.collector.test.ts` |
| Test-only reference store over plain, cloneable durable state | `server/test/secrets-reference-store.ts` | `server/test/secrets.reference.test.ts` |
| Adapter-agnostic conformance suite: `describeSecretStoreConformance(name, makeHarness)` | `server/test/secrets-conformance.ts` | `server/test/secrets.reference.test.ts` |
| Proof that each conformance case can fail (defect variants of the reference store) | `server/test/secrets-reference-store.ts` | `server/test/secrets.conformance-meta.test.ts` |
| PostgreSQL backend: store logic, repo seam (one transaction per method), `091_secret_store.sql`, `092_secret_external.sql` (storage columns, external-only `deleting`) | `server/src/secrets/postgres-secret-store.ts`, `server/src/secrets/postgres-secret-repo.ts`, `server/migrations/091_secret_store.sql`, `server/migrations/092_secret_external.sql` | `server/test-db/secrets-postgres.conformance.test.ts` (the full suite, no skips), `server/test-db/secrets-postgres.{replicas,rotation,faults}.test.ts`, `server/test-db/migration.092-secret-external.test.ts` |
| Payload seam: where a version's bytes live (`PayloadStore`), the database envelope store, `ProviderFault` verdicts and the removal in two phases | `server/src/secrets/secret-payloads.ts`, `server/src/secrets/database-payloads.ts`, `server/src/secrets/secret-call.ts`, `server/src/secrets/postgres-secret-support.ts` | `server/test/secrets.call.test.ts`, `server/test-db/secrets-postgres.faults.test.ts` |
| AES-256-GCM envelope and key loading (`SECRETS_*` env: data-key ring, active id, separate operation and fingerprint keys) | `server/src/secrets/secret-envelope.ts`, `server/src/secrets/secret-keys.ts` | `server/test/secrets.envelope.test.ts`, `server/test/secrets.keys.test.ts`, `server/test-db/secrets-postgres.{envelope,sanitization}.test.ts` |
| Backend selection: `SECRETS_BACKEND=database\|aws\|vault` (required, no default), `SECRETS_VAULT_{ADDR,MOUNT,PREFIX,AUTH}` with `ROLE` and `TOKEN_FILE` (kubernetes) or `TOKEN` (development only), cross-backend and cross-auth variables refused, the store factory, `rotate-cli` refusing an external backend | `server/src/secrets/secret-backend.ts`, `server/src/main.ts` | `server/test/secrets.backend-config.test.ts`, `server/test/secrets.boot.test.ts` |
| External store (all providers): the plaintext at the provider, a keyed per-version `payload_mac` in the row, the object name, the verification a read needs | `server/src/secrets/external-payloads.ts` | `server/test/secrets.external-payloads.test.ts` |
| One bounded provider HTTP exchange: budget and abort, capped body, transport and status to `ProviderFault` | `server/src/secrets/provider-http.ts` | `server/test/secrets.aws.test.ts` |
| AWS Secrets Manager adapter: SigV4 JSON 1.1, `CreateSecret` with `ClientRequestToken`, `ForceDeleteWithoutRecovery`; credentials via `artifacts/s3-credentials.ts` (static, Pod Identity, IRSA) | `server/src/secrets/aws-secrets-manager.ts`, `server/src/artifacts/sigv4.ts`, `server/src/artifacts/s3-credentials.ts` | `server/test/secrets.aws.test.ts`, `server/test/artifacts.unit.test.ts`, `server/test-db/secrets-aws.conformance.test.ts` (moto), `server/test-db/secrets-external.faults.test.ts` |
| Vault KV v2 adapter: `cas=0` write at `<mount>/data/<path>`, read at version 1, metadata delete; one classifier of every answer (write, read, delete, login); Kubernetes login with a single-flight, 80%-of-lease token cache and one re-login per call on a 403 | `server/src/secrets/vault-kv.ts`, `server/src/secrets/vault-answer.ts`, `server/src/secrets/vault-token.ts` | `server/test/secrets.vault.test.ts`, `server/test-db/secrets-vault.conformance.test.ts`, `server/test-db/secrets-vault.faults.test.ts` |
| Provider faults for the external suites, injected at the adapter's `fetch`; the moto emulator (compose profile `secrets-aws`, CI service, `SECRETS_TEST_REQUIRE_AWS`) and the dev-mode Vault (compose profile `secrets-vault`, CI service, `SECRETS_TEST_REQUIRE_VAULT`) | `server/test-db/secrets-external-harness.ts`, `server/test-db/secrets-aws-provider.ts`, `server/test-db/secrets-vault-harness.ts`, `server/test-db/secrets-vault-provider.ts`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.github/workflows/mirror-images.yml` | `core/test/ci-workflows.test.ts` |
| Rotation command: `npm run secrets:rotate [-- --batch N]`, `-- --verify-retired <keyId>`; Kubernetes `kubectl exec deploy/<release>-factory -c dashboard -- node server/dist/secrets/rotate-cli.js` | `server/src/secrets/rotate-cli.ts`, `server/src/secrets/rotate-args.ts`, `package.json` | `server/test/secrets.rotate-cli.test.ts` |
| Key delivery: `secrets.env` (`npm run secrets:init`), compose `env_file` on the dashboard, chart `secretStore.*` Secret on the dashboard container | `scripts/secrets-init.mjs`, `secrets.env.example`, `docker-compose.yml`, `charts/factory/templates/secret.yaml`, `charts/factory/templates/deployment.yaml` | `server/test/secrets.environment.test.ts`, `server/test/secrets.init-script.test.ts`, `scripts/test-k8s.sh` |

## Invariants

- **Identity is immutable and checked on every call**, retry and status lookup included; a reference alone grants
  nothing. Owner is an organization (`orgId`) or a user (`userId`, `orgId` or `null` for a personal executor
  profile); a different owner, org, scope, purpose or owning record is `identity-mismatch`. Changing any of
  them needs a new secret and reference. `server/src/secrets/secret-input.ts`, `server/test/secrets.input.test.ts`.
- **Consumer mappings** (the BEL-54 rows are confirmed by `envSecretIdentity` in `server/src/db/env-secrets.ts`, pinned by `server/test-db/env-var-store.test.ts`; the consumer issue confirms each of the others; `server/src/db/env-var-store.ts`, `server/src/db/connection-grants.ts` (`grantSecretIdentity`), `server/migrations/094_integration_connections.sql`):

  | Consumer | Owner | Scope | Purpose | Owning record |
  | --- | --- | --- | --- | --- |
  | BEL-54 org env secret | organization(orgId) | organization/orgId | environment-secret | env-var (name) |
  | BEL-54 workspace env secret | user(userId, orgId) | workspace/userId | environment-secret | env-var (name) |
  | BEL-54 repository env secret | organization(orgId) | repository/owner/name | environment-secret | env-var (name) |
  | BEL-59..61 integration grant | user(principal_user_id, orgId) | integration-grant/id | connection-grant | integration-grant |
  | BEL-35 executor credential | user(userId, null) personal, organization(orgId) org | executor-profile/id | executor-credential | profile |

- **The store owns a pool of its own**: `main.ts` builds it on a second pool, never the claim's, because the claim reads
  environment secrets while holding a pooled connection and a store call opens its own transaction; a shared pool
  deadlocks at `DB_POOL_MAX` concurrent claims. A consumer may call the store inside its own transaction, never with a
  borrowed one. `server/src/main.ts`, `server/test-db/env-secrets.claim.test.ts`.
- **The keys and the provider settings reach the dashboard process alone**, and every boot requires them (`AUTH_MODE=none` and `dashboard.offline` included): they live in
  the gitignored `secrets.env`, never `.env`, which the driver and CLIs load; only the dashboard's launchers read it, the driver deletes any
  `SECRETS_*` it is handed (the AWS and Vault settings and the static development keys and token included), and `scripts/test-jobs.sh` puts them on board launches only. Provider credentials in Kubernetes are the dashboard ServiceAccount's workload identity (IRSA, Pod Identity, or a Vault-audience projected token mounted into the dashboard container alone), never a chart value. Docker development bind-mounts the tree, so the file is
  visible inside the driver container; a stated docker-only limit. `server/test/secrets.environment.test.ts`, `driver/test/strip-secret-store-env.test.ts`.
- **One backend per deployment, chosen by `SECRETS_BACKEND` on every boot, with no default.** A missing value names `npm run secrets:init`, which adds the line to a `secrets.env` an older release wrote and leaves its keys alone. A variable of another backend is refused, not ignored. External mode needs no data keys and has no rotation. `server/test/secrets.backend-config.test.ts`, `server/test/secrets.init-script.test.ts`.
- **External payloads are write-once objects, one per storage version**, named `<prefix>/<reference>/<versionId>`; a read believes the bytes only when the returned name and version match and `payload_mac` verifies, and a row never names an object other than the one its reference and id derive. `server/test/secrets.external-payloads.test.ts`.
- **An unconfirmed provider answer never deletes or condemns.** A row is dropped only after the provider confirmed the object gone; absent means a validated not-found, a malformed or unverifiable answer is `integrity-failure`, any failure is `unavailable`. `server/test-db/secrets-aws.conformance.test.ts`, `server/test/secrets.aws.test.ts`, `server/test/secrets.vault.test.ts` (a Vault 404 is absent only when it names errors and no `data.metadata`; a 404 with metadata is a soft delete and an integrity failure).
- **Stated limits**: a provider write that lands after the delete of its secret leaves an orphan object the collector cannot see; switching backends with rows stored is unsupported (the other storage's rows read as `invalid-configuration` and are never collected, `server/test-db/secrets-external.faults.test.ts`); the signed Secrets Manager requests are checked against a signature-blind emulator, so the EKS walk (`docs/eks-runbook.md`) is the first real check; a Vault behind a private CA is trusted only through `NODE_EXTRA_CA_CERTS`, which the operator sets on the dashboard (the chart has no CA option); the Vault login is `auth/kubernetes/login` with no namespace header, so a differently mounted auth method or an enterprise namespace is unsupported.
- **Payload** is opaque bytes, 0 through 32768 inclusive; null and strings are `invalid-input`, rejected before any write. `server/src/secrets/secret-input.ts`.
- **Operations**: create-if-absent, read-active, replace and delete (both need the expected version),
  reconcile. A successful replace is always a new version, a rekey keeps it, a deleted reference is never reused.
  `conflict` is `stale-version`, `reference-exists`, `operation-pending` or `operation-id-reused`. `server/src/secrets/secret-store.ts`.
- **Operation IDs are server-issued** (`op_<issuedAt>_<nonce>_<mac>`) and bound to kind, reference, expected version
  and the payload; a definitive failure after validation (`not-found`, `conflict`, `identity-mismatch`) binds the ID too.
  An identical replay returns the original definitive result and never reactivates an old value.
  Completed IDs are kept seven days; after pruning, expiry is still recognised from the signed issue time and is
  `invalid-input` with reason `operation-id-expired`. Unresolved operations are never pruned. `server/test/secrets-conformance.ts` (retry cases).
- **A fresh mutation conflicts (`operation-pending`) only behind an operation already marked `unknown`**, i.e. one that
  returned `outcome-unknown`; a pending or crashed one does not block, the loser fails at activation. `server/test/secrets-conformance.ts` (concurrency, retry).
- **Only `unavailable` retries automatically**, with the same operation ID, under an absolute deadline owned by the
  backend. An ambiguous write is `outcome-unknown` and is reconciled by its ID before any new mutation. `server/test/secrets-conformance.ts` (faults).
- **Recovery**: operation `pending` -> (`unknown`) -> `succeeded` | `failed`; version `staged` -> `active` -> `collectable`;
  delete: row `tombstoned`, version `cleanup-pending` -> collected. An external version is removed in two phases (`deleting`, payload removed, row dropped); a database version in one guarded delete and is never `deleting` (a check; 091's collector must see every removable row); only `staged` ever activates. Intent metadata is written before any provider
  write; read-active never sees a staged version; reconcile rolls forward only if the expected version is still
  active, so it never resurrects a delete or overwrites a newer winner. A missing staged object is `unknown`, never `failed`. `server/test/secrets-reference-store.ts`, `server/test/secrets-conformance.ts` (faults).
- **Durable metadata holds no payload and no unkeyed payload digest**; fingerprints are HMACs under a key kept outside the
  database. Errors and diagnostics use closed code/reason sets, so no payload, ciphertext, key or provider body can ride in them. `server/test/secrets-conformance.ts` (sanitization).
- **Envelope** `0x01 | keyIdLen | keyId | nonce(12, random) | ciphertext | tag(16)`; identity, reference and logical version are
  the AAD, so a tampered, wrong-key or copied envelope is `integrity-failure`, never plaintext. Rotation (`rotate`, `rekey`,
  `verifyRetired`) is resumable and keeps the logical version; a key leaves the ring only after `verifyRetired` is 0. The
  operation and fingerprint keys cannot be rotated: changing one invalidates outstanding operation IDs. Purging an owner's
  secrets is the consumers' job (no foreign key to `organization` or `app_user`). `server/test-db/secrets-postgres.rotation.test.ts`.
- **Delivery**: contract (BEL-64) -> database backend (BEL-136) -> consumers (BEL-54, BEL-35, BEL-59..61) -> AWS/Vault (BEL-137). OAuth refresh is never replayed as a storage retry. `docs/connections.md`.
