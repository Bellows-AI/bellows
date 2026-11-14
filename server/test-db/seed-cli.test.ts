import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createAuthStore } from '../src/auth/store.js';
import { LOCAL_ORG_ID } from '../src/identifiers.js';
import { randomGithubId, testOrg } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * `npm run seed` applies to a freshly migrated, empty schema — the state `verify:ui`'s reset leaves — including the
 * stand-in installation orgs `SEED_ORGS` names, which no sign-in has materialized yet. Every org-owned table carries
 * a foreign key to `organization`, so a seeder that writes for an org it did not create first fails here, not in
 * the browser lane's web server boot. A later sign-in to a seeded org still materializes it.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const db = useTestDb();

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));
const SEED_TIMEOUT_MS = 90_000;

const seed = (seedOrgs: readonly string[]) =>
    run(TSX, ['server/src/seed/cli.ts'], {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: db.url, SEED_ORGS: seedOrgs.join(',') },
        timeout: SEED_TIMEOUT_MS,
    });

describe.skipIf(!enabled)('the seed CLI on a fresh schema', () => {
    it(
        'plants every org it writes for, twice over, and a sign-in still materializes the stand-in org',
        async () => {
            const orgs = [testOrg(), testOrg()];

            await seed(orgs);
            await seed(orgs);

            const planted = await db.sql<{ id: string }[]>`
                select id from organization where id = any(${[LOCAL_ORG_ID, ...orgs]}) order by id
            `;
            expect(planted.map((r) => r.id)).toEqual([LOCAL_ORG_ID, ...orgs].sort());
            const branches = await db.sql<{ orgId: string }[]>`
                select distinct org_id as "orgId" from session_branch where org_id = any(${orgs}) order by org_id
            `;
            expect(branches.map((r) => r.orgId)).toEqual([...orgs].sort());

            const [org] = orgs as [string, string];
            await createAuthStore({ sql: db.sql }).signIn(
                { githubUserId: randomGithubId(), login: 'seeded-member', displayName: null, avatarUrl: null },
                org,
                [{ id: org, name: 'seeded-installation' }]
            );
            const [row] = await db.sql<{ name: string; installationId: string; role: string }[]>`
                select o.name, o.installation_id::text as "installationId", m.role
                from organization o join org_membership m on m.org_id = o.id
                where o.id = ${org} and m.github_login = 'seeded-member'
            `;
            expect(row).toEqual({ name: 'seeded-installation', installationId: org, role: 'admin' });
        },
        SEED_TIMEOUT_MS * 2
    );
});
