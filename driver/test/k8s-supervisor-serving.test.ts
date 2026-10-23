/**
 * `Runner.supervisorServing` on kubernetes (#928): whether a prior group's supervisor can still pick up a
 * rebind. Only a confirmed end (Job gone, pod over, supervisor terminated, the served line) is an answer
 * of "no"; every read that fails to say so is inconclusive. The read-fault rows cannot go red on the code
 * before the member existed: they pin the unconfirmed-read rule.
 */
import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import { jobPath } from '../src/k8s/k8s-auxspec.js';
import { supervisorServing } from '../src/k8s/k8s-adopt.js';
import { runnerName } from '../src/k8s/k8s-podspec.js';
import type { K8sDeps, K8sResponse } from '../src/k8s/k8s-transport.js';
import { AGENT_CONTAINER, SUPERVISOR_CONTAINER, SUPERVISOR_SERVED_LINE } from '../src/supervisor-contract.js';

const NS = 'factory';
const prior = {
    id: '11111111-1111-4111-8111-111111111111',
    leaseToken: '22222222-2222-4222-8222-222222222222',
} as BoardJob;
const JOB_PATH = jobPath(NS, runnerName(prior));
const bound = (signal?: AbortSignal) => ({ deadline: Date.now() + 60_000, ...(signal && { signal }) });

const jobBody = JSON.stringify({ metadata: { uid: 'uid-1' }, status: {} });
const podsOf = (phase: string, supervisor: object | undefined) =>
    JSON.stringify({
        items: [
            {
                metadata: { name: 'runner-pod' },
                status: {
                    phase,
                    containerStatuses: [
                        { name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } },
                        ...(supervisor ? [{ name: SUPERVISOR_CONTAINER, state: supervisor }] : []),
                    ],
                },
            },
        ],
    });

type Answer = K8sResponse | Error;
interface Script {
    job?: Answer;
    pods?: Answer;
    log?: Answer;
}
const ok = (body: string): K8sResponse => ({ status: 200, body });

function world({ job = ok(jobBody), pods = ok(podsOf('Running', { running: {} })), log = ok('') }: Script) {
    const calls: { path: string; signal: AbortSignal | undefined; timeoutMs: number | undefined }[] = [];
    const deps: K8sDeps = {
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NS }),
        sleep: async () => {},
        request: async (_method, path, _body, options) => {
            calls.push({ path, signal: options?.signal, timeoutMs: options?.timeoutMs });
            const answer = path === JOB_PATH ? job : path.includes('/log') ? log : pods;
            if (answer instanceof Error) throw answer;
            return answer;
        },
    };
    return { deps, calls };
}

const read = (script: Script, signal?: AbortSignal) => supervisorServing(world(script).deps, prior, bound(signal));

describe('kubernetes supervisorServing (#928)', () => {
    it('answers true for a running supervisor whose log has no served line', async () => {
        expect(await read({ log: ok('supervisor: serving\n') })).toEqual({ kind: 'value', value: true });
    });

    it.each([
        ['the served line is logged', { log: ok(`supervisor: serving\n${SUPERVISOR_SERVED_LINE}\n`) }],
        ['its supervisor container terminated', { pods: ok(podsOf('Running', { terminated: { exitCode: 0 } })) }],
        ['its pod succeeded', { pods: ok(podsOf('Succeeded', undefined)) }],
        ['its pod failed', { pods: ok(podsOf('Failed', { running: {} })) }],
    ] as [string, Script][])('answers false once %s', async (_name, script) => {
        expect(await read(script)).toEqual({ kind: 'value', value: false });
    });

    it('answers absent for a Job the apiserver confirms gone', async () => {
        expect(await read({ job: { status: 404, body: '{}' } })).toEqual({ kind: 'absent' });
    });

    it.each([
        ['the Job read is refused', { job: { status: 500, body: 'unavailable' } }],
        ['the Job read throws', { job: new Error('socket hang up') }],
        ['the Job is not a Job', { job: ok('{"kind":"Status"}') }],
        ['the pod list is refused', { pods: { status: 503, body: 'unavailable' } }],
        ['the pod list throws', { pods: new Error('timed out') }],
        ['no pod is listed', { pods: ok('{"items":[]}') }],
        ['the pod list is malformed', { pods: ok('{"items":"x"}') }],
        ['the supervisor state is not shown', { pods: ok(podsOf('Running', undefined)) }],
        ['the supervisor is waiting', { pods: ok(podsOf('Running', { waiting: {} })) }],
        ['the log read is refused', { log: { status: 500, body: 'unavailable' } }],
        ['the log is gone (404)', { log: { status: 404, body: '' } }],
        ['the log read throws', { log: new Error('socket hang up') }],
    ] as [string, Script][])('is inconclusive, never an end, when %s', async (_name, script) => {
        expect(await read(script)).toMatchObject({ kind: 'inconclusive' });
    });

    it('makes one request per object and hands each the stand-down and the remaining time', async () => {
        const { deps, calls } = world({});
        const stop = new AbortController();

        await supervisorServing(deps, prior, bound(stop.signal));

        expect(calls).toHaveLength(3);
        for (const call of calls) {
            expect(call.signal?.aborted).toBe(false);
            expect(call.timeoutMs).toBeGreaterThan(0);
        }
        stop.abort();
        expect(calls.every((call) => call.signal?.aborted)).toBe(true);
    });

    it('answers inconclusive, without a request, once the stand-down has fired', async () => {
        const { deps, calls } = world({});
        const stop = new AbortController();
        stop.abort();

        expect(await supervisorServing(deps, prior, bound(stop.signal))).toMatchObject({ kind: 'inconclusive' });
        expect(calls).toEqual([]);
    });
});
