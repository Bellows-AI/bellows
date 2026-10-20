/**
 * `adoptFinishedRunner` (`k8s-adopt.ts`) called directly, the contracts the runner-level suites in
 * `k8s.test.ts` cannot state: what the injected `CloseReads` receive, a supervisor log that answers
 * 404 or "never started", a pod list that fails only after the Job list admitted the run, and a
 * sweep that fails after the read. Assertions are on requests and on what the adoption answers or
 * throws, never on how many polls a read took.
 */
import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { jobPath } from '../src/k8s-auxspec.js';
import { type CloseReads, adoptFinishedRunner } from '../src/k8s-adopt.js';
import { jobsPath, runnerJobName, secretName } from '../src/k8s-podspec.js';
import type { K8sDeps } from '../src/k8s-transport.js';
import { AdoptionBlocked, commandMark } from '../src/runner.js';
import { AGENT_CONTAINER, SUPERVISOR_CONTAINER } from '../src/supervisor-contract.js';
import { k8sApiserver, type Special } from './fixtures/k8s-apiserver.js';

const NS = 'factory';
const START = '2026-08-20T06:00:00.000Z';
const SESSION = '33333333-3333-4333-8333-333333333333';
const NEW_TOKEN = '99999999-9999-4999-8999-999999999999';
const OTHER_TOKEN = '55555555-5555-4555-8555-555555555555';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    maxAttempts: 1,
    lastAttempt: false,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    executorRefusal: null,
    planRefusal: null,
    skillRefusal: null,
    masterPrompt: 'prompt',
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: '44444444-4444-4444-8444-444444444444',
    workspacePath: 'bellows/user',
    rootCommand: 'fix the failing build',
};
const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
const opencodeAdopter: BoardJob = { ...adopter, executorType: 'opencode' };
const priorName = runnerJobName(job);
const podName = `${priorName}-xxxxx`;

/** An earlier claim's finished agent runner Job, as the label listing answers it. */
const runnerItem = (
    status: Record<string, unknown> = { succeeded: 1 },
    { lease = job.leaseToken, seq = '1', session = SESSION as string | null } = {}
) => ({
    metadata: {
        name: runnerJobName({ ...job, leaseToken: lease }),
        uid: `uid-${runnerJobName({ ...job, leaseToken: lease })}`,
        labels: { 'factory.job': job.id, 'factory.lease': lease },
        annotations: {
            'factory.claim-seq': seq,
            'factory.command': commandMark(job.command),
            ...(session ? { 'factory.session': session } : {}),
        },
    },
    spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
    status: { startTime: START, ...status },
});

/** The adoption's world: `items` listed as the earlier runners, `special` in front of the fake apiserver. */
function world(items: unknown[], special: Special = () => undefined, overrides: Record<string, unknown> = {}) {
    const { routed } = k8sApiserver({ namespace: NS, podName });
    const { request, calls } = routed((method, path, body) => {
        const answer = special(method, path, body);
        if (answer !== undefined) return answer;
        if (method === 'GET' && path.startsWith(`${jobsPath(NS)}?`)) {
            return { status: 200, body: JSON.stringify({ items }) };
        }
    }, overrides);
    const deps: K8sDeps = {
        request,
        sleep: async () => {},
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: NS }),
    };
    return { deps, calls };
}

const reads = (): CloseReads & { scrape: ReturnType<typeof vi.fn>; attach: ReturnType<typeof vi.fn> } => {
    const scrape = vi.fn(async () => ({ turns: 7, summary: 'closed the loop', blocked: 'needs a token' }));
    const attach = vi.fn(async (_deps, _job, _startedAt, outcome) => {
        outcome.agentTurns = 3;
    });
    return { scrapeClaudeCloseRead: scrape, attachOpencodeOutcome: attach, scrape, attach };
};

const supervisorLogPath = (path: string): boolean => path.includes('/log') && path.includes('container=supervisor');
const deletes = (calls: { method: string; path: string }[]) => calls.filter((call) => call.method === 'DELETE');

describe('the close-time readouts an adoption performs', () => {
    it('hands a claude run to the scrape with the earlier lease, its session and its start, and merges the answer', async () => {
        const { deps, calls } = world([runnerItem()]);
        const injected = reads();

        const adopted = await adoptFinishedRunner(deps, adopter, injected);

        expect(injected.scrape).toHaveBeenCalledTimes(1);
        expect(injected.scrape).toHaveBeenCalledWith(
            deps,
            expect.objectContaining({ id: job.id, leaseToken: job.leaseToken }),
            SESSION,
            START
        );
        expect(injected.attach).not.toHaveBeenCalled();
        expect(adopted).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, agentTurns: 7, summary: 'closed the loop', blockedLine: 'needs a token' },
        });
        // The run it read is the one its sweeps now keep, and its Job is not deleted.
        expect(deps.adopted?.get(adopter.leaseToken)).toBe(priorName);
        expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, priorName)))).toBe(false);
    });

    it('hands an opencode run to the attach with the earlier lease and its start, and scrapes nothing', async () => {
        const { deps } = world([runnerItem()]);
        const injected = reads();

        const adopted = await adoptFinishedRunner(deps, opencodeAdopter, injected);

        expect(injected.attach).toHaveBeenCalledTimes(1);
        expect(injected.attach).toHaveBeenCalledWith(
            deps,
            expect.objectContaining({ id: job.id, leaseToken: job.leaseToken }),
            START,
            expect.objectContaining({ exitCode: 0 })
        );
        expect(injected.scrape).not.toHaveBeenCalled();
        expect(adopted?.outcome.agentTurns).toBe(3);
    });

    it('reads no close-time readout for a claude run that carries no session', async () => {
        const { deps } = world([runnerItem({ succeeded: 1 }, { session: null })]);
        const injected = reads();

        const adopted = await adoptFinishedRunner(deps, adopter, injected);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });
        expect(injected.scrape).not.toHaveBeenCalled();
        expect(injected.attach).not.toHaveBeenCalled();
    });
});

describe('the supervisor log of an earlier runner', () => {
    const failedRunner = () => runnerItem({ failed: 1 });
    /** A finished group whose pod ran its agent and its supervisor to their ends. */
    const pods = {
        status: 200,
        body: JSON.stringify({
            items: [
                {
                    metadata: { name: podName },
                    status: {
                        phase: 'Failed',
                        containerStatuses: [
                            { name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } },
                            { name: SUPERVISOR_CONTAINER, state: { terminated: { exitCode: 70 } } },
                        ],
                    },
                },
            ],
        }),
    };

    it.each([
        ['404', { status: 404, body: '{"kind":"Status"}' }],
        ['a 400 that says the container is waiting to start', { status: 400, body: 'container is waiting to start' }],
    ])(
        'is no report, so the run is taken away and the claim given back, never blocked, when it answers %s',
        async (_label, answer) => {
            const { deps, calls } = world(
                [failedRunner()],
                (_method, path) => (supervisorLogPath(path) ? answer : undefined),
                { pods }
            );

            const adopted = await adoptFinishedRunner(deps, adopter, reads());

            expect(adopted).toBeNull();
            expect(
                calls.some((call) => call.method === 'DELETE' && call.path.includes('/configmaps/factory-job-'))
            ).toBe(true);
            expect(deletes(calls).some((call) => call.path.startsWith(jobPath(NS, priorName)))).toBe(false);
        }
    );

    it('stands the attempt down, deleting nothing, when the pod list fails only after the Job list admitted the run', async () => {
        let podLists = 0;
        const { deps, calls } = world(
            [failedRunner()],
            (method, path) => {
                if (method === 'GET' && path.includes('/pods?') && decodeURIComponent(path).includes('job-name=')) {
                    podLists += 1;
                    // The admission read (and the group's end) are answered; the report's own list is not.
                    return podLists <= 1 ? undefined : { status: 503, body: 'unavailable' };
                }
            },
            { pods }
        );

        await expect(adoptFinishedRunner(deps, adopter, reads())).rejects.toThrow(AdoptionBlocked);

        expect(deletes(calls).filter((call) => !call.path.includes('/configmaps/'))).toEqual([]);
        expect(deps.adopted?.has(adopter.leaseToken)).toBe(false);
    });
});

describe('the sweep after the read', () => {
    /** An older claim's leftover runner Job, which the sweep must delete and cannot. */
    const leftover = () => runnerItem({ active: 1 }, { lease: OTHER_TOKEN, seq: '0' });

    it('stands the attempt down naming the read, keeping the run and its Secret, when a leftover will not go', async () => {
        const stuck = leftover();
        const { deps, calls } = world([runnerItem(), stuck], (method, path) =>
            method === 'DELETE' && path.startsWith(jobPath(NS, stuck.metadata.name))
                ? { status: 503, body: 'unavailable' }
                : undefined
        );

        await expect(adoptFinishedRunner(deps, adopter, reads())).rejects.toThrow(/^the run was read, but /);

        // The read run is not rerun: neither its Job nor its Secret was touched, and it is no longer recorded.
        expect(calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(NS, priorName)))).toBe(
            false
        );
        expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/${secretName(job)}`))).toBe(false);
        expect(deps.adopted?.has(adopter.leaseToken)).toBe(false);
    });

    it('deletes the adopted run Secret only after the sweep is done, and keeps the Job', async () => {
        const gone = leftover();
        let listed = [runnerItem(), gone];
        const { deps, calls } = world([], (method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(NS)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path.startsWith(jobPath(NS, gone.metadata.name))) {
                listed = listed.filter((item) => item !== gone);
                return { status: 200, body: '{}' };
            }
        });

        await adoptFinishedRunner(deps, adopter, reads());

        const order = calls
            .filter((call) => call.method === 'DELETE')
            .map((call) => call.path)
            .filter((path) => !path.includes('/configmaps/'));
        const leftoverAt = order.findIndex((path) => path.startsWith(jobPath(NS, gone.metadata.name)));
        const secretAt = order.findIndex((path) => path.endsWith(`/${secretName(job)}`));
        expect(leftoverAt).toBeGreaterThanOrEqual(0);
        expect(secretAt).toBeGreaterThan(leftoverAt);
        expect(order.some((path) => path.startsWith(jobPath(NS, priorName)))).toBe(false);
    });
});
