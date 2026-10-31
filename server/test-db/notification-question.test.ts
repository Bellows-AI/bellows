import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { notificationEventOf } from '@factory-ai/core';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { QUESTIONS_PER_ATTEMPT } from '../src/db/jobs/job-store-questions.js';
import type { AskedQuestion, Claim, JobStore } from '../src/db/jobs/job-store-types.js';
import { createNotificationOutboxStore } from '../src/notifications/outbox-store.js';
import { createNotificationSubscriptionStore } from '../src/notifications/subscription-store.js';
import type { NotificationSubscriptionStore, SubscriptionFields } from '../src/notifications/subscription-store.js';
import type { SecretStore } from '../src/secrets/secret-store.js';
import { testSecretStore } from './env-secrets-harness.js';
import { useTestDb } from './harness.js';
import { testOrg, testUser } from './fixtures.js';

/**
 * BEL-135: task.question fires once per question a running agent asks and a person can still answer.
 * Answering, closing or expiring the question never emits again (docs/notifications.md).
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORG = testOrg();
const ANSWERER = testUser('answerer');
const PUBLIC_URL = 'https://board.example.test';
const db = useTestDb({ orgs: [ORG], users: [ANSWERER], max: 4 });

let sql: Sql;
let store: JobStore;
let subs: NotificationSubscriptionStore;
let secrets: SecretStore;

beforeAll(() => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    secrets = testSecretStore(sql);
    subs = createNotificationSubscriptionStore({ sql, orgId: ORG, secrets, secretLog: () => {} });
});

const asked = (...texts: string[]): AskedQuestion[] =>
    texts.map((question) => ({ question, header: 'Pick', multiSelect: false, options: [{ label: 'A' }] }));

async function running(): Promise<{ id: string; claim: Claim }> {
    const ref = await store.create('ask me things', null, { repo: null, executor: null });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    const claim = (await store.claim('w1', 300)) as Claim;
    expect(claim.id).toBe(ref.id);
    return { id: ref.id, claim };
}

const ask = (id: string, token: string, questionId: string, ...texts: string[]) =>
    store.askQuestion(id, token, { questionId, questions: asked(...(texts.length > 0 ? texts : ['Which db?'])) });

interface EventRow {
    id: string;
    kind: string;
    job_id: string;
    root_job_id: string;
    command: string;
    reason: string | null;
    pr_url: string | null;
    question_id: string | null;
    questions: string[] | null;
    occurred_at: Date;
}

const questionEvents = (jobId: string) =>
    sql<EventRow[]>`
        select id, kind, job_id, root_job_id, command, reason, pr_url, question_id, questions, occurred_at
        from notification_event
        where org_id = ${ORG} and job_id = ${jobId} and kind = 'task.question'
        order by question_id
    `;

const expectedId = async (jobId: string, questionId: string): Promise<string> =>
    (
        await sql<
            { id: string }[]
        >`select md5(${jobId}::text || '/' || ${questionId}::text || '/task.question')::uuid as id`
    )[0]!.id;

const fields = (eventKinds: SubscriptionFields['eventKinds']): SubscriptionFields => ({
    connectorKind: 'fake',
    connectorConfig: { target: `room-${Math.random()}` },
    eventKinds,
    repos: [],
    workflows: [],
    enabled: true,
});

describe.skipIf(!enabled)('task.question — database', () => {
    it('a pending question emits one task.question with its texts', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1', 'Which db?', 'Which cache?');

        const rows = await questionEvents(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: await expectedId(id, 'toolu_1'),
            job_id: id,
            root_job_id: id,
            command: 'ask me things',
            question_id: 'toolu_1',
            questions: ['Which db?', 'Which cache?'],
            reason: null,
            pr_url: null,
        });
    });

    it('answering the question does not re-emit', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        const [before] = await questionEvents(id);
        await store.answerQuestion(id, 'toolu_1', { 'Which db?': 'ok' }, ANSWERER.id);

        const rows = await questionEvents(id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ id: before!.id, occurred_at: before!.occurred_at });
    });

    it('an expired question does not re-emit', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        await sql`update job_question set state = 'expired' where org_id = ${ORG} and job_id = ${id}`;
        expect(await questionEvents(id)).toHaveLength(1);
    });

    it('a replayed ask emits nothing more', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        expect((await ask(id, claim.leaseToken, 'toolu_1')).result).toBe('existing');
        expect(await questionEvents(id)).toHaveLength(1);
    });

    it('each question of a job emits its own event', async () => {
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_a');
        await ask(id, claim.leaseToken, 'toolu_b');

        const rows = await questionEvents(id);
        expect(rows.map((r) => r.id)).toEqual([await expectedId(id, 'toolu_a'), await expectedId(id, 'toolu_b')]);
        expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    });

    it('a refused ask emits nothing', async () => {
        const { id, claim } = await running();
        expect((await ask(id, randomUUID(), 'toolu_x')).result).toBe('lost');
        expect(await questionEvents(id)).toHaveLength(0);

        for (let n = 1; n <= QUESTIONS_PER_ATTEMPT; n++) await ask(id, claim.leaseToken, `toolu_${n}`);
        expect((await ask(id, claim.leaseToken, 'toolu_over')).result).toBe('limit');
        expect(await questionEvents(id)).toHaveLength(QUESTIONS_PER_ATTEMPT);
    });

    it('a question asked under a stop request emits nothing', async () => {
        const { id, claim } = await running();
        await sql`update job set cancel_requested_at = now() where org_id = ${ORG} and id = ${id}`;
        expect((await ask(id, claim.leaseToken, 'toolu_1')).result).toBe('created');
        expect(await questionEvents(id)).toHaveLength(0);
    });

    it('a question row that is not answerable at commit emits nothing', async () => {
        const { id, claim } = await running();
        const insert = (questionId: string, lease: string, state: string) => sql`
            insert into job_question (org_id, job_id, question_id, attempt, claim_seq, lease_token, questions, state)
            values (${ORG}, ${id}, ${questionId}, 1, 1, ${lease}, ${sql.json([{ question: 'q?' }])}, ${state})
        `;
        await insert('stale_lease', randomUUID(), 'pending');
        await insert('not_pending', claim.leaseToken, 'expired');
        await sql`update job set status = 'failed', finished_at = now() where org_id = ${ORG} and id = ${id}`;
        await insert('not_running', claim.leaseToken, 'pending');
        expect(await questionEvents(id)).toHaveLength(0);
    });

    it('a question fans out to task.question subscriptions only', async () => {
        const wanted = await subs.create(fields(['task.question']), `https://hook.example.test/${randomUUID()}`);
        const other = await subs.create(fields(['task.blocked']), `https://hook.example.test/${randomUUID()}`);
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1');
        await store.answerQuestion(id, 'toolu_1', { 'Which db?': 'ok' }, ANSWERER.id);

        const [event] = await questionEvents(id);
        const out = await sql<{ subscription_id: string }[]>`
            select subscription_id from notification_outbox where org_id = ${ORG} and event_id = ${event!.id}
        `;
        expect(out.map((r) => r.subscription_id)).toEqual([wanted.id]);
        expect(out.map((r) => r.subscription_id)).not.toContain(other.id);
    });

    it('the outbox lease carries the question id and texts', async () => {
        const sub = await subs.create(fields(['task.question']), `https://hook.example.test/${randomUUID()}`);
        const { id, claim } = await running();
        await ask(id, claim.leaseToken, 'toolu_1', 'Which db?', 'Which cache?');

        const outbox = createNotificationOutboxStore({ sql, orgId: ORG, secrets });
        const lease = await outbox.lease(1000, 60_000);
        try {
            const item = lease!.items.find((i) => i.subscriptionId === sub.id && i.event.jobId === id);
            expect(item!.event).toMatchObject({
                kind: 'task.question',
                questionId: 'toolu_1',
                questions: ['Which db?', 'Which cache?'],
            });
            expect(notificationEventOf(item!.event, PUBLIC_URL).link).toBe(`${PUBLIC_URL}/tasks/${id}`);
        } finally {
            await outbox.release(lease!.token);
        }
    });
});
