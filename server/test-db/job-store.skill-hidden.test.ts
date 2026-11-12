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
import { createSkillStore, type SkillStore } from '../src/db/skill-store.js';
import { bundleFromSkillMd } from '../src/skills/skill-bundle.js';
import { expireLease, oauthConnection, testOrg, testUser } from './fixtures.js';
import { useTestDb } from './harness.js';

/**
 * a job row decides once, when its skills are pinned, which skills the CLI must not list (`skill_hidden`):
 * a switched-off skill, or one whose required connection the task does not hold. Every path that makes a row carries
 * or re-decides it (docs/skills.md). Each case takes its own organization.
 */
const enabled = Boolean(process.env.DATABASE_URL);
const ORGS = Array.from({ length: 24 }, () => testOrg());
const ALICE = testUser('hid-alice');
const ADMIN = testUser('hid-admin');
const LEASE_SECONDS = 300;
const PREFIX = 'test/';

const db = useTestDb({ orgs: ORGS, users: [ALICE, ADMIN], max: 4 });
let sql: Sql;
let objects: ObjectStore;
let nextOrg = 0;

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    objects = createFilesystemStore(await mkdtemp(join(tmpdir(), 'skill-hidden-')));
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

const md = (name: string, requires?: string) =>
    bundleFromSkillMd(
        name,
        `---\nname: ${name}\ndescription: ${name} helps\n${requires ? `metadata:\n  requires-connections: ${requires}\n` : ''}---\nDo it.\n`
    );

const orgSkill = async (c: Case, name: string, requires?: string) => {
    const made = await c.skills.create(null, { name, bundle: md(name, requires), createdBy: ALICE.id });
    if (made.result !== 'created') throw new Error(`skill create refused: ${made.result}`);
    return made.skill;
};

const createJob = async (c: Case, skills: string[] = [], repo: string | null = null) => {
    const ref = await c.jobs.create('work', ALICE.id, { repo, executor: null, skills });
    if (typeof ref === 'string') throw new Error(`create refused: ${ref}`);
    return ref.id;
};

interface Hidden {
    name: string;
    source: string;
    reason: string;
    connection?: string;
}

const hiddenOf = async (id: string): Promise<Hidden[]> => {
    const [row] = await sql<{ skill_hidden: Hidden[] }[]>`select skill_hidden from job where id = ${id}`;
    return row!.skill_hidden;
};

const namesOf = (hidden: readonly { name: string }[]) => hidden.map((entry) => entry.name);

const pinNamesOf = async (id: string): Promise<string[]> => {
    const [row] = await sql<{ skill_pin: { name: string }[] }[]>`select skill_pin from job where id = ${id}`;
    return namesOf(row!.skill_pin);
};

const claimOf = async (c: Case, id: string): Promise<Claim> => {
    const claim = await c.jobs.claim('w1', LEASE_SECONDS);
    expect(claim?.id).toBe(id);
    return claim!;
};

const finish = async (c: Case, id: string, status: 'succeeded' | 'failed' = 'succeeded'): Promise<Claim> => {
    const claim = await claimOf(c, id);
    await c.jobs.session(id, claim.leaseToken, randomUUID());
    await c.jobs.complete(id, claim.leaseToken, { status, exitCode: status === 'succeeded' ? 0 : 1, output: 'done' });
    return claim;
};

const followUp = async (c: Case, parent: string) => {
    const ref = await c.jobs.createFollowUp(parent, 'adjust it', ALICE.id);
    if (typeof ref === 'string') throw new Error(`follow-up refused: ${ref}`);
    return ref.id;
};

const JIRA_HIDDEN: Hidden = { name: 'factory-jira', source: 'builtin', reason: 'needs_connection', connection: 'jira' };

describe.skipIf(!enabled)('the skill visibility decision on a job row', () => {
    it('hides factory-jira from a task without a Jira binding (needs_connection, jira)', async () => {
        const c = freshCase();
        const id = await createJob(c);

        expect(await hiddenOf(id)).toContainEqual(JIRA_HIDDEN);
        expect((await claimOf(c, id)).skillHidden).toContainEqual(JIRA_HIDDEN);
    });

    it('answers the row’s hidden skills, name and reason only, on get alone', async () => {
        const c = freshCase();
        await c.skills.setBuiltinEnabled('factory-fix', false, ADMIN.id);
        const id = await createJob(c);

        const hidden = (await c.jobs.get(id))!.hiddenSkills!;

        expect(hidden).toContainEqual({ name: 'factory-fix', reason: 'switched_off' });
        expect(hidden).toContainEqual({ name: 'factory-jira', reason: 'needs_connection' });
        expect((await c.jobs.thread(id))![0]!.hiddenSkills).toBeUndefined();
    });

    it('keeps factory-jira for a task bound to Jira', async () => {
        const c = freshCase();
        await oauthConnection(sql, c.org, ALICE.id);
        const id = await createJob(c);

        expect(namesOf(await hiddenOf(id))).not.toContain('factory-jira');
    });

    it('counts a bound connection whose status is not active as held', async () => {
        const c = freshCase();
        const connection = await oauthConnection(sql, c.org, ALICE.id);
        const root = await createJob(c);
        await finish(c, root);
        await sql`update connector_connection set status = 'disconnected' where id = ${connection.id}`;

        const head = await followUp(c, root);

        expect(namesOf(await hiddenOf(head))).not.toContain('factory-jira');
    });

    it('never hides a selected factory-jira (D3)', async () => {
        const c = freshCase();
        const id = await createJob(c, ['factory-jira']);

        expect(namesOf(await hiddenOf(id))).not.toContain('factory-jira');
    });

    it('does not pin an org skill needing Jira and records needs_connection when the task holds none (D1)', async () => {
        const c = freshCase();
        await orgSkill(c, 'org-jira', 'jira');
        await orgSkill(c, 'org-plain');
        const id = await createJob(c);

        expect(await hiddenOf(id)).toContainEqual({
            name: 'org-jira',
            source: 'org',
            reason: 'needs_connection',
            connection: 'jira',
        });
        expect(await pinNamesOf(id)).toEqual(['org-plain']);
    });

    it('pins an org skill needing Jira for a task bound to Jira', async () => {
        const c = freshCase();
        await oauthConnection(sql, c.org, ALICE.id);
        await orgSkill(c, 'org-jira', 'jira');
        const id = await createJob(c);

        expect(namesOf(await hiddenOf(id))).not.toContain('org-jira');
        expect(await pinNamesOf(id)).toEqual(['org-jira']);
    });

    it('hides a switched-off built-in (switched_off)', async () => {
        const c = freshCase();
        await c.skills.setBuiltinEnabled('factory-fix', false, ADMIN.id);
        const id = await createJob(c);

        expect(await hiddenOf(id)).toContainEqual({ name: 'factory-fix', source: 'builtin', reason: 'switched_off' });
    });

    it('records a disabled org skill as switched_off and does not pin it', async () => {
        const c = freshCase();
        const off = await orgSkill(c, 'org-off');
        await c.skills.setEnabled(null, off.id, false);
        const id = await createJob(c);

        expect(await hiddenOf(id)).toContainEqual({ name: 'org-off', source: 'org', reason: 'switched_off' });
        expect(await pinNamesOf(id)).not.toContain('org-off');
    });

    it('copies skill_hidden from the head on a retry, whatever changed since', async () => {
        const c = freshCase();
        await c.skills.setBuiltinEnabled('factory-fix', false, ADMIN.id);
        const root = await createJob(c);
        await finish(c, root, 'failed');
        await c.skills.setBuiltinEnabled('factory-fix', true, ADMIN.id);

        const ref = await c.jobs.createRetry(root, ALICE.id);
        if (typeof ref === 'string') throw new Error(`retry refused: ${ref}`);

        expect(await hiddenOf(ref.id)).toEqual(await hiddenOf(root));
        expect(namesOf(await hiddenOf(ref.id))).toContain('factory-fix');
    });

    it('carries the row’s skill_hidden on a takeover claim after the switch flips', async () => {
        const c = freshCase();
        const id = await createJob(c);
        const first = await claimOf(c, id);
        await c.skills.setBuiltinEnabled('factory-fix', false, ADMIN.id);
        await expireLease(sql, id);

        const taken = await claimOf(c, id);

        expect(taken.claimSeq).toBeGreaterThan(first.claimSeq);
        expect(taken.skillHidden).toEqual(first.skillHidden);
        expect(namesOf(taken.skillHidden)).not.toContain('factory-fix');
    });

    it('decides again on a follow-up (switch back on → visible)', async () => {
        const c = freshCase();
        await c.skills.setBuiltinEnabled('factory-fix', false, ADMIN.id);
        const root = await createJob(c);
        expect(namesOf(await hiddenOf(root))).toContain('factory-fix');
        await finish(c, root);
        await c.skills.setBuiltinEnabled('factory-fix', true, ADMIN.id);

        const head = await followUp(c, root);

        expect(namesOf(await hiddenOf(head))).not.toContain('factory-fix');
        expect(namesOf((await claimOf(c, head)).skillHidden)).not.toContain('factory-fix');
    });

    it('gives a workflow successor and a durable wake’s row the predecessor’s skill_hidden', async () => {
        const c = freshCase();
        await c.skills.setBuiltinEnabled('factory-fix', false, ADMIN.id);
        const root = await createJob(c);

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

        expect(await hiddenOf(made)).toEqual(await hiddenOf(root));
        expect(namesOf(await hiddenOf(made))).toContain('factory-fix');
    });

    it('fails the create whole when the switched-off read throws: no row, nothing narrowed', async () => {
        const c = freshCase();
        const failing = failingOn(sql, 'builtin_skill_off');
        const jobs = createJobStore({ sql: failing, orgId: c.org });

        await expect(jobs.create('work', ALICE.id, { repo: null, executor: null, skills: [] })).rejects.toThrow(
            'injected read failure'
        );

        const [count] = await sql<{ n: number }[]>`select count(*)::int as n from job where org_id = ${c.org}`;
        expect(count!.n).toBe(0);
    });

    describe('reviewer rows', () => {
        const SECURITY: ReviewerSpec = {
            name: 'security',
            instructions: 'Look for injection.',
            timeoutMinutes: 7,
            connections: [],
        };

        it('decide with no bindings (factory-jira hidden even when the task holds Jira) and their claim carries it', async () => {
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
            await oauthConnection(sql, c.org, ALICE.id);
            await c.skills.setBuiltinEnabled('factory-fix', false, ADMIN.id);
            const id = await createJob(c, [], 'acme/web');
            const caller = await claimOf(c, id);
            expect(namesOf(caller.skillHidden)).not.toContain('factory-jira');

            const asked = await c.jobs.requestReview(caller.id, caller.leaseToken, {
                key: 'sec-1',
                profile: 'security',
                revision: 'h:2',
                ref: reviewRefOf(caller.id, 'sec-1'),
            });

            if (!('claim' in asked) || !asked.claim) throw new Error('no live review claim');
            expect(await hiddenOf(asked.review.id)).toContainEqual(JIRA_HIDDEN);
            expect(namesOf(await hiddenOf(asked.review.id))).toContain('factory-fix');
            expect(asked.claim.skillHidden).toEqual(await hiddenOf(asked.review.id));
        });
    });
});

/** A `sql` whose tagged queries naming `fragment` throw, so a test can fail exactly one read of a transaction. */
function failingOn(real: Sql, fragment: string): Sql {
    const wrap = <T extends object>(target: T): T =>
        new Proxy(target, {
            apply(fn, self, args: unknown[]) {
                const first = args[0];
                if (Array.isArray(first) && first.join('?').includes(fragment)) {
                    throw new Error('injected read failure');
                }
                return Reflect.apply(fn as never, self, args);
            },
            get(fn, prop) {
                const value = Reflect.get(fn, prop);
                if (prop === 'begin') {
                    return (...args: unknown[]) => {
                        const body = args.at(-1) as (tx: never) => unknown;
                        return (fn as unknown as Sql).begin(...(args.slice(0, -1) as []), ((tx: never) =>
                            body(wrap(tx as object) as never)) as never);
                    };
                }
                return typeof value === 'function' ? value.bind(fn) : value;
            },
        });
    return wrap(real);
}
