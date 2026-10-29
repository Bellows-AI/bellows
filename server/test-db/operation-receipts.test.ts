import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createConnectionGrants } from '../src/db/connection-grants.js';
import { createOperationReceipts, type BeginInput, type ReceiptStatus } from '../src/db/operation-receipts.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';
import { attachJira, bindConnections, newRoot } from './integration-store-faults.js';

/**
 * BEL-61: the durable receipt of one runner-side write (docs/connections.md). A receipt is the thread
 * root's, keyed by a logical operation key; its status moves only through guarded single statements.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ALICE = testUser('receipt-alice');
const FINGERPRINT = 'a'.repeat(64);
const OTHER_FINGERPRINT = 'b'.repeat(64);

const db = useTestDb({ orgs: [ORG], users: [ALICE] });

async function rig() {
    const sql = db.sql;
    await sql`insert into org_membership (org_id, github_login, user_id) values (${ORG}, ${ALICE.login}, ${ALICE.id})
        on conflict do nothing`;
    const receipts = createOperationReceipts({ sql });
    const rootJobId = await newRoot(sql, ORG, ALICE.id);
    const begin = (over: Partial<BeginInput> = {}): BeginInput => ({
        orgId: ORG,
        rootJobId,
        jobId: rootJobId,
        connectionId: randomUUID(),
        provider: 'jira',
        operation: 'addComment',
        key: `k-${randomUUID()}`,
        fingerprint: FINGERPRINT,
        ...over,
    });
    return { sql, receipts, rootJobId, begin };
}

const started = async (r: Awaited<ReturnType<typeof rig>>) => {
    const made = await r.receipts.begin(r.begin());
    if (made === 'key-reused') throw new Error('unexpected key-reused');
    return made.receipt;
};

describe.skipIf(!enabled)('operation receipts', () => {
    it('begin twice with the same key returns the same receipt, created only once', async () => {
        const r = await rig();
        const input = r.begin();
        const first = await r.receipts.begin(input);
        const second = await r.receipts.begin(input);
        if (first === 'key-reused' || second === 'key-reused') throw new Error('unexpected key-reused');
        expect(first.created).toBe(true);
        expect(second.created).toBe(false);
        expect(second.receipt).toEqual(first.receipt);
        expect(first.receipt).toEqual({ id: expect.any(String), status: 'started', result: null, dispatchedAt: null });
        const [counted] = await r.sql<{ count: string }[]>`
            select count(*) from integration_operation_receipt where org_id = ${ORG} and root_job_id = ${r.rootJobId}
        `;
        expect(Number(counted?.count)).toBe(1);
    });

    it('begin with the same key and another fingerprint or connection is key-reused', async () => {
        const r = await rig();
        const input = r.begin();
        await r.receipts.begin(input);
        expect(await r.receipts.begin({ ...input, fingerprint: OTHER_FINGERPRINT })).toBe('key-reused');
        expect(await r.receipts.begin({ ...input, connectionId: randomUUID() })).toBe('key-reused');
    });

    it('started to dispatched has one winner of two racers', async () => {
        const r = await rig();
        const receipt = await started(r);
        const move = () =>
            r.receipts.transition({
                orgId: ORG,
                jobId: r.rootJobId,
                receiptId: receipt.id,
                from: ['started'],
                to: 'dispatched',
            });
        const results = await Promise.all([move(), move()]);
        expect(results.filter((x) => x !== null)).toHaveLength(1);
        const won = results.find((x) => x !== null);
        expect(won?.status).toBe('dispatched');
        expect(won?.dispatchedAt).toEqual(expect.any(String));
    });

    it('succeeded is terminal, unknown to succeeded is allowed, dispatched to started is refused', async () => {
        const r = await rig();
        const move = (id: string, from: ReceiptStatus[], to: ReceiptStatus, result?: { commentId: string }) =>
            r.receipts.transition({
                orgId: ORG,
                jobId: r.rootJobId,
                receiptId: id,
                from,
                to,
                ...(result ? { result } : {}),
            });

        const a = await started(r);
        expect(await move(a.id, ['started'], 'dispatched')).not.toBeNull();
        expect(await move(a.id, ['dispatched'], 'started')).toBeNull();
        expect((await move(a.id, ['dispatched'], 'unknown'))?.status).toBe('unknown');
        const done = await move(a.id, ['unknown'], 'succeeded', { commentId: '10042' });
        expect(done).toMatchObject({ status: 'succeeded', result: { commentId: '10042' } });
        for (const to of ['dispatched', 'failed', 'unknown', 'started'] as const) {
            expect(await move(a.id, ['succeeded'], to)).toBeNull();
        }

        // Never dispatched may fail; a dispatched one may not skip back; failed is terminal too.
        const b = await started(r);
        expect((await move(b.id, ['started'], 'failed'))?.status).toBe('failed');
        expect(await move(b.id, ['failed'], 'succeeded')).toBeNull();
        const c = await started(r);
        expect(await move(c.id, ['started'], 'succeeded')).toBeNull();
        expect(await move(c.id, ['started'], 'unknown')).toBeNull();
        // The guarded `from` is the caller's belief: a wrong belief moves nothing.
        expect(await move(c.id, ['dispatched'], 'succeeded')).toBeNull();
        expect((await r.receipts.read(ORG, r.rootJobId, c.id))?.status).toBe('started');
    });

    it("a receipt is the root's: another root's job cannot read or move it", async () => {
        const r = await rig();
        const receipt = await started(r);
        const other = await newRoot(r.sql, ORG, ALICE.id);
        expect(await r.receipts.read(ORG, other, receipt.id)).toBeNull();
        expect(
            await r.receipts.transition({
                orgId: ORG,
                jobId: other,
                receiptId: receipt.id,
                from: ['started'],
                to: 'dispatched',
            })
        ).toBeNull();
        expect(await r.receipts.read(ORG, r.rootJobId, receipt.id)).toMatchObject({ status: 'started' });
        // The same key under another root is its own receipt.
        const input = r.begin({ key: 'shared-key' });
        const mine = await r.receipts.begin(input);
        const theirs = await r.receipts.begin({ ...input, rootJobId: other, jobId: other });
        if (mine === 'key-reused' || theirs === 'key-reused') throw new Error('unexpected key-reused');
        expect(theirs.created).toBe(true);
        expect(theirs.receipt.id).not.toBe(mine.receipt.id);
    });

    it('isBound is true only for a live connection the root is bound to', async () => {
        const r = await rig();
        const attached = await attachJira(createConnectionGrants({ sql: r.sql, orgId: ORG }), ALICE.id, {
            externalAccountId: `acct-${randomUUID()}`,
            cloudId: `cloud-${randomUUID()}`,
        });
        expect(await r.receipts.isBound(ORG, r.rootJobId, attached.connectionId)).toBe(false);
        await bindConnections(r.sql, { orgId: ORG, rootJobId: r.rootJobId, userId: ALICE.id }, [attached.connectionId]);
        expect(await r.receipts.isBound(ORG, r.rootJobId, attached.connectionId)).toBe(true);
        expect(await r.receipts.isBound(ORG, r.rootJobId, randomUUID())).toBe(false);
        await r.sql`update connector_connection set status = 'disconnected' where id = ${attached.connectionId}`;
        expect(await r.receipts.isBound(ORG, r.rootJobId, attached.connectionId)).toBe(false);
    });
});
