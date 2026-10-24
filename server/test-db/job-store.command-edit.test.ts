import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/jobs/job-store.js';
import type { JobStore } from '../src/db/jobs/job-store-types.js';
import { createWorkflowStore } from '../src/db/workflows/workflow-store.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { useTestDb } from './harness.js';
import { account, mustCreate, randomGithubId, testOrg } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
/** A second store on the same pool, bound to a different org. Only the org guard uses it. */
let otherOrgStore: JobStore;
let workflows: ReturnType<typeof createWorkflowStore>;

const ORG = testOrg();
const OTHER_ORG = testOrg();
/** A well-formed uuid, only ever used where the job is expected not to exist. */
const ABSENT = randomUUID();
const SESSION = randomUUID();
const LEASE_SECONDS = 300;

const db = useTestDb({ orgs: [ORG] });

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
    workflows = createWorkflowStore({ sql, orgId: ORG });
});

const queue = async (command: string, createdBy: string | null = null): Promise<string> => {
    const ref = await mustCreate(store.create(command, createdBy, { repo: null, executor: null }));
    return ref.id;
};

/** A two-node graph: implement then review, one edge on `succeeded` — the smallest walk. */
const TWO_NODE: WorkflowDefinition = {
    entry: 'implement',
    params: [],
    nodes: [
        { name: 'implement', kind: 'agent', session: 'resume', prompt: 'implement' },
        { name: 'review', kind: 'agent', session: 'fresh', prompt: 'review the work', publish: true },
    ],
    edges: [{ from: 'implement', to: 'review', when: 'succeeded' }],
};

/** Seeds the named definition and queues a task on it — the root row carries `workflow_node`. */
async function queueWorkflowJob(definition: WorkflowDefinition, name = 'walk'): Promise<string> {
    const created = await workflows.create({ name, scope: { kind: 'org' }, definition, createdBy: null });
    expect(created).toHaveProperty('id');
    const job = await mustCreate(
        store.create('fix the thing', null, {
            repo: null,
            executor: null,
            workflow: {
                id: (created as { id: string }).id,
                name,
                node: definition.entry,
                snapshot: definition,
                params: {},
            },
        })
    );
    return job.id;
}

describe.skipIf(!enabled)('editCommand — a queued task\u2019s command (issue #329)', () => {
    it('edits a queued row, and edits it again', async () => {
        const id = await queue('echo hi');

        expect(await store.editCommand(id, 'echo changed', null)).toEqual({ result: 'ok', command: 'echo changed' });
        expect(await store.get(id)).toMatchObject({ command: 'echo changed', status: 'queued' });

        expect(await store.editCommand(id, 'echo again', null)).toEqual({ result: 'ok', command: 'echo again' });
        expect(await store.get(id)).toMatchObject({ command: 'echo again', status: 'queued' });
    });

    // The whole point of the feature: the command is read at claim time, so the edit reaches
    // the runner without a stop-and-recreate.
    it('delivers the edited command to the next claim', async () => {
        const id = await queue('echo hi');
        await store.editCommand(id, 'echo changed', null);

        const claim = await store.claim('w1', LEASE_SECONDS);

        expect(claim).toMatchObject({ id, command: 'echo changed' });
    });

    it('refuses a running row with not_queued, leaving the command alone', async () => {
        const id = await queue('echo hi');
        await store.claim('w1', LEASE_SECONDS);

        expect(await store.editCommand(id, 'echo changed', null)).toEqual({ result: 'not_queued', status: 'running' });
        expect((await store.get(id))?.command).toBe('echo hi');
    });

    it('refuses a terminal row with not_queued, naming the settled status', async () => {
        const id = await queue('echo hi');
        await store.stop(id, null);

        expect(await store.editCommand(id, 'echo changed', null)).toEqual({ result: 'not_queued', status: 'stopped' });
        expect((await store.get(id))?.command).toBe('echo hi');
    });

    // Author-scoped like the follow-up, and null-safe both ways: a null caller may only edit an
    // authorless row (the state every pre-accounts task is in), and an authored row refuses a
    // caller with no account.
    it('scopes the edit to the author, null-safe in both directions', async () => {
        const author = await account(sql, randomGithubId(), 'command-author');
        const other = await account(sql, randomGithubId(), 'command-other');

        const authored = await queue('echo hi', author);
        expect(await store.editCommand(authored, 'echo mine', other)).toBe('forbidden');
        expect(await store.editCommand(authored, 'echo mine', null)).toBe('forbidden');
        expect(await store.editCommand(authored, 'echo mine', author)).toEqual({
            result: 'ok',
            command: 'echo mine',
        });

        const authorless = await queue('echo hi');
        expect(await store.editCommand(authorless, 'echo mine', null)).toEqual({
            result: 'ok',
            command: 'echo mine',
        });
    });

    // A workflow row's command IS the interpolated entry prompt — the raw chat line was never
    // stored, so there is nothing to edit from. Refused, exactly as the issue allows.
    it('refuses a queued workflow root with workflow', async () => {
        const root = await queueWorkflowJob(TWO_NODE);

        expect(await store.editCommand(root, 'echo changed', null)).toBe('workflow');
        expect((await store.get(root))?.command).toBe('fix the thing');
    });

    // The engine's queued continuation rows are prompt-built the same way — the discriminator
    // is `workflow_node`, not which member of the thread the row is.
    it('refuses a queued workflow continuation with workflow', async () => {
        const root = await queueWorkflowJob(TWO_NODE);
        const rootClaim = await store.claim('w1', LEASE_SECONDS);
        await store.complete(rootClaim!.id, rootClaim!.leaseToken, {
            status: 'succeeded',
            exitCode: 0,
            output: 'done',
        });

        const review = (await store.thread(root))!.find((job) => job.workflowNode === 'review');
        expect(review).toBeDefined();
        expect(review!.status).toBe('queued');

        expect(await store.editCommand(review!.id, 'echo changed', null)).toBe('workflow');
        expect((await store.get(review!.id))?.command).toBe('review the work');
    });

    // parent_job_id is not the discriminator — a queued user follow-up is off-graph, its command
    // is the member's own words, and it edits like any queued root.
    it('edits a queued follow-up, which is off-graph', async () => {
        const parent = await queue('echo hi');
        const claim = await store.claim('w1', LEASE_SECONDS);
        await store.session(parent, claim!.leaseToken, SESSION);
        await store.complete(parent, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: 'done' });
        const followUp = await store.createFollowUp(parent, 'again, tighter', null);
        if (typeof followUp === 'string') throw new Error(`createFollowUp refused: ${followUp}`);

        expect(await store.editCommand(followUp.id, 'again, much tighter', null)).toEqual({
            result: 'ok',
            command: 'again, much tighter',
        });
        expect(await store.get(followUp.id)).toMatchObject({ command: 'again, much tighter', status: 'queued' });
    });

    it('separates a missing id from a refused edit, org included', async () => {
        const id = await queue('echo hi');

        expect(await store.editCommand(ABSENT, 'echo changed', null)).toBe('missing');
        expect(await otherOrgStore.editCommand(id, 'echo changed', null)).toBe('missing');
    });
});
