# Secret storage

The one contract that environment secrets, managed connection grants and notification credentials store their payload
bytes through, with four backends (AES-256-GCM database, AWS Secrets Manager, Vault KV v2, Google Cloud Secret Manager); `SECRETS_BACKEND` picks one.

| Concern | Code | Test |
| --- | --- | --- |
| The contract: identity, versions, operations, closed error codes | `server/src/secrets/secret-store.ts` | `server/test/secrets.boundary.test.ts` |
| Shared validators: payload size, identity, references, retention | `server/src/secrets/secret-input.ts` | `server/test/secrets.input.test.ts` |
| Injection point (`AppDeps.secrets` built on `main.ts`'s own second pool) and the collector loop | `server/src/main.ts`, `server/src/app.ts`, `server/src/secrets/secret-collector.ts` | `server/test/secrets.boot.test.ts`, `server/test/secrets.collector.test.ts`, `server/test-db/env-secrets.claim.test.ts` |
| Consumer identities: env, grant, notification | `server/src/db/env-secrets.ts` (`envSecretIdentity`), `server/src/db/connection-grants.ts` (`grantSecretIdentity`), `server/src/notifications/subscription-credential.ts` (`subscriptionSecretIdentity`) | `server/test-db/env-var-store.test.ts`, `server/test-db/integration-lineage.test.ts`, `server/test-db/notification-subscriptions.test.ts` |
| Reference store and the conformance suite (`describeSecretStoreConformance`), with proof each case can fail | `server/test/secrets-reference-store.ts`, `server/test/secrets-conformance.ts` | `server/test/secrets.reference.test.ts`, `server/test/secrets.conformance-meta.test.ts` |
| PostgreSQL backend: store, repo seam, storage columns | `server/src/secrets/postgres-secret-store.ts`, `server/src/secrets/postgres-secret-repo.ts`, `server/migrations/091_secret_store.sql`, `server/migrations/092_secret_external.sql` | `server/test-db/secrets-postgres.conformance.test.ts`, `server/test-db/secrets-postgres.faults.test.ts`, `server/test-db/migration.092-secret-external.test.ts` |
| Payload seam (`PayloadStore`, `ProviderFault`, two-phase removal) | `server/src/secrets/secret-payloads.ts`, `server/src/secrets/database-payloads.ts`, `server/src/secrets/secret-call.ts` | `server/test/secrets.call.test.ts` |
| AES-256-GCM envelope, key ring, rotation | `server/src/secrets/secret-envelope.ts`, `server/src/secrets/secret-keys.ts`, `server/src/secrets/rotate-cli.ts` | `server/test/secrets.envelope.test.ts`, `server/test/secrets.keys.test.ts`, `server/test-db/secrets-postgres.rotation.test.ts`, `server/test/secrets.rotate-cli.test.ts` |
| Backend selection and its refusals (`SECRETS_*`) | `server/src/secrets/secret-backend.ts` | `server/test/secrets.backend-config.test.ts` |
| External payloads (all providers) and the bounded provider HTTP exchange | `server/src/secrets/external-payloads.ts`, `server/src/secrets/provider-http.ts` | `server/test/secrets.external-payloads.test.ts`, `server/test-db/secrets-external.faults.test.ts` |
| AWS adapter (SigV4; credentials via `server/src/artifacts/s3-credentials.ts`) | `server/src/secrets/aws-secrets-manager.ts`, `server/src/artifacts/sigv4.ts`, `server/src/artifacts/s3-credentials.ts` | `server/test/secrets.aws.test.ts`, `server/test-db/secrets-aws.conformance.test.ts` |
| Vault KV v2 adapter, answer classifier, Kubernetes login | `server/src/secrets/vault-kv.ts`, `server/src/secrets/vault-answer.ts`, `server/src/secrets/vault-token.ts` | `server/test/secrets.vault.test.ts`, `server/test-db/secrets-vault.conformance.test.ts` |
| GCP Secret Manager adapter (REST, one secret per version named `<prefix><ref>-<version>`, delete destroys every version) and its Application Default Credentials source (metadata server, `authorized_user` file; no key file) | `server/src/secrets/gcp-secret-manager.ts`, `server/src/secrets/gcp-credentials.ts`, `server/migrations/134_secret_gcp_storage.sql` | `server/test/secrets.gcp.test.ts`, `server/test/secrets.gcp-credentials.test.ts`, `server/test/secrets.backend-config.gcp.test.ts`, `server/test-db/secrets-gcp.conformance.test.ts` |
| Emulators for the external suites (moto, dev Vault; compose profiles) | `server/test-db/secrets-external-harness.ts`, `docker-compose.yml`, `.github/workflows/ci.yml` | `core/test/ci-workflows.test.ts` |
| Key delivery: `secrets.env` (`npm run secrets:init`), compose `env_file`, chart `secretStore.*` | `scripts/secrets-init.mjs`, `secrets.env.example`, `charts/factory/templates/secret.yaml`, `charts/factory/templates/deployment.yaml` | `server/test/secrets.environment.test.ts`, `server/test/secrets.init-script.test.ts` |
| Rotation: `npm run secrets:rotate` | `package.json` | `server/test/secrets.rotate-cli.test.ts` |

## Invariants

- **Identity is immutable and checked on every call**; a reference alone grants nothing, and a different owner, org, scope, purpose or owning record is `identity-mismatch`. `server/test/secrets.input.test.ts`.
- **The store owns a pool of its own**: the claim reads secrets while holding a pooled connection, so a shared pool deadlocks at `DB_POOL_MAX` concurrent claims. `server/src/main.ts`, `server/test-db/env-secrets.claim.test.ts`.
- **Keys and provider settings reach the dashboard process alone**, every boot, in the gitignored `secrets.env` (never `.env`); the driver deletes every `SECRETS_*` it is handed. `server/test/secrets.environment.test.ts`, `driver/test/strip-secret-store-env.test.ts`.
- **One backend per deployment, no default**; a variable of another backend is refused. `server/test/secrets.backend-config.test.ts`.
- **An unconfirmed provider answer never deletes or condemns**: a row is dropped only after the provider confirmed the object gone. `server/test/secrets.aws.test.ts`, `server/test/secrets.vault.test.ts`, `server/test/secrets.gcp.test.ts`.
- **The gcp backend calls only `secretmanager.secrets.create` (granted on the project, never conditionable), and `versions.add`, `versions.access` and `secrets.delete` on secrets named `<prefix>...`**: it never lists, reads metadata or destroys a version. An IAM condition on the name sees the project NUMBER, the settings take the id. `server/test/secrets.gcp.test.ts`.
- **Operation IDs are server-issued and bound to kind, reference, expected version and payload**; only `unavailable` retries automatically; an ambiguous write is `outcome-unknown` and is reconciled by its ID before any new mutation. `server/test/secrets-conformance.ts`.
- **Durable metadata holds no payload and no unkeyed digest**; errors use closed code and reason sets. `server/test-db/secrets-postgres.sanitization.test.ts`.
- **A rotated key leaves the ring only after `verifyRetired` is 0**; the operation and fingerprint keys cannot be rotated. `server/test-db/secrets-postgres.rotation.test.ts`.
- **Purging an owner's secrets is the consumers' job** (no foreign key to `organization` or `app_user`).

## Stated limits

- A provider write landing after the delete of its secret leaves an orphan the collector cannot see.
- Switching backends with rows stored is unsupported (`server/test-db/secrets-external.faults.test.ts`).
- The store bounds a call by its own deadline, not the caller's signal; a consumer races the signal itself.
- A Vault behind a private CA is trusted only through `NODE_EXTRA_CA_CERTS` on the dashboard; its login is `auth/kubernetes/login` with no namespace header.
- Secret Manager error bodies and the IAM condition are checked against an in-process emulator (`server/test-db/secrets-gcp-provider.ts`); the first real check is the hosted-cluster walk.
- Signed AWS requests are checked against a signature-blind emulator; the EKS walk ([eks-runbook.md](eks-runbook.md)) is the first real check.
- Docker development bind-mounts the tree, so `secrets.env` is visible inside the driver container.
