# Skills

Org and workspace skills: versioned `SKILL.md` bundles a task can select beside the built-ins and a repository's own.

| Concern | Code | Test |
| --- | --- | --- |
| Bundle codec: inline `SKILL.md` or zip to a validated, deterministic tar and its sha256; stable refusal reasons | `server/src/skills/skill-bundle.ts`, `core/src/skills.ts` (`MAX_SKILL_FILES`, `MAX_SKILL_BYTES`, `MAX_SKILL_FILE_BYTES`) | `server/test/skill-bundle.test.ts` |
| Tables: `skill` (owner, enabled, soft delete, current version) and immutable `skill_version` | `server/migrations/128_skills.sql` | `server/test-db/skill-store.test.ts` |
| Store: owner in every by-id WHERE, pending row then object then `ready` + current swap, `effective(userId)` | `server/src/db/skill-store.ts` | `server/test-db/skill-store.test.ts` |
| Routes: `/api/org/skills` (read: any member, write: org admin) and `/api/workspace/skills` (own skills); list, get, create (JSON `{name, skillMd}` or raw `application/zip` with `?name=`), `/:id/versions`, `PUT /:id/enabled`, `DELETE` (soft), `POST /api/workspace/skills/:id/scope` (admin) | `server/src/routes/skills-store.ts`, `server/src/auth/route-class.ts` | `server/test/routes.skills-store.test.ts`, `server/test/auth.enforcement.test.ts` |
| Catalog: `effectiveCatalog` reads enabled org skills and the caller's workspace skills; a failed read is `storedError`, which makes a name `unverified` and `GET /api/skills` a 503 | `server/src/skill-catalog.ts`, `server/src/routes/skills.ts` | `server/test/routes.skills-store.test.ts`, `server/test/skills.test.ts` |
| Retention sweep: a deleted skill's versions and orphan objects are removed after the retention window | `server/src/skills/skill-collector.ts` | `server/test-db/skill-store.test.ts` |

## Invariants

- A workspace skill is owned by one member and an org skill by the organization; another owner's id is `404 SKILL_NOT_FOUND`, never `403`.
- A version is immutable; equal content reuses its row. Delete is soft and a version stays readable for a pin until the sweep.
- A name starting `factory-` is refused (`422 SKILL_BUNDLE_INVALID`, reason `reserved_name`); a taken name in the same scope is `409 NAME_TAKEN`; a workspace and an org skill may share a name, the org one wins.
- Promote is workspace to org, admin only, and `409` when the org already has the name.
- An unconfirmed read is never "no skills": a lost object is `410 SKILL_GONE`, an unreachable store or object is `503`.
- The object key is per org (`<prefix>_skills/<org>/<sha256>`); only the sweep deletes objects.
- The catalog limits and per-layer precedence for selection stay in [docs/jobs.md](jobs.md).
