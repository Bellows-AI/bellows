import type { Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { USER_SCOPE } from '@factory-ai/core';
import { createProviderSetupStore, type SetupCommand } from '../src/db/provider-setup-store.js';
import { createUserExecutorStore } from '../src/db/user-executor-store.js';
import { testSecretStore } from './env-secrets-harness.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { DEADLINE_MS, holder, pool, settledWithin, value, waitForLockWait } from './lock-order-harness.js';

/**
 * The lock order across the setup, the deletion of an organization executor with a replacement and its demotion to a
 * personal one (docs/persistence.md): the profile rows first, the selection rows after. Each test parks a real setup
 * edit of B behind a connection lock after it took B, queues the real delete (or demotion) of A naming B as the
 * replacement behind it, and requires both to finish: an inversion is a 40P01 here, never a timing accident.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE_USER = testUser('lo-setup-alice');
const ALICE = ALICE_USER.id;
const SETUP = 'setup-under-test';
const REMOVER = 'remover-under-test';
const db = useTestDb({ orgs: [ORG], users: [ALICE_USER], max: 6 });

let sql: Sql;
let setupPool: Sql;
let removerPool: Sql;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    setupPool = pool(SETUP);
    removerPool = pool(REMOVER);
});

afterAll(async () => {
    await setupPool?.end({ timeout: 5 });
    await removerPool?.end({ timeout: 5 });
});

const deps = (on: Sql) => ({ sql: on, orgId: ORG, secrets: testSecretStore(sql), secretLog: () => {} });

let counter = 0;
const command = (over: Partial<SetupCommand>): SetupCommand => {
    counter += 1;
    return {
        scope: 'org',
        userId: ALICE,
        requestId: `lock-order-${counter}`,
        connection: { intent: 'create', provider: 'anthropic', key: 'sk-ant-lock-order', baseUrl: null, name: 'A' },
        executor: { name: 'A', agentType: 'claude-code', model: 'claude-sonnet-4-5' },
        ...over,
    };
};

/** Executors A and B with a connection each; the organization default names A. */
async function twoExecutors() {
    const setup = createProviderSetupStore(deps(sql));
    const a = await setup.apply(command({}));
    const b = await setup.apply(
        command({
            connection: { intent: 'create', provider: 'anthropic', key: 'sk-ant-lock-b', baseUrl: null, name: 'B' },
            executor: { name: 'B', agentType: 'claude-code', model: 'claude-sonnet-4-5' },
        })
    );
    await setup.apply(
        command({
            connection: { intent: 'reuse', id: a.connectionId! },
            executor: { id: a.executorId, agentType: 'claude-code', model: 'claude-sonnet-4-5' },
        })
    );
    return { a, b };
}

describe.skipIf(!enabled)('provider setup lock order — database', () => {
    it.each([
        ['deleting A with B as its replacement', 'delete'],
        ['demoting A to personal with B as its replacement', 'demote'],
    ] as const)('a setup edit of B and %s finish without a deadlock', async (_name, removal) => {
        const { a, b } = await twoExecutors();
        const remover = createUserExecutorStore(deps(removerPool));
        const setup = createProviderSetupStore(deps(setupPool));
        const deadline = Date.now() + DEADLINE_MS;

        // The setup edit of B takes B, then waits for B's connection row.
        const parked = await holder(
            sql,
            (tx) => tx`select 1 from provider_connection where id = ${b.connectionId} for update`
        );
        const edit = setup.apply(
            command({
                connection: { intent: 'reuse', id: b.connectionId! },
                executor: { id: b.executorId, agentType: 'claude-code', model: 'claude-opus-4-5' },
            })
        );
        await waitForLockWait(sql, SETUP, deadline);

        // The removal of A starts meanwhile: it may hold the default's row, and wants B as the replacement.
        const resolution = { replaceWith: b.executorId };
        const removed =
            removal === 'delete'
                ? remover.deleteOrg(a.executorId, resolution)
                : remover.changeScope(a.executorId, USER_SCOPE, ALICE, resolution);
        await waitForLockWait(sql, REMOVER, deadline);
        parked.release();
        await parked.done;

        const [editResult, removedResult] = await settledWithin([edit, removed]);
        expect(value(editResult).executorId).toBe(b.executorId);
        expect(value(removedResult)).toBeTruthy();
        const [selection] = await sql<{ executor_id: string }[]>`
            select executor_id from executor_default_selection where org_id = ${ORG} and owner_id is null
        `;
        expect(selection?.executor_id).toBe(b.executorId);
    });
});
