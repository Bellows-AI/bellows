import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuthStore } from '../src/auth/store.js';
import { createOrgOfJob } from '../src/db/jobs/job-store-org-resolvers.js';
import { migrate } from '../src/db/migrate.js';
import { orgSql } from '../src/db/org-sql.js';
import { crossOrgPool, requestPools } from '../src/db/pool.js';
import { LOCAL_ORG_ID } from '../src/identifiers.js';
import { craftJob, randomGithubId, testOrg } from './fixtures.js';
import { assertTestDatabase } from './harness.js';

/**
 * 154 forces the org policies on the owner. The owner here is a login of its own with neither superuser nor BYPASSRLS,
 * as on a managed database, so the force is observable: the image's superuser ignores every policy. The schema stops
 * at the release before (a copy of the migrations without 154), where the owner is exempt and writes rows with no
 * setting, as a pod of that release does; the upgrade then forces the policies and the board's pools, built as
 * main.ts builds them, still serve every lookup.
 */
const url = process.env.DATABASE_URL;
if (url) assertTestDatabase(url);
const enabled = Boolean(url);

const VERSION = '154_force_row_level_security.sql';
const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url));
const POOL = { max: 2, statementTimeoutMs: 30_000 };
const UPGRADE_TIMEOUT_MS = 120_000;
const SEED_TIMEOUT_MS = 90_000;
const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TSX = fileURLToPath(new URL('../../node_modules/.bin/tsx', import.meta.url));

let admin: Sql;
let owner: Sql;
let ownerUrl: string;
let role: string;
let schema: string;
let before: string;

const pools: Sql[] = [];
const pool = (sql: Sql): Sql => {
    pools.push(sql);
    return sql;
};

const hash = (token: string): Buffer => createHash('sha256').update(token).digest();

const orgTables = (sql: Sql) =>
    sql<{ name: string; forced: boolean }[]>`
        select c.relname as name, c.relforcerowsecurity as forced from pg_class c
        join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
        where c.relnamespace = ${schema}::regnamespace and c.relkind in ('r', 'p') order by 1`;

beforeAll(async () => {
    if (!enabled) return;
    admin = postgres(url as string, { max: 1, onnotice: () => {} });
    const hex = randomUUID().replaceAll('-', '');
    role = `rls_up_${hex}`;
    schema = `mig_${hex}`;
    const password = randomBytes(16).toString('hex');
    await admin.unsafe(`create role ${role} login nosuperuser nobypassrls password '${password}'`);
    // The roles exist cluster-wide from the template's migration; 151 only checks them and the owner's membership.
    await admin.unsafe(`grant bellows_request, bellows_cross_org to ${role}`);
    await admin.unsafe(`create schema ${schema} authorization ${role}`);
    // Every pool on the login resolves the schema, the role-taking ones included: boardPool passes no search_path.
    await admin.unsafe(`alter role ${role} set search_path = ${schema}`);
    const parsed = new URL(url as string);
    parsed.username = role;
    parsed.password = password;
    ownerUrl = parsed.toString();
    assertTestDatabase(ownerUrl);
    owner = pool(postgres(ownerUrl, { max: 1, onnotice: () => {} }));

    before = mkdtempSync(join(tmpdir(), 'mig-153-'));
    for (const name of readdirSync(MIGRATIONS)) {
        if (name.endsWith('.sql') && !name.startsWith('154_')) copyFileSync(join(MIGRATIONS, name), join(before, name));
    }
});

afterAll(async () => {
    if (!enabled) return;
    await Promise.all(pools.map((sql) => sql.end({ timeout: 5 })));
    await admin.unsafe(`drop schema ${schema} cascade`);
    await admin.unsafe(`drop owned by ${role}`);
    await admin.unsafe(`drop role ${role}`);
    await admin.end({ timeout: 5 });
    rmSync(before, { recursive: true, force: true });
});

describe.skipIf(!enabled)('154_force_row_level_security', () => {
    it(
        'upgrades from 153 as an owner without BYPASSRLS: the owner is bound, and the board still serves every lookup',
        async () => {
            const [attrs] = await owner<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
                select rolsuper, rolbypassrls from pg_roles where rolname = current_user
            `;
            expect(attrs).toEqual({ rolsuper: false, rolbypassrls: false });

            // The release before: the owner is exempt and writes with no setting.
            await migrate(owner, { dir: pathToFileURL(`${before}/`), attempts: 1, localUser: false });
            const org = testOrg();
            const auth = createAuthStore({ sql: owner });
            const caller = await auth.signIn(
                { githubUserId: randomGithubId(), login: 'upgrade-member', displayName: null, avatarUrl: null },
                org,
                [{ id: org, name: 'upgrade-installation' }]
            );
            const live = `live-${randomUUID()}`;
            const expired = `expired-${randomUUID()}`;
            await auth.createSession(hash(live), caller.user.id, new Date(Date.now() + 3_600_000), org);
            await auth.createSession(hash(expired), caller.user.id, new Date(Date.now() - 3_600_000), org);
            const job = await craftJob({ sql: owner, org, author: caller.user.id });
            const [planted] = await owner<{ sessions: number; jobs: number }[]>`
                select (select count(*)::int from session) as sessions, (select count(*)::int from job) as jobs
            `;
            expect(planted).toEqual({ sessions: 2, jobs: 1 });

            await migrate(owner, { attempts: 1, localUser: true });

            // Applied, and in effect on every org table and partition.
            const ledger = await owner<{ version: string }[]>`
                select version from schema_migrations where version = ${VERSION}
            `;
            expect(ledger).toEqual([{ version: VERSION }]);
            const tables = await orgTables(owner);
            expect(tables.length).toBeGreaterThan(0);
            expect(tables.filter((t) => !t.forced).map((t) => t.name)).toEqual([]);

            // The owner with no setting reads nothing: the lookups below are not explained by a bypass.
            const [blind] = await owner<{ sessions: number; jobs: number }[]>`
                select (select count(*)::int from session) as sessions, (select count(*)::int from job) as jobs
            `;
            expect(blind).toEqual({ sessions: 0, jobs: 0 });

            // The seed and the reaps ran under the force (a regression guard: they take the cross-org role).
            const crossOrg = pool(crossOrgPool(ownerUrl, POOL));
            const [seeded] = await crossOrg<{ members: number; expired: number }[]>`
                select (select count(*)::int from org_membership where org_id = ${LOCAL_ORG_ID}) as members,
                       (select count(*)::int from session where token_hash = ${hash(expired)}) as expired
            `;
            expect(seeded).toEqual({ members: 1, expired: 0 });

            // The board's pools, built as main.ts builds them, serve the planted rows (a regression guard).
            const {
                owner: bootOwner,
                request,
                secrets,
            } = requestPools({ databaseUrl: ownerUrl, databaseRequestUrl: null }, POOL);
            pool(bootOwner);
            pool(request);
            pool(secrets);
            const found = await createAuthStore({ sql: crossOrg }).findSession(hash(live));
            expect(found?.user.id).toBe(caller.user.id);
            expect(found?.org.id).toBe(org);
            expect(await createOrgOfJob({ sql: crossOrg })(job)).toBe(org);
            const rows = await orgSql(request, org)<{ id: string }[]>`select id from job where id = ${job}`;
            expect(rows).toEqual([{ id: job }]);
        },
        UPGRADE_TIMEOUT_MS
    );

    it(
        'seeds through the cross-org role: the seed CLI on an owner bound by the forced policies plants its rows',
        async () => {
            await migrate(owner, { attempts: 1, localUser: true });
            await run(TSX, ['server/src/seed/cli.ts'], {
                cwd: ROOT,
                env: { ...process.env, DATABASE_URL: ownerUrl, SEED_ORGS: '' },
                timeout: SEED_TIMEOUT_MS,
            });
            const crossOrg = pool(crossOrgPool(ownerUrl, POOL));
            const [rows] = await crossOrg<{ branches: number; points: number; jobs: number }[]>`
                select (select count(*)::int from session_branch where org_id = ${LOCAL_ORG_ID}) as branches,
                       (select count(*)::int from metric_point where org_id = ${LOCAL_ORG_ID}) as points,
                       (select count(*)::int from job where org_id = ${LOCAL_ORG_ID}) as jobs
            `;
            expect(rows!.branches).toBeGreaterThan(0);
            expect(rows!.points).toBeGreaterThan(0);
            expect(rows!.jobs).toBeGreaterThan(0);
        },
        SEED_TIMEOUT_MS * 2
    );
});
