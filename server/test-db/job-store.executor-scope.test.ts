import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { useTestDb } from './harness.js';
import { mustCreate, testOrg, testUser } from './fixtures.js';

/**
 * Issue 391's board half: a task selection names a scope and a profile, and the claim resolves
 * type + configuration from the STAMPED scope's row — a personal and an organization row sharing
 * a name stay distinguishable, an org row resolves for any author, and an unavailable selection
 * stays null (the driver fails it) rather than falling back to the other scope. The copies —
 * follow-up, retry — inherit the scope beside the executor label they already inherit.
 */

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;

const ORG = testOrg();
const ALICE_USER = testUser('alice');
const BOB_USER = testUser('bob');
const ALICE = ALICE_USER.id;
const BOB = BOB_USER.id;
const SESSION = randomUUID();
const FOLLOW_UP_SESSION = randomUUID();
const LEASE_SECONDS = 300;

const db = useTestDb({
    orgs: [ORG],
    users: [ALICE_USER, BOB_USER],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({
        sql,
        orgId: ORG,
        executorConfig: createUserExecutorStore({ sql, orgId: ORG }),
    });
});

describe.skipIf(!enabled)('claim resolution across executor scopes (issue 391)', () => {
    /** Alice's personal "main" and the organization's own "main": same name, two rows. */
    const seedSameName = async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG });
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: { model: 'personal-model' } }]);
        await executors.createOrg({
            name: 'main',
            type: 'claude-code',
            config: { model: 'shared-model' },
            createdBy: ALICE,
        });
    };

    it('resolves an org-scoped selection from the org row, for any author', async () => {
        await seedSameName();
        const { id } = await mustCreate(
            store.create('echo hi', BOB, { repo: null, executor: 'main', executorScope: 'org' })
        );

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBe('claude-code');
        // The org row's configuration reaches the claim env under claude-code's merge name —
        // with the runner-managed keys already stripped, per the standing claim contract.
        const merged = claim?.env?.CLAUDE_CODE_CONFIG_CONTENT;
        expect(merged).toBeDefined();
        expect(JSON.parse(merged!)).toEqual({ model: 'shared-model' });
    });

    it('resolves the personal row when the selection stamps the personal scope', async () => {
        await seedSameName();
        await mustCreate(store.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' }));

        const claim = await store.claim('w2', LEASE_SECONDS);

        expect(claim?.executorType).toBe('opencode');
        expect(JSON.parse(claim?.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({ model: 'personal-model' });
    });

    it('a scope with no matching row stays null — no cross-scope fallback', async () => {
        await seedSameName();
        // Bob has no personal "main": his personal-scope selection names nothing.
        const { id } = await mustCreate(
            store.create('echo hi', BOB, { repo: null, executor: 'main', executorScope: 'user' })
        );

        const claim = await store.claim('w3', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBeNull();
        expect(claim?.env?.OPENCODE_CONFIG_CONTENT).toBeUndefined();
        expect(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT).toBeUndefined();
    });

    it('a row removed after queueing resolves null, and the task fails clearly rather than guessing', async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG });
        await executors.createOrg({ name: 'gone', type: 'claude-code', config: {}, createdBy: ALICE });
        const { id } = await mustCreate(
            store.create('echo hi', ALICE, { repo: null, executor: 'gone', executorScope: 'org' })
        );
        const orgRow = (await executors.listOrg()).find((row) => row.name === 'gone')!;
        await executors.deleteOrg(orgRow.id);

        const claim = await store.claim('w4', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBeNull();
    });
});

describe.skipIf(!enabled)('claim resolution against a suspended profile (issue 440)', () => {
    const suspend = async (scope: 'user' | 'org', name: string, suspended: boolean) => {
        const executors = createUserExecutorStore({ sql, orgId: ORG });
        if (scope === 'org') {
            const row = (await executors.listOrg()).find((r) => r.name === name)!;
            await executors.setOrgSuspended(row.id, suspended);
        } else {
            const row = (await executors.list(ALICE)).find((r) => r.name === name)!;
            await executors.setPersonalSuspended(ALICE, row.id, suspended);
        }
    };

    it('hands out no runner and no config for a suspended profile, and says why', async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG });
        await executors.replace(ALICE, [{ name: 'main', type: 'claude-code', config: { model: 'secret' } }]);
        const { id } = await mustCreate(
            store.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'user' })
        );
        await suspend('user', 'main', true);

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim?.id).toBe(id);
        expect(claim?.executorType).toBeNull();
        expect(claim?.executorRefusal).toContain('"main"');
        expect(claim?.executorRefusal).toContain('suspended');
        expect(claim?.env?.CLAUDE_CODE_CONFIG_CONTENT).toBeUndefined();
    });

    it('is scoped: a suspended personal profile does not refuse the same-named org selection', async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG });
        await executors.replace(ALICE, [{ name: 'main', type: 'opencode', config: {} }]);
        await executors.createOrg({ name: 'main', type: 'claude-code', config: {}, createdBy: ALICE });
        await suspend('user', 'main', true);
        await mustCreate(store.create('echo hi', ALICE, { repo: null, executor: 'main', executorScope: 'org' }));

        const claim = await store.claim('w2', LEASE_SECONDS);

        expect(claim?.executorType).toBe('claude-code');
        expect(claim?.executorRefusal).toBeNull();
    });

    it('applies to a follow-up and a retry the same way, and launches again once resumed', async () => {
        const executors = createUserExecutorStore({ sql, orgId: ORG });
        await executors.createOrg({ name: 'team', type: 'claude-code', config: {}, createdBy: ALICE });
        const parent = await mustCreate(
            store.create('drive me', ALICE, { repo: null, executor: 'team', executorScope: 'org' })
        );
        const first = await store.claim('w3', LEASE_SECONDS);
        await store.session(parent.id, first!.leaseToken, FOLLOW_UP_SESSION);
        await store.complete(parent.id, first!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        await suspend('org', 'team', true);

        const followUp = await store.createFollowUp(parent.id, 'adjust', ALICE);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);
        const refused = await store.claim('w4', LEASE_SECONDS);
        expect(refused?.id).toBe(followUp.id);
        expect(refused?.executorType).toBeNull();
        expect(refused?.executorRefusal).toContain('suspended');
        // The driver fails a refused claim as config (driver/src/loop-run.ts failOnClaimRefusal);
        // until it does the follow-up is the thread's moving head and a retry is not_finished.
        await store.complete(followUp.id, refused!.leaseToken, {
            status: 'failed',
            exitCode: null,
            output: refused!.executorRefusal!,
            failureKind: 'config',
        });

        await suspend('org', 'team', false);
        const retry = await store.createRetry(parent.id, ALICE);
        if (typeof retry === 'string') throw new Error(`createRetry refused: ${retry}`);
        const allowed = await store.claim('w5', LEASE_SECONDS);
        expect(allowed?.id).toBe(retry.id);
        expect(allowed?.executorType).toBe('claude-code');
        expect(allowed?.executorRefusal).toBeNull();
    });
});

describe.skipIf(!enabled)('the scope rides the thread (issue 391)', () => {
    /** Takes a job the whole way to a finished run with a session, the follow-up's starting state. */
    const finishWithSession = async (target: { executor: string; executorScope: 'user' | 'org' }) => {
        const { id } = await mustCreate(store.create('drive me', ALICE, { repo: null, ...target }));
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(id, claim!.leaseToken, SESSION);
        await store.complete(id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        return id;
    };

    it('a follow-up inherits the stamped scope beside the executor label', async () => {
        const parent = await finishWithSession({ executor: 'main', executorScope: 'org' });

        const followUp = await store.createFollowUp(parent, 'adjust', ALICE);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);

        expect(await store.get(followUp.id)).toMatchObject({
            executor: 'main',
            executorScope: 'org',
            followUpTo: parent,
        });
    });

    it('a retry inherits the stamped scope from the thread head', async () => {
        const head = await finishWithSession({ executor: 'team-runner', executorScope: 'org' });

        const retry = await store.createRetry(head, ALICE);
        if (typeof retry === 'string') throw new Error(`createRetry refused: ${retry}`);

        expect(await store.get(retry.id)).toMatchObject({
            executor: 'team-runner',
            executorScope: 'org',
            rootJobId: (await store.get(head))?.rootJobId,
        });
    });
});
