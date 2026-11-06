# Skills

Org and workspace skills: versioned `SKILL.md` bundles a task can select beside the built-ins and a repository's own.

| Concern | Code | Test |
| --- | --- | --- |
| Bundle codec: inline `SKILL.md` or zip to a validated, deterministic tar and its sha256; stable refusal reasons | `server/src/skills/skill-bundle.ts`, `core/src/skills.ts` (`MAX_SKILL_FILES`, `MAX_SKILL_BYTES`, `MAX_SKILL_FILE_BYTES`) | `server/test/skill-bundle.test.ts` |
| Tables: `skill` (owner, enabled, soft delete, current version) and immutable `skill_version` | `server/migrations/128_skills.sql` | `server/test-db/skill-store.test.ts` |
| Store: owner in every by-id WHERE, object first (content-addressed), then one transaction for rows + current swap, `effective(userId)` | `server/src/db/skill-store.ts` | `server/test-db/skill-store.test.ts` |
| Routes: `/api/org/skills` (read: any member, write: org admin) and `/api/workspace/skills` (own skills); list, get, create (JSON `{name, skillMd}` or raw `application/zip` with `?name=`), `/:id/versions`, `PUT /:id/enabled`, `DELETE` (soft), `POST /api/workspace/skills/:id/scope` (admin) | `server/src/routes/skills-store.ts`, `server/src/auth/route-class.ts` | `server/test/routes.skills-store.test.ts`, `server/test/auth.enforcement.test.ts` |
| Catalog: `effectiveCatalog` reads enabled org skills and the caller's workspace skills; a failed read is `storedError`, which makes a name `unverified` and `GET /api/skills` a 503 | `server/src/skill-catalog.ts`, `server/src/routes/skills.ts` | `server/test/routes.skills-store.test.ts`, `server/test/skills.test.ts` |
| Retention sweep: a deleted skill's versions and their objects are removed after the retention window, and never while any job row's `skill_pin` names the version; a failed reference read aborts the pass | `server/src/skills/skill-collector.ts` (`findReferencedVersions`) | `server/test-db/skill-store.test.ts`, `server/test-db/job-store.skill-pin.test.ts` |
| Pin: a job row's `skill_pin` (`[{name, source, versionId, sha256}]`) holds the org and workspace skills its task selected, resolved when the row is made; create and follow-up resolve (a follow-up for the thread owner's workspace), retry copies the thread head's pin, workflow successors and durable-wait wakes copy the predecessor's, a reviewer row is empty; every `insert into job` under `server/src/db` names `skill_pin` | `server/migrations/129_job_skill_pin.sql`, `server/src/db/jobs/job-store-skill-pin.ts`, `server/src/db/jobs/job-store-actions.ts`, `server/src/db/jobs/job-store-rows.ts`, `server/src/db/jobs/job-store-reviews.ts` | `server/test-db/job-store.skill-pin.test.ts`, `server/test/job-insert-pin.test.ts` |
| Claim: `skillPin` is the claimed row's own pin; a selected name the pin holds is delivered at the pinned version and is not checked against the live catalog | `server/src/db/jobs/job-store-claim-skills.ts` (`resolveClaimSkills`), `server/src/db/jobs/job-store-types.ts` | `server/test-db/job-store.skill-pin.test.ts` |
| Content route: `POST /api/jobs/:id/skills/:versionId/content` with `{leaseToken}`; bytes with `x-content-sha256` for a version in the row's pin; `409` lost lease, `404` not in the pin (`SKILL_NOT_FOUND`), `410` version or object gone, `422` bytes fail the sha256, `503` unconfirmed read | `server/src/routes/jobs/job-handlers-skill-content.ts`, `server/src/auth/plugin.ts` (`WORKER_ROUTES`) | `server/test/routes.jobs-skill-content.test.ts`, `server/test/auth.enforcement.test.ts` |

## Invariants

- A workspace skill is owned by one member and an org skill by the organization; another owner's id is `404 SKILL_NOT_FOUND`, never `403`.
- A version is immutable; equal content reuses its row. Delete is soft and a version stays readable for a pin until the sweep.
- A name starting `factory-` is refused (`422 SKILL_BUNDLE_INVALID`, reason `reserved_name`); a taken name in the same scope is `409 NAME_TAKEN`; a workspace and an org skill may share a name, the org one wins.
- Promote is workspace to org, admin only, and `409` when the org already has the name.
- An unconfirmed read is never "no skills": a lost object is `410 SKILL_GONE`, an unreachable store or object is `503`.
- The object key is per org (`<prefix>_skills/<org>/<sha256>`); only the sweep deletes objects. Stated limit: an upload whose transaction then fails or loses a name race leaves an unreferenced object that nothing lists or sweeps.
- The catalog limits and per-layer precedence for selection stay in [docs/jobs.md](jobs.md).
- A pin is never re-resolved across claims: a takeover or user retry delivers the versions the row was made with, even for a skill disabled or deleted since; only a follow-up resolves again. A pinned version a runner cannot fetch is `410`/`422`, never `404`, so it cannot read as "not pinned".
