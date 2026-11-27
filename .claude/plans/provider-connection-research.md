# Provider connections — research map

A model-provider credential is a first-class `provider_connection` row an executor profile can reference, and the model
setup (onboarding and Settings → Model) creates or selects one together with the executor that runs on it and the scope's
default. This file maps each concern to the code and the test that pin it; every path below resolves today.

| Concern | Code | Test |
| --- | --- | --- |
| Connection row: sibling scopes (`user_id` null is the org), name unique per scope, org RLS, sealed key reference | `server/migrations/167_provider_connection.sql`, `server/src/db/provider-connection-store.ts`, `server/src/db/provider-connection-secrets.ts` | `server/test-db/provider-connection-store.test.ts`, `server/test-db/row-level-security.test.ts` |
| Provider/runtime matrix, selection and model rules, safe metadata | `core/src/model-providers.ts`, `core/src/provider-connections.ts` | `core/test/provider-connection-selection.test.ts` |
| Connection CRUD, discovery (`GET /:id/models`), reference-aware delete | `server/src/routes/provider-connections.ts` | `server/test/routes.provider-connections.test.ts`, `server/test-db/provider-connections.routes.test.ts` |
| Executor references one nullable connection; a write judges visibility, provider/runtime and model | `server/migrations/168_executor_provider_connection.sql`, `server/src/db/executor-connection-selection.ts` | `server/test-db/user-executor-store.test.ts` |
| Claim reads the CURRENT sealed key, layers it above ambient scopes and below a pasted config; docker and kubernetes get the same claim payload | `server/src/db/jobs/job-store-claim-executor.ts`, `driver/src/k8s/k8s-podspec.ts` | `server/test-db/job-store.provider-connections.test.ts`, `driver/test/k8s/pod-spec.test.ts` |
| Stable executor ids, scoped default selection (member before organization before the legacy chain), one launch resolution | `server/migrations/169_executor_default_selection.sql`, `server/src/db/executor-default-store.ts`, `server/src/routes/jobs/executor-usable.ts` | `server/test-db/executor-default-store.test.ts`, `server/test/routes.executor-lifecycle.test.ts` |
| Model setup command: intents create, reuse, rotate, none; connection, executor, default and receipt in one transaction under a per-scope lock | `server/src/db/model-setup-store.ts`, `server/src/db/executor-setup-rows.ts`, `server/migrations/170_model_setup_operation.sql` | `server/test-db/model-setup.store.test.ts` |
| Setup route: body contract, admin check for the org scope, refusals, `GET` selected executor and `effective: 'executor'` | `server/src/routes/model-setup.ts`, `server/src/routes/model-setup-save.ts` | `server/test/routes.model-setup.test.ts`, `server/test-db/model-setup.routes.test.ts` |
| Clients: create/reuse/rotate/none bodies, the executor banner, replace-key, Ready summary, no-model state | `web/src/model-setup/save-body.ts`, `web/src/model-setup/ConfiguredBanner.tsx`, `web/src/model-setup/RotateKey.tsx`, `web/src/onboarding/no-model.ts` | `web/test/model-setup.dom.test.tsx`, `web/test/model-setup-bodies.test.ts`, `web/test/no-model.test.ts`, `e2e/onboarding.spec.ts` |

## Verified behavior

- **Identity is by id, never by name or provider label.** A create into a name the scope holds is refused
  (`ModelSetupNameConflict`, 409 `NAME_TAKEN`); reuse, rotate and executor edits carry ids. `server/test-db/model-setup.store.test.ts`.
- **Retry is a receipt, not a guess.** The same `requestId` replays the same executor and connection; the same id with a
  different command is refused; receipts hold no credential. `server/test-db/model-setup.store.test.ts`.
- **A key is sealed before the transaction, released only if no row names it, retired only after commit.**
  `server/src/db/provider-connection-secrets.ts`, `server/test-db/model-setup.store.test.ts`.
- **Connection-backed setup writes no env credential and no agent default**; legacy env and agent-default setups keep
  resolving and adopt a real executor only on request (intent `none`). `server/test-db/model-setup.routes.test.ts`.
- **Platform-only deployments** create a real executor on no connection (intent `none`); no connection is invented for the
  platform. `server/src/routes/model-setup-save.ts`, `server/test/routes.model-setup.test.ts`.
- **Rotation reaches later claims only**; a running attempt keeps the key it was injected with.
  `server/test-db/model-setup.store.test.ts`, `server/test-db/job-store.provider-connections.test.ts`.
- **Deleting a referenced connection or a default executor is refused**, never cascaded.
  `server/test-db/model-setup.store.test.ts`, `server/test-db/executor-default-store.test.ts`.
