# Secret storage

The one contract that environment secrets, managed connection grants and executor credentials store their
payload bytes through; the interface, the conformance suite and the AES-256-GCM PostgreSQL backend ship here, `main.ts` composes the backend on every boot.

## Where things live

| Concern | Code | Test |
| --- | --- | --- |
| The contract: identity, versions, operations, closed error codes and reasons | `server/src/secrets/secret-store.ts` | `server/test/secrets.boundary.test.ts` |
| Shared validators: 0..32768 bytes, identity, references, retention window | `server/src/secrets/secret-input.ts` | `server/test/secrets.input.test.ts` |
| Injection point: `AppDeps.secrets`, supplied by `main.ts` after `loadSecretKeys(process.env)` and before `postgres(`; the collector loop (`SECRET_COLLECT_INTERVAL_MS`, every replica) | `server/src/main.ts`, `server/src/app.ts`, `server/src/secrets/secret-collector.ts` | `server/test/secrets.boundary.test.ts`, `server/test/secrets.boot.test.ts`, `server/test/secrets.collector.test.ts` |
| Test-only reference store over plain, cloneable durable state | `server/test/secrets-reference-store.ts` | `server/test/secrets.reference.test.ts` |
| Adapter-agnostic conformance suite: `describeSecretStoreConformance(name, makeHarness)` | `server/test/secrets-conformance.ts` | `server/test/secrets.reference.test.ts` |
| Proof that each conformance case can fail (defect variants of the reference store) | `server/test/secrets-reference-store.ts` | `server/test/secrets.conformance-meta.test.ts` |
| PostgreSQL backend: store logic, repo seam (one transaction per method), `091_secret_store.sql` | `server/src/secrets/postgres-secret-store.ts`, `server/src/secrets/postgres-secret-repo.ts`, `server/migrations/091_secret_store.sql` | `server/test-db/secrets-postgres.conformance.test.ts` (the full suite, no skips), `server/test-db/secrets-postgres.{replicas,rotation,faults}.test.ts` |
| AES-256-GCM envelope and key loading (`SECRETS_*` env: data-key ring, active id, separate operation and fingerprint keys) | `server/src/secrets/secret-envelope.ts`, `server/src/secrets/secret-keys.ts` | `server/test/secrets.envelope.test.ts`, `server/test/secrets.keys.test.ts`, `server/test-db/secrets-postgres.{envelope,sanitization}.test.ts` |
| Rotation command: `npm run secrets:rotate [-- --batch N]`, `-- --verify-retired <keyId>`; Kubernetes `kubectl exec deploy/<release>-factory -c dashboard -- node server/dist/secrets/rotate-cli.js` | `server/src/secrets/rotate-cli.ts`, `server/src/secrets/rotate-args.ts`, `package.json` | `server/test/secrets.rotate-cli.test.ts` |
| Key delivery: `secrets.env` (`npm run secrets:init`), compose `env_file` on the dashboard, chart `secretStore.*` Secret on the dashboard container | `scripts/secrets-init.mjs`, `secrets.env.example`, `docker-compose.yml`, `charts/factory/templates/secret.yaml` | `server/test/secrets.environment.test.ts`, `scripts/test-k8s.sh` |

## Invariants

- **Identity is immutable and checked on every call**, retry and status lookup included; a reference alone grants
  nothing. Owner is an organization (`orgId`) or a user (`userId`, `orgId` or `null` for a personal executor
  profile); a different owner, org, scope, purpose or owning record is `identity-mismatch`. Changing any of
  them needs a new secret and reference. `server/src/secrets/secret-input.ts`, `server/test/secrets.input.test.ts`.
- **Proposed consumer mappings** (the consumer issue confirms each; `server/src/db/env-var-store.ts`, `server/src/db/connection-store.ts`, `server/migrations/054_connections.sql`):

  | Consumer | Owner | Scope | Purpose | Owning record |
  | --- | --- | --- | --- | --- |
  | BEL-54 org env secret | organization(orgId) | organization/orgId | environment-secret | env_var row |
  | BEL-54 workspace env secret | user(userId, orgId) | workspace/userId | environment-secret | env_var row |
  | BEL-54 repository env secret | organization(orgId) | repository/owner/name | environment-secret | env_var row |
  | BEL-59..61 org connection | organization(orgId) | connection/id | connection-grant | connection |
  | BEL-59..61 personal connection | user(owner_user_id, orgId) | connection/id | connection-grant | connection |
  | BEL-35 executor credential | user(userId, null) personal, organization(orgId) org | executor-profile/id | executor-credential | profile |

- **The keys reach the dashboard process alone**, and every boot requires them (`AUTH_MODE=none` and `dashboard.offline` included): they live in
  the gitignored `secrets.env`, never `.env`, which the driver and CLIs load; only the dashboard's launchers read it, the driver deletes any
  `SECRETS_*` it is handed, and `scripts/test-jobs.sh` puts them on board launches only. Docker development bind-mounts the tree, so the file is
  visible inside the driver container; a stated docker-only limit. `server/test/secrets.environment.test.ts`, `driver/test/strip-secret-store-env.test.ts`.
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
  delete: row `tombstoned`, version `cleanup-pending` -> collected. Intent metadata is written before any provider
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
