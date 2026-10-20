import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { GATE_GID, GATE_UID, REVIEWER_TREE_PATH } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { applyCloseTimeReadout, tickCacheWatch } from '../src/docker-close-read.js';
import { ensureTaskVolume, taskVolumeIsOurs } from '../src/docker-task-volume.js';
import { OPENCODE } from '../src/executors.js';
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
    workspacePath: 'acme/33333333-3333-4333-8333-333333333333',
} as BoardJob;
const config = loadDriverConfig({});
const NAME = `factory-task-${ROOT}-1`;

/**
 * A daemon whose `volume inspect <name>` answers `volume`: a label map (the volume exists with
 * those labels), `null` (it exists unlabeled), 'absent' (docker's own `no such volume`), raw text,
 * or an Error. Every call is recorded.
 */
const daemon = (volume: Record<string, string> | null | 'absent' | string | Error) => {
    const calls: string[][] = [];
    const execDocker = async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'volume' && args[1] === 'inspect') {
            if (volume instanceof Error) throw volume;
            if (volume === 'absent') throw new Error('Error response from daemon: get x: no such volume');
            return { stdout: typeof volume === 'string' ? volume : `${JSON.stringify(volume)}\n` };
        }
        return { stdout: '' };
    };
    return { calls, deps: { config, execDocker } };
};
const OURS = { [TASK_ROOT_LABEL]: ROOT };
const creates = (calls: string[][]) => calls.filter((a) => a[0] === 'volume' && a[1] === 'create');

describe("the thread's docker task volume (issue #775)", () => {
    it('is named for the thread root, whichever job of the thread asks', () => {
        expect(taskVolumeName(job)).toBe(NAME);
        expect(taskVolumeName({ ...job, id: ROOT, rootJobId: null })).toBe(NAME);
    });

    it('is inspected by name, then created with its labels when the thread has none', async () => {
        const d = daemon('absent');
        await ensureTaskVolume(d.deps, job);
        expect(d.calls[0]).toEqual(['volume', 'inspect', '--format', '{{json .Labels}}', NAME]);
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
        // The inspect, then the root init of the volume root: no reviewer, so no second init.
        expect(d.calls.map((a) => a[0])).toEqual(['volume', 'run']);
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

    it('is never created on a failed inspect: the refusal throws and nothing else is asked', async () => {
        const d = daemon(new Error('Cannot connect to the Docker daemon'));
        await expect(ensureTaskVolume(d.deps, job)).rejects.toThrow(/Cannot connect to the Docker daemon/);
        expect(d.calls).toHaveLength(1);
    });

    it('is never created on an inspect that is not a label map', async () => {
        const d = daemon('<html>proxy error</html>\n');
        await expect(ensureTaskVolume(d.deps, job)).rejects.toThrow(/not the listing/);
        expect(creates(d.calls)).toEqual([]);
    });

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
