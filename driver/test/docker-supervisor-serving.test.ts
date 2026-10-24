/**
 * `Runner.supervisorServing` on docker (#928): whether a prior group's supervisor can still pick up a rebind.
 * Only a container the daemon says exited or no longer exists, or a log carrying the served line, is an end;
 * every read that fails to say so is inconclusive. The read-fault rows cannot go red on the code before the
 * member existed: they pin the unconfirmed-read rule.
 */
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { supervisorServing } from '../src/docker/docker-group-probe.js';
import type { ExecDocker } from '../src/docker/docker-runner-support.js';
import { SUPERVISOR_SERVED_LINE } from '../src/supervisor-contract.js';

const group = {
    id: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
} as BoardJob;
const bound = (signal?: AbortSignal) => ({ deadline: Date.now() + 60_000, ...(signal && { signal }) });

type Answer = { stdout: string } | Error;
const state = (running: unknown) => ({ stdout: JSON.stringify({ Running: running }) });
const failed = (stderr: string) => Object.assign(new Error('Command failed'), { stderr });

function daemon(inspect: Answer, logs: Answer = { stdout: '' }) {
    const calls: string[][] = [];
    const exec: ExecDocker = async (args) => {
        calls.push(args);
        const answer = args[0] === 'inspect' ? inspect : logs;
        if (answer instanceof Error) throw answer;
        return answer;
    };
    return { exec, calls };
}

describe('docker supervisorServing (#928)', () => {
    it('answers true for a running supervisor whose log has no served line', async () => {
        const { exec } = daemon(state(true), { stdout: 'supervisor: serving\n' });
        expect(await supervisorServing(exec, group, bound())).toEqual({ kind: 'value', value: true });
    });

    it.each([
        ['it exited', state(false), { stdout: '' }],
        ['its log carries the served line', state(true), { stdout: `x\n${SUPERVISOR_SERVED_LINE}\n` }],
    ] as [string, Answer, Answer][])('answers false once %s', async (_name, inspect, logs) => {
        expect(await supervisorServing(daemon(inspect, logs).exec, group, bound())).toEqual({
            kind: 'value',
            value: false,
        });
    });

    it.each([
        ['container', 'Error: No such container: factory-supervisor-x'],
        ['object', 'Error: No such object: factory-supervisor-x'],
    ])('answers absent for a %s the daemon says does not exist', async (_name, stderr) => {
        expect(await supervisorServing(daemon(failed(stderr)).exec, group, bound())).toEqual({ kind: 'absent' });
    });

    it.each([
        ['the inspect fails', failed('Cannot connect to the Docker daemon')],
        ['the inspect times out', new Error('timed out')],
        ['the inspect is not JSON', { stdout: 'nope' }],
        ['the inspect says nothing of Running', { stdout: '{}' }],
        ['the inspect is null', { stdout: 'null' }],
    ] as [string, Answer][])('is inconclusive, never an end, when %s', async (_name, inspect) => {
        expect(await supervisorServing(daemon(inspect).exec, group, bound())).toMatchObject({ kind: 'inconclusive' });
    });

    it('is inconclusive when the log read of a running supervisor fails', async () => {
        const { exec } = daemon(state(true), failed('Cannot connect to the Docker daemon'));
        expect(await supervisorServing(exec, group, bound())).toMatchObject({ kind: 'inconclusive' });
    });

    it('is inconclusive, without a daemon call, once the stand-down has fired', async () => {
        const { exec, calls } = daemon(state(false));
        const stop = new AbortController();
        stop.abort();

        expect(await supervisorServing(exec, group, bound(stop.signal))).toMatchObject({ kind: 'inconclusive' });
        expect(calls).toEqual([]);
    });
});
