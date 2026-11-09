import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sql } from 'postgres';
import { beforeAll, describe, expect, it } from 'vitest';
import { createFilesystemStore } from '../src/artifacts/fs-store.js';
import type { ObjectStore } from '../src/artifacts/object-store.js';
import { createJobStore } from '../src/db/jobs/job-store.js';
import { insertWorkflowSuccessor } from '../src/db/jobs/job-store-rows.js';
import { reviewRefOf } from '../src/db/jobs/job-store-reviews.js';
import type { Claim, JobStore, ReviewerSpec } from '../src/db/jobs/job-store-types.js';
import { createSkillStore, type SkillRecord, type SkillStore } from '../src/db/skill-store.js';
import { createSkillCollector, findReferencedVersions } from '../src/skills/skill-collector.js';
import { bundleFromSkillMd } from '../src/skills/skill-bundle.js';
import { createWorkflowStore } from '../src/db/workflows/workflow-store.js';
import type { WorkflowDefinition } from '../src/db/workflows/workflow-schema.js';
import { testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * BEL-273: a job row pins every enabled org skill and the creator’s workspace skills at the versions current when it is made, and every path that makes a row
 * carries or re-resolves that pin (docs/skills.md). Each case takes its own organization, so no case claims another's
 * queued row.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORGS = Array.from({ length: 24 }, () => testOrg());
const ALICE = testUser('pin-alice');
const BOB = testUser('pin-bob');
const ADMIN = testUser('pin-admin');
const LEASE_SECONDS = 300;
const PREFIX = 'test/';

const db = useTestDb({ orgs: ORGS, users: [ALICE, BOB, ADMIN], max: 4 });
let sql: Sql;
let objects: ObjectStore;
let nextOrg = 0;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'skill-pin-')));
});

interface Case {
    org: string;
    jobs: JobStore;
    skills: SkillStore;
}

const freshCase = (jobsOver: Partial<Parameters<typeof createJobStore>[0]> = {}): Case => {
    const org = ORGS[nextOrg++]!;
    return {
        org,
        jobs: createJobStore({ sql, orgId: org, ...jobsOver }),
        skills: createSkillStore({ sql, objects, orgId: org, prefix: PREFIX }),
    };
};

const md = (name: string, body = 'Do the thing.') =>
    bundleFromSkillMd(name, `---\nname: ${name}\ndescription: ${name} helps\n---\n${body}\n`);

const skillOf = async (c: Case, owner: string | null, name: string, body?: string): Promise<SkillRecord> => {
    const made = await c.skills.create(owner, { name, bundle: md(name, body), createdBy: ALICE.id });
    if (made.result !== 'created') throw new Error(`skill create refused: ${made.result}`);
    return made.skill;
};

const pinned = (skill: SkillRecord) => ({
    name: skill.name,
    source: skill.scope,
    versionId: skill.current.id,
    sha256: skill.current.sha256,
});

const createJob = async (c: Case, userId: string, skills: string[], repo: string | null = null) => {
    const ref = await c.jobs.create('work', userId, { repo, executor: null, skills });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    return ref.id;
};

const pinOf = async (id: string): Promise<unknown> => {
    const [row] = await sql<{ skill_pin: unknown }[]>`select skill_pin from job where id = ${id}`;
    return row!.skill_pin;
};

const claimOf = async (c: Case, id: string): Promise<Claim> => {
    const claim = await c.jobs.claim('w1', LEASE_SECONDS);
    expect(claim?.id).toBe(id);
    return claim!;
};

/** Claims `id`, runs it to a finish and returns what the claim carried. */
const finish = async (c: Case, id: string, status: 'succeeded' | 'failed' = 'succeeded'): Promise<Claim> => {
    const claim = await claimOf(c, id);
    await c.jobs.session(id, claim.leaseToken, randomUUID());
    await c.jobs.complete(id, claim.leaseToken, { status, exitCode: status === 'succeeded' ? 0 : 1, output: 'done' });
    return claim;
};

const followUp = async (c: Case, parent: string, userId: string, admin = false) => {
    const ref = await c.jobs.createFollowUp(parent, 'adjust it', userId, undefined, undefined, admin);
    if (typeof ref === 'string') throw new Error(`follow-up refused: ${ref}`);
    return ref.id;
};

const retry = async (c: Case, id: string, userId: string) => {
    const ref = await c.jobs.createRetry(id, userId);
    if (typeof ref === 'string') throw new Error(`retry refused: ${ref}`);
    return ref.id;
};

describe.skipIf(!enabled)('the skill pin on a job row', () => {
    it('pins every enabled org skill and the creator’s enabled workspace skills, selected or not, and no one else’s', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        const orgOther = await skillOf(c, null, 'org-unselected');
        const mine = await skillOf(c, ALICE.id, 'ws-one');
        const mineOther = await skillOf(c, ALICE.id, 'ws-unselected');
        await skillOf(c, BOB.id, 'bob-only');

        const id = await createJob(c, ALICE.id, ['org-one', 'ws-one', 'factory-jira', 'bob-only']);

        expect(await pinOf(id)).toEqual([pinned(org), pinned(orgOther), pinned(mine), pinned(mineOther)]);
    });

    it('pins the enabled skills of a task that selected none', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        const mine = await skillOf(c, ALICE.id, 'ws-one');

        expect(await pinOf(await createJob(c, ALICE.id, []))).toEqual([pinned(org), pinned(mine)]);
    });

    it('does not pin a disabled skill', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-off');
        const mine = await skillOf(c, ALICE.id, 'ws-off');
        const on = await skillOf(c, ALICE.id, 'ws-on');
        await c.skills.setEnabled(null, org.id, false);
        await c.skills.setEnabled(ALICE.id, mine.id, false);

        expect(await pinOf(await createJob(c, ALICE.id, []))).toEqual([pinned(on)]);
    });

    it('does not pin another member’s workspace skill into a member’s job', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        await skillOf(c, ALICE.id, 'alice-skill');
        const bobs = await skillOf(c, BOB.id, 'bob-skill');

        expect(await pinOf(await createJob(c, BOB.id, []))).toEqual([pinned(bobs), pinned(org)]);
    });

    it('pins only org skills for a job with no member principal', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        await skillOf(c, ALICE.id, 'alice-skill');
        const ref = await c.jobs.create('work', null, { repo: null, executor: null, skills: [] });
        if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);

        expect(await pinOf(ref.id)).toEqual([pinned(org)]);
    });

    it('pins the workspace skill over an org skill of the same name', async () => {
        const c = freshCase();
        await skillOf(c, null, 'shared');
        const mine = await skillOf(c, ALICE.id, 'shared', 'my own take');

        expect(await pinOf(await createJob(c, ALICE.id, ['shared']))).toEqual([pinned(mine)]);
        expect(await pinOf(await createJob(c, ALICE.id, []))).toEqual([pinned(mine)]);
    });

    it('leaves the pin alone when a new version lands, and the claim carries the row’s own pin', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        const id = await createJob(c, ALICE.id, ['org-one']);
        await c.skills.addVersion(null, org.id, md('org-one', 'second'));

        expect(await pinOf(id)).toEqual([pinned(org)]);
        const claim = await claimOf(c, id);
        expect(claim.skillPin).toEqual([pinned(org)]);
        expect(claim.skillRefusal).toBeNull();
    });

    it('re-resolves on a follow-up, and a disabled skill is absent from new pins only', async () => {
        const c = freshCase();
        const keep = await skillOf(c, null, 'keeps');
        const off = await skillOf(c, ALICE.id, 'goes-off');
        const root = await createJob(c, ALICE.id, ['keeps', 'goes-off']);
        await finish(c, root);
        const added = await c.skills.addVersion(null, keep.id, md('keeps', 'second'));
        if (added.result !== 'added') throw new Error('no new version');
        await c.skills.setEnabled(ALICE.id, off.id, false);

        const turn = await followUp(c, root, ALICE.id);

        expect(await pinOf(turn)).toEqual([pinned(added.skill)]);
        expect(await pinOf(root)).toEqual([pinned(off), pinned(keep)]);
        const claim = await claimOf(c, turn);
        expect(claim.skillPin).toEqual([pinned(added.skill)]);
    });

    it('resolves an admin’s follow-up against the thread owner’s workspace, not the admin’s', async () => {
        const c = freshCase();
        const mine = await skillOf(c, ALICE.id, 'alice-skill');
        const root = await createJob(c, ALICE.id, ['alice-skill']);
        await finish(c, root);

        const turn = await followUp(c, root, ADMIN.id, true);

        expect(await pinOf(turn)).toEqual([pinned(mine)]);
    });

    it('claims with the pinned version after the skill is disabled or deleted, never a refusal (A3)', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        const mine = await skillOf(c, ALICE.id, 'ws-one');
        const id = await createJob(c, ALICE.id, ['org-one', 'ws-one']);
        await c.skills.setEnabled(null, org.id, false);
        await c.skills.remove(ALICE.id, mine.id);

        const claim = await claimOf(c, id);

        expect(claim.skillRefusal).toBeNull();
        expect(claim.skillPin).toEqual([pinned(org), pinned(mine)]);
    });

    it('keeps the locked pin through a retry even when the skill is deleted before it (B3, A3)', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        const root = await createJob(c, ALICE.id, ['org-one']);
        await finish(c, root, 'failed');
        await c.skills.remove(null, org.id);

        const again = await retry(c, root, ALICE.id);

        expect(await pinOf(again)).toEqual([pinned(org)]);
        const claim = await claimOf(c, again);
        expect(claim.skillRefusal).toBeNull();
        expect(claim.skillPin).toEqual([pinned(org)]);
    });

    it('copies the thread head’s pin on a retry through the root id, not the named row’s (A1)', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        const root = await createJob(c, ALICE.id, ['org-one']);
        await finish(c, root);
        const added = await c.skills.addVersion(null, org.id, md('org-one', 'second'));
        if (added.result !== 'added') throw new Error('no new version');
        const head = await followUp(c, root, ALICE.id);
        await finish(c, head, 'failed');
        expect(await pinOf(root)).toEqual([pinned(org)]);
        expect(await pinOf(head)).toEqual([pinned(added.skill)]);

        const again = await retry(c, root, ALICE.id);

        expect(await pinOf(again)).toEqual([pinned(added.skill)]);
    });

    describe('workflow successors (A2)', () => {
        const walk: WorkflowDefinition = {
            entry: 'implement',
            params: [],
            nodes: [
                { name: 'implement', kind: 'agent', session: 'resume', prompt: 'implement' },
                { name: 'review', kind: 'agent', session: 'fresh', publish: true, prompt: 'review the work' },
            ],
            edges: [{ from: 'implement', to: 'review', when: 'succeeded' }],
        };

        const workflowJob = async (c: Case) => {
            const made = await createWorkflowStore({ sql, orgId: c.org }).create({
                name: 'walk',
                scope: { kind: 'org' },
                definition: walk,
                createdBy: null,
            });
            if (!('id' in made)) throw new Error(`workflow refused: ${JSON.stringify(made)}`);
            const ref = await c.jobs.create('go', ALICE.id, {
                repo: null,
                executor: null,
                skills: ['org-one'],
                workflow: { id: made.id, name: 'walk', node: 'implement', snapshot: walk, params: {} },
            });
            if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
            return ref.id;
        };

        it('gives a transition’s successor the predecessor’s pin, even after a new version', async () => {
            const c = freshCase();
            const org = await skillOf(c, null, 'org-one');
            const root = await workflowJob(c);
            await c.skills.addVersion(null, org.id, md('org-one', 'second'));
            await finish(c, root);

            const [successor] = await sql<{ id: string }[]>`
                select id from job where org_id = ${c.org} and parent_job_id = ${root}
            `;

            expect(successor).toBeDefined();
            expect(await pinOf(successor!.id)).toEqual([pinned(org)]);
        });

        it('gives a block-wait wake’s successor, made by the shared insert, the predecessor’s pin', async () => {
            const c = freshCase();
            const org = await skillOf(c, null, 'org-one');
            const root = await workflowJob(c);

            const made = await sql.begin((tx) =>
                insertWorkflowSuccessor(tx, {
                    orgId: c.org,
                    command: 'wake',
                    createdBy: ALICE.id,
                    repo: null,
                    executor: null,
                    executorScope: 'user',
                    parentJobId: root,
                    sessionId: null,
                    rootJobId: root,
                    workflowId: null,
                    workflowName: 'walk',
                    workflowNode: 'review',
                })
            );

            expect(await pinOf(made)).toEqual([pinned(org)]);
        });
    });

    describe('reviewer jobs (F273-3)', () => {
        const SECURITY: ReviewerSpec = {
            name: 'security',
            instructions: 'Look for injection.',
            timeoutMinutes: 7,
            connections: [],
        };

        it('carry an empty pin, in the row and in their claim, whatever the caller pinned', async () => {
            const c = freshCase({
                plan: {
                    readFor: async () => ({
                        config: null,
                        error: null,
                        services: [],
                        revision: null,
                        reviewers: [SECURITY],
                    }),
                },
                env: { resolveFor: async () => ({}) },
                githubApp: true,
            });
            await skillOf(c, null, 'org-one');
            const id = await createJob(c, ALICE.id, ['org-one'], 'acme/web');
            const caller = await claimOf(c, id);
            expect(caller.skillPin).toHaveLength(1);

            const asked = await c.jobs.requestReview(caller.id, caller.leaseToken, {
                key: 'sec-1',
                profile: 'security',
                revision: 'h:2',
                ref: reviewRefOf(caller.id, 'sec-1'),
            });

            if (!('claim' in asked) || !asked.claim) throw new Error('no live review claim');
            expect(await pinOf(asked.review.id)).toEqual([]);
            expect(asked.claim.skillPin).toEqual([]);
        });
    });
});

describe.skipIf(!enabled)('the retention sweep and job pins (F271-4)', () => {
    const collectorOf = () => createSkillCollector({ sql, objects, prefix: PREFIX, retentionDays: 30 });

    const deletedLongAgo = (skillId: string) =>
        sql`update skill set deleted_at = now() - interval '40 days' where id = ${skillId}`;

    it('reads every version any job row pins, whatever its status, and nothing else', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        const other = await skillOf(c, null, 'org-two');
        await c.skills.setEnabled(null, other.id, false);
        const done = await createJob(c, ALICE.id, ['org-one']);
        await finish(c, done, 'failed');
        await createJob(c, ALICE.id, []);

        const held = await findReferencedVersions(sql, [org.current.id, other.current.id, randomUUID()]);

        expect([...held]).toEqual([org.current.id]);
    });

    it('aborts on a failed reference read instead of answering an empty set', async () => {
        await expect(findReferencedVersions(sql, ['not-a-uuid'])).rejects.toThrow();
    });

    it('keeps a deleted skill’s pinned version, and sweeps it once no job row names it', async () => {
        const c = freshCase();
        const org = await skillOf(c, null, 'org-one');
        const id = await createJob(c, ALICE.id, ['org-one']);
        await c.skills.remove(null, org.id);
        await deletedLongAgo(org.id);

        const kept = await collectorOf().collect();
        expect(kept.versions).toBe(0);
        expect(await objects.get(org.current.objectKey)).not.toBeNull();

        await sql`update job set skill_pin = '[]'::jsonb where id = ${id}`;
        expect((await collectorOf().collect()).versions).toBe(1);
        expect(await objects.get(org.current.objectKey)).toBeNull();
    });
});
