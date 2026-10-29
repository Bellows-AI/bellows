import { setTimeout as sleep } from 'node:timers/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createEnvVarStore } from '../src/db/env-var-store.js';
import { convertPlaintextEnvSecrets, conversionExitCode } from '../src/db/env-secret-conversion.js';
import { envSecretIdentity, type EnvSecretScope } from '../src/db/env-secrets.js';
import { MAX_SECRET_BYTES } from '../src/secrets/secret-input.js';
import { ProviderFault } from '../src/secrets/secret-payloads.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';
import {
    captureDiagnostics,
    failingPoolQuery,
    faultySecrets,
    seedPlaintextRow,
    spySecrets,
    testSecretStore,
} from './env-secrets-harness.js';
import { createPostgresHarness, MutableKeys, wrappedPayloads } from './secrets-postgres-harness.js';

const enabled = Boolean(process.env.DATABASE_URL);

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const ALICE = ALICE_USER.id;
const ORG_SCOPE: EnvSecretScope = { kind: 'org' };
const WS_SCOPE: EnvSecretScope = { kind: 'workspace', userId: ALICE };
const REPO_SCOPE: EnvSecretScope = { kind: 'repo', owner: 'Bellows-AI', name: 'bellows.ai' };

const db = useTestDb({ orgs: [ORG], users: [ALICE_USER] });

let sql: Sql;
let keys: MutableKeys;
let healthy: ReturnType<typeof testSecretStore>;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    keys = new MutableKeys();
    healthy = testSecretStore(sql, keys);
});

const slot = (scope: EnvSecretScope, name: string) => ({ orgId: ORG, scope, name });

const rowWhere = (scope: EnvSecretScope, name: string) =>
    sql`org_id = ${ORG} and name = ${name}
        and user_id is not distinct from ${scope.kind === 'workspace' ? scope.userId : null}::uuid
        and repo_owner is not distinct from ${scope.kind === 'repo' ? scope.owner : null}
        and repo_name is not distinct from ${scope.kind === 'repo' ? scope.name : null}`;

const rowOf = async (scope: EnvSecretScope, name: string) => {
    const [row] = await sql<{ value: string | null; is_secret: boolean; secret_ref: string | null }[]>`
        select value, is_secret, secret_ref from env_var where ${rowWhere(scope, name)}
    `;
    return row;
};

const readState = async (scope: EnvSecretScope, name: string, ref: string | null): Promise<string> => {
    const read = await healthy.readActive({ identity: envSecretIdentity(ORG, scope, name), ref: ref as never });
    return read.ok ? 'ok' : read.error.code;
};

const nonSecretSnapshot = () => sql`select to_jsonb(e) as row from env_var e where not is_secret order by name`;

const run = (secrets: SecretStore, over: { sql?: Sql; signal?: AbortSignal } = {}) => {
    const diag = captureDiagnostics();
    const summary = convertPlaintextEnvSecrets({
        sql: over.sql ?? sql,
        secrets,
        signal: over.signal ?? new AbortController().signal,
        secretLog: diag.log,
    });
    return { diag, summary };
};

describe.skipIf(!enabled)('plaintext env secret conversion', () => {
    it('converts old-format secrets in all three scopes and resolves the same values', async () => {
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'S_ORG'), 'org-secret', true);
        await seedPlaintextRow(sql, slot(WS_SCOPE, 'S_WS'), 'ws-secret', true);
        await seedPlaintextRow(sql, slot(REPO_SCOPE, 'S_REPO'), 'repo-secret', true);
        const spy = spySecrets(healthy);

        const { summary, diag } = run(spy.store);
        const result = await summary;

        expect(result).toMatchObject({ converted: 3, remaining: 0, aborted: false, failed: 0, orphans: [] });
        expect(conversionExitCode(result)).toBe(0);
        const [plain] = await sql<{ n: number }[]>`
            select count(*)::int as n from env_var where is_secret and value is not null
        `;
        expect(plain?.n).toBe(0);
        const store = createEnvVarStore({ sql, orgId: ORG, secrets: healthy, secretLog: () => {} });
        expect(await store.resolveFor({ userId: ALICE, repo: 'Bellows-AI/bellows.ai' })).toEqual({
            S_ORG: 'org-secret',
            S_WS: 'ws-secret',
            S_REPO: 'repo-secret',
        });
        expect(JSON.stringify([result, diag.events])).not.toMatch(/org-secret|ws-secret|repo-secret/);
    });

    it('never touches a non-secret row, updated_at included', async () => {
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'P_ORG'), 'plain-org', false);
        await seedPlaintextRow(sql, slot(WS_SCOPE, 'P_WS'), 'plain-ws', false);
        await seedPlaintextRow(sql, slot(REPO_SCOPE, 'P_REPO'), 'plain-repo', false);
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'S_ORG'), 'org-secret', true);
        await sql`update env_var set updated_at = now() - interval '3 days' where not is_secret`;
        const before = await nonSecretSnapshot();
        const spy = spySecrets(healthy);

        const result = await run(spy.store).summary;

        expect(result.converted).toBe(1);
        expect(await nonSecretSnapshot()).toEqual(before);
        expect(spy.calls.creates.map((c) => c.name)).toEqual(['S_ORG']);
        expect(spy.calls.deletes).toEqual([]);
        expect(spy.calls.reconciles).toEqual([]);
    });

    it('a rerun converts nothing and exits 0', async () => {
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'S_ORG'), 'org-secret', true);
        await run(healthy).summary;
        const spy = spySecrets(healthy);

        const result = await run(spy.store).summary;

        expect(result).toMatchObject({ converted: 0, remaining: 0 });
        expect(spy.calls.creates).toEqual([]);
        expect(conversionExitCode(result)).toBe(0);
    });

    it('a row edited mid-conversion keeps its new value and the new record is deleted', async () => {
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'S_ORG'), 'old-value', true);
        const spy = spySecrets(
            faultySecrets(healthy, {
                create: async (input) => {
                    await sql`update env_var set value = 'new-value' where ${rowWhere(ORG_SCOPE, 'S_ORG')}`;
                    return healthy.create(input);
                },
            })
        );

        const result = await run(spy.store).summary;

        expect(await rowOf(ORG_SCOPE, 'S_ORG')).toMatchObject({ value: 'new-value', secret_ref: null });
        const ref = spy.calls.creates[0]?.ref ?? '';
        expect(spy.calls.deletes.map((d) => d.ref)).toEqual([ref]);
        expect(await readState(ORG_SCOPE, 'S_ORG', ref)).toBe('not-found');
        expect(result).toMatchObject({ converted: 0, remaining: 1, orphans: [] });
        expect(conversionExitCode(result)).toBe(1);
    });

    it('a row flipped to non-secret mid-conversion stays plaintext and never gets a reference', async () => {
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'S_ORG'), 'old-value', true);
        const spy = spySecrets(
            faultySecrets(healthy, {
                create: async (input) => {
                    await sql`update env_var set is_secret = false where ${rowWhere(ORG_SCOPE, 'S_ORG')}`;
                    return healthy.create(input);
                },
            })
        );

        const result = await run(spy.store).summary;

        expect(await rowOf(ORG_SCOPE, 'S_ORG')).toEqual({ value: 'old-value', is_secret: false, secret_ref: null });
        const ref = spy.calls.creates[0]?.ref ?? '';
        expect(await readState(ORG_SCOPE, 'S_ORG', ref)).toBe('not-found');
        expect(result).toMatchObject({ converted: 0, remaining: 0 });
        expect(conversionExitCode(result)).toBe(0);
    });

    it('a compare-and-set miss whose scope re-read fails reports the orphan and deletes nothing', async () => {
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'S_ORG'), 'old-value', true);
        const spy = spySecrets(
            faultySecrets(healthy, {
                create: async (input) => {
                    await sql`update env_var set value = 'new-value' where ${rowWhere(ORG_SCOPE, 'S_ORG')}`;
                    return healthy.create(input);
                },
            })
        );

        const { summary, diag } = run(spy.store, { sql: failingPoolQuery(sql, 'select secret_ref') });
        const result = await summary;

        const ref = spy.calls.creates[0]?.ref ?? '';
        expect(result.orphans).toEqual([ref]);
        expect(spy.calls.deletes).toEqual([]);
        expect(diag.events.some((e) => e.event === 'cleanup-failed' && e.ref === ref)).toBe(true);
        expect(await readState(ORG_SCOPE, 'S_ORG', ref)).toBe('ok');
        expect(conversionExitCode(result)).toBe(1);
    });

    it('an oversized row is reported by org, scope and name, left plaintext, and fails the run', async () => {
        const big = 'x'.repeat(MAX_SECRET_BYTES + 1);
        await seedPlaintextRow(sql, slot(WS_SCOPE, 'BIG'), big, true);
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'S_ORG'), 'org-secret', true);
        const spy = spySecrets(healthy);

        const { summary, diag } = run(spy.store);
        const result = await summary;

        expect(result.oversized).toEqual([{ org: ORG, scopeKind: 'workspace', scopeKey: ALICE, name: 'BIG' }]);
        expect(result).toMatchObject({ converted: 1, remaining: 1 });
        expect(await rowOf(WS_SCOPE, 'BIG')).toMatchObject({ value: big, secret_ref: null });
        expect(spy.calls.creates.map((c) => c.name)).toEqual(['S_ORG']);
        expect(conversionExitCode(result)).toBe(1);
        expect(JSON.stringify([result, diag.events])).not.toContain(big);
    });

    it('two concurrent runs leave exactly one reference per row and delete the losing run record', async () => {
        const names = ['S_A', 'S_B', 'S_C'];
        for (const name of names) await seedPlaintextRow(sql, slot(ORG_SCOPE, name), `value-${name}`, true);
        const gates = new Map<string, { count: number; release: () => void; promise: Promise<void> }>();
        const meet = async (key: string) => {
            let gate = gates.get(key);
            if (!gate) {
                let release!: () => void;
                const promise = new Promise<void>((resolve) => (release = resolve));
                gate = { count: 0, release, promise };
                gates.set(key, gate);
            }
            if (++gate.count >= 2) gate.release();
            await gate.promise;
        };
        const racer = () =>
            spySecrets(
                faultySecrets(healthy, {
                    create: async (input) => {
                        await meet(input.identity.owningRecord.id);
                        return healthy.create(input);
                    },
                })
            );
        const [a, b] = [racer(), racer()];

        const [first, second] = await Promise.all([run(a.store).summary, run(b.store).summary]);

        expect(first.converted + second.converted).toBe(names.length);
        const refs = [...a.calls.creates, ...b.calls.creates];
        expect(refs).toHaveLength(names.length * 2);
        let live = 0;
        for (const name of names) {
            const row = await rowOf(ORG_SCOPE, name);
            expect(row).toMatchObject({ value: null });
            for (const created of refs.filter((c) => c.name === name)) {
                const state = await readState(ORG_SCOPE, name, created.ref);
                if (created.ref === row?.secret_ref) expect(state).toBe('ok');
                else expect(state).toBe('not-found');
                if (state === 'ok') live += 1;
            }
        }
        expect(live).toBe(names.length);
    });

    it('an abort stops between rows and fails the run', async () => {
        for (const name of ['S_A', 'S_B', 'S_C']) await seedPlaintextRow(sql, slot(ORG_SCOPE, name), name, true);
        const controller = new AbortController();
        let issued = 0;
        const spy = spySecrets(
            faultySecrets(healthy, {
                issueOperationId: async () => {
                    if (++issued === 2) controller.abort();
                    return healthy.issueOperationId();
                },
            })
        );

        const result = await run(spy.store, { signal: controller.signal }).summary;

        expect(result).toMatchObject({ converted: 1, failed: 1, remaining: 2, aborted: true });
        expect(spy.calls.creates).toHaveLength(1);
        expect(conversionExitCode(result)).toBe(1);
    });

    it('an already-aborted signal converts nothing', async () => {
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'S_A'), 'a', true);
        const spy = spySecrets(healthy);

        const result = await run(spy.store, { signal: AbortSignal.abort() }).summary;

        expect(result).toMatchObject({ converted: 0, remaining: 1, aborted: true });
        expect(spy.calls.creates).toEqual([]);
        expect(conversionExitCode(result)).toBe(1);
    });

    it('a create that fails after staging is reconciled once, counted failed, and the next row still runs', async () => {
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'A_ROW'), 'a-value', true);
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'B_ROW'), 'b-value', true);
        const h = createPostgresHarness(sql, { deadlineMs: 3000, keys });
        let writes = 0;
        const broken = h.openWith(h.faultyRepo, (database) =>
            wrappedPayloads({
                async write() {
                    if (writes++ === 0) throw new ProviderFault('misconfigured');
                    return database.write();
                },
            })(database)
        );
        const spy = spySecrets(broken);

        const { summary, diag } = run(spy.store);
        const result = await summary;

        expect(result).toMatchObject({ converted: 1, failed: 1, remaining: 1 });
        expect(spy.calls.reconciles).toHaveLength(1);
        expect(await rowOf(ORG_SCOPE, 'A_ROW')).toMatchObject({ value: 'a-value', secret_ref: null });
        expect(await rowOf(ORG_SCOPE, 'B_ROW')).toMatchObject({ value: null, secret_ref: expect.any(String) });
        const ref = spy.calls.creates[0]?.ref ?? '';
        const reported = diag.events.some((e) => e.event === 'cleanup-failed' && e.ref === ref);
        expect((await readState(ORG_SCOPE, 'A_ROW', ref)) === 'not-found' || reported).toBe(true);
        expect(conversionExitCode(result)).toBe(1);
    });

    it('a create delayed past the row deadline is abandoned at the row signal, tracked, and the next row runs', async () => {
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'A_ROW'), 'a-value', true);
        await seedPlaintextRow(sql, slot(ORG_SCOPE, 'B_ROW'), 'b-value', true);
        const h = createPostgresHarness(sql, { deadlineMs: 3000, keys });
        let stages = 0;
        const slow = h.openWith({
            ...h.realRepo,
            stageVersion: async (version, budgetMs) => {
                if (stages++ === 0) await sleep(2000);
                return h.realRepo.stageVersion(version, budgetMs);
            },
        });
        const spy = spySecrets(slow);
        const diag = captureDiagnostics();

        const started = Date.now();
        const result = await convertPlaintextEnvSecrets({
            sql,
            secrets: spy.store,
            signal: new AbortController().signal,
            secretLog: diag.log,
            rowDeadlineMs: 200,
        });
        const elapsed = Date.now() - started;

        expect(elapsed).toBeLessThan(1500);
        expect(result).toMatchObject({ converted: 1, failed: 1, remaining: 1 });
        const ref = spy.calls.creates[0]?.ref ?? '';
        const reported = () => diag.events.some((e) => e.event === 'cleanup-failed' && e.ref === ref);
        expect(spy.calls.reconciles.filter((r) => r.ref === ref).length === 1 || reported()).toBe(true);

        await sleep(2300);
        expect((await readState(ORG_SCOPE, 'A_ROW', ref)) === 'not-found' || reported()).toBe(true);
        expect(await rowOf(ORG_SCOPE, 'A_ROW')).toMatchObject({ value: 'a-value', secret_ref: null });
    });
});
