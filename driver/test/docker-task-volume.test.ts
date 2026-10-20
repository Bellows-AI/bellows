import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { REVIEWER_TREE_PATH } from '../src/claim.js';
import { loadDriverConfig } from '../src/config.js';
import { ensureTaskVolume } from '../src/docker-task-volume.js';
import {
    TASK_GENERATION_LABEL,
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

/** A daemon that answers `volume ls` with `listing` (or throws it) and records every call. */
const daemon = (listing: string | Error) => {
    const calls: string[][] = [];
    const execDocker = async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'volume' && args[1] === 'ls') {
            if (listing instanceof Error) throw listing;
            return { stdout: listing };
        }
        return { stdout: '' };
    };
    return { calls, deps: { config, execDocker } };
};
const creates = (calls: string[][]) => calls.filter((a) => a[0] === 'volume' && a[1] === 'create');

describe("the thread's docker task volume (issue #775)", () => {
    it('is named for the thread root, whichever job of the thread asks', () => {
        expect(taskVolumeName(job)).toBe(NAME);
        expect(taskVolumeName({ ...job, id: ROOT, rootJobId: null })).toBe(NAME);
    });

    it('is listed by its root label, then created with its labels when the thread has none', async () => {
        const d = daemon('');
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
        const d = daemon(`${NAME}\n`);
        await ensureTaskVolume(d.deps, job);
        expect(creates(d.calls)).toEqual([]);
        // Nothing but the listing: no reviewer, so no init container either.
        expect(d.calls).toHaveLength(1);
    });

    it('is never created on a failed listing: the refusal throws and nothing else is asked', async () => {
        const d = daemon(new Error('Cannot connect to the Docker daemon'));
        await expect(ensureTaskVolume(d.deps, job)).rejects.toThrow(/Cannot connect to the Docker daemon/);
        expect(d.calls).toHaveLength(1);
        expect(creates(d.calls)).toEqual([]);
    });

    it('is never created on a listing that is not a list of names', async () => {
        const d = daemon('<html>proxy error</html>\n');
        await expect(ensureTaskVolume(d.deps, job)).rejects.toThrow(/not the listing/);
        expect(creates(d.calls)).toEqual([]);
    });

    it('is not named for a thread root that is no uuid: the daemon is never asked', async () => {
        const d = daemon('');
        await expect(ensureTaskVolume(d.deps, { ...job, rootJobId: '../../etc' })).rejects.toThrow(/not a uuid/);
        expect(d.calls).toEqual([]);
    });

    it('never deletes a volume', async () => {
        const d = daemon(`${NAME}\n`);
        await ensureTaskVolume(d.deps, { ...job, reviewerProfiles: ['security'] });
        expect(d.calls.some((a) => a.includes('rm') || a.includes('prune'))).toBe(false);
    });

    it('makes the reviewer home with one hardened throwaway container when the thread reviews', async () => {
        const d = daemon(`${NAME}\n`);
        await ensureTaskVolume(d.deps, { ...job, reviewerProfiles: ['security'] });
        const runs = d.calls.filter((a) => a[0] === 'run');
        expect(runs).toHaveLength(1);
        const [run] = runs;
        expect(run).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--rm', ...taskMountArgs(job)]));
        expect(run).toEqual(expect.arrayContaining(['-c', taskInitScript, 'init', REVIEWER_TREE_PATH]));
    });

    it.each([[undefined], [[]]])('starts no init container for reviewerProfiles %j', async (reviewerProfiles) => {
        const d = daemon('');
        await ensureTaskVolume(d.deps, { ...job, reviewerProfiles } as BoardJob);
        expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
    });
});
