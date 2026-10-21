import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { GATE_GID, GATE_UID, REVIEWER_TREE_PATH } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { applyCloseTimeReadout, tickCacheWatch } from '../src/docker-close-read.js';
import { CheckpointUnrestorable } from '../src/task-restore.js';
import { ensureTaskVolume, removeTaskVolumes, taskVolumeIsOurs } from '../src/docker-task-volume.js';
import { OPENCODE } from '../src/executors.js';
import { StartupRefused } from '../src/startup-cause.js';
import type { RunOutcome } from '../src/runner.js';
import {
    TASK_GENERATION_LABEL,
    TASK_MOUNT,
    TASK_ROOT_LABEL,
    taskInitScript,
    taskMountArgs,
    taskVolumeName,
} from '../src/task-volume.js';

const ROOT = '11111111-1111-4111-8111-111111111111';
const job = {
    id: '22222222-2222-4222-8222-222222222222',
    rootJobId: ROOT,
    executorType: 'claude-code',
    claimSeq: 1,
    followUp: false,
    resumeSessionId: null,
    workspacePath: 'acme/33333333-3333-4333-8333-333333333333',
} as BoardJob;
const config = loadDriverConfig({});
const NAME = `factory-task-${ROOT}-1`;
const OTHER_ROOT = '99999999-9999-4999-8999-999999999999';

/**
 * A daemon whose `volume inspect <name>` answers `volume`: a label map (the volume exists with
 * those labels), `null` (it exists unlabeled), 'absent' (docker's own `no such volume`), raw text,
 * or an Error. `volume ls` lists the thread's one first-generation volume unless it is 'absent' (empty
 * list) or an Error (the call fails), or `listed` names the volumes. Every call is recorded.
 */
const daemon = (volume: Record<string, string> | null | 'absent' | string | Error, listed: string[] | null = null) => {
    const calls: string[][] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const execDocker = async (args: string[], options?: { signal?: AbortSignal }) => {
        calls.push(args);
        signals.push(options?.signal);
        if (args[0] === 'volume' && args[1] === 'ls') {
            if (volume instanceof Error) throw volume;
            return { stdout: (listed ?? (volume === 'absent' ? [] : [NAME])).map((name) => `${name}\n`).join('') };
        }
        if (args[0] === 'volume' && args[1] === 'inspect') {
            if (volume instanceof Error) throw volume;
            if (volume === 'absent') throw new Error('Error response from daemon: get x: no such volume');
            return { stdout: typeof volume === 'string' ? volume : `${JSON.stringify(volume)}\n` };
        }
        return { stdout: '' };
    };
    return { calls, signals, deps: { config, execDocker } };
};
const OURS = { [TASK_ROOT_LABEL]: ROOT };
const creates = (calls: string[][]) => calls.filter((a) => a[0] === 'volume' && a[1] === 'create');

describe("the thread's docker task volume (issue #775)", () => {
    it('is named for the thread root, whichever job of the thread asks', () => {
        expect(taskVolumeName(job)).toBe(NAME);
        expect(taskVolumeName({ ...job, id: ROOT, rootJobId: null })).toBe(NAME);
    });

    it('is listed by its root label, then created with its labels when the thread has none', async () => {
        const d = daemon('absent');
        await ensureTaskVolume(d.deps, job);
        expect(d.calls[0]).toEqual([
            'volume',
            'ls',
            '--filter',
            `label=${TASK_ROOT_LABEL}=${ROOT}`,
            '--format',
            '{{.Name}}',
        ]);
        expect(creates(d.calls)).toHaveLength(1);
        const [create] = creates(d.calls);
        expect(create).toEqual(expect.arrayContaining(['--label', `${TASK_ROOT_LABEL}=${ROOT}`]));
        expect(create).toEqual(expect.arrayContaining(['--label', `${TASK_GENERATION_LABEL}=1`]));
        expect(create!.at(-1)).toBe(NAME);
    });

    it('is adopted, not created again, when the thread already has it', async () => {
        const d = daemon(OURS);
        await ensureTaskVolume(d.deps, job);
        expect(creates(d.calls)).toEqual([]);
        // The listing and the label check, then the root init of the volume root: no reviewer, so no second init.
        expect(d.calls.map((a) => (a[0] === 'volume' ? a[1] : a[0]))).toEqual(['ls', 'inspect', 'run']);
    });

    it.each([[null], [{ [TASK_ROOT_LABEL]: '99999999-9999-4999-8999-999999999999' }], [{ other: 'x' }]])(
        'is refused, never mounted or recreated, when a volume of its name carries labels %j',
        async (labels) => {
            const d = daemon(labels);
            await expect(ensureTaskVolume(d.deps, { ...job, reviewerProfiles: ['security'] })).rejects.toThrow(
                /not labelled as the task volume/
            );
            expect(creates(d.calls)).toEqual([]);
            expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
        }
    );

    it('is never created on a failed listing: the refusal throws and nothing else is asked', async () => {
        const d = daemon(new Error('Cannot connect to the Docker daemon'));
        await expect(ensureTaskVolume(d.deps, job)).rejects.toThrow(/Cannot connect to the Docker daemon/);
        expect(d.calls).toHaveLength(1);
    });

    it('is never created on an inspect that is not a label map', async () => {
        const d = daemon('<html>proxy error</html>\n');
        await expect(ensureTaskVolume(d.deps, job)).rejects.toThrow(/not the listing/);
        expect(creates(d.calls)).toEqual([]);
    });

    it.each([['<html>proxy error</html>\n'], [`factory-task-${OTHER_ROOT}-1\n`], [`${NAME}-x\n`]])(
        'is never created, nor restored, on a listing that is not a list of its generations: %j',
        async (raw) => {
            const calls: string[][] = [];
            const execDocker = async (args: string[]) => {
                calls.push(args);
                return { stdout: raw };
            };
            const checkpoint = vi.fn();
            await expect(
                ensureTaskVolume({ config, execDocker, checkpoints: { checkpoint } }, { ...job, followUp: true })
            ).rejects.toThrow();
            expect(creates(calls)).toEqual([]);
            expect(checkpoint).not.toHaveBeenCalled();
        }
    );

    it('is never asked for by an aborted attempt: the daemon sees no create', async () => {
        const d = daemon('absent');
        const controller = new AbortController();
        controller.abort();
        await expect(ensureTaskVolume(d.deps, job, controller.signal)).rejects.toThrow();
        expect(creates(d.calls)).toEqual([]);
    });

    it('is judged by whether a mount may use it: taskVolumeIsOurs answers false for absent and unlabeled', async () => {
        expect(await taskVolumeIsOurs(daemon(OURS).deps.execDocker, job)).toBe(true);
        expect(await taskVolumeIsOurs(daemon('absent').deps.execDocker, job)).toBe(false);
        expect(await taskVolumeIsOurs(daemon(null).deps.execDocker, job)).toBe(false);
        expect(await taskVolumeIsOurs(daemon(new Error('boom')).deps.execDocker, job)).toBe(false);
    });

    it('is not named for a thread root that is no uuid: the daemon is never asked', async () => {
        const d = daemon('absent');
        await expect(ensureTaskVolume(d.deps, { ...job, rootJobId: '../../etc' })).rejects.toThrow(/not a uuid/);
        expect(d.calls).toEqual([]);
    });

    it('never deletes a volume', async () => {
        const d = daemon(OURS);
        await ensureTaskVolume(d.deps, { ...job, reviewerProfiles: ['security'] });
        expect(d.calls.some((a) => a.includes('rm') || a.includes('prune'))).toBe(false);
    });

    it('hands the volume root to the task group with a root init before anything mounts it, as fsGroup does', async () => {
        for (const state of ['absent', OURS] as const) {
            const d = daemon(state);
            await ensureTaskVolume(d.deps, job);
            const runs = d.calls.filter((a) => a[0] === 'run');
            expect(runs).toHaveLength(1);
            const [run] = runs;
            expect(run).toEqual(expect.arrayContaining(['--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN']));
            // The image's own /task (uid 1000) is copied up into the empty volume, so root does not
            // own the directory it hands over: chmod needs FOWNER, and keeping the setgid bit while
            // root is outside the group needs FSETID (a real daemon answers EPERM / drops 2000 otherwise).
            expect(run).toEqual(expect.arrayContaining(['--cap-add', 'FOWNER', '--cap-add', 'FSETID']));
            expect(run).toEqual(expect.arrayContaining(['--rm', ...taskMountArgs(job)]));
            expect(run).toEqual(expect.arrayContaining(['-c', taskInitScript, 'init', TASK_MOUNT, String(GATE_GID)]));
            // Last: after the inspect and any create, so the init mounts a labelled volume and never makes one.
            expect(d.calls.findIndex((a) => a[0] === 'run')).toBe(d.calls.length - 1);
        }
    });

    it('makes the reviewer home with a second hardened throwaway container, as the task user, when the thread reviews', async () => {
        const d = daemon(OURS);
        await ensureTaskVolume(d.deps, { ...job, reviewerProfiles: ['security'] });
        const runs = d.calls.filter((a) => a[0] === 'run');
        expect(runs).toHaveLength(2);
        const run = runs[1]!;
        expect(run).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--rm', ...taskMountArgs(job)]));
        expect(run).toEqual(expect.arrayContaining(['--user', `${GATE_UID}:${GATE_GID}`]));
        expect(run).toEqual(expect.arrayContaining(['-c', taskInitScript, 'init', REVIEWER_TREE_PATH]));
    });

    it("hands the attempt's signal to both init containers, so a stood-down attempt stops waiting on them", async () => {
        const d = daemon(OURS);
        const signal = new AbortController().signal;
        await ensureTaskVolume(d.deps, { ...job, reviewerProfiles: ['security'] }, signal);
        const runs = d.calls.flatMap((a, i) => (a[0] === 'run' ? [d.signals[i]] : []));
        expect(runs).toEqual([signal, signal]);
    });

    // The init containers run the executor image before the group does: a refusal of that image is the
    // same typed startup refusal the group start answers (a configuration fault), never a raw error.
    it.each([
        ['the root init', [] as string[]],
        ['the reviewer-home init', ['security']],
    ])('types a refused executor image in %s as a startup refusal', async (_n, reviewerProfiles) => {
        const runs: string[][] = [];
        const refusal = Object.assign(new Error('Command failed: docker run'), {
            stderr: "docker: invalid reference format.\nSee 'docker run --help'.\n",
        });
        const execDocker = async (args: string[]) => {
            if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: `${JSON.stringify(OURS)}\n` };
            if (args[0] === 'run') {
                runs.push(args);
                if (runs.length > (reviewerProfiles.length > 0 ? 1 : 0)) throw refusal;
            }
            return { stdout: '' };
        };
        const error = await ensureTaskVolume({ config, execDocker }, { ...job, reviewerProfiles }).catch(
            (e: unknown) => e
        );
        expect(error).toBeInstanceOf(StartupRefused);
        expect(error).toMatchObject({ startupCause: 'image' });
        expect((error as Error).message).toMatch(/invalid reference format/);
    });
});

const POINTER = { bytes: 10, truncated: false, chunks: [{ offset: 0, length: 10, sha256: 'a'.repeat(64) }] };
const continuing = { ...job, followUp: true } as BoardJob;

describe("the thread's docker task volume across generations (issue #775)", () => {
    const board = (
        read: Awaited<ReturnType<NonNullable<Parameters<typeof ensureTaskVolume>[0]['checkpoints']>['checkpoint']>>
    ) => ({
        checkpoint: vi.fn(async () => read),
    });

    it('restores into generation n+1 when no volume is listed: the next volume is created, labelled and owed a restore', async () => {
        const d = daemon('absent');
        const checkpoints = board({ state: 'found', checkpoint: POINTER });
        const restoring = { ...continuing } as BoardJob;

        await ensureTaskVolume({ ...d.deps, checkpoints }, restoring);

        const [create] = creates(d.calls);
        expect(create!.at(-1)).toBe(`factory-task-${ROOT}-2`);
        expect(create).toEqual(expect.arrayContaining(['--label', `${TASK_GENERATION_LABEL}=2`]));
        expect(restoring.taskGeneration).toBe(2);
        expect(restoring.taskRestore).toEqual({ checkpoint: POINTER, older: [], restored: false });
        expect(taskMountArgs(restoring)[1]).toContain(`src=factory-task-${ROOT}-2,`);
    });

    it('adopts the highest generation listed and owes it the older ones to delete after a restore', async () => {
        const d = daemon(OURS, [NAME, `factory-task-${ROOT}-3`]);
        const checkpoints = board({ state: 'found', checkpoint: POINTER });
        const adopting = { ...continuing } as BoardJob;

        await ensureTaskVolume({ ...d.deps, checkpoints }, adopting);

        expect(creates(d.calls)).toEqual([]);
        expect(adopting.taskGeneration).toBe(3);
        expect(adopting.taskRestore).toEqual({ checkpoint: POINTER, older: [1], restored: false });
        expect(d.calls.find((a) => a[1] === 'inspect')!.at(-1)).toBe(`factory-task-${ROOT}-3`);
    });

    it('fails checkpoint_unrestorable, creating nothing, for a follow-up whose volume is gone and whose checkpoint is none, gone or truncated', async () => {
        for (const read of [
            { state: 'none' },
            { state: 'gone' },
            { state: 'found', checkpoint: { ...POINTER, truncated: true } },
        ] as const) {
            const d = daemon('absent');
            await expect(ensureTaskVolume({ ...d.deps, checkpoints: board(read) }, continuing)).rejects.toBeInstanceOf(
                CheckpointUnrestorable
            );
            expect(creates(d.calls)).toEqual([]);
        }
    });

    it('starts a thread fresh on its first claim even when the board holds no checkpoint: generation 1, no board read', async () => {
        const d = daemon('absent');
        const checkpoints = board({ state: 'none' });
        const first = { ...job } as BoardJob;

        await ensureTaskVolume({ ...d.deps, checkpoints }, first);

        expect(creates(d.calls)[0]!.at(-1)).toBe(NAME);
        expect(first.taskRestore).toBeUndefined();
        expect(checkpoints.checkpoint).not.toHaveBeenCalled();
    });

    it('removes an older generation by name and treats one already gone as removed', async () => {
        const calls: string[][] = [];
        const execDocker = async (args: string[]) => {
            calls.push(args);
            if (args.at(-1)?.endsWith('-2')) throw new Error('Error response from daemon: no such volume');
            return { stdout: '' };
        };
        await removeTaskVolumes(execDocker, job, [1, 2]);
        expect(calls).toEqual([
            ['volume', 'rm', `factory-task-${ROOT}-1`],
            ['volume', 'rm', `factory-task-${ROOT}-2`],
        ]);
    });
});

describe('the close-time readouts and the task volume (issue #775)', () => {
    const noVolume = () => {
        const calls: string[][] = [];
        const execDocker = async (args: string[]) => {
            calls.push(args);
            if (args[1] === 'inspect') throw new Error('Error response from daemon: no such volume');
            return { stdout: '{"id":"ses_1"}\n' };
        };
        return { calls, ctx: { execDocker, config, job, startedAt: new Date().toISOString() } };
    };
    const readouts = (calls: string[][]) => calls.filter((a) => a[0] === 'run');

    it('run no opencode readout container where the thread has no labelled volume', async () => {
        const d = noVolume();
        const outcome = await applyCloseTimeReadout(
            { exitCode: 0 } as RunOutcome,
            { ...d.ctx, job: { ...job, executorType: OPENCODE } as BoardJob },
            null
        );
        expect(readouts(d.calls)).toEqual([]);
        expect(outcome.readoutError).toMatch(/task volume/);
    });

    it('run no claude turn readout where the thread has no labelled volume', async () => {
        const d = noVolume();
        await applyCloseTimeReadout(
            { exitCode: 0 } as RunOutcome,
            { ...d.ctx, job: { ...job, executorType: 'claude-code' } as BoardJob },
            { id: '44444444-4444-4444-8444-444444444444', resume: false }
        );
        expect(readouts(d.calls)).toEqual([]);
    });

    it('run no cache probe where the thread has no labelled volume', async () => {
        const d = noVolume();
        await tickCacheWatch({ ...d.ctx, kill: async () => undefined }, { cacheLost: null });
        expect(readouts(d.calls)).toEqual([]);
    });
});
