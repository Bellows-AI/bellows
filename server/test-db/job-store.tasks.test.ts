import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import { createJobStore } from '../src/db/job-store.js';
import type { JobStore } from '../src/db/job-store-types.js';
import { useTestDb } from './harness.js';
import { craftJob, type CraftShape, mustCreate, testUser } from './fixtures.js';

const enabled = Boolean(process.env.DATABASE_URL);

let sql: Sql;
let store: JobStore;
/** A second store on the same pool, bound to a different org — the isolation guard's other side. */
let otherOrgStore: JobStore;

const ORG = randomUUID();
const OTHER_ORG = randomUUID();

/**
 * Two authors: the author filter and the root-author join need more than one account to mean
 * anything. Re-planted before every test — `created_by` is a uuid FK.
 */
const AUTHOR_USER = testUser('tasks-cat');
const OTHER_AUTHOR_USER = testUser('tasks-other');
const AUTHOR = AUTHOR_USER.id;
const OTHER_AUTHOR = OTHER_AUTHOR_USER.id;

const db = useTestDb({
    max: 8,
    // workflow_wait FKs to organization — the wait tests below need it planted.
    orgs: [ORG],
    users: [AUTHOR_USER, OTHER_AUTHOR_USER],
});

beforeAll(async () => {
    if (!enabled) return;
    sql = db.sql;
    store = createJobStore({ sql, orgId: ORG });
    otherOrgStore = createJobStore({ sql, orgId: OTHER_ORG });
});

const MS_PER_MINUTE = 60_000;

/** How long ago an ISO stamp reads, in minutes — for asserting backdated times without sleeping. */
const minutesAgo = (iso: string): number => (Date.now() - Date.parse(iso)) / MS_PER_MINUTE;

/** Writes a job row in whatever state the case needs, authored by AUTHOR unless the shape says otherwise. */
const craft = (shape: CraftShape = {}) => craftJob({ sql, org: ORG, author: AUTHOR }, shape);

/** Writes a `workflow_wait` row for a root, straight SQL — the 036 wait store's own shape. */
const enterWait = async (
    root: string,
    shape: {
        reason?: string;
        activeMinutesAgo?: number;
        terminalReason?: string | null;
        completed?: boolean;
        cancelled?: boolean;
    } = {}
): Promise<void> => {
    await sql`
        insert into workflow_wait (org_id, root_job_id, reason, repo, pr_number, active_at, completed_at, cancelled_at, terminal_reason)
        values (
            ${ORG}, ${root}, ${shape.reason ?? 'review'}, 'acme/widgets', 1,
            now() - (${shape.activeMinutesAgo ?? 5} * interval '1 minute'),
            ${shape.completed ? sql`now()` : null},
            ${shape.cancelled ? sql`now()` : null},
            ${shape.terminalReason ?? null}
        )
    `;
};

describe.skipIf(!enabled)('listTasks', () => {
    it('folds a thread with follow-ups into one summary: root identity, head present tense', async () => {
        const root = await craft({
            command: 'the opening ask',
            createdMinutesAgo: 60,
            status: 'succeeded',
            finishedMinutesAgo: 55,
            summary: 'root words',
            author: OTHER_AUTHOR,
        });
        await craft({ parent: root, status: 'failed', createdMinutesAgo: 40, finishedMinutesAgo: 35 });
        const RUNNING_HEAD_STARTED_MINUTES_AGO = 19;
        await craft({
            parent: root,
            status: 'running',
            createdMinutesAgo: 20,
            startedMinutesAgo: RUNNING_HEAD_STARTED_MINUTES_AGO,
            runtime: {
                cpuPercent: 1,
                memUsedMb: 2,
                memPercent: 3,
                activity: 'the live line',
                sampledAt: '2026-09-10T11:59:00Z',
            },
        });

        const { page } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(page.items).toHaveLength(1);
        const task = page.items[0]!;
        // Identity is the ROOT's: the id every link targets, the opening ask, the thread's author.
        expect(task.id).toBe(root);
        expect(task.command).toBe('the opening ask');
        expect(task.author?.login).toBe('tasks-other');
        expect(Math.abs(minutesAgo(task.createdAt) - 60)).toBeLessThan(2);
        // Present tense is the HEAD's: status, live activity, close-time summary, activity stamp.
        expect(task.status).toBe('running');
        expect(task.activity).toBe('the live line');
        expect(task.summary).toBeNull();
        expect(task.doneAt).toBeNull();
        expect(Math.abs(minutesAgo(task.activityAt) - RUNNING_HEAD_STARTED_MINUTES_AGO)).toBeLessThan(2);
    });

    it('buckets queued and running heads as running', async () => {
        const RUNNING_STATUSES = ['queued', 'running'] as const;
        for (const status of RUNNING_STATUSES) {
            await craft({ status, command: `task ${status}`, createdMinutesAgo: 30 });
        }
        const { navigation, page } = await store.listTasks({ state: 'running', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({ running: RUNNING_STATUSES.length, review: 0, past: 0 });
        expect(page.items).toHaveLength(RUNNING_STATUSES.length);
    });

    it('buckets a non-terminal head with an open wait as review, not running', async () => {
        const root = await craft({ status: 'queued', command: 'waiting task', createdMinutesAgo: 30 });
        await enterWait(root, { activeMinutesAgo: 10 });

        const { navigation } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({ running: 0, review: 1, past: 0 });
        const review = await store.listTasks({ state: 'review', sort: 'newest', limit: 30 });
        expect(review.page.items).toHaveLength(1);
        expect(review.page.items[0]).toMatchObject({
            id: root,
            waitReason: 'review',
            waitTerminalReason: null,
        });
        expect(review.page.items[0]!.waitingSince).not.toBeNull();
    });

    it('buckets an open wait as past once the task is done, never running', async () => {
        const root = await craft({ status: 'queued', createdMinutesAgo: 30, doneMinutesAgo: 5 });
        await enterWait(root, { activeMinutesAgo: 10 });

        const { navigation } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({ running: 0, review: 0, past: 1 });
    });

    it('falls back to the ordinary bucket once the wait has gone terminal', async () => {
        const root = await craft({ status: 'queued', command: 'exhausted wait task', createdMinutesAgo: 30 });
        await enterWait(root, { activeMinutesAgo: 20, completed: true, terminalReason: 'exhausted' });

        const { navigation } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        // queued is not itself terminal, and the wait no longer overrides it — back to running.
        expect(navigation.counts).toEqual({ running: 1, review: 0, past: 0 });
        const running = await store.listTasks({ state: 'running', sort: 'newest', limit: 30 });
        expect(running.page.items[0]).toMatchObject({
            id: root,
            waitReason: 'review',
            waitTerminalReason: 'exhausted',
        });
    });

    it('buckets terminal heads by the head done stamp — review without it, past with it', async () => {
        const TERMINAL_STATUSES = ['succeeded', 'failed', 'dead', 'stopped'] as const;
        for (const status of TERMINAL_STATUSES) {
            await craft({ status, createdMinutesAgo: 40, finishedMinutesAgo: 35 });
            await craft({ status, createdMinutesAgo: 30, finishedMinutesAgo: 25, doneMinutesAgo: 20 });
        }
        const { navigation } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({
            running: 0,
            review: TERMINAL_STATUSES.length,
            past: TERMINAL_STATUSES.length,
        });
        const review = await store.listTasks({ state: 'review', sort: 'newest', limit: 30 });
        expect(review.page.items).toHaveLength(TERMINAL_STATUSES.length);
        for (const task of review.page.items) expect(task.doneAt).toBeNull();
        const past = await store.listTasks({ state: 'past', sort: 'newest', limit: 30 });
        expect(past.page.items).toHaveLength(TERMINAL_STATUSES.length);
        for (const task of past.page.items) expect(task.doneAt).not.toBeNull();
    });

    it('resurrects a done task with a queued follow-up — running again, done gone', async () => {
        const root = await craft({
            status: 'succeeded',
            createdMinutesAgo: 60,
            finishedMinutesAgo: 50,
            doneMinutesAgo: 40,
        });
        await craft({ parent: root, status: 'queued', createdMinutesAgo: 10 });

        const { navigation, page } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ id: root, status: 'queued', doneAt: null });
        expect(navigation.counts).toEqual({ running: 1, review: 0, past: 0 });
    });
});

describe.skipIf(!enabled)('listTasks: filters', () => {
    it('filters by repository, author and search at task level, not run level', async () => {
        // A task whose follow-up mentions the term but whose ROOT does not: the search reads the
        // root command only, so the task must not match. It sits in review — reachable by every
        // other filter — so only the search can exclude it.
        const wrongRoot = await craft({
            command: 'unrelated ask',
            status: 'succeeded',
            createdMinutesAgo: 50,
            finishedMinutesAgo: 45,
            repo: 'acme/other',
        });
        await craft({
            parent: wrongRoot,
            command: 'now fix the LOGIN page',
            status: 'succeeded',
            createdMinutesAgo: 10,
            finishedMinutesAgo: 5,
        });
        // A task whose root matches, carried by a follow-up that does not have to.
        const match = await craft({
            command: 'Fix the LOGIN flow',
            status: 'running',
            createdMinutesAgo: 40,
            startedMinutesAgo: 39,
            repo: 'acme/widgets',
        });
        await craft({ parent: match, command: 'carry on', status: 'running', createdMinutesAgo: 10 });
        // Another author's task, on another repository, matching the same term.
        const other = await craft({
            command: 'fix the login flow for tests',
            status: 'running',
            createdMinutesAgo: 30,
            startedMinutesAgo: 29,
            repo: 'acme/other',
            author: OTHER_AUTHOR,
        });

        // `match`'s head is its follow-up (`carry on`, the newest run), so its activity stamp is
        // the newest of the two — newest activity first.
        const bySearch = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30, q: 'login' });
        expect(bySearch.page.items.map((task) => task.id)).toEqual([match, other]);

        const byRepo = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30, repo: 'acme/widgets' });
        expect(byRepo.page.items.map((task) => task.id)).toEqual([match]);

        // The author filter is a login, compared case-insensitively.
        const byAuthor = await store.listTasks({
            state: 'attention',
            sort: 'newest',
            limit: 30,
            author: 'TASKS-OTHER',
        });
        expect(byAuthor.page.items.map((task) => task.id)).toEqual([other]);

        const combined = await store.listTasks({
            state: 'running',
            sort: 'newest',
            limit: 30,
            q: 'LOGIN',
            repo: 'acme/widgets',
            author: 'tasks-cat',
        });
        expect(combined.page.items.map((task) => task.id)).toEqual([match]);
    });
});

describe.skipIf(!enabled)('listTasks: ordering and pagination', () => {
    it('orders by head activity, the id descending on an exactly equal stamp', async () => {
        // Two roots whose heads carry the SAME absolute stamps: the id descending breaks the tie.
        // One literal shared by both crafts — two Date.now() calls could straddle a millisecond.
        const TIE_MINUTES_AGO = 30;
        const tieStamp = new Date(Date.now() - TIE_MINUTES_AGO * MS_PER_MINUTE).toISOString();
        const tieA = await craft({
            status: 'running',
            at: { created: tieStamp, started: tieStamp },
        });
        const tieB = await craft({
            status: 'running',
            at: { created: tieStamp, started: tieStamp },
        });
        const older = await craft({ status: 'running', createdMinutesAgo: 60, startedMinutesAgo: 59 });

        const { page } = await store.listTasks({ state: 'running', sort: 'newest', limit: 30 });
        const ids = page.items.map((task) => task.id);
        expect(ids.slice(0, 2)).toEqual([tieA, tieB].sort().reverse());
        expect(ids[2]).toBe(older);
    });

    it('splits an exactly-tied pair across a page boundary', async () => {
        // Three roots on one stamp, limit 2: the exclusive (activity_at, id) comparison must hand
        // the tied third over whole — neither duplicated nor skipped.
        const TIE_MINUTES_AGO = 45;
        const stamp = new Date(Date.now() - TIE_MINUTES_AGO * MS_PER_MINUTE).toISOString();
        const craftTie = (): Promise<string> => craft({ status: 'running', at: { created: stamp, started: stamp } });
        const tieA = await craftTie();
        const tieB = await craftTie();
        const tieC = await craftTie();
        const expected = [tieA, tieB, tieC].sort().reverse();

        const first = await store.listTasks({ state: 'running', sort: 'newest', limit: 2 });
        expect(first.page.items.map((task) => task.id)).toEqual(expected.slice(0, 2));
        const second = await store.listTasks({
            state: 'running',
            sort: 'newest',
            limit: 2,
            cursor: first.page.nextCursor!,
        });
        expect(second.page.items.map((task) => task.id)).toEqual(expected.slice(2));
        expect(second.page.nextCursor).toBeNull();
    });

    it('paginates forward on (activity_at, root id) without duplicates or omissions', async () => {
        const RUN_COUNT = 7;
        const BASE_CREATED_MINUTES_AGO = 100;
        const BASE_STARTED_MINUTES_AGO = 99;
        for (let i = 0; i < RUN_COUNT; i++) {
            await craft({
                status: 'running',
                createdMinutesAgo: BASE_CREATED_MINUTES_AGO - i,
                startedMinutesAgo: BASE_STARTED_MINUTES_AGO - i,
            });
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard++) {
            const { page } = await store.listTasks({
                state: 'running',
                sort: 'newest',
                limit: 3,
                ...(cursor ? { cursor } : {}),
            });
            seen.push(...page.items.map((task) => task.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
        }
        expect(seen).toHaveLength(RUN_COUNT);
        expect(new Set(seen).size).toBe(RUN_COUNT);
    });

    it('paginates oldest first under its own cursor direction', async () => {
        const RUN_COUNT = 5;
        const BASE_CREATED_MINUTES_AGO = 100;
        const BASE_STARTED_MINUTES_AGO = 99;
        for (let i = 0; i < RUN_COUNT; i++) {
            await craft({
                status: 'running',
                createdMinutesAgo: BASE_CREATED_MINUTES_AGO - i,
                startedMinutesAgo: BASE_STARTED_MINUTES_AGO - i,
            });
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard++) {
            const { page } = await store.listTasks({
                state: 'running',
                sort: 'oldest',
                limit: 2,
                ...(cursor ? { cursor } : {}),
            });
            seen.push(...page.items.map((task) => task.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
        }
        expect(seen).toHaveLength(RUN_COUNT);
        expect(new Set(seen).size).toBe(RUN_COUNT);
        // The first page really is the oldest end.
        const first = await store.listTasks({ state: 'running', sort: 'oldest', limit: 1 });
        expect(seen[0]).toBe(first.page.items[0]!.id);
    });
});

describe.skipIf(!enabled)('listTasks: reachability at scale', () => {
    it('reaches every root past fifty interleaved runs — the old web window is not the world', async () => {
        // 26 threads x 2 runs = 52 job rows. Ordered by recency the oldest ROOT lands outside the
        // newest-50 window GET /api/jobs serves — and every task must still be reachable here.
        const THREAD_COUNT = 26;
        const ROOT_CREATED_BASE_MINUTES_AGO = 200;
        const ROOT_FINISHED_BASE_MINUTES_AGO = 199;
        const ROOT_DONE_BASE_MINUTES_AGO = 198;
        const FOLLOW_UP_CREATED_BASE_MINUTES_AGO = 199;
        const FOLLOW_UP_FINISHED_BASE_MINUTES_AGO = 198;
        const FOLLOW_UP_DONE_BASE_MINUTES_AGO = 197;
        for (let thread = 0; thread < THREAD_COUNT; thread++) {
            const root = await craft({
                status: 'succeeded',
                createdMinutesAgo: ROOT_CREATED_BASE_MINUTES_AGO - thread * 2,
                finishedMinutesAgo: ROOT_FINISHED_BASE_MINUTES_AGO - thread * 2,
                doneMinutesAgo: ROOT_DONE_BASE_MINUTES_AGO - thread * 2,
            });
            await craft({
                parent: root,
                status: 'succeeded',
                createdMinutesAgo: FOLLOW_UP_CREATED_BASE_MINUTES_AGO - thread * 2,
                finishedMinutesAgo: FOLLOW_UP_FINISHED_BASE_MINUTES_AGO - thread * 2,
                doneMinutesAgo: FOLLOW_UP_DONE_BASE_MINUTES_AGO - thread * 2,
            });
        }
        const seen: string[] = [];
        let cursor: string | undefined;
        for (let guard = 0; guard < 10; guard++) {
            const { page } = await store.listTasks({
                state: 'past',
                sort: 'newest',
                limit: 10,
                ...(cursor ? { cursor } : {}),
            });
            seen.push(...page.items.map((task) => task.id));
            if (page.nextCursor === null) break;
            cursor = page.nextCursor;
        }
        expect(seen).toHaveLength(THREAD_COUNT);
        expect(new Set(seen).size).toBe(THREAD_COUNT);
    });
});

describe.skipIf(!enabled)('listTasks: organization-wide summary', () => {
    it('names the newest run of the thread as headRunId, never the root or an older run', async () => {
        const root = await craft({ status: 'succeeded', createdMinutesAgo: 60, finishedMinutesAgo: 55 });
        await craft({ root, parent: root, status: 'failed', createdMinutesAgo: 40, finishedMinutesAgo: 35 });
        const head = await craft({ root, parent: root, status: 'running', createdMinutesAgo: 10 });

        const { page } = await store.listTasks({ state: 'running', sort: 'newest', limit: 30 });

        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ id: root, headRunId: head, status: 'running' });
    });

    // A retry is a thread member with no parent (issue #326): it folds into its task, never a second one.
    it('folds a parentless retry row into its thread', async () => {
        const root = await craft({ status: 'failed', createdMinutesAgo: 60, finishedMinutesAgo: 55 });
        const retry = await craft({ root, status: 'running', createdMinutesAgo: 10 });

        const { navigation, page } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });

        expect(navigation.counts).toEqual({ running: 1, review: 0, past: 0 });
        expect(page.items).toHaveLength(1);
        expect(page.items[0]).toMatchObject({ id: root, headRunId: retry });
    });

    it('caps the running preview at three and the review preview at five, newest first', async () => {
        const RUNNING = 4;
        const REVIEW = 6;
        const running: string[] = [];
        for (let i = 0; i < RUNNING; i++) running.push(await craft({ status: 'running', createdMinutesAgo: 10 + i }));
        const review: string[] = [];
        for (let i = 0; i < REVIEW; i++) {
            review.push(await craft({ status: 'succeeded', createdMinutesAgo: 30 + i, finishedMinutesAgo: 30 + i }));
        }

        const { navigation } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });

        expect(navigation.counts).toEqual({ running: RUNNING, review: REVIEW, past: 0 });
        expect(navigation.running.map((task) => task.id)).toEqual(running.slice(0, 3));
        expect(navigation.review.map((task) => task.id)).toEqual(review.slice(0, 5));
    });

    it('keeps counts and previews organization-wide while the page obeys the filters', async () => {
        const RUNNING_STARTED_MINUTES_AGO = 59;
        await craft({
            status: 'running',
            createdMinutesAgo: 60,
            startedMinutesAgo: RUNNING_STARTED_MINUTES_AGO,
            repo: 'acme/one',
        });
        await craft({ status: 'succeeded', createdMinutesAgo: 50, finishedMinutesAgo: 45, repo: 'acme/two' });
        await craft({
            status: 'failed',
            createdMinutesAgo: 40,
            finishedMinutesAgo: 35,
            doneMinutesAgo: 30,
            repo: 'acme/three',
        });

        const { navigation, page } = await store.listTasks({
            state: 'review',
            sort: 'newest',
            limit: 30,
            repo: 'acme/two',
        });
        expect(navigation.counts).toEqual({ running: 1, review: 1, past: 1 });
        expect(navigation.running).toHaveLength(1);
        expect(navigation.review).toHaveLength(1);
        // Preview rows arrive through the json path, where stamps read back as offset strings —
        // the shape stampOf exists to normalize. A regression there would null these stamps.
        expect(navigation.running[0]).toMatchObject({ repo: 'acme/one' });
        expect(Math.abs(minutesAgo(navigation.running[0]!.createdAt) - 60)).toBeLessThan(2);
        expect(Math.abs(minutesAgo(navigation.running[0]!.activityAt) - RUNNING_STARTED_MINUTES_AGO)).toBeLessThan(2);
        expect(page.items.map((task) => task.repo)).toEqual(['acme/two']);
    });

    it('never mixes another organization into counts, previews, page or search', async () => {
        await craft({ status: 'running', createdMinutesAgo: 60, startedMinutesAgo: 59, command: 'mine running' });
        await craft({ status: 'succeeded', createdMinutesAgo: 50, finishedMinutesAgo: 45, command: 'mine review' });

        const LEASE_SECONDS = 300;
        const other = await mustCreate(otherOrgStore.create('theirs', null, { repo: null, executor: null }));
        const claim = await otherOrgStore.claim('w1', LEASE_SECONDS);
        await otherOrgStore.complete(other.id, claim!.leaseToken, { status: 'succeeded', exitCode: 0, output: null });

        const { navigation, page } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(navigation.counts).toEqual({ running: 1, review: 1, past: 0 });
        expect(navigation.running.map((task) => task.command)).toEqual(['mine running']);
        expect(navigation.review.map((task) => task.command)).toEqual(['mine review']);
        // `mine review` finished 45 minutes ago; `mine running` last changed 59 minutes ago.
        expect(page.items.map((task) => task.command)).toEqual(['mine review', 'mine running']);

        const search = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30, q: 'theirs' });
        expect(search.page.items).toEqual([]);
    });

    it('carries no run detail: no output, no gates, no runtime object', async () => {
        const root = await craft({
            status: 'running',
            createdMinutesAgo: 30,
            startedMinutesAgo: 29,
            runtime: {
                cpuPercent: 1,
                memUsedMb: 2,
                memPercent: 3,
                activity: 'line',
                sampledAt: '2026-09-10T11:59:00Z',
            },
        });

        const { page } = await store.listTasks({ state: 'attention', sort: 'newest', limit: 30 });
        expect(page.items[0]!.id).toBe(root);
        expect(Object.keys(page.items[0]!).sort()).toEqual([
            'activity',
            'activityAt',
            'author',
            'cancelRequestedAt',
            'command',
            'createdAt',
            'doneAt',
            'executor',
            // The stamped scope beside the label (issue 391) — selection metadata, still bounded.
            'executorScope',
            // The thread's newest run, so a status is never read off the root (#613).
            'headRunId',
            'id',
            // Whether any run of the thread holds an answerable agent question (#537).
            'needsAnswer',
            'repo',
            'status',
            'summary',
            // The PR-wait fields (036) ride the summary contract; this thread never waited, so all
            // three read null.
            'waitReason',
            'waitTerminalReason',
            'waitingSince',
        ]);
        expect(JSON.stringify(page.items[0])).not.toContain('cpuPercent');
    });
});
