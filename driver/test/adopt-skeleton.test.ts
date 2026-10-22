import { describe, expect, it } from 'vitest';
import { type AdoptPrimitives, adoptEarlierRun, type EarlierRun } from '../src/adopt-skeleton.js';
import { AdoptionBlocked, commandMark, Inconclusive, type RunOutcome, type AdoptedRun } from '../src/runner.js';
import type { EndEvidence } from '../src/termination.js';
import { boardJob } from './fixtures/board-job.js';

const job = boardJob({ claimSeq: 5 });
const MARK = commandMark(job.command);

interface Earlier extends EarlierRun {
    name: string;
}

const earlier = (claimSeq: number, over: Partial<Earlier> = {}): Earlier => ({
    name: `run-${claimSeq}`,
    prior: { ...job, leaseToken: `lease-${claimSeq}` },
    claimSeq,
    commandMark: MARK,
    session: null,
    ...over,
});

const cleanEnd: EndEvidence = {
    kills: [],
    driverKilledHard: false,
    report: null,
    budgetEnded: false,
    vanished: null,
    unfinalized: null,
};

interface Fake {
    steps: string[];
    p: AdoptPrimitives<Earlier>;
}

/** Fake primitives that log each step; `over` replaces one primitive to throw, answer null or abort. */
function fake(listed: Earlier[], over: Partial<AdoptPrimitives<Earlier>> = {}): Fake {
    const steps: string[] = [];
    const p: AdoptPrimitives<Earlier> = {
        list: async () => {
            steps.push('list');
            return listed;
        },
        begin: async () => void steps.push('begin'),
        awaitEnd: async (found) => {
            steps.push('awaitEnd');
            return found;
        },
        read: async () => {
            steps.push('read');
            return {
                end: cleanEnd,
                body: async () => {
                    steps.push('body');
                    return { exitCode: 0, output: 'out', fullLog: 'log', logTruncated: false, startedAt: 't0' };
                },
            };
        },
        confirmOwnership: async () => void steps.push('confirmOwnership'),
        closeReadout: async () => void steps.push('closeReadout'),
        recordKey: (found) => found.name,
        sweep: async () => void steps.push('sweep'),
        rollback: async () => void steps.push('rollback'),
        adoptLive: () => () => void steps.push('unlive'),
        ...over,
    };
    return { steps, p };
}

describe('adoptEarlierRun', () => {
    it('adopts the newest earlier run of the same command, in step order, ownership before the record and sweep', async () => {
        const adopted = new Map<string, string>();
        const { steps, p } = fake([earlier(1), earlier(3), earlier(2)], {
            sweep: async () => {
                steps.push(`sweep:${adopted.get(job.leaseToken)}`);
            },
        });
        const run = await adoptEarlierRun(p, adopted, job);
        expect(run?.claimSeq).toBe(3);
        expect((run as AdoptedRun | null)?.outcome).toMatchObject({
            exitCode: 0,
            output: 'out',
            fullLog: 'log',
            timedOut: false,
            started: true,
        });
        expect(steps).toEqual([
            'list',
            'begin',
            'awaitEnd',
            'read',
            'body',
            'closeReadout',
            'confirmOwnership',
            'sweep:run-3',
        ]);
        expect(adopted.get(job.leaseToken)).toBe('run-3');
    });

    it('skips runs of this claim or a later one, and of another command', async () => {
        const { steps, p } = fake([
            earlier(5),
            earlier(6),
            earlier(4, { commandMark: 'someone-elses-command' }),
            earlier(2),
        ]);
        expect((await adoptEarlierRun(p, new Map(), job))?.claimSeq).toBe(2);
        expect(steps[0]).toBe('list');
    });

    it('is null, touching nothing, when no earlier run qualifies', async () => {
        const { steps, p } = fake([earlier(5), earlier(4, { commandMark: undefined })]);
        expect(await adoptEarlierRun(p, new Map(), job)).toBeNull();
        expect(steps).toEqual(['list']);
    });

    it('falls to the next candidate the executor does not admit', async () => {
        const { p } = fake([earlier(4), earlier(3)], { admit: async (f) => (f.claimSeq === 4 ? null : f) });
        expect((await adoptEarlierRun(p, new Map(), job))?.claimSeq).toBe(3);
    });

    it('takes the session of the earlier run when the close-time readout found none', async () => {
        const { p } = fake([earlier(2, { session: 'sess-2' })]);
        expect(((await adoptEarlierRun(p, new Map(), job)) as AdoptedRun | null)?.outcome.sessionId).toBe('sess-2');
    });

    it('keeps the session the close-time readout found', async () => {
        const { p } = fake([earlier(2, { session: 'sess-2' })], {
            closeReadout: async (outcome: RunOutcome) => {
                outcome.sessionId = 'sess-read';
            },
        });
        expect(((await adoptEarlierRun(p, new Map(), job)) as AdoptedRun | null)?.outcome.sessionId).toBe('sess-read');
    });

    describe('a run that is gone', () => {
        it('keeps the adoption error when the rollback itself rejects', async () => {
            const { p } = fake([earlier(2)], {
                confirmOwnership: async () => {
                    throw new AdoptionBlocked('the claim moved');
                },
                rollback: async () => {
                    throw new Error('rollback refused');
                },
            });
            await expect(adoptEarlierRun(p, new Map(), job)).rejects.toThrow('the claim moved');
        });

        it('rolls back once when a give-back rollback rejects', async () => {
            let rollbacks = 0;
            const { p } = fake([earlier(2)], {
                awaitEnd: async () => null,
                rollback: async () => {
                    rollbacks += 1;
                    throw new Error('rollback refused');
                },
            });
            await expect(adoptEarlierRun(p, new Map(), job)).rejects.toThrow('rollback refused');
            expect(rollbacks).toBe(1);
        });

        it('rolls back and answers null when awaitEnd finds nothing', async () => {
            const adopted = new Map<string, string>();
            const { steps, p } = fake([earlier(2)], { awaitEnd: async () => null });
            expect(await adoptEarlierRun(p, adopted, job)).toBeNull();
            expect(steps).toEqual(['list', 'begin', 'rollback']);
            expect(adopted.size).toBe(0);
        });

        it('rolls back and answers null on an infrastructure loss, never reading the body', async () => {
            const { steps, p } = fake([earlier(2)], {
                read: async () => ({
                    end: { ...cleanEnd, unfinalized: 'the supervisor was killed' },
                    body: async () => {
                        steps.push('body');
                        throw new Error('read the body of a lost run');
                    },
                }),
            });
            expect(await adoptEarlierRun(p, new Map(), job)).toBeNull();
            expect(steps).toEqual(['list', 'begin', 'awaitEnd', 'rollback']);
        });

        it('classifies the end through settleEnd: a recorded timeout reads as timed out', async () => {
            const { p } = fake([earlier(2)], {
                read: async () => ({
                    end: { ...cleanEnd, kills: [{ reason: 'timeout', detail: 'budget' }] },
                    body: async () => ({
                        exitCode: 124,
                        output: '',
                        fullLog: '',
                        logTruncated: false,
                        startedAt: 't0',
                    }),
                }),
            });
            expect(((await adoptEarlierRun(p, new Map(), job)) as AdoptedRun | null)?.outcome.timedOut).toBe(true);
        });
    });

    describe('abort', () => {
        it('before begin: nothing is taken, but the (idempotent) rollback runs and the abort is rethrown', async () => {
            const abort = new AbortController();
            abort.abort();
            const { steps, p } = fake([earlier(2)]);
            await expect(adoptEarlierRun(p, new Map(), job, abort.signal)).rejects.toThrow(/abandoned/);
            expect(steps).toEqual(['list', 'rollback']);
        });

        it('while the run is waited for and read: nothing is recorded or swept', async () => {
            const abort = new AbortController();
            const adopted = new Map<string, string>();
            const { steps, p } = fake([earlier(2)], {
                closeReadout: async () => {
                    steps.push('closeReadout');
                    abort.abort();
                },
            });
            await expect(adoptEarlierRun(p, adopted, job, abort.signal)).rejects.toThrow(/abandoned/);
            expect(steps).not.toContain('confirmOwnership');
            expect(steps).not.toContain('sweep');
            expect(steps.at(-1)).toBe('rollback');
            expect(adopted.size).toBe(0);
        });

        it('while the sweep runs: the abort is rethrown as it is, unwrapped, and the record is dropped', async () => {
            const abort = new AbortController();
            const adopted = new Map<string, string>();
            const { p } = fake([earlier(2)], {
                sweep: async () => {
                    abort.abort();
                    throw new Error('sweep died');
                },
            });
            await expect(adoptEarlierRun(p, adopted, job, abort.signal)).rejects.toThrow('sweep died');
            expect(adopted.size).toBe(0);
        });

        it('while the listing is paced: the retry pause is cut short', async () => {
            const abort = new AbortController();
            let tries = 0;
            const { p } = fake([], {
                pacing: {
                    attempts: 3,
                    retryMs: 5,
                    sleep: async () => {
                        abort.abort();
                    },
                },
                list: async () => {
                    tries += 1;
                    throw new Error('daemon refused');
                },
            });
            await expect(adoptEarlierRun(p, new Map(), job, abort.signal)).rejects.toThrow(/abandoned/);
            expect(tries).toBe(1);
        });
    });

    describe('a throw after an earlier run was found', () => {
        it('rolls back, drops the record and stands the attempt down, wrapping a plain error', async () => {
            const adopted = new Map<string, string>([[job.leaseToken, 'stale']]);
            const { steps, p } = fake([earlier(2)], {
                sweep: async () => {
                    throw new Error('delete refused');
                },
            });
            const failure = await adoptEarlierRun(p, adopted, job).catch((e: unknown) => e);
            expect(failure).toBeInstanceOf(AdoptionBlocked);
            expect((failure as Error).message).toBe('the earlier run could not be adopted: delete refused');
            expect(steps.at(-1)).toBe('rollback');
            expect(adopted.has(job.leaseToken)).toBe(false);
        });

        it('rethrows an AdoptionBlocked unwrapped', async () => {
            const blocked = new AdoptionBlocked('the claim was taken over');
            const { p } = fake([earlier(2)], {
                confirmOwnership: async () => {
                    throw blocked;
                },
            });
            await expect(adoptEarlierRun(p, new Map(), job)).rejects.toBe(blocked);
        });

        it('maps an unproven read to AdoptionBlocked with its own message', async () => {
            const { p } = fake([earlier(2)], {
                read: async () => {
                    throw new Inconclusive('the report log was not served');
                },
            });
            const failure = await adoptEarlierRun(p, new Map(), job).catch((e: unknown) => e);
            expect(failure).toBeInstanceOf(AdoptionBlocked);
            expect((failure as Error).message).toBe('the report log was not served');
        });

        it('does not record the run when ownership is lost: the confirmation precedes the record', async () => {
            const adopted = new Map<string, string>();
            const { steps, p } = fake([earlier(2)], {
                confirmOwnership: async () => {
                    throw new AdoptionBlocked('the checkout claim was taken over');
                },
            });
            await expect(adoptEarlierRun(p, adopted, job)).rejects.toThrow(AdoptionBlocked);
            expect(steps).not.toContain('sweep');
            expect(adopted.size).toBe(0);
        });
    });

    describe('a listing that fails', () => {
        it('stands the attempt down with AdoptionBlocked, never as "no earlier run", and takes no claim', async () => {
            const { steps, p } = fake([], {
                list: async () => {
                    throw new Error('daemon refused');
                },
            });
            const failure = await adoptEarlierRun(p, new Map(), job).catch((e: unknown) => e);
            expect(failure).toBeInstanceOf(AdoptionBlocked);
            expect((failure as Error).message).toBe('the earlier runners could not be read: daemon refused');
            expect(steps).toEqual([]);
        });

        it('maps an Inconclusive listing to AdoptionBlocked', async () => {
            const { p } = fake([], {
                list: async () => {
                    throw new Inconclusive('the listing proved nothing');
                },
            });
            await expect(adoptEarlierRun(p, new Map(), job)).rejects.toThrow(AdoptionBlocked);
        });

        it('contains a candidate the executor cannot admit', async () => {
            const { p } = fake([earlier(2)], {
                admit: async () => {
                    throw new Error('pods unreadable');
                },
            });
            await expect(adoptEarlierRun(p, new Map(), job)).rejects.toThrow(AdoptionBlocked);
        });

        it('is tried again, paced, up to the executor attempts, then stands down', async () => {
            let tries = 0;
            const pauses: number[] = [];
            const { p } = fake([], {
                pacing: {
                    attempts: 3,
                    retryMs: 2000,
                    sleep: async (ms) => {
                        pauses.push(ms);
                    },
                },
                list: async () => {
                    tries += 1;
                    throw new Error('daemon refused');
                },
            });
            await expect(adoptEarlierRun(p, new Map(), job)).rejects.toThrow(AdoptionBlocked);
            expect(tries).toBe(3);
            expect(pauses).toEqual([2000, 2000]);
        });

        it('adopts when a retry is answered', async () => {
            let tries = 0;
            const { p } = fake([], {
                pacing: { attempts: 3, retryMs: 1, sleep: async () => undefined },
                list: async () => {
                    tries += 1;
                    if (tries < 2) throw new Error('daemon refused');
                    return [earlier(2)];
                },
            });
            expect((await adoptEarlierRun(p, new Map(), job))?.claimSeq).toBe(2);
        });
    });
});
