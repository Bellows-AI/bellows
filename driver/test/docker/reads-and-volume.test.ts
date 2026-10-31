import { describe, expect, it } from 'vitest';
import type { Board, BoardJob, ReviewClaim } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { TASK_ROOT_LABEL } from '../../src/task-volume.js';
import { createDockerRunner } from '../../src/docker/docker-runner.js';
import { untilStandDown } from '../../src/docker/docker-runner-support.js';
import { gateName, reviewerName } from '../../src/docker/docker-group.js';
import { supervisorName } from '../../src/docker/docker-mailbox.js';
import {
    idLines,
    listOtherAttemptsOrThrow,
    nameLines,
    readDocker,
    tabRows,
} from '../../src/docker/docker-runner-support.js';
import { job, ok, fakeSteps, spawnChild, dockerRunner } from '../fixtures/docker-suite.js';

describe('readDocker and its listing parsers (#869)', () => {
    const answering = (stdout: string) => async (): Promise<{ stdout: string }> => ({ stdout });
    const refusing =
        (stderr: string, extra: object = {}) =>
        async (): Promise<{ stdout: string }> => {
            throw Object.assign(new Error('Command failed'), { stderr, ...extra });
        };
    const read = <T>(
        exec: () => Promise<{ stdout: string }>,
        parse: (stdout: string) => T | null,
        absentOn?: readonly string[]
    ) => readDocker(exec, ['volume', 'inspect', 'x'], 'reading x', { parse, ...(absentOn ? { absentOn } : {}) });

    it('reads a refused exec as inconclusive, never as an empty list', async () => {
        const got = await read(refusing('Error response from daemon: 503'), nameLines);
        expect(got).toEqual({ kind: 'inconclusive', reason: 'reading x: Command failed' });
    });

    it('reads a timed-out exec as inconclusive', async () => {
        const got = await read(refusing('', { killed: true, signal: 'SIGTERM' }), nameLines);
        expect(got.kind).toBe('inconclusive');
    });

    it('reads the daemon\'s own "no such volume" as absent only for a kind it was told to expect', async () => {
        const gone = refusing('Error: No such volume: x');
        expect(await read(gone, nameLines, ['volume'])).toEqual({ kind: 'absent' });
        expect((await read(gone, nameLines)).kind).toBe('inconclusive');
        expect((await read(refusing('Error: No such container: x'), nameLines, ['volume'])).kind).toBe('inconclusive');
    });

    it('reads an answer that is no listing as inconclusive', async () => {
        const html = '<html><body>502 Bad Gateway</body></html>';
        expect((await read(answering(html), nameLines)).kind).toBe('inconclusive');
        expect((await read(answering(html), idLines)).kind).toBe('inconclusive');
    });

    it('reads an empty answer as the empty list', async () => {
        expect(await read(answering(''), nameLines)).toEqual({ kind: 'value', value: [] });
        expect(await read(answering('\n'), idLines)).toEqual({ kind: 'value', value: [] });
    });

    it('reads names and ids line by line', async () => {
        expect(await read(answering('factory-a\nfactory_b.c\n'), nameLines)).toEqual({
            kind: 'value',
            value: ['factory-a', 'factory_b.c'],
        });
        expect(await read(answering('0123456789ab\n' + 'f'.repeat(64) + '\n'), idLines)).toEqual({
            kind: 'value',
            value: ['0123456789ab', 'f'.repeat(64)],
        });
    });

    it.each(['null', 'agent-id', '0123456789a', '0123456789AB', `${'f'.repeat(65)}`, '0123456789ab extra'])(
        'refuses %s as a container id, so it is never a kill or rm target',
        (line) => {
            expect(idLines(`0123456789ab\n${line}\n`)).toBeNull();
        }
    );

    it.each(['-leading', 'a b', '<html>', '{"x":1}', 'a,b'])('refuses %s as a name', (line) => {
        expect(nameLines(`ok\n${line}\n`)).toBeNull();
    });

    it('reads tab rows of exactly the asked fields, an empty label included', async () => {
        const two = tabRows(2);
        expect(await read(answering('alpha\tlease-1\nbeta\t\n'), two)).toEqual({
            kind: 'value',
            value: [
                ['alpha', 'lease-1'],
                ['beta', ''],
            ],
        });
        expect((await read(answering('alpha\n'), two)).kind).toBe('inconclusive');
        expect((await read(answering('alpha\tb\tc\n'), two)).kind).toBe('inconclusive');
        expect((await read(answering('<html>\t502\n'), two)).kind).toBe('inconclusive');
    });

    // #869: the lease is what decides a row is "another attempt's", and so a delete target.
    describe('the fence listings', () => {
        const OLD = 'aaaaaaaa-1111-4111-8111-111111111111';
        const KEPT = { leaseToken: 'bbbbbbbb-2222-4222-8222-222222222222', grammar: /^[0-9a-f]{12,64}$/ };
        const list = (stdout: string) => listOtherAttemptsOrThrow(async () => ({ stdout }), ['ps'], 'listing', KEPT);

        it('names the rows of other attempts by their lease', async () => {
            expect(await list(`abcdef123456\t${OLD}\nabcdef123457\t${KEPT.leaseToken}\n`)).toEqual(['abcdef123456']);
        });

        it.each([
            ['a lease that is no lease', 'abcdef123456\tcorrupt\n'],
            ['an empty lease', 'abcdef123456\t\n'],
            ['a good row beside a corrupt one', `abcdef123456\t${OLD}\nabcdef123457\tcorrupt\n`],
        ])('reads %s as no listing, never as an attempt to delete', async (_name, stdout) => {
            await expect(list(stdout)).rejects.toThrow(/listing/);
        });
    });

    it('reads a tab row whose first field is not of the asked grammar as inconclusive', () => {
        expect(tabRows(2, /^[0-9a-f]{12,64}$/)('null\tlease\n')).toBeNull();
    });
});

// Issue #773: a gate is a step of the attempt's group, whose gate container runs it. Until the
// docker group shares one network namespace, the gate container joins the attempt's services
// network before a gate runs, once per attempt, so a gate reaches the services by name.
describe('the docker runner and the gates', () => {
    const gated: BoardJob = {
        ...job,
        repo: 'Bellows-AI/bellows',
        gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
    };
    const gate = {
        command: 'npm test',
        cwd: `/task/bellows`,
        env: {},
        timeoutMs: 1000,
    };
    const recording = () => {
        const calls: string[][] = [];
        const exec = (async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        return { calls, exec };
    };

    // Issue #773: the gate container shares its supervisor's namespace from its create, so the
    // declared services are on its loopback with no network to join.
    it('runs a gate as a step of a group it makes on demand, in its supervisor’s namespace, joining no network', async () => {
        const daemon = recording();
        const supervised = fakeSteps(() => ok('passed'));
        const runner = dockerRunner(daemon.exec, { steps: supervised.sink });

        expect(await runner.runGate(gated, gate)).toEqual(ok('passed'));
        await runner.runGate(gated, gate);

        expect(supervised.ofKind('gate')).toHaveLength(2);
        expect(supervised.ofKind('gate')[0]).toMatchObject({ argv: ['npm test'], cwd: gate.cwd });
        const created = daemon.calls.filter((args) => args[0] === 'create');
        const gateCreate = created.find((args) => args[args.indexOf('--name') + 1] === gateName(gated));
        expect(gateCreate?.[gateCreate.indexOf('--network') + 1]).toBe(`container:${supervisorName(gated)}`);
        expect(daemon.calls.some((args) => args[0] === 'network')).toBe(false);
    });

    // Issue #774: a review is steps of the CALLER's group — the reviewer's home, its restored
    // worktree, the executor in the reviewer container — made on demand like a gate's.
    it('runs a review as steps of the caller’s group, made on demand, with the reviewer container in it', async () => {
        const daemon = recording();
        const supervised = fakeSteps((step) => (step.kind === 'review' ? ok() : ok('{"ok":true,"reason":null}')));
        const runner = dockerRunner(daemon.exec, { steps: supervised.sink });
        const caller: BoardJob = { ...job, repo: 'Bellows-AI/bellows', reviewerProfiles: ['security'] };
        const review = {
            ...caller,
            id: '66666666-6666-4666-8666-666666666666',
            rootJobId: caller.id,
            reviewRun: { profile: 'security', ref: `refs/factory/review/${caller.id}/sec-1`, timeoutMinutes: 5 },
        } as unknown as ReviewClaim;

        expect(await runner.runReview(caller, review, { id: 'sess-1', resume: false })).toEqual(ok());

        expect(supervised.ofKind('review')).toHaveLength(1);
        expect(supervised.steps().map((step) => step.kind)).toEqual(['sync', 'sync', 'review']);
        const created = daemon.calls.filter((args) => args[0] === 'create');
        expect(created.map((args) => args[args.indexOf('--name') + 1])).toContain(reviewerName(caller));
        expect(supervised.submitted.every((entry) => entry.token === supervised.submitted[0]!.token)).toBe(true);
    });

    it('resizes nothing: the reviewer container keeps its RUNNER_* sizing, as the gate container its GATE_*', async () => {
        const daemon = recording();
        const runner = dockerRunner(daemon.exec, { env: { RUNNER_SERVICES: '0' }, steps: fakeSteps().sink });
        expect(await runner.resizeReviewer({ ...job, reviewerProfiles: ['security'] }, 'run')).toBe(false);
        expect(daemon.calls).toEqual([]);
    });

    it('resizes nothing: the gate container keeps its GATE_* sizing', async () => {
        const daemon = recording();
        const runner = dockerRunner(daemon.exec, { env: { RUNNER_SERVICES: '0' }, steps: fakeSteps().sink });
        expect(await runner.resizeGate(gated, 'verify')).toBe(false);
        expect(daemon.calls).toEqual([]);
    });
});

describe('untilStandDown', () => {
    it('hands its signal into the exec already in flight, so the stand-down kills it', async () => {
        const controller = new AbortController();
        let seen: AbortSignal | undefined;
        const exec = untilStandDown(async (_args, options) => {
            seen = options?.signal;
            return { stdout: '' };
        }, controller.signal);

        await exec(['ps']);
        expect(seen?.aborted).toBe(false);
        controller.abort();

        expect(seen?.aborted).toBe(true);
        await expect(exec(['ps'])).rejects.toThrow(/abandoned/);
    });

    it('keeps a signal the call brought as well', async () => {
        const own = new AbortController();
        let seen: AbortSignal | undefined;
        const exec = untilStandDown(async (_args, options) => {
            seen = options?.signal;
            return { stdout: '' };
        }, new AbortController().signal);

        await exec(['ps'], { signal: own.signal, timeout: 5 });
        own.abort();

        expect(seen?.aborted).toBe(true);
    });
});

/*
 * Restoring a thread's task tree (issue #775): a continuing claim whose volume is gone is rebuilt from
 * the board's checkpoint onto the next generation by a supervised `restore` step that runs before the
 * sync step; the generation it replaces is removed only after that step reports ok.
 */
describe('the docker runner restoring a task volume', () => {
    const ROOT_ID = '77777777-7777-4777-8777-777777777777';
    const restoreJob = (over: Partial<BoardJob> = {}): BoardJob => ({
        ...job,
        repo: 'acme/widgets',
        rootJobId: ROOT_ID,
        followUp: true,
        env: { GITHUB_TOKEN: 'claim-token' },
        ...over,
    });
    const named = (generation: number) => `factory-task-${ROOT_ID}-${generation}`;
    const POINTER = {
        state: 'found' as const,
        checkpoint: { bytes: 4, truncated: false, chunks: [{ offset: 0, length: 4, sha256: 'c'.repeat(64) }] },
    };
    /** A daemon listing `volumes` for the thread; every other verb answers nothing. */
    const daemon = (volumes: number[]) => {
        const calls: string[][] = [];
        const exec = (async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'volume' && args[1] === 'ls' && args[3]?.startsWith(`label=${TASK_ROOT_LABEL}=`)) {
                return { stdout: volumes.map((g) => `${named(g)}\n`).join('') };
            }
            if (args[0] === 'volume' && args[1] === 'inspect') {
                return { stdout: JSON.stringify({ [TASK_ROOT_LABEL]: ROOT_ID }) };
            }
            return { stdout: args[0] === 'wait' ? '0\n' : '' };
        }) as unknown as Parameters<typeof createDockerRunner>[2];
        return { calls, exec };
    };
    const runner = (volumes: number[], steps: ReturnType<typeof fakeSteps>, checkpoints: Pick<Board, 'checkpoint'>) => {
        const d = daemon(volumes);
        return {
            d,
            runner: createDockerRunner(loadDriverConfig({}), spawnChild('', '', 0), d.exec, {
                steps: steps.sink,
                sleep: async () => {},
                checkpoints,
            }),
        };
    };
    const restoreStep = (steps: ReturnType<typeof fakeSteps>) =>
        steps.submitted.find((s) => s.step.id.endsWith('-restore'));
    const taskCreates = (calls: string[][]) =>
        calls
            .filter((a) => a[0] === 'volume' && a[1] === 'create')
            .flatMap((a) => a.filter((x) => x.startsWith('factory-task-')));
    const removes = (calls: string[][]) => calls.filter((a) => a[0] === 'volume' && a[1] === 'rm').map((a) => a[2]);

    it('creates the next generation, restores onto it before the sync step, and removes the old one after ok', async () => {
        const steps = fakeSteps(() => ok('{"ok":true,"reason":null}'));
        const { d, runner: r } = runner([], steps, { checkpoint: async () => POINTER });
        const j = restoreJob();
        const result = await r.syncCheckout(j, undefined, null, 'ghs_x');
        expect(result).toEqual({ ok: true, reason: null });
        expect(j.taskGeneration).toBe(2);
        expect(taskCreates(d.calls)).toEqual([named(2)]);
        const ids = steps.submitted.map((s) => s.step.id);
        expect(ids[0]).toMatch(/-restore$/);
        expect(ids).toHaveLength(2);
        expect(restoreStep(steps)?.step.env).toMatchObject({ RESTORE_FEED: '1' });
        expect(steps.submitted[1]?.step.env).toMatchObject({ RESTORE: '1' });
    });

    it('keeps the older generation when the restore step fails, and fails the sync with its reason', async () => {
        const steps = fakeSteps((step) =>
            step.id.endsWith('-restore')
                ? ok('{"ok":false,"reason":"bundle unreadable"}')
                : ok('{"ok":true,"reason":null}')
        );
        const { d, runner: r } = runner([1, 2], steps, { checkpoint: async () => POINTER });
        const result = await r.syncCheckout(restoreJob(), undefined, null, 'ghs_x');
        expect(result).toMatchObject({ ok: false });
        expect(result.reason).toContain('bundle unreadable');
        expect(removes(d.calls)).toEqual([]);
        // The sync step never ran on the half-restored volume.
        expect(steps.submitted).toHaveLength(1);
    });

    it('removes the older generation once the restore of an adopted restored volume reports ok', async () => {
        const steps = fakeSteps(() => ok('{"ok":true,"reason":null}'));
        const { d, runner: r } = runner([1, 2], steps, { checkpoint: async () => POINTER });
        await r.syncCheckout(restoreJob(), undefined, null, 'ghs_x');
        expect(removes(d.calls)).toEqual([named(1)]);
    });

    it.each([
        ['none', { state: 'none' as const }],
        ['gone', { state: 'gone' as const }],
        ['truncated', { state: 'found' as const, checkpoint: { bytes: 1, truncated: true, chunks: [] } }],
    ])('ends a follow-up with checkpoint_unrestorable on a %s checkpoint and no volume', async (_n, read) => {
        const steps = fakeSteps();
        const { d, runner: r } = runner([], steps, { checkpoint: async () => read });
        const result = await r.syncCheckout(restoreJob(), undefined, null, 'ghs_x');
        expect(result).toMatchObject({ ok: false, kind: 'checkpoint_unrestorable' });
        expect(steps.submitted).toEqual([]);
        expect(taskCreates(d.calls)).toEqual([]);
    });

    it('starts a first claim on generation 1 with a fresh clone and no restore', async () => {
        const steps = fakeSteps(() => ok('{"ok":true,"reason":null}'));
        const { runner: r } = runner([], steps, { checkpoint: async () => ({ state: 'none' as const }) });
        const j = restoreJob({ followUp: false });
        await r.syncCheckout(j, undefined, null, 'ghs_x');
        expect(j.taskGeneration).toBe(1);
        expect(restoreStep(steps)).toBeUndefined();
    });

    describe('a repo-free continuing claim and its task inputs', () => {
        const FILE = {
            id: '66666666-6666-4666-8666-666666666666',
            name: 'brief.pdf',
            mediaType: 'application/pdf',
            size: 3,
            sha256: 'e'.repeat(64),
            originJobId: ROOT_ID,
        };
        const repoFree = (over: Partial<BoardJob> = {}): BoardJob =>
            ({ ...restoreJob(over), repo: undefined }) as unknown as BoardJob;
        const names = (steps: ReturnType<typeof fakeSteps>) =>
            steps.submitted.map((s) => s.step.id.replace(/^sync-[0-9a-f]+-/, ''));
        const NONE = { checkpoint: async () => ({ state: 'none' as const }) };

        it('rebuilds the Claude session on the new generation before release, with no attachments', async () => {
            const steps = fakeSteps(() => ok('{"ok":true,"reason":null}'));
            const { d, runner: r } = runner([], steps, NONE);
            const j = repoFree();
            expect(await r.syncCheckout(j, undefined, null)).toEqual({ ok: true, reason: null });
            expect(j.taskGeneration).toBe(2);
            expect(taskCreates(d.calls)).toEqual([named(2)]);
            expect(names(steps)).toEqual(['restore']);
            expect(restoreStep(steps)?.step.env).toMatchObject({ RESTORE_FEED: '1' });
            expect(restoreStep(steps)?.step.env).not.toHaveProperty('CHECKOUT');
        });

        it('then writes the inputs, in that order, when the claim carries attachments', async () => {
            const steps = fakeSteps(() => ok('{"ok":true,"reason":null}'));
            const { runner: r } = runner([], steps, NONE);
            expect(await r.syncCheckout(repoFree({ attachments: [FILE] }), undefined, null)).toEqual({
                ok: true,
                reason: null,
            });
            expect(names(steps)).toEqual(['restore', 'inputs']);
            expect(steps.submitted[1]?.step.env).toMatchObject({ INPUT_FEED: '1', INPUT_DELIVERY: 'task' });
            expect(JSON.parse(steps.submitted[1]?.step.env.MANIFEST ?? '')).toEqual([FILE]);
        });

        it('delivers the inputs of a first repo-free claim and starts nothing without attachments', async () => {
            const withFiles = fakeSteps(() => ok('{"ok":true,"reason":null}'));
            await runner([], withFiles, NONE).runner.syncCheckout(
                repoFree({ followUp: false, attachments: [FILE] }),
                undefined,
                null
            );
            expect(names(withFiles)).toEqual(['inputs']);
            const bare = fakeSteps(() => ok('{"ok":true,"reason":null}'));
            await runner([], bare, NONE).runner.syncCheckout(repoFree({ followUp: false }), undefined, null);
            expect(names(bare)).toEqual([]);
        });

        it('never reaches the inputs step past a failed restore', async () => {
            const steps = fakeSteps((step) =>
                ok(step.id.endsWith('-restore') ? '{"ok":false,"reason":"no transcripts"}' : '{"ok":true}')
            );
            const result = await runner([], steps, NONE).runner.syncCheckout(
                repoFree({ attachments: [FILE] }),
                undefined,
                null
            );
            expect(result).toMatchObject({ ok: false });
            expect(names(steps)).toEqual(['restore']);
        });

        it('ends attachment_unavailable on a definitive refusal and throws on a transient one', async () => {
            const refused = fakeSteps((step) =>
                ok(
                    step.id.endsWith('-inputs')
                        ? '{"ok":false,"reason":"gone","kind":"attachment_unavailable"}'
                        : '{"ok":true,"reason":null}'
                )
            );
            expect(
                await runner([1], refused, NONE).runner.syncCheckout(
                    restoreJob({ attachments: [FILE] }),
                    undefined,
                    null,
                    'ghs_x'
                )
            ).toMatchObject({ ok: false, kind: 'attachment_unavailable' });
            const transient = fakeSteps((step) =>
                ok(
                    step.id.endsWith('-inputs')
                        ? '{"ok":false,"reason":"503","transient":true}'
                        : '{"ok":true,"reason":null}'
                )
            );
            await expect(
                runner([1], transient, NONE).runner.syncCheckout(
                    restoreJob({ attachments: [FILE] }),
                    undefined,
                    null,
                    'ghs_x'
                )
            ).rejects.toThrow();
        });

        it.each([[true], [false]])(
            'returns the checkout sync result, fingerprint and conflicts, with attachments %s',
            async (withFiles) => {
                const synced = '{"ok":true,"reason":null,"fingerprint":"fp-1","conflicts":["a.txt"]}';
                const steps = fakeSteps((step) => ok(step.id.endsWith('-inputs') ? '{"ok":true}' : synced));
                const result = await runner([1], steps, NONE).runner.syncCheckout(
                    restoreJob({ followUp: false, ...(withFiles ? { attachments: [FILE] } : {}) }),
                    undefined,
                    null,
                    'ghs_x'
                );
                expect(result).toMatchObject({ ok: true, fingerprint: 'fp-1', conflicts: ['a.txt'] });
                expect(names(steps).includes('inputs')).toBe(withFiles);
            }
        );

        it('delivers the inputs of a repo job after its sync step, and again on a retry', async () => {
            const steps = fakeSteps(() => ok('{"ok":true,"reason":null}'));
            await runner([1], steps, NONE).runner.syncCheckout(
                restoreJob({ followUp: false, claimSeq: 2, attachments: [FILE] }),
                undefined,
                null,
                'ghs_x'
            );
            expect(names(steps)).toEqual(['1', 'inputs']);
        });
    });
});
