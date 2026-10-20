import { describe, expect, it } from 'vitest';
import type { BoardJob, LeaseState } from '../src/board.js';
import { BOARD_CALL_ATTEMPTS, BoardHttpError } from '../src/board-retry.js';
import { end } from '../src/loop-conclusion.js';
import { newJobState } from '../src/loop-attempt.js';
import { recordEnding } from '../src/loop-phase.js';
import type { AttemptCtx, EndDecision } from '../src/loop-types.js';

const JOB = { id: 'job-1', lastAttempt: false } as BoardJob;

const VERDICT: EndDecision = {
    kind: 'verdict',
    verdict: { status: 'failed', exitCode: 1, output: 'nope', failureKind: 'runner_error' },
};

/** What a board call answers; a function throws, so one call can fail where the rest land. */
interface Answers {
    suspend?: LeaseState | (() => never);
    interrupt?: LeaseState | 'exhausted' | (() => never);
    requeue?: () => never;
    stage?: LeaseState | 'lost' | 'conflict' | 'removed' | (() => never);
    complete?: LeaseState | (() => never);
}

const answer = <T>(given: T | (() => never) | undefined, fallback: T): T =>
    typeof given === 'function' ? (given as () => never)() : (given ?? fallback);

/**
 * One attempt stubbed down to what `end` touches, every call recorded in order: the board's durable
 * calls, the quiesce, and each destructive step of the teardown. A fence held (`fenced`) is the
 * kubernetes checkout claim before the launch.
 */
function attempt(answers: Answers = {}, { fenced = false, launched = false } = {}) {
    const calls: string[] = [];
    const lines: string[] = [];
    const state = newJobState();
    state.launched = launched;
    state.control = 'control-token';
    const ctx = {
        rt: {
            runner: {
                finish: async () => {
                    calls.push('finish');
                },
                releaseServices: async () => {
                    calls.push('services');
                },
                releaseFence: async () => {
                    calls.push('fence');
                },
            },
            gates: {
                server: {
                    closeControl: () => calls.push('control.close'),
                    unregister: () => calls.push('gate.unregister'),
                },
                manager: { release: () => calls.push('gate.release') },
            },
            board: {
                suspend: async () => {
                    calls.push('suspend');
                    return answer(answers.suspend, 'held');
                },
                interrupt: async () => {
                    calls.push('interrupt');
                    return answer(answers.interrupt, 'held');
                },
                requeue: async () => {
                    calls.push('requeue');
                    return answer(answers.requeue, 'held');
                },
                stageConclusion: async () => {
                    calls.push('stage');
                    return answer(answers.stage, 'held');
                },
            },
            config: { leaseSeconds: 300 },
            report: async () => {
                calls.push('complete');
                return answer(answers.complete, 'ok');
            },
            sleep: async () => {},
            log: (line: string) => {
                calls.push('log');
                lines.push(line);
            },
        },
        job: JOB,
        state,
        quiesce: async () => {
            calls.push('quiesce');
        },
        fenced,
        treeBefore: null,
        gateSession: { token: 'gate-token', key: 'gate-key' },
        setupDone: true,
    } as unknown as AttemptCtx;
    return { ctx, calls, lines };
}

/** Every teardown step in its order: the group, then its control channel, then the rest. */
const TEARDOWN = ['quiesce', 'finish', 'control.close', 'gate.unregister', 'gate.release', 'services'];

const down = (calls: readonly string[]) => calls.filter((call) => call !== 'log');
const unavailable = (): never => {
    throw new BoardHttpError(503, '/api/jobs/job-1 answered 503: down');
};

describe('end lands the board call before it destroys anything (issue #828)', () => {
    it.each([
        ['a verdict', VERDICT, ['stage', 'complete']],
        ['a park', { kind: 'park', phase: 'setup' }, ['suspend']],
        ['an interrupt', { kind: 'interrupt', reason: 'the pod was evicted', exitCode: null }, ['interrupt']],
        ['a requeue', { kind: 'requeue', log: 'the checkout lock is held' }, ['requeue']],
        ['a leave before the launch', { kind: 'leave', log: 'left' }, []],
        ['a lost lease', { kind: 'none', log: 'lost' }, []],
    ] satisfies readonly (readonly [string, EndDecision, string[]])[])(
        'orders %s: durable call, quiesce, finish while control is open, the rest, the claim last',
        async (_what, decision, durable) => {
            const { ctx, calls } = attempt({}, { fenced: true });

            await end(ctx, decision);

            expect(down(calls)).toEqual([...durable, ...TEARDOWN, 'fence']);
        }
    );

    it('finishes the runner while the control channel is still open', async () => {
        const { ctx, calls } = attempt();
        const finish = ctx.rt.runner.finish;
        ctx.rt.runner.finish = async (job) => {
            calls.push('finish:begin');
            await new Promise((resolve) => setTimeout(resolve, 5));
            await finish(job);
        };

        await end(ctx, { kind: 'park', phase: 'setup' });

        expect(calls.indexOf('control.close')).toBeGreaterThan(calls.indexOf('finish'));
    });

    it('keeps the verdict ahead of the quiesce, which waits for it (issue #821)', async () => {
        const { ctx, calls } = attempt();

        await end(ctx, VERDICT);

        expect(down(calls).slice(0, 3)).toEqual(['stage', 'complete', 'quiesce']);
        expect(ctx.state.phase).toBe('concluding');
    });

    it('runs the pre-park work and drains the output before the park', async () => {
        const { ctx, calls } = attempt();
        ctx.state.drainOutput = async () => void calls.push('drain');

        await end(ctx, { kind: 'park', phase: 'its run', beforePark: async () => void calls.push('hook') });

        expect(down(calls).slice(0, 3)).toEqual(['hook', 'drain', 'suspend']);
    });

    it('still parks when the pre-park work throws', async () => {
        const { ctx, calls, lines } = attempt();

        await end(ctx, {
            kind: 'park',
            phase: 'its run',
            beforePark: async () => {
                throw new Error('artifact upload refused');
            },
        });

        expect(calls).toContain('suspend');
        expect(lines[0]).toContain('parking anyway: artifact upload refused');
    });
});

describe("end is the attempt's one ending (issue #820)", () => {
    it('acts on the first decision only; a second ask awaits the first', async () => {
        const { ctx, calls } = attempt();

        const first = end(ctx, { kind: 'park', phase: 'setup' });
        const second = end(ctx, VERDICT);
        await Promise.all([first, second]);

        expect(second).toBe(first);
        expect(down(calls).filter((call) => call === 'suspend')).toHaveLength(1);
        expect(calls).not.toContain('stage');
        expect(calls.filter((call) => call === 'finish')).toHaveLength(1);
    });

    it("answers a later ask the first one's answer, with nothing done again", async () => {
        const { ctx, calls } = attempt();

        expect(await end(ctx, VERDICT)).toBe('ok');
        const seen = calls.length;
        expect(await end(ctx, { kind: 'park', phase: 'its run' })).toBe('ok');

        expect(calls).toHaveLength(seen);
    });

    it('tears down even when the board call throws, and says so to the caller', async () => {
        const { ctx, calls } = attempt();
        ctx.state.drainOutput = async () => {
            throw new Error('the pump is wedged');
        };

        await expect(end(ctx, { kind: 'park', phase: 'setup' })).rejects.toThrow('the pump is wedged');

        expect(down(calls)).toEqual(TEARDOWN);
    });
});

describe("end leaves a launched attempt's runner to the next claim (I6)", () => {
    it('never finishes the runner of a leave after the launch, and still closes everything else', async () => {
        const { ctx, calls } = attempt({}, { launched: true });

        await end(ctx, { kind: 'leave', log: 'could not run: the daemon refused' });

        expect(calls).not.toContain('finish');
        expect(down(calls)).toEqual(['quiesce', 'control.close', 'gate.unregister', 'gate.release', 'services']);
    });

    it('finishes a leave before the launch: no agent ran, nothing to adopt', async () => {
        const { ctx, calls } = attempt();

        await end(ctx, { kind: 'leave', log: 'checkout sync threw' });

        expect(calls).toContain('finish');
    });

    it('never finishes the runner of an attempt a drain handed over', async () => {
        const { ctx, calls } = attempt();
        recordEnding(ctx.state, 'handover');

        await end(ctx, { kind: 'none', log: 'handed over' });

        expect(calls).not.toContain('finish');
        expect(calls).toContain('control.close');
    });
});

describe('end retains the runner a board call did not reach', () => {
    it('keeps it when the park never lands, after retrying the call', async () => {
        const { ctx, calls, lines } = attempt({ suspend: unavailable });

        await end(ctx, { kind: 'park', phase: 'setup' });

        expect(calls.filter((call) => call === 'suspend')).toHaveLength(BOARD_CALL_ATTEMPTS);
        expect(lines.join('\n')).toContain('the board did not take the stop, left to the lease');
        expect(calls).not.toContain('finish');
        expect(calls).toContain('control.close');
    });

    it('keeps it when the requeue never lands', async () => {
        const { ctx, calls } = attempt({ requeue: unavailable }, { fenced: true });

        await end(ctx, { kind: 'requeue', log: 'the checkout lock is held' });

        expect(calls).not.toContain('finish');
        // The claim stays with the runner too: the next claim adopts or sweeps both.
        expect(calls).not.toContain('fence');
    });

    it('keeps it when the interruption never lands, and leaves the attempt to the lease', async () => {
        const { ctx, calls, lines } = attempt({ interrupt: unavailable });

        await end(ctx, { kind: 'interrupt', reason: 'the pod was evicted', exitCode: null });

        expect(calls).not.toContain('finish');
        expect(lines.join('\n')).toContain('leaving it to the lease');
    });

    it("reports a last attempt's interruption that never landed as a failed verdict, and finishes on it", async () => {
        const { ctx, calls } = attempt({ interrupt: unavailable });
        ctx.job = { ...JOB, lastAttempt: true, attempts: 3, maxAttempts: 3 } as BoardJob;

        await end(ctx, { kind: 'interrupt', reason: 'the pod was evicted', exitCode: null });

        expect(down(calls).filter((call) => call === 'stage' || call === 'complete')).toEqual(['stage', 'complete']);
        expect(calls).toContain('finish');
    });

    it('leaves the group and the claim standing when neither the stage nor the verdict was accepted', async () => {
        const { ctx, calls } = attempt({ stage: unavailable, complete: unavailable }, { fenced: true });

        await end(ctx, VERDICT);

        expect(calls).not.toContain('finish');
        expect(calls).not.toContain('fence');
    });

    it('spends an exhausted interruption budget as a leave, finishing a runner that never launched', async () => {
        const { ctx, calls, lines } = attempt({ interrupt: 'exhausted' });

        await end(ctx, { kind: 'interrupt', reason: 'the pod was evicted', exitCode: null });

        expect(lines.join('\n')).toContain('the interruption budget is spent');
        expect(calls).toContain('finish');
    });
});

describe('end takes the board\'s "lost" as final', () => {
    it('does not retry a park the board answers lost, and tears down as for a lost lease', async () => {
        const { ctx, calls, lines } = attempt({ suspend: 'lost' });

        await end(ctx, { kind: 'park', phase: 'its run' });

        expect(calls.filter((call) => call === 'suspend')).toHaveLength(1);
        expect(lines.join('\n')).toContain('but the board had already reclaimed it');
        expect(down(calls)).toEqual(['suspend', ...TEARDOWN]);
    });

    it('does not retry an interruption the board answers lost', async () => {
        const { ctx, calls, lines } = attempt({ interrupt: 'lost' });

        await end(ctx, { kind: 'interrupt', reason: 'the pod was evicted', exitCode: null });

        expect(calls.filter((call) => call === 'interrupt')).toHaveLength(1);
        expect(lines.join('\n')).toContain('and the lease was already lost');
        expect(calls).toContain('finish');
    });

    it('settles at once, with no verdict, on a stage the board answers lost', async () => {
        const { ctx, calls } = attempt({ stage: 'lost' });

        expect(await end(ctx, VERDICT)).toBe('lost');

        expect(calls).not.toContain('complete');
        expect(calls).toContain('finish');
    });
});
