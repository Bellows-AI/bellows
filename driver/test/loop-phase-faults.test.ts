/**
 * The phase-boundary fault harness (issue #828, slice 1): one fresh attempt per cell, a fault — a
 * Stop, a lost lease, a Remove, a drain's handover or an exception — injected at one boundary of the
 * attempt from inside the stub that hosts it, and the attempt's ordered board/runner/gate calls
 * checked against the attempt-level invariants:
 *
 * - I1, one logical conclusion: the accepted conclusions — a verdict (its stage or its complete), a
 *   suspend, a released interrupt, a requeue — number at most one, and it is the one expected.
 * - I2, finalization: `runner.finish` runs as often as expected (0 after a handover, else 1), and
 *   each of finish, `releaseServices`, the gate release and the control close at most once.
 * - I3, contained: no unhandled rejection, and no attempt that threw out to `track` (`loop.ts`).
 * - I4, outcome before teardown: the first durable acknowledgement precedes the first teardown.
 * - I5, finish while control is open: `runner.finish` precedes the control close.
 * - I6, retention: an attempt left to the lease after its agent ran never finishes its runner —
 *   the run is the next claim's to adopt (`thrownRunDecision`, `loop-fence.ts`).
 *
 * Judgement calls the checker encodes:
 * - The interrupt `adoptStep` records for an EARLIER claim (`release: false`) is no conclusion.
 * - A handover's released interrupt is that attempt's conclusion; the attempt itself reports none.
 * - `leave` has no conclusion, so I4 is vacuous for it — and for lost and removed.
 * - A verdict's durable acknowledgement is its accepted stage (#821: a recovering claim commits it),
 *   the complete only when nothing was staged.
 * - A Stop while the agent runs drains cooperatively: the run returns and the attempt parks.
 * - A plain pre-helper exception leaves the lease with a group the sync created but no agent run in
 *   it: `Runner.adopt` takes only a FINISHED run (`runner.ts`), so there is nothing to retain and
 *   I6 does not apply.
 *
 * Expectations are read from the code; every cell holds.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BoardJob, HeartbeatVerdict } from '../src/board.js';
import type { HelperPlan, HelperResult } from '../src/helpers.js';
import type { Loop } from '../src/loop.js';
import type { RunOutcome } from '../src/runner.js';
import { StepChannelClosed } from '../src/step-control.js';
import { drive, gatedJob, ok, stubBoard, stubGateStack, stubRunner } from './fixtures/loop-stubs.js';

/** The wall-clock cap on every wait the harness makes: a delivery, the settle-wait, the drive. */
const CAP_MS = 5_000;
/** Consecutive quiet ticks that read as an attempt with nothing left in flight. */
const QUIET_TICKS = 20;

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Polls `done` on macrotask ticks for at most `CAP_MS` of wall clock; answers whether it came true. */
async function until(done: () => boolean): Promise<boolean> {
    const deadline = Date.now() + CAP_MS;
    while (!done()) {
        if (Date.now() > deadline) return false;
        await tick();
    }
    return true;
}

const BOUNDARIES = [
    'claim',
    'adopt',
    'sync',
    'pre-helpers',
    'services',
    'gate setup',
    'run',
    'run tail',
    'probe',
    'gates',
    'post-helpers',
    'publish',
    'conclusion',
    'settle',
] as const;
type Boundary = (typeof BOUNDARIES)[number];
type Fault = 'stop' | 'lost' | 'removed' | 'handover' | 'exception';
type Conclusion = 'verdict' | 'suspend' | 'interrupt:release' | 'requeue' | 'none';

/** The boundaries whose verdict is already decided: a later stop, loss or handover acts on nothing. */
const CONCLUDING: readonly Boundary[] = ['conclusion', 'settle'];

interface Expected {
    conclusion: Conclusion;
    finishes: 0 | 1;
    /** Left to the lease after the agent ran: the runner is the next claim's (I6), never finished. */
    retain?: boolean;
}

/** What one attempt did, in order: `<call>` on invocation, `<call>:ok` / `<call>:threw` on completion. */
interface Observed {
    timeline: string[];
    logs: string[];
    rejections: unknown[];
    /** Harness failures: a seam never reached, a fault never delivered, an attempt that never settled. */
    setup: string[];
}

/** The calls whose acceptance concludes an attempt, by the conclusion kind each is. */
const CONCLUSIONS: Record<string, Exclude<Conclusion, 'none'>> = {
    'board.suspend:ok': 'suspend',
    'board.interrupt(release):ok': 'interrupt:release',
    'board.requeue:ok': 'requeue',
};
const DURABLE_ACKS = [
    'board.stageConclusion',
    'board.complete',
    'board.suspend',
    'board.interrupt(release)',
    'board.requeue',
] as const;
const TEARDOWNS = ['runner.finish', 'runner.releaseServices', 'gate.release', 'control.close'] as const;

/** The accepted conclusions in order; a verdict is one however many of its stage and complete landed. */
function conclusionsOf(timeline: readonly string[]): Exclude<Conclusion, 'none'>[] {
    const out: Exclude<Conclusion, 'none'>[] = [];
    let stages = 0;
    let completes = 0;
    let verdicts = 0;
    for (const entry of timeline) {
        if (entry === 'board.stageConclusion:ok') stages += 1;
        if (entry === 'board.complete:ok') completes += 1;
        if (Math.max(stages, completes) > verdicts) {
            verdicts += 1;
            out.push('verdict');
        }
        const kind = CONCLUSIONS[entry];
        if (kind) out.push(kind);
    }
    return out;
}

/** The violated invariants of one observed attempt, each a line naming its invariant; empty when it held. */
function violationsOf(run: Observed, expected: Expected): string[] {
    const { timeline } = run;
    const v = run.setup.map((line) => `SETUP: ${line}`);
    const count = (name: string) => timeline.filter((entry) => entry === name).length;
    const first = (name: string) => timeline.indexOf(name);

    const concluded = conclusionsOf(timeline);
    const one = concluded.length === 0 ? 'none' : concluded.length === 1 ? concluded[0] : null;
    if (one !== expected.conclusion) {
        v.push(`I1: ${concluded.join(', ') || 'none'} (expected ${expected.conclusion})`);
    }

    const finishes = count('runner.finish');
    if (expected.retain) {
        if (finishes > 0) v.push('I6: runner.finish on a leave after the agent ran');
    } else if (finishes !== expected.finishes) {
        v.push(`I2: runner.finish ran ${finishes} times (expected ${expected.finishes})`);
    }
    for (const name of TEARDOWNS) {
        if (count(name) > 1) v.push(`I2: ${name} ran ${count(name)} times`);
    }

    for (const rejection of run.rejections) v.push(`I3: unhandled rejection: ${String(rejection)}`);
    if (run.logs.some((line) => line.includes('the attempt threw'))) v.push('I3: the attempt threw out to the loop');

    const acks = DURABLE_ACKS.map((name) => ({ name, at: first(`${name}:ok`) })).filter(({ at }) => at >= 0);
    const ack = acks.sort((a, b) => a.at - b.at)[0];
    const torn = TEARDOWNS.map((name) => ({ name, at: first(name) })).filter(({ at }) => at >= 0);
    const teardown = torn.sort((a, b) => a.at - b.at)[0];
    if (expected.conclusion !== 'none' && ack && teardown && teardown.at < ack.at) {
        v.push(`I4: ${teardown.name} before ${ack.name}`);
    }

    const finishAt = first('runner.finish');
    const closeAt = first('control.close');
    if (finishAt >= 0 && closeAt >= 0 && closeAt < finishAt) v.push('I5: runner.finish after control.close');
    return v;
}

/** Wraps one call so the timeline records its invocation, then its acceptance or its throw. */
function recorded<A extends unknown[], R>(
    timeline: string[],
    label: string | ((...args: NoInfer<A>) => string),
    call: (...args: A) => R
): (...args: A) => R {
    return (...args: A): R => {
        const name = typeof label === 'string' ? label : label(...args);
        timeline.push(name);
        let out: R;
        try {
            out = call(...args);
        } catch (e) {
            timeline.push(`${name}:threw`);
            throw e;
        }
        if (!(out instanceof Promise)) {
            timeline.push(`${name}:ok`);
            return out;
        }
        return out.then(
            (value: unknown) => {
                timeline.push(`${name}:ok`);
                return value;
            },
            (e: unknown) => {
                timeline.push(`${name}:threw`);
                throw e;
            }
        ) as R;
    };
}

/** How one cell scripts the attempt beyond the boundary fault: the extra rows of the matrix. */
interface Script {
    /** The boundary fault; null for the baseline and the scripted rows. */
    at: { boundary: Boundary; fault: Fault } | null;
    /** The sync's answer, when not an ok one. */
    sync?: { ok: false; reason: string };
    /** The run's own outcome or throw, when not a clean exit. */
    run?: (scraped: string) => Promise<RunOutcome>;
    /** A helper of this phase loses its supervisor (`StepChannelClosed`). */
    helperLost?: HelperPlan['phase'];
    /** That loss lands with a stop beat still in flight, which the interruption's settle awaits. */
    stopInFlight?: boolean;
    lastAttempt?: boolean;
}

const HELD: HeartbeatVerdict = { result: 'held', cancelRequested: false };
const answerOf = (fault: 'stop' | 'lost' | 'removed'): HeartbeatVerdict =>
    fault === 'stop' ? { result: 'held', cancelRequested: true } : fault;

/**
 * Runs one fresh attempt of a gated job with a pre- and a post-helper through the real loop, every
 * stub scripted to succeed except where `script` says otherwise, and answers what it observed once
 * the attempt has nothing left in flight.
 */
async function attempt(script: Script): Promise<Observed & { seams: Set<string> }> {
    const userId = randomUUID();
    const claim: BoardJob = {
        ...gatedJob(1),
        id: randomUUID(),
        leaseToken: randomUUID(),
        userId,
        workspacePath: `bellows/${userId}`,
        lastAttempt: script.lastAttempt ?? false,
        helperPlans: [
            { helperId: 'noop', phase: 'pre', input: null, githubWriting: false },
            { helperId: 'noop', phase: 'post', input: null, githubWriting: false },
        ],
    };
    const fingerprint = randomUUID();
    const scraped = randomUUID();
    const observed: Observed & { seams: Set<string> } = {
        timeline: [],
        logs: [],
        rejections: [],
        setup: [],
        seams: new Set(),
    };
    const { timeline, seams } = observed;
    const onRejection = (reason: unknown) => observed.rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
        const board = stubBoard([claim]);
        const { gates } = stubGateStack({}, { control: true });
        const runner = stubRunner(async () => (script.run ? script.run(scraped) : ok({ sessionId: scraped })), {
            sync: script.sync ?? { ok: true, reason: null, fingerprint },
            probeTree: randomUUID(),
        });
        let loop: Loop | null = null;
        const { boundary, fault } = script.at ?? { boundary: null, fault: null };
        const delivered = { done: false };

        // The heartbeat: the answer a delivered verdict fault swaps in, or a beat parked in flight.
        let answer: HeartbeatVerdict = HELD;
        let parked: { beat: Promise<HeartbeatVerdict>; release: (v: HeartbeatVerdict) => void } | null = null;
        let parkedBeat = false;
        const heartbeat = board.board.heartbeat.bind(board.board);
        board.board.heartbeat = async (j) => {
            if (board.board.beats === 0 && boundary === 'claim') {
                seams.add('claim');
                if (fault === 'handover') await handover();
                if (fault === 'stop' || fault === 'lost' || fault === 'removed') {
                    // The verdict is returned by the beat itself (A1): nothing to wait for inside it.
                    board.board.beats += 1;
                    answer = answerOf(fault);
                    delivered.done = true;
                    return answer;
                }
            }
            if (parked) {
                board.board.beats += 1;
                parkedBeat = true;
                const { beat } = parked;
                parked = null;
                return beat;
            }
            if (answer === HELD) return heartbeat(j);
            board.board.beats += 1;
            return answer;
        };

        const handover = async () => {
            loop?.stop();
            await loop?.handover('injected');
            delivered.done = true;
        };

        /** Delivers the cell's fault from inside the stub that hosts `at`; never throws. */
        const inject = async (at: Boundary): Promise<'throw' | null> => {
            seams.add(at);
            if (at !== boundary || delivered.done) return null;
            if (fault === 'exception') {
                delivered.done = true;
                return 'throw';
            }
            if (fault === 'handover') {
                await handover();
                return null;
            }
            if (fault === null) return null;
            answer = answerOf(fault);
            // Read after the swap: the beat that carries the verdict is one invoked from here on.
            const before = board.board.beats;
            if (!(await until(() => board.board.beats > before))) {
                observed.setup.push(`${at} fault never delivered`);
                return null;
            }
            await tick();
            delivered.done = true;
            return null;
        };
        const hosted = async (at: Boundary) => {
            if ((await inject(at)) === 'throw') throw new Error(`injected at ${at}`);
        };

        // The board's conclusions and teardown-relevant calls, recorded.
        const b = board.board;
        const claimOnce = b.claim.bind(b);
        let claims = 0;
        b.claim = recorded(timeline, 'board.claim', async (worker: string) => {
            claims += 1;
            if (claims === 1 && boundary === 'claim') {
                seams.add('claim');
                if (fault === 'exception') {
                    delivered.done = true;
                    throw new Error('injected at claim');
                }
            }
            return claimOnce(worker);
        });
        const stage = b.stageConclusion.bind(b);
        b.stageConclusion = recorded(
            timeline,
            'board.stageConclusion',
            async (j: BoardJob, result: Parameters<typeof stage>[1]) => {
                seams.add('stage');
                if (fault !== 'exception') await hosted('conclusion');
                return stage(j, result);
            }
        );
        const complete = b.complete.bind(b);
        b.complete = recorded(
            timeline,
            'board.complete',
            async (j: BoardJob, result: Parameters<typeof complete>[1]) => {
                seams.add('complete');
                if (boundary === 'conclusion' && fault === 'exception') {
                    seams.add('conclusion');
                    delivered.done = true;
                    throw new Error('injected at conclusion');
                }
                return complete(j, result);
            }
        );
        b.suspend = recorded(timeline, 'board.suspend', b.suspend.bind(b));
        b.requeue = recorded(timeline, 'board.requeue', b.requeue.bind(b));
        b.interrupt = recorded(
            timeline,
            (_j, interruption) => `board.interrupt(${interruption.release ? 'release' : 'record'})`,
            b.interrupt.bind(b)
        );
        const session = b.session.bind(b);
        b.session = recorded(timeline, 'board.session', async (j: BoardJob, id: string | null) => {
            if (id === scraped) {
                seams.add('scraped session');
                await hosted('run tail');
            }
            return session(j, id);
        });
        b.putArtifactChunk = recorded(timeline, 'board.artifact', b.putArtifactChunk.bind(b));
        b.finalizeArtifact = recorded(timeline, 'board.artifact', b.finalizeArtifact.bind(b));

        // The runner: every hosting seam, and the teardown it owns.
        const adopt = runner.adopt.bind(runner);
        runner.adopt = async (j, signal) => {
            await hosted('adopt');
            return adopt(j, signal);
        };
        const sync = runner.syncCheckout.bind(runner);
        runner.syncCheckout = async (j, signal, runSession, token) => {
            await hosted('sync');
            return sync(j, signal, runSession, token);
        };
        runner.runHelper = async (_j, plan): Promise<HelperResult> => {
            const at = plan.phase === 'pre' ? 'pre-helpers' : 'post-helpers';
            if (script.helperLost === plan.phase) {
                seams.add(at);
                if (script.stopInFlight) {
                    // The next beat is held in flight, and answers a stop only after the loss below.
                    let release: (v: HeartbeatVerdict) => void = () => {};
                    const beat = new Promise<HeartbeatVerdict>((resolve) => {
                        release = resolve;
                    });
                    parked = { beat, release };
                    if (!(await until(() => parkedBeat))) observed.setup.push(`${at}: no beat was in flight`);
                    setTimeout(() => release({ result: 'held', cancelRequested: true }), 0);
                }
                throw new StepChannelClosed(`the ${plan.phase}-run helper`);
            }
            await hosted(at);
            return { ok: true, output: null };
        };
        const startServices = runner.startServices.bind(runner);
        runner.startServices = async (j, signal) => {
            await hosted('services');
            return startServices(j, signal);
        };
        const run = runner.run;
        runner.run = async (j, runSession, onOutput) => {
            await hosted('run');
            return run(j, runSession, onOutput);
        };
        const probeTree = runner.probeTree.bind(runner);
        runner.probeTree = async (j, signal) => {
            await hosted('probe');
            return probeTree(j, signal);
        };
        const publishGit = runner.publishGit.bind(runner);
        runner.publishGit = async (j, token, options) => {
            await hosted('publish');
            return publishGit(j, token, options);
        };
        const finish = runner.finish.bind(runner);
        runner.finish = recorded(timeline, 'runner.finish', async (j: BoardJob) => {
            seams.add('finish');
            await hosted('settle');
            return finish(j);
        });
        runner.releaseServices = recorded(timeline, 'runner.releaseServices', runner.releaseServices.bind(runner));
        runner.kill = recorded(timeline, 'runner.kill', runner.kill.bind(runner));
        const stopAgent = runner.stopAgent;
        runner.stopAgent = recorded(timeline, 'runner.stopAgent', (j: BoardJob) => stopAgent(j));

        // The gate stack: the first acquire and gate host their boundaries; release and close are teardown.
        const { manager, server } = gates;
        const acquire = manager.acquire.bind(manager);
        let acquired = 0;
        manager.acquire = async (...args) => {
            acquired += 1;
            if (acquired === 1) await hosted('gate setup');
            return acquire(...args);
        };
        const runGate = manager.runGate.bind(manager);
        let ran = 0;
        manager.runGate = async (...args) => {
            ran += 1;
            if (ran === 1) await hosted('gates');
            return runGate(...args);
        };
        manager.release = recorded(timeline, 'gate.release', manager.release.bind(manager));
        server.closeControl = recorded(timeline, 'control.close', server.closeControl.bind(server));

        let capped: ReturnType<typeof setTimeout> | null = null;
        const stopped = await Promise.race([
            drive({
                board: b,
                attach: (l) => {
                    loop = l;
                    board.attach(l);
                },
                runner,
                gates,
                log: (line) => observed.logs.push(line),
            }).then(() => true),
            new Promise<false>((resolve) => {
                capped = setTimeout(() => resolve(false), CAP_MS);
            }),
        ]);
        if (capped) clearTimeout(capped);
        if (!stopped) {
            (loop as Loop | null)?.stop();
            observed.setup.push('the loop never stopped');
        }

        // After a handover `start()` resolves before the attempt ends: wait until nothing moves.
        let quiet = 0;
        let seen = timeline.length;
        const settled = await until(() => {
            quiet = timeline.length === seen ? quiet + 1 : 0;
            seen = timeline.length;
            return quiet >= QUIET_TICKS;
        });
        if (!settled) observed.setup.push('the attempt never settled');
        if (boundary !== null && !seams.has(boundary)) observed.setup.push(`${boundary} seam never reached`);
        if (boundary !== null && !delivered.done && !observed.setup.length) {
            observed.setup.push(`${boundary} fault never delivered`);
        }
        return observed;
    } finally {
        process.off('unhandledRejection', onRejection);
    }
}

/** What each cell is expected to end as, read from the code (the table in the plan). */
function expectedOf(boundary: Boundary, fault: Fault): Expected {
    if (CONCLUDING.includes(boundary)) return { conclusion: 'verdict', finishes: 1 };
    if (fault === 'stop') return { conclusion: 'suspend', finishes: 1 };
    if (fault === 'lost' || fault === 'removed') return { conclusion: 'none', finishes: 1 };
    if (fault === 'handover') return { conclusion: 'interrupt:release', finishes: 0 };
    switch (boundary) {
        case 'sync':
        case 'pre-helpers':
            return { conclusion: 'none', finishes: 1 };
        case 'services':
            return { conclusion: 'interrupt:release', finishes: 1 };
        case 'run':
        case 'post-helpers':
            return { conclusion: 'none', finishes: 0, retain: true };
        default:
            return { conclusion: 'verdict', finishes: 1 };
    }
}

/** One cell as a test. */
function cell(name: string, script: Script, expected: Expected): void {
    it(name, async () => {
        expect(violationsOf(await attempt(script), expected)).toEqual([]);
    });
}

describe('an attempt faulted at each phase boundary (#828)', () => {
    it('reaches every seam with no fault, and concludes once with a verdict', async () => {
        const run = await attempt({ at: null });
        for (const seam of [
            'adopt',
            'sync',
            'pre-helpers',
            'services',
            'gate setup',
            'run',
            'scraped session',
            'probe',
            'gates',
            'post-helpers',
            'publish',
            'stage',
            'complete',
            'finish',
        ]) {
            expect(run.seams, seam).toContain(seam);
        }
        expect(violationsOf(run, { conclusion: 'verdict', finishes: 1 })).toEqual([]);
    });

    for (const boundary of BOUNDARIES) {
        describe(`at ${boundary}`, () => {
            for (const fault of ['stop', 'lost', 'removed', 'handover', 'exception'] as const) {
                // Settlement quiesces the heartbeat before `runner.finish` (`loop-conclusion.ts:23-37`):
                // no beat is left to carry a stop, a loss or a removal there.
                if (boundary === 'settle' && fault !== 'handover' && fault !== 'exception') continue;
                cell(fault, { at: { boundary, fault } }, expectedOf(boundary, fault));
            }
        });
    }

    it('a finish that throws at settle is swallowed, and the control channel still closes after it', async () => {
        const { timeline } = await attempt({ at: { boundary: 'settle', fault: 'exception' } });
        expect(timeline.filter((entry) => entry === 'runner.finish')).toHaveLength(1);
        expect(timeline).toContain('runner.finish:threw');
        expect(timeline.indexOf('control.close')).toBeGreaterThan(timeline.indexOf('runner.finish:threw'));
    });

    describe('scripted endings', () => {
        cell(
            'a lock-blocked sync requeues',
            { at: null, sync: { ok: false, reason: 'transient worktree sync: the checkout lock is held' } },
            { conclusion: 'requeue', finishes: 1 }
        );
        cell(
            'a pre-helper whose supervisor was lost is interrupted',
            { at: null, helperLost: 'pre' },
            { conclusion: 'interrupt:release', finishes: 1 }
        );
        cell(
            'a post-helper whose supervisor was lost is interrupted',
            { at: null, helperLost: 'post' },
            { conclusion: 'interrupt:release', finishes: 1 }
        );
        cell(
            'a run the platform took away is interrupted',
            { at: null, run: async (scraped) => ok({ sessionId: scraped, infraLoss: 'the runner pod was evicted' }) },
            { conclusion: 'interrupt:release', finishes: 1 }
        );
        cell(
            'a run that never started is interrupted',
            { at: null, run: async () => ok({ started: false, exitCode: null, output: 'no container' }) },
            { conclusion: 'interrupt:release', finishes: 1 }
        );
        cell(
            'a last attempt whose run threw reports a failed verdict',
            {
                at: null,
                lastAttempt: true,
                run: async () => {
                    throw new Error('the daemon refused');
                },
            },
            { conclusion: 'verdict', finishes: 1 }
        );
    });

    // A stop beat still in flight when a helper's loss is interrupted: `end` memoises the first ending,
    // so the beat the quiesce awaits cannot park an attempt already interrupted.
    describe('a helper lost with a stop beat in flight', () => {
        for (const phase of ['pre', 'post'] as const) {
            cell(
                `${phase}-run`,
                { at: null, helperLost: phase, stopInFlight: true },
                { conclusion: 'interrupt:release', finishes: 1 }
            );
        }
    });
});
