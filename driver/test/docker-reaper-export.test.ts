import { describe, expect, it, vi } from 'vitest';
import { loadDriverConfig } from '../src/config.js';
import { containerHardeningArgs } from '../src/docker/docker.js';
import { createDockerReaper } from '../src/docker/docker-reaper.js';
import type { ExecDocker } from '../src/docker/docker-runner-support.js';
import { claudeExportScript } from '../src/container-scripts.js';
import type { VolumeExportChannel, VolumeExportProof } from '../src/loop/loop-export.js';
import type { VolumeThread } from '../src/reaper.js';

/**
 * The docker arm of the reaper's export-before-delete (issue #938): the one-shot exporter container over
 * the thread's newest task volume. The daemon seam is the injected `ExecDocker`, so the test is a router
 * over argv that records what the arm asked the daemon for.
 */

const BOARD = 'b0a4d00000000001';
const ROOT = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = { jobId: '22222222-2222-4222-8222-222222222222', claimSeq: 3 };
const NAME = `factory-export-${ROOT}`;
const config = loadDriverConfig({ RUNNER_NETWORK: 'factory-ai_default' });
const thread: VolumeThread = {
    root: ROOT,
    volumes: [{ name: `factory-task-${ROOT}-1` }, { name: `factory-task-${ROOT}-2` }],
};

const refusal = (message: string, extra: object = {}): Error => Object.assign(new Error(message), extra);

interface World {
    /** Overrides per verb: a function answering the call, or an Error to throw. */
    on?: Partial<Record<'volume' | 'create' | 'start' | 'wait' | 'inspect' | 'rm', (args: string[]) => unknown>>;
    proof?: VolumeExportProof;
    channel?: null | 'throws';
    drainMs?: number;
}

/** The arm over a scripted daemon: `wait` blocks until the call's own kill, as a container that never ends. */
const scene = (world: World = {}) => {
    const calls: string[][] = [];
    const close = vi.fn();
    const channel: VolumeExportChannel = {
        url: 'http://host.docker.internal:9/control',
        token: 'export-token',
        proof: () => world.proof ?? { drained: true },
        close,
    };
    const execDocker: ExecDocker = async (args, options) => {
        calls.push([...args]);
        const verb = args[0] === 'volume' ? 'volume' : (args[0] as keyof NonNullable<World['on']>);
        const answer = world.on?.[verb]?.(args);
        if (answer instanceof Error) throw answer;
        if (answer !== undefined) return { stdout: String(answer) };
        if (verb === 'wait') {
            return new Promise((_resolve, reject) => {
                const timer = setTimeout(() => reject(refusal('timed out', { killed: true })), options?.timeout ?? 1e9);
                options?.signal?.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(refusal('aborted', { killed: true }));
                });
            });
        }
        if (verb === 'inspect') return { stdout: 'exited' };
        return { stdout: '' };
    };
    const arm = createDockerReaper(execDocker, BOARD, {
        config,
        open: async () => {
            if (world.channel === 'throws') throw new Error('listen failed');
            return world.channel === null ? null : channel;
        },
        drainMs: world.drainMs ?? 600,
    });
    return { arm, calls, close, channel, controller: new AbortController() };
};

const removals = (calls: string[][]): string[][] => calls.filter((call) => call[0] === 'rm');
const WAITS = { wait: () => '0' };

describe('the docker arm: exporting a thread’s volume before its delete (#938)', () => {
    it('runs the exporter over the newest volume with the live runners’ hardening, labels and the script by content', async () => {
        const { arm, calls, controller } = scene({ on: WAITS });
        await arm.exportVolume!(thread, ATTEMPT, controller.signal);
        const create = calls.find((call) => call[0] === 'create')!;
        expect(create.slice(0, 1 + containerHardeningArgs().length)).toEqual(['create', ...containerHardeningArgs()]);
        expect(create).toEqual(
            expect.arrayContaining([
                '--name',
                NAME,
                `factory.board=${BOARD}`,
                `factory.volume-export=${ROOT}`,
                `type=volume,src=factory-task-${ROOT}-2,target=/task`,
                '--entrypoint',
                'node',
                config.executorImages['claude-code'],
            ])
        );
        expect(create.join(' ')).not.toMatch(/factory\.(job|lease|role)=/);
        expect(create.join(' ')).not.toContain(`factory-task-${ROOT}-1`);
        expect(create).toEqual(expect.arrayContaining(['--network', 'factory-ai_default']));
        expect(create.slice(-2)).toEqual(['-e', claudeExportScript]);
        const envs = create.flatMap((arg, at) => (create[at - 1] === '-e' ? [arg] : []));
        expect(envs).toEqual(
            expect.arrayContaining([
                `CLAUDE_TRANSCRIPT_DIR=/task/.factory/transcripts/${ROOT}`,
                'EXPORT_ONCE=partial',
                'EXPORT_ONCE_CAUSE=reaper_export',
                'BELLOWS_CONTROL_URL=http://host.docker.internal:9/control',
                'BELLOWS_CONTROL_TOKEN=export-token',
            ])
        );
        const giveUps = envs.filter((entry) => /^EXPORT_(DRAIN_)?GIVEUP_MS=/.test(entry));
        expect(giveUps).toHaveLength(2);
        for (const entry of giveUps) expect(Number(entry.split('=')[1])).toBeLessThan(600);
    });

    it('is drained when the relay proved it, and removes the container and closes the channel once', async () => {
        const { arm, calls, close, controller } = scene({ on: WAITS });
        await expect(arm.exportVolume!(thread, ATTEMPT, controller.signal)).resolves.toEqual({ result: 'drained' });
        expect(removals(calls)).toEqual([['rm', '-f', NAME]]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('is inconclusive, never drained, when the exporter exited without the relay’s proof', async () => {
        const { arm, calls, close, controller } = scene({
            on: WAITS,
            proof: { drained: false, why: 'a chunk was refused' },
        });
        const result = await arm.exportVolume!(thread, ATTEMPT, controller.signal);
        expect(result).toEqual({ result: 'inconclusive', why: expect.stringContaining('a chunk was refused') });
        expect(removals(calls)).toHaveLength(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('is never_started when the daemon refuses the create, and still removes the name once', async () => {
        const { arm, calls, close, controller } = scene({ on: { create: () => refusal('pull access denied') } });
        const result = await arm.exportVolume!(thread, ATTEMPT, controller.signal);
        expect(result.result).toBe('never_started');
        expect(calls.some((call) => call[0] === 'start')).toBe(false);
        expect(removals(calls)).toEqual([['rm', '-f', NAME]]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('is never_started when the daemon refuses the start', async () => {
        const { arm, calls, controller } = scene({ on: { start: () => refusal('cannot start') } });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('never_started');
        expect(removals(calls)).toHaveLength(1);
    });

    it('is never_started with no control endpoint, or one that fails to open, and runs nothing', async () => {
        for (const channel of [null, 'throws'] as const) {
            const { arm, calls, controller } = scene({ channel });
            expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('never_started');
            expect(calls.some((call) => call[0] === 'create')).toBe(false);
        }
    });

    it('kills and removes the container once when the deadline passes, and is inconclusive', async () => {
        const { arm, calls, close, controller } = scene({ drainMs: 300 });
        const started = Date.now();
        const result = await arm.exportVolume!(thread, ATTEMPT, controller.signal);
        expect(result.result).toBe('inconclusive');
        expect(Date.now() - started).toBeLessThan(1500);
        expect(removals(calls)).toEqual([['rm', '-f', NAME]]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('kills and removes the container once when the reaper stops', async () => {
        const { arm, calls, close, controller } = scene({ drainMs: 5000 });
        const pending = arm.exportVolume!(thread, ATTEMPT, controller.signal);
        await vi.waitFor(() => expect(calls.some((call) => call[0] === 'wait')).toBe(true));
        controller.abort();
        await pending;
        expect(removals(calls)).toEqual([['rm', '-f', NAME]]);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('is inconclusive when the finished container cannot be inspected', async () => {
        const { arm, controller } = scene({ on: { ...WAITS, inspect: () => refusal('daemon unavailable') } });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
    });

    it('is inconclusive when the container is not in a finished state', async () => {
        const { arm, controller } = scene({ on: { ...WAITS, inspect: () => 'running' } });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
    });

    it('skips a volume the daemon says is gone, and keeps one it could not read', async () => {
        const gone = scene({ on: { volume: () => refusal('Error: No such volume: x') } });
        await expect(gone.arm.exportVolume!(thread, ATTEMPT, gone.controller.signal)).resolves.toEqual({
            result: 'drained',
        });
        expect(gone.calls.some((call) => call[0] === 'create')).toBe(false);
        const failed = scene({ on: { volume: () => refusal('daemon unavailable') } });
        const result = await failed.arm.exportVolume!(thread, ATTEMPT, failed.controller.signal);
        expect(result.result).toBe('inconclusive');
        expect(failed.calls.some((call) => call[0] === 'create')).toBe(false);
    });

    it('clears a stale container under the name and is inconclusive this round', async () => {
        const { arm, calls, controller } = scene({
            on: { create: () => refusal(`Conflict. The container name "/${NAME}" is already in use`) },
        });
        expect((await arm.exportVolume!(thread, ATTEMPT, controller.signal)).result).toBe('inconclusive');
        expect(removals(calls)).toEqual([['rm', '-f', NAME]]);
    });

    it('is invisible to the group scan: no job, lease or role label', async () => {
        const row = JSON.stringify({
            ID: 'abcdef012345',
            Names: NAME,
            Labels: `factory.board=${BOARD},factory.volume-export=${ROOT}`,
            CreatedAt: '2026-01-01 00:00:00 +0000 UTC',
            State: 'exited',
        });
        const execDocker: ExecDocker = async (args) => ({ stdout: args[0] === 'ps' ? row : '' });
        const groups = await createDockerReaper(execDocker, BOARD).scan();
        expect(groups).toEqual([]);
    });
});
