import { describe, expect, it } from 'vitest';
import type { ThreadActivity } from '../src/api/useJobActivity.js';
import { figure } from '../src/components/usage/usage-format.js';
import { coverageNote, gateFigures, prFigures, taskStats } from '../src/task-stats.js';
import {
    NO_GATES,
    NO_PRS,
    NO_TOKENS,
    OUTCOMES,
    activityAnswer,
    gateActivity,
    job,
    runUsage,
    taskUsage,
    usageBlock,
    withActivity,
} from './tasks-fixtures.js';

/**
 * The task statistics read model (issues #530, #847, #848): the totals are the canonical task's usage
 * (review runs included, never re-summed from the thread), a missing measurement stays null (rendered
 * "—"), a measured zero stays 0, and a run still going marks the figures provisional.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const REVIEW = '33333333-3333-4333-8333-333333333333';

describe('taskStats', () => {
    it('takes the totals from task.usage, so a review absent from the thread is counted once and listed', () => {
        const task = taskUsage(A, [
            runUsage(A, 'run', { input: 100, output: 10, cacheRead: 1000, cacheCreation: 5 }),
            runUsage(B, 'follow-up', { input: 50, output: 5, cacheRead: 500, cacheCreation: 0 }),
            runUsage(REVIEW, 'review', { input: 7, output: 3 }, { reviewOf: B }),
        ]);
        const activity: ThreadActivity = {
            [A]: activityAnswer(A, { input: 100, output: 10, cacheRead: 1000, cacheCreation: 5 }, task),
            [B]: activityAnswer(B, { input: 50, output: 5, cacheRead: 500, cacheCreation: 0 }, task),
        };
        const stats = taskStats([job({ id: A, agentTurns: 3 }), job({ id: B, agentTurns: 4 })], activity);

        expect(stats.usage?.tokens).toEqual({ input: 157, output: 18, cacheRead: 1500, cacheCreation: 5 });
        expect(stats.reviews).toBe(1);
        expect(stats.agentTurns).toEqual({ value: 7, measured: 2, runs: 2 });
        expect(stats.runs.map((run) => run.label)).toEqual(['Run 1', 'Run 2', 'Review of run 2']);
        expect(stats.runs.map((run) => run.kind)).toEqual(['run', 'follow-up', 'review']);
        expect(stats.runs[2]!.operational).toBe(false);
        expect(stats.provisional).toBe(false);
        expect(stats.telemetry).toBe('measured');
    });

    it('reads the task total, not the latest run or a re-sum of the runs', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 100 })], {
            block: { tokens: { ...NO_TOKENS, input: 999 } },
        });
        const stats = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 100 }, task) });
        expect(stats.usage?.tokens.input).toBe(999);
        expect(stats.runs[0]!.usage?.tokens.input).toBe(100);
    });

    it('keeps a shared-session follow-up as its own row of the thread', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 10 }), runUsage(B, 'follow-up', { input: 20 })]);
        const stats = taskStats([job({ id: A }), job({ id: B })], { [B]: activityAnswer(B, { input: 20 }, task) });
        expect(stats.runs.map((run) => [run.label, run.kind, run.usage?.tokens.input])).toEqual([
            ['Run 1', 'run', 10],
            ['Run 2', 'follow-up', 20],
        ]);
    });

    it('shows the run-unassigned amount as its own row, not as a run', () => {
        const owned = usageBlock(
            { input: 5 },
            { unassigned: [{ reason: 'no-segment', tokens: { ...NO_TOKENS, input: 5 } }] }
        );
        const task = taskUsage(A, [runUsage(A, 'run', { input: 10 })], { taskOwned: owned });
        const stats = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 10 }, task) });
        expect(stats.taskOwned).toBe(owned);
        expect(stats.runs).toHaveLength(1);
        expect(stats.usage?.tokens.input).toBe(15);
    });

    it('marks a run whose job row is gone', () => {
        const gone = runUsage(REVIEW, 'run', { input: 1 }, { operational: false });
        const task = taskUsage(A, [runUsage(A, 'run', { input: 10 }), gone]);
        const stats = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 10 }, task) });
        expect(stats.runs.map((run) => [run.label, run.operational])).toEqual([
            ['Run 1', true],
            ['Earlier run', false],
        ]);
    });

    it('counts an adopted run once: the same job under a second claim adds no run and no usage', () => {
        const first = runUsage(A, 'run', { input: 10 });
        const base = taskUsage(A, [first]);
        const adopted = { ...base, runs: [first, { ...first, endedAt: '2026-09-01T12:09:00.000Z' }] };
        const before = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 10 }, base) });
        const after = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 10 }, adopted) });
        expect(after.runs.map((run) => run.id)).toEqual([A]);
        expect(after.runs[0]!.usage).toEqual(before.runs[0]!.usage);
    });

    it('names the newest thread run as the latest, however many earlier runs were answered', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 1 }), runUsage(B, 'follow-up', { input: 2 })]);
        const stats = taskStats([job({ id: A }), job({ id: B })], {
            [A]: activityAnswer(A, { input: 1 }, task),
            [B]: activityAnswer(B, { input: 2 }, task),
        });
        expect(stats.latest?.id).toBe(B);
        expect(taskStats([], {}).latest).toBeNull();
    });

    it('tells a measured zero from an unmeasured figure, per run and per type', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 0 }), runUsage(B, 'follow-up', null)]);
        const activity: ThreadActivity = {
            [A]: activityAnswer(A, { input: 0 }, task),
            [B]: activityAnswer(B, null, task),
        };
        const stats = taskStats([job({ id: A, agentTurns: 0 }), job({ id: B, agentTurns: null })], activity);
        expect(stats.agentTurns.value).toBe(0);
        expect(stats.usage?.tokens).toEqual({ ...NO_TOKENS, input: 0 });
        expect(stats.runs.map((run) => run.telemetry)).toEqual(['measured', 'none']);
        expect(stats.runs[0]!.usage?.tokens).toEqual({ ...NO_TOKENS, input: 0 });
        expect(coverageNote('Agent turns', stats.agentTurns)).toBe('Agent turns measured for 1 of 2 runs.');
        expect(figure(stats.runs[1]!.agentTurns)).toBe('—');
        expect(figure(stats.runs[0]!.agentTurns)).toBe('0');
        expect(figure(stats.usage!.tokens.output)).toBe('—');
    });

    it('keeps the task unreadable, not zero, when nothing was answered, and separates loading from unavailable', () => {
        const loading = taskStats([job({ id: A }), job({ id: B })], {});
        expect(loading.telemetry).toBe('loading');
        const refused = taskStats([job({ id: A }), job({ id: B })], { [B]: 'unavailable', [A]: 'unavailable' });
        expect(refused.usage).toBeNull();
        expect(refused.agentTurns.value).toBeNull();
        expect(refused.telemetry).toBe('unavailable');
        expect(refused.runs.map((run) => run.telemetry)).toEqual(['unavailable', 'unavailable']);
    });

    it('reads every run of the thread from the task carried by the newest run answer alone', () => {
        const task = taskUsage(A, [runUsage(A, 'run', { input: 100 }), runUsage(B, 'follow-up', null)]);
        const stats = taskStats([job({ id: A }), job({ id: B })], { [B]: activityAnswer(B, null, task) });
        expect(stats.runs.map((run) => run.telemetry)).toEqual(['measured', 'none']);
        expect(stats.runs[0]!.usage?.tokens).toEqual({ ...NO_TOKENS, input: 100 });
        expect(stats.runs[1]!.usage?.state).toBe('unmeasured');
    });

    it('marks a run still going, or a provisional task block, as provisional', () => {
        const live = taskStats([job({ id: A, status: 'running', finishedAt: null })], {});
        expect(live.provisional).toBe(true);
        expect(live.runs[0]!.live).toBe(true);
        const task = taskUsage(A, [runUsage(A, 'run', { input: 1 })], { block: { provisional: true } });
        const done = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 1 }, task) });
        expect(done.provisional).toBe(true);
    });

    it('carries per-type partial coverage and precision from the block, never re-derived', () => {
        const block = {
            coverage: {
                input: { measured: 1, contributors: 2 },
                output: { measured: 2, contributors: 2 },
                cacheRead: { measured: 2, contributors: 2 },
                cacheCreation: { measured: 0, contributors: 2 },
            },
        };
        const task = taskUsage(A, [runUsage(A, 'run', { input: 1 })], { block });
        const stats = taskStats([job({ id: A })], { [A]: activityAnswer(A, { input: 1 }, task) });
        expect(stats.usage?.coverage.input).toEqual({ measured: 1, contributors: 2 });
    });
});

/**
 * Gate and PR activity (issue #983): the task-level answer the newest run carries, worded for the
 * dialog. A figure nobody recorded is "—", never 0, and a partial answer says so.
 */
describe('taskStats gate and PR activity', () => {
    const answer = (gates = gateActivity(), prs = NO_PRS) => withActivity(activityAnswer(B, { input: 1 }), gates, prs);

    it('reads the task-level gates and PRs from the newest answered run', () => {
        const gates = gateActivity({ executions: 5 });
        const stats = taskStats([job({ id: A }), job({ id: B })], {
            [A]: withActivity(activityAnswer(A, { input: 1 }), gateActivity({ executions: 1 }), NO_PRS),
            [B]: answer(gates),
        });
        expect(stats.gates).toEqual(gates);
    });

    it('has no gate or PR activity while nothing is answered or the board refused', () => {
        expect(taskStats([job({ id: B })], {}).gates).toBeNull();
        expect(taskStats([job({ id: B })], { [B]: 'unavailable' }).prs).toBeNull();
    });

    it('words the outcome counts in order and leaves zero outcomes out', () => {
        const figures = gateFigures(gateActivity());
        expect(figures.executions).toBe('3');
        expect(figures.outcomes).toEqual([
            { key: 'passed', label: 'Passed', count: 2 },
            { key: 'failed', label: 'Failed', count: 1 },
        ]);
        expect(figures.duration).toBe('2m 30s');
        expect(figures.durationNote).toBeNull();
        expect(figures.partial).toBe(false);
    });

    it('shows a dash, not 0, when nothing was recorded', () => {
        expect(gateFigures(NO_GATES)).toMatchObject({
            executions: '—',
            outcomes: [],
            duration: '—',
            durationNote: null,
            partial: false,
            recorded: false,
        });
        expect(prFigures(NO_PRS)).toMatchObject({ operations: '—', distinct: '—', links: [], recorded: false });
    });

    it('says how many executions the duration covers, and a dash when none was timed', () => {
        const some = gateFigures(gateActivity({ measuredCount: 2, unmeasuredCount: 1, coverage: 'partial' }));
        expect(some.durationNote).toBe('Duration measured for 2 of 3 executions.');
        expect(some.partial).toBe(true);
        const none = gateFigures(
            gateActivity({ executions: 2, measuredMs: null, measuredCount: 0, unmeasuredCount: 2, coverage: 'partial' })
        );
        expect(none.duration).toBe('—');
        expect(none.durationNote).toBe('Duration measured for 0 of 2 executions.');
    });

    it('attributes a reused check to the execution it reused, and counts agent-observed calls apart', () => {
        const figures = gateFigures(
            gateActivity({
                reused: [
                    {
                        jobId: A,
                        gate: 'test',
                        executionId: '0a1b2c3d-0000-4000-8000-000000000001',
                        finishedAt: null,
                        reason: 'tree unchanged',
                    },
                ],
                observed: { executions: 2, byOutcome: { ...OUTCOMES, unknown: 2 } },
            })
        );
        expect(figures.reused).toEqual([
            { gate: 'test', text: 'Reused the result of execution 0a1b2c3d: tree unchanged' },
        ]);
        expect(figures.observed).toBe('2 more gate calls appear in the agent transcript with no board record.');
    });

    it('words a PR whose creation kind was not recorded, and says coverage is partial', () => {
        const url = 'https://github.com/acme/web/pull/7';
        const figures = prFigures({
            coverage: 'partial',
            counts: { operations: 1, distinct: 1 },
            operations: [{ jobId: A, operationId: null, kind: 'unknown', repo: 'acme/web', number: 7, url }],
            distinct: [{ repo: 'acme/web', number: 7, url }],
        });
        expect(figures).toMatchObject({ operations: '1', distinct: '1', partial: true });
        expect(figures.byKind).toEqual([{ label: 'Kind not recorded', count: 1 }]);
    });

    it('counts operations apart from distinct PRs and links each PR once', () => {
        const figures = prFigures({
            coverage: 'complete',
            counts: { operations: 3, distinct: 2 },
            operations: [
                {
                    jobId: A,
                    operationId: 'o1',
                    kind: 'created',
                    repo: 'acme/web',
                    number: 7,
                    url: 'https://github.com/acme/web/pull/7',
                },
                {
                    jobId: A,
                    operationId: 'o2',
                    kind: 'reused',
                    repo: 'acme/web',
                    number: 7,
                    url: 'https://github.com/acme/web/pull/7',
                },
                {
                    jobId: B,
                    operationId: null,
                    kind: 'agent_created',
                    repo: 'acme/web',
                    number: 9,
                    url: 'https://github.com/acme/web/pull/9',
                },
            ],
            distinct: [
                { repo: 'acme/web', number: 7, url: 'https://github.com/acme/web/pull/7' },
                { repo: 'acme/web', number: 9, url: 'https://github.com/acme/web/pull/9' },
            ],
        });
        expect(figures).toMatchObject({ operations: '3', distinct: '2', partial: false });
        expect(figures.byKind).toEqual([
            { label: 'Created', count: 1 },
            { label: 'Reused', count: 1 },
            { label: 'Created by the agent', count: 1 },
        ]);
        expect(figures.links).toEqual([
            { label: 'acme/web#7', url: 'https://github.com/acme/web/pull/7' },
            { label: 'acme/web#9', url: 'https://github.com/acme/web/pull/9' },
        ]);
    });
});

describe('taskStats with telemetry off (issue #983)', () => {
    it('reads tokens as unavailable, not unmeasured, when the answer arrives with gate records but no token figures', () => {
        const off = withActivity(
            { ...activityAnswer(A, null), usage: usageBlock(null, { state: 'unavailable' }) },
            gateActivity(),
            NO_PRS
        );
        const stats = taskStats([job({ id: A })], { [A]: off });
        expect(stats.telemetry).toBe('unavailable');
        expect(stats.runs[0]!.telemetry).toBe('unavailable');
        expect(stats.gates?.executions).toBe(3);
    });
});
