import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import type { HelperPlan } from '../../src/helpers.js';
import { createLoop } from '../../src/loop/loop.js';
import type { RunOutcome, RunSession } from '../../src/runner.js';
import { StepChannelClosed } from '../../src/step-control.js';
import { ForgeWait } from '../../src/supervised-steps.js';
import { config, drive, job, ok, sleep, stubBoard, stubRunner } from '../fixtures/loop-stubs.js';
import { githubRef } from '../fixtures/repo-ref.js';

/**
 * The loop over a GitLab job (docs/connections.md): its git asks the member's token through the supervisor's
 * forge mailbox, so the loop asks the board for no token before the sync, a helper or the publish — and a
 * credential ask the board leaves unanswered or waiting hands the attempt back as an interruption, the session
 * and the checkout kept, never a fault and never `dead`.
 */

/** What a credential wait's hand-back says (`credentialWaitReason`): the cause, never a lost supervisor. */
const CREDENTIAL_WAIT = 'the GitLab credential could not be confirmed; the task waits and resumes';

const gitlab = (n: number, over: Partial<BoardJob> = {}): BoardJob => ({
    ...job(n),
    repo: { forge: 'gitlab', host: 'gitlab.example.com', path: 'group/sub/widgets' },
    ...over,
});

const LANDED = {
    ok: true,
    published: true,
    branch: 'factory/x',
    prUrl: 'https://gitlab.example.com/group/sub/widgets/-/merge_requests/1',
    reason: null,
    cause: null,
    repository: 'group/sub/widgets',
    baseBranch: 'main',
    prNumber: 1,
} as const;

describe('a GitLab job in the loop', () => {
    it('asks the board for no token: the sync and the publish get none, and the run publishes', async () => {
        const board = stubBoard([gitlab(1)], { githubToken: 'ghs_should-not-be-asked' });
        const runner = stubRunner(async () => ok(), { publish: LANDED });

        await drive({ ...board, runner });

        expect(board.board.githubAsks).toEqual([]);
        expect(runner.syncTokens).toEqual([undefined]);
        expect(runner.githubTokens).toEqual([undefined]);
        expect(board.board.completed[0]).toMatchObject({ status: 'succeeded' });
    });

    it('asks no token before a github-writing helper either', async () => {
        const plan: HelperPlan = { helperId: 'noop', phase: 'pre', input: null, githubWriting: true };
        const board = stubBoard([gitlab(1, { publish: false, helperPlans: [plan] })], { githubToken: 'ghs_x' });
        const runner = stubRunner(async () => ok());
        const tokens: (string | undefined)[] = [];
        runner.runHelper = async (_job, _plan, { token } = {}) => {
            tokens.push(token);
            return { ok: true, output: null };
        };

        await drive({ ...board, runner });

        expect(board.board.githubAsks).toEqual([]);
        expect(tokens).toEqual([undefined]);
    });

    it('hands the attempt back when the sync’s credential ask waits: interrupted, no verdict, nothing run', async () => {
        const board = stubBoard([gitlab(1)]);
        let ran = 0;
        const runner = stubRunner(
            async () => {
                ran += 1;
                return ok();
            },
            { sync: { ok: false, reason: 'the credential ask waits', kind: 'forge_wait' } }
        );

        await drive({ ...board, runner });

        expect(ran).toBe(0);
        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([
            expect.objectContaining({
                id: gitlab(1).id,
                blocked: true,
                reason: expect.stringContaining(CREDENTIAL_WAIT),
            }),
        ]);
        expect(runner.reclaimed).toEqual([]);
    });

    it('hands the attempt back when the publish’s credential ask waits, never a failed publish', async () => {
        const board = stubBoard([gitlab(1)]);
        const runner = stubRunner(async () => ok());
        runner.publishGit = async () => {
            throw new ForgeWait('git push');
        };

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([expect.objectContaining({ id: gitlab(1).id, blocked: true })]);
        expect(board.board.interrupted[0]?.reason).toContain('git push');
        expect(board.board.interrupted[0]?.reason).toContain(CREDENTIAL_WAIT);
        expect(board.board.interrupted[0]?.reason).not.toContain('supervisor');
        expect(runner.reclaimed).toEqual([]);
    });

    it('hands a helper’s unanswered credential ask back outside the budget, never a failed helper', async () => {
        const plan: HelperPlan = { helperId: 'noop', phase: 'pre', input: null, githubWriting: true };
        const board = stubBoard([gitlab(1, { publish: false, helperPlans: [plan] })]);
        const runner = stubRunner(async () => ok());
        runner.runHelper = async () => {
            throw new ForgeWait('the helper noop');
        };

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([
            expect.objectContaining({
                id: gitlab(1).id,
                blocked: true,
                reason: expect.stringContaining(CREDENTIAL_WAIT),
            }),
        ]);
    });

    it('leaves an attempt whose supervisor was lost mid-fetch to its lease: no verdict, nothing reclaimed', async () => {
        const board = stubBoard([gitlab(1)]);
        const runner = stubRunner(async () => ok(), { syncError: new StepChannelClosed('the sync was answered') });

        await drive({ ...board, runner });

        expect(board.board.completed).toEqual([]);
        expect(runner.reclaimed).toEqual([]);
    });

    it('hands a sync still fetching over on a drain: interrupted, never failed', async () => {
        const claimed = gitlab(1);
        const board = stubBoard([claimed]);
        let fetching: () => void = () => {};
        const inFetch = new Promise<void>((resolve) => {
            fetching = resolve;
        });
        const runner = stubRunner(async (): Promise<RunOutcome> => ok());
        runner.syncCheckout = async () => {
            fetching();
            return new Promise(() => {});
        };
        const loop = createLoop({ board: board.board, runner, config: config(), sleep });
        board.attach(loop);
        const started = loop.start();

        await inFetch;
        await loop.handover('the driver was drained');
        await started;

        expect(board.board.completed).toEqual([]);
        expect(board.board.interrupted).toEqual([
            expect.objectContaining({ id: claimed.id, reason: 'the driver was drained' }),
        ]);
    });

    it('keeps a GitHub job on its asks: one before the sync, one before the publish', async () => {
        const board = stubBoard([{ ...job(1), repo: githubRef('acme/widgets') }], { githubToken: 'ghs_minted' });
        const runner = stubRunner(async () => ok(), { publish: LANDED });

        await drive({ ...board, runner });

        expect(board.board.githubAsks).toHaveLength(2);
        expect(runner.syncTokens).toEqual(['ghs_minted']);
        expect(runner.githubTokens).toEqual(['ghs_minted']);
    });
});

/**
 * The board's budget rule (`releaseOpen`, server/src/db/jobs/job-store-interruption-budget.ts) over the stub board: a
 * blocked, requirement, org-suspended or node-loss hand-back is outside the poison budget; any other spends it, and
 * past ten the board refuses the hand-back (`exhausted`), which leaves the attempt to retire.
 */
const INTERRUPTION_BUDGET = 10;
function budgeted(board: ReturnType<typeof stubBoard>): string[] {
    const counted: string[] = [];
    const take = board.board.interrupt.bind(board.board);
    board.board.interrupt = async (claimed, interruption) => {
        const free =
            interruption.blocked || interruption.requirement || interruption.orgSuspended || interruption.nodeLoss;
        if (!free) {
            if (counted.length >= INTERRUPTION_BUDGET) return 'exhausted';
            counted.push(interruption.reason);
        }
        return take(claimed, interruption);
    };
    return counted;
}

describe('a credential wait never spends the interruption budget', () => {
    const OUTAGES = INTERRUPTION_BUDGET + 3;
    /** Every claim of one task, the session it continues kept on each. */
    const claims = (n: number): BoardJob[] =>
        Array.from({ length: n }, (_, i) => gitlab(1, { claimSeq: i + 1, resumeSessionId: 'session-1' }));

    it('waits out more outages at the sync than the budget holds, then runs and publishes: never dead', async () => {
        const board = stubBoard(claims(OUTAGES + 1));
        const counted = budgeted(board);
        const sessions: (RunSession | null)[] = [];
        const runner = stubRunner(
            async (_job, session) => {
                sessions.push(session);
                return ok();
            },
            { publish: LANDED }
        );
        let syncs = 0;
        runner.syncCheckout = async (synced) => {
            runner.synced.push(synced);
            syncs += 1;
            return syncs <= OUTAGES
                ? { ok: false, reason: 'the credential ask went unanswered', kind: 'forge_wait' }
                : { ok: true, reason: null };
        };

        await drive({ ...board, runner });

        expect(board.board.interrupted).toHaveLength(OUTAGES);
        for (const handed of board.board.interrupted) {
            expect(handed).toMatchObject({ blocked: true, reason: expect.stringContaining(CREDENTIAL_WAIT) });
        }
        expect(counted).toEqual([]);
        // The checkout is never reclaimed and the session is resumed once the credential is back.
        expect(runner.reclaimed).toEqual([]);
        expect(sessions).toEqual([{ id: 'session-1', resume: true }]);
        expect(board.board.completed).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    });

    it('waits out more outages at the publish than the budget holds, then publishes: never failed', async () => {
        const board = stubBoard(claims(OUTAGES + 1));
        const counted = budgeted(board);
        const runner = stubRunner(async () => ok());
        let pushes = 0;
        runner.publishGit = async () => {
            pushes += 1;
            if (pushes <= OUTAGES) throw new ForgeWait('git push');
            return LANDED;
        };

        await drive({ ...board, runner });

        expect(board.board.interrupted).toHaveLength(OUTAGES);
        for (const handed of board.board.interrupted) expect(handed).toMatchObject({ blocked: true });
        expect(counted).toEqual([]);
        expect(runner.reclaimed).toEqual([]);
        expect(board.board.completed).toEqual([expect.objectContaining({ status: 'succeeded' })]);
    });
});
