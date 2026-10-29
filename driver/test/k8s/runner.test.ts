import { describe, expect, it, vi } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { AGENT_CONTAINER, EXPORTER_CONTAINER, SUPERVISOR_CONTAINER } from '../../src/supervisor-contract.js';
import { claudeManagedSettings, opencodeOtelConfig } from '../../src/telemetry-config.js';
import type { K8sMethod, K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import { POLL_MAX_CONSECUTIVE_FAILURES } from '../../src/k8s/k8s-transport.js';
import { jobsPath, runnerJobName, secretName } from '../../src/k8s/k8s-podspec.js';
import { claimName, jobPath } from '../../src/k8s/k8s-auxspec.js';
import type { Call } from '../fixtures/k8s-apiserver.js';
import {
    MASTER_PROMPT,
    job,
    SESSION,
    opencodeJob,
    namespace,
    podName,
    FAKE,
    claimServer,
    fakeRequest,
    routed,
    fakeSteps,
    supervisedRunner,
    runner,
    boardLease,
    NEW_TOKEN,
    OTHER_HOLDER,
    configmapsPath,
    claimPathFor,
} from '../fixtures/k8s-suite.js';

/** The thread's task volume, as `prepare` asks the apiserver for it: a label list that finds nothing, then the create. */
const taskVolumeCalls = (): string[] => [
    'GET /api/v1/namespaces/factory/persistentvolumeclaims',
    'POST /api/v1/namespaces/factory/persistentvolumeclaims',
];

/**
 * The methods of a runner attempt after its sweep: the claim verify, the task volume (read, created),
 * the Job POST (suspended), the Secret POST, the claim verify, the Job's resume, the status poll, the pod list and the log.
 * The close-time claude-code turn read is a supervised step: no call of its own. The group's Secret is not reaped here, nor is the checkout claim released: the group's
 * end (`finish`) does both, once confirmed (issue #821). The fence tests spell out everything before it.
 */
const RUN_FROM_SECRET = ['GET', 'GET', 'POST', 'POST', 'POST', 'GET', 'PATCH', 'GET', 'GET', 'GET'];

/** The answer a hand-written fake gave a call it did not script. */
const noAnswer = (method: K8sMethod, path: string): Promise<K8sResponse> =>
    Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));

/** A DELETE of one Job by name — a `routed` fake whose original never scripted it rejects it. */
const isJobDelete = (method: K8sMethod, path: string): boolean =>
    method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`);

/** A DELETE of the checkout claim — likewise rejected where the original never scripted it. */
const isClaimDelete = (method: K8sMethod, path: string): boolean =>
    method === 'DELETE' && path.startsWith(`${configmapsPath}/`);

describe('the kubernetes runner', () => {
    // #869: the reads after the Job ended stand on the attempt's kill, not on their own patience.
    it('ends the verdict reads of a finished Job when the attempt is killed', async () => {
        const { request } = fakeRequest();
        let hung = false;
        const hanging: K8sRequest = (method, path, body, options) => {
            if (!path.includes('/log') || options?.signal === undefined) return request(method, path, body, options);
            hung = true;
            return new Promise((_resolve, reject) => {
                options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
        };
        const live = runner(hanging);

        const running = live.run(job, { id: SESSION, resume: false });
        await vi.waitFor(() => expect(hung).toBe(true));
        await live.kill(job);

        const ended = await Promise.race([
            running.then(
                () => true,
                () => true
            ),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
        ]);
        expect(ended).toBe(true);
    });

    it('sweeps the job label, then creates the job in the configured namespace and reports success', async () => {
        const { request, calls } = fakeRequest();
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        // The claim is the first thing the run does: one POST whose name uniqueness arbitrates
        // the checkout. Then the fence: a label LIST of the job's previous attempts — nothing
        // answers — before this one creates anything.
        expect(calls[0]?.method).toBe('POST');
        expect(calls[0]?.path).toBe(configmapsPath);
        expect(calls[1]).toEqual({ method: 'GET', path: expect.stringContaining(jobsPath(namespace)) });
        expect(calls[1]!.path).toContain(`labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`);
        expect(calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`)).toEqual([
            `POST ${configmapsPath}`,
            // The sweep lists every kind the job label can answer — the runner Jobs, then their
            // pods — before this attempt creates anything.
            `GET ${jobsPath(namespace)}`,
            `GET /api/v1/namespaces/factory/pods`,
            // The claim verify, then the Job created suspended and only then its per-attempt
            // Secret (the runner's attempt pair), so a Secret never exists without a Job to derive
            // it from (issue #821); the post-create verify, then the resume that starts the pod.
            `GET ${claimPathFor(job.id)}`,
            ...taskVolumeCalls(),
            `POST ${jobsPath(namespace)}`,
            `POST /api/v1/namespaces/factory/secrets`,
            `GET ${claimPathFor(job.id)}`,
            `PATCH ${jobPath(namespace, runnerJobName(job))}`,
            `GET ${jobPath(namespace, runnerJobName(job))}`,
            'GET /api/v1/namespaces/factory/pods',
            `GET /api/v1/namespaces/factory/pods/${podName}/log`,
            // The close-time claude-code turn read: one aux Job, polled, logged, reaped.
            // The group does not go here: its Job and Secret
            // serve the steps after the run until the loop's `finish` — which is also what hands
            // the checkout claim back, once the group's end is confirmed (issue #821).
        ]);
        expect(outcome).toEqual({
            // The fake's log parses as no count at all: unmeasured, never zero.
            agentTurns: null,
            exitCode: 0,
            output: 'did the work\n',
            timedOut: false,
            started: true,
            // The full log rides the outcome now (issue #325) — the whole (one-line) log, uncut.
            fullLog: 'did the work\n',
            logTruncated: false,
        });
    });

    it('creates the per-job Secret before the Job when the claim carries env, and keeps it until the group is finished', async () => {
        const { request, calls } = fakeRequest();
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const r = supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {}
        );
        await r.run(envJob, { id: SESSION, resume: false });

        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        expect(secretPost?.body).toMatchObject({
            apiVersion: 'v1',
            kind: 'Secret',
            type: 'Opaque',
            metadata: { name: secretName(envJob), labels: { 'factory.job': envJob.id } },
            stringData: {
                CORE_TOKEN: 'shh',
                RUNNER_JOB_ID: envJob.id,
                RUNNER_LEASE_TOKEN: envJob.leaseToken,
            },
        });
        // The Secret follows the Job, created suspended, and precedes its resume: no pod exists
        // before its Secret (a CreateContainerConfigError would burn the attempt), and no Secret
        // exists without a Job the fence and the reaper can derive it from (issue #821).
        const secretIndex = calls.findIndex((call) => call.method === 'POST' && call.path === secretsPath);
        const jobIndex = calls.findIndex((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        const resumeIndex = calls.findIndex(
            (call) => call.method === 'PATCH' && call.path === jobPath(namespace, runnerJobName(envJob))
        );
        expect(jobIndex).toBeGreaterThanOrEqual(0);
        expect((calls[jobIndex]!.body as { spec: { suspend?: boolean } }).spec.suspend).toBe(true);
        expect(secretIndex).toBeGreaterThan(jobIndex);
        expect(resumeIndex).toBeGreaterThan(secretIndex);
        // And creating it is the FIRST thing the run does to a Secret: the name carries this
        // attempt's lease token, so there is no previous attempt's Secret at this name to sweep.
        const firstSecretCall = calls.find((call) => call.path?.includes('/secrets'));
        expect(firstSecretCall?.method).toBe('POST');
        // The attempt outlives its run (the gates, the publish and the helpers are its supervisor's
        // steps), so the verdict does not reap the Secret: `finish` does, once nothing of the group
        // can still read it.
        const reaped = (): boolean =>
            calls.some((call) => call.method === 'DELETE' && call.path === `${secretsPath}/${secretName(envJob)}`);
        expect(reaped()).toBe(false);
        await r.finish(envJob);
        expect(reaped()).toBe(true);
    });

    // The parity pin for docs/connections.md: the runner pod gets the attempt pair and the board
    // URL, which is all the Jira helper needs to ask the broker — and never a Jira credential or a
    // JIRA_API, whatever the claim carried.
    it('78: the runner pod carries no Jira credential and no JIRA_API', async () => {
        const { request, calls } = fakeRequest();
        const withJira: BoardJob = {
            ...job,
            env: { ATLASSIAN_API_TOKEN: 'atlassian-secret', ATLASSIAN_EMAIL: 'agent@example.com' },
        };
        await runner(request).run(withJira, { id: SESSION, resume: false });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const stringData = (secretPost?.body as { stringData?: Record<string, string> })?.stringData ?? {};
        expect(Object.keys(stringData).filter((key) => key.startsWith('ATLASSIAN') || key === 'JIRA_API')).toEqual([]);
        expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('JIRA_API');
        expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('atlassian-secret');
        expect(stringData).toMatchObject({ RUNNER_JOB_ID: job.id, RUNNER_LEASE_TOKEN: job.leaseToken });
    });

    it('creates the per-attempt Secret for every runner — the pair rides it even with no claim env', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(job, { id: SESSION, resume: false });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        // The Secret is never empty now: the runner's own branch-ingest credential is always in it.
        expect(secretPost?.body).toMatchObject({
            stringData: { RUNNER_JOB_ID: job.id, RUNNER_LEASE_TOKEN: job.leaseToken },
        });
    });

    // Issue #452: the Secret carries the managed settings the pod mounts, rendered with the
    // driver's endpoint — the entrypoint no longer rewrites them in place.
    it.each([
        [{}, 'http://collector:4318'],
        [{ RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' }, 'http://otel.example:4318'],
    ])('renders the managed settings into a claude-code runner Secret (%o)', async (env, endpoint) => {
        const { request, calls } = fakeRequest();
        await runner(request, env).run(job, { id: SESSION, resume: false });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const stringData = (secretPost?.body as { stringData?: Record<string, string> })?.stringData ?? {};
        expect(stringData['managed-settings.json']).toBe(claudeManagedSettings(endpoint));
    });

    it('renders otel.json, and no managed settings, into an opencode runner Secret', async () => {
        const { request, calls } = fakeRequest();
        await runner(request, { RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' }).run(opencodeJob, null);
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const stringData = (secretPost?.body as { stringData?: Record<string, string> })?.stringData ?? {};
        expect(stringData['otel.json']).toBe(opencodeOtelConfig('http://otel.example:4318'));
        expect(stringData).not.toHaveProperty('managed-settings.json');
    });

    // Issue #244: the per-attempt Secret and the pod spec's env NAMES must agree on
    // OPENCODE_CONFIG_CONTENT — one merge (runnerClaimEnv), never two, or the two could drift the
    // way `secretEnv`/`runnerEnv` used `claimEnv` independently before this change.
    it('merges the reserved factory agent into the runner Secret and references it by name in the pod spec', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(opencodeJob, null);

        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const stringData = (secretPost?.body as { stringData?: Record<string, string> })?.stringData ?? {};
        expect(JSON.parse(stringData.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
            agent: { factory: { mode: 'primary', prompt: MASTER_PROMPT, disable: false } },
        });

        const jobPost = calls.find((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        const env = (jobPost?.body as { spec?: { template?: { spec?: { containers?: { env?: unknown[] }[] } } } })?.spec
            ?.template?.spec?.containers?.[0]?.env as {
            name: string;
            valueFrom?: { secretKeyRef?: { key: string } };
        }[];
        expect(env).toContainEqual({
            name: 'OPENCODE_CONFIG_CONTENT',
            valueFrom: { secretKeyRef: { name: secretName(opencodeJob), key: 'OPENCODE_CONFIG_CONTENT' } },
        });
    });

    /*
     * kill() deletes the attempt's group (the Job) and its Secret by their own names. The attempt
     * outlives `run` now — its steps and its `finish` follow it — so run() no longer reaps the
     * Secret, and a kill, the one path that takes the group away without `finish`, must. (The
     * reaper sweeps what a dead driver leaves.)
     */
    it('deletes the runner Job and its own attempt Secret when it kills', async () => {
        const { request, calls } = fakeRequest();
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        await runner(request).kill(envJob);
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path?.startsWith(jobPath(namespace, runnerJobName(envJob)))
            )
        ).toBe(true);
        // The attempt's Secret (issue #821; the gates hold none of their own, issue #773), before the
        // Job: nothing could derive its name once it is gone.
        expect(calls.filter((call) => call.path?.includes('/secrets')).map((call) => call.path)).toEqual([
            `/api/v1/namespaces/${namespace}/secrets/${secretName(envJob)}`,
        ]);
        const secretAt = calls.findIndex((call) => call.path?.includes('/secrets'));
        const jobAt = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path?.startsWith(jobPath(namespace, runnerJobName(envJob)))
        );
        expect(secretAt).toBeLessThan(jobAt);
    });

    /*
     * The reported race: a lease expires, the board reclaims the job, and a replacement attempt
     * creates its Secret. The superseded worker then processes its lost heartbeat and its kill()
     * deletes a Secret. The lease token is in the name, so what kill() deletes is the old attempt's
     * own Secret and never the replacement's — whose group outlives its `run`, Secret and all.
     */
    it("deletes only the superseded attempt's Secret when the job id has been reclaimed", async () => {
        const oldJob: BoardJob = {
            ...job,
            env: { CORE_TOKEN: 'shh' },
            leaseToken: '22222222-2222-4222-8222-222222222222',
        };
        const newJob: BoardJob = {
            ...job,
            env: { CORE_TOKEN: 'shh' },
            leaseToken: '99999999-9999-4999-8999-999999999999',
        };
        const { request, calls } = fakeRequest();

        // The replacement attempt runs to completion: it creates its OWN Secret, which it keeps for
        // its group's steps until `finish`.
        const replacement = runner(request);
        await replacement.run(newJob, { id: SESSION, resume: false });
        const afterRun = calls.length;
        const secretOf = (j: BoardJob) => `/api/v1/namespaces/${namespace}/secrets/${secretName(j)}`;
        expect(calls.some((call) => call.method === 'DELETE' && call.path === secretOf(newJob))).toBe(false);

        // The superseded worker's kill reaches its own attempt's Secret and nothing else: the
        // replacement's is a different name.
        await runner(request).kill(oldJob);
        const deleted = calls.slice(afterRun).filter((call) => call.path?.includes('/secrets'));
        expect(deleted.map((call) => call.path)).toEqual([secretOf(oldJob)]);
        expect(secretName(oldJob)).not.toBe(secretName(newJob));

        // The replacement's own `finish` is what reaps its Secret.
        await replacement.finish(newJob);
        expect(calls.some((call) => call.method === 'DELETE' && call.path === secretOf(newJob))).toBe(true);
    });

    it('reports a non-zero exit with the pod exit code and the tail of the log', async () => {
        const { request } = fakeRequest({
            job: { status: 200, body: JSON.stringify({ status: { failed: 1 } }) },
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                containerStatuses: [
                                    { name: 'agent', state: { terminated: { exitCode: 3 } } },
                                    { name: 'supervisor', state: { terminated: { exitCode: 0 } } },
                                ],
                            },
                        },
                    ],
                }),
            },
            log: { status: 200, body: 'claude: permission denied' },
        });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(3);
        expect(outcome.timedOut).toBe(false);
        expect(outcome.output).toBe('claude: permission denied');
    });

    /**
     * Live output on this platform is the log tail read mid-run: one poll sees the Job still
     * running, discovers the pod, and hands the caller what the log says so far; the next sees
     * the terminal status and the finished run reports exactly as it always did. The final log
     * read is unchanged — the preview never replaces the report.
     */
    it('streams the log tail while the pod runs, and reports the finished log at the end', async () => {
        const tails: string[] = [];
        let gets = 0;
        const { request } = routed((method, path) => {
            if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                gets += 1;
                // First poll: still running, and worth a look at the log. Second: done.
                return gets === 1 ? { status: 200, body: JSON.stringify({ status: {} }) } : (FAKE.job as K8sResponse);
            }
            if (path.includes('/log')) {
                return gets === 1 ? { status: 200, body: 'partial output\n' } : (FAKE.log as K8sResponse);
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false }, (tail) => tails.push(tail));

        expect(tails).toEqual(['partial output\n']);
        expect(outcome).toEqual({
            // The fake's log parses as no count at all: unmeasured, never zero.
            agentTurns: null,
            exitCode: 0,
            output: 'did the work\n',
            timedOut: false,
            started: true,
            // The full log rides the outcome now (issue #325) — the whole (one-line) log, uncut.
            fullLog: 'did the work\n',
            logTruncated: false,
        });
    });

    // A pod that has not been scheduled yet, or a log endpoint that hiccups, is a skipped preview —
    // never a failed run.
    it('streams nothing, and fails nothing, when the mid-run log read answers badly', async () => {
        const tails: string[] = [];
        let gets = 0;
        const { request } = routed((method, path) => {
            if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                gets += 1;
                return gets === 1 ? { status: 200, body: JSON.stringify({ status: {} }) } : (FAKE.job as K8sResponse);
            }
            if (path.includes('/log')) return { status: 500, body: 'unavailable' };
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false }, (tail) => tails.push(tail));

        expect(tails).toEqual([]);
        expect(outcome.exitCode).toBe(0);
    });

    /*
     * A job id is only reused when a lease expired and the row was reclaimed — and the leftover
     * Job objects of the previous attempts may still exist. Sweeping them by label before
     * creating is the fencing mechanism: two writers on one checkout is the thing actually
     * worth preventing (docs/jobs.md). The sweep is by LABEL, not by name — attempt-scoped Job
     * names would make a name-targeted delete miss every previous attempt.
     */
    it('sweeps leftover jobs by label before creating, and waits for the sweep to land', async () => {
        const leftover = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        let lists = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                // First read: the old Job is still listed. Second: gone. Everything after is
                // the NEW Job's own status poll. The fixture carries no creationTimestamp —
                // the fence classifies nothing, so it reads none.
                return lists === 1
                    ? {
                          status: 200,
                          body: JSON.stringify({ items: [{ metadata: { name: leftover, uid: `uid-${leftover}` } }] }),
                      }
                    : { status: 200, body: JSON.stringify({ items: [] }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) return { status: 200, body: '{}' };
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
        // Claim, then LIST finds the leftover by label, the claim is confirmed still ours,
        // the leftover is deleted BY NAME with Foreground propagation, LISTs again — nothing
        // deletable answers — and only then the create. Foreground propagation starts the
        // teardown; the next list is what proves the old pods are off the checkout — the
        // delete's own response does not wait for them.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            // Round one lists every kind — jobs names the leftover, pods answer empty — then the
            // claim is confirmed ours and the leftover is deleted by name.
            'GET',
            'GET',
            'GET',
            'DELETE',
            // Round two: both kinds answer empty. The per-attempt Secret is written after
            // the sweep, before the claim that precedes the create — and reaped with the attempt.
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
        expect(calls[1]!.path).toContain(`labelSelector=${encodeURIComponent(`factory.job=${job.id}`)}`);
        expect(calls[4]!.path).toBe(`${jobPath(namespace, leftover)}?propagationPolicy=Foreground`);
    });

    // A re-claim whose sweep never lands — an apiserver losing deletes, say — must not loop
    // forever heartbeating a lease around a create that would run alongside leftovers. Bounded,
    // then thrown: the job goes back to the board rather than two writers racing one checkout.
    // "Deletable" means ANY item the selector answers — the fence classifies nothing — so the
    // fixture carries no timestamp for it to read.
    it('gives up when a deletable leftover job never disappears', async () => {
        const leftover = {
            metadata: { name: 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner', uid: 'uid-old' },
        };
        const { request } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: [leftover] }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                // Answered, and yet the object never leaves the list — the failure mode the
                // bound exists for.
                return { status: 200, body: '{}' };
            }
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/never disappeared/);
    });

    // Issue #869: a leftover listing with an entry that names nothing proves nothing about what is
    // left. The sweep neither reads it as free nor deletes beside it; it waits out its bound.
    it.each([
        ['an empty entry', {}],
        ['an entry named by a number', { metadata: { name: 5 } }],
        ['an entry with no uid', { metadata: { name: 'leftover-runner' } }],
        ['an entry with an empty uid', { metadata: { name: 'leftover-runner', uid: '' } }],
        [
            'an entry whose lease label is no lease',
            { metadata: { name: 'leftover-runner', uid: 'u', labels: { 'factory.lease': 'corrupt' } } },
        ],
    ])('does not create beside a leftover listing that carries %s', async (_name, entry) => {
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: [entry] }) };
            }
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not confirm the checkout empty/
        );

        expect(calls.filter((call) => call.method === 'DELETE' && call.path.startsWith(jobsPath(namespace)))).toEqual(
            []
        );
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
    });

    /*
     * Issue #32, race 2: the old fence deleted EVERY Job the `factory.job` selector answered, so
     * a stale attempt fencing after its replacement was posted would delete the legitimate lease
     * holder's Job — whose status poll then answers 404 and aborts an active run. Under the
     * claim protocol the stale attempt loses the acquisition step instead — the claim's attempt
     * number is ahead of its own — and stands down having created and deleted nothing at all.
     */
    it('stands down when a newer attempt holds the checkout claim, and touches nothing of its replacement', async () => {
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const newerJobName = runnerJobName(newerJob);
        const claimPath = claimPathFor(job.id);
        let replacementAlive = true;
        const { request, calls } = routed((method, path) => {
            // The claim is held by attempt 2; this run is attempt 1.
            if (method === 'POST' && path === configmapsPath) {
                return { status: 409, body: '{"reason":"AlreadyExists"}' };
            }
            if (path === claimPath && method === 'GET') {
                return {
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'claim-uid-2' },
                        data: { holder: NEW_TOKEN, claimSeq: '2' },
                    }),
                };
            }
            // The replacement's runner Job is live and answers the label selector.
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        items: replacementAlive
                            ? [{ metadata: { name: newerJobName, uid: `uid-${newerJobName}` } }]
                            : [],
                    }),
                };
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, newerJobName)}?`)) {
                replacementAlive = false;
                return { status: 200, body: '{}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
            if (isClaimDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/stands down/);
        // The replacement's Job still exists — a superseded attempt never reaches the winner.
        expect(replacementAlive).toBe(true);
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(newerJobName))).toBe(false);
        // Nothing was created either: standing down leaves the job to its lease.
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        // And the claim it does not hold is not deleted by the loser either.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    /*
     * Issue #302's runner twin: an unpullable executor image used to hold the runner Job past
     * its whole deadline — the run reporting a timeout while the pod's own words went unread.
     * The poll names the image the moment the pod does.
     */
    it('names an unpullable executor image instead of burning the runner deadline', async () => {
        const { request: base } = fakeRequest({
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                containerStatuses: [
                                    {
                                        name: AGENT_CONTAINER,
                                        state: {
                                            waiting: {
                                                reason: 'ImagePullBackOff',
                                                message: 'Failed to pull image "claude-executor": pull access denied',
                                            },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                }),
            },
        });
        let polls = 0;
        const deletes: string[] = [];
        const request: K8sRequest = async (method, path, body) => {
            if (method === 'DELETE') deletes.push(path);
            if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                polls += 1;
                return polls === 1
                    ? { status: 200, body: '{"status":{}}' }
                    : {
                          status: 200,
                          body: JSON.stringify({
                              status: { failed: 1, conditions: [{ type: 'Failed', reason: 'DeadlineExceeded' }] },
                          }),
                      };
            }
            return base(method, path, body);
        };
        const running = runner(request).run(job, { id: SESSION, resume: false });
        await expect(running).rejects.toThrow(
            /the executor image "claude-executor" cannot be pulled: ImagePullBackOff/
        );
        // Typed by the cause its words prove (#824 D11), as the sync's wait types it.
        await expect(running).rejects.toMatchObject({ name: 'StartupRefused', startupCause: 'auth' });
        // Named on the first poll — the image question never waits out the deadline.
        expect(polls).toBe(1);
        // A thrown fact: run() deletes the group's Job itself no more than docker's removes its
        // containers (#828) — the loop's end() finishes it.
        expect(deletes.filter((path) => path === jobPath(namespace, runnerJobName(job)))).toEqual([]);
    });

    // A container config the kubelet refuses holds the pod as surely as an image: named at once,
    // not after the runner Job's deadline (#824 D11).
    it('names a container config the kubelet refuses instead of burning the runner deadline', async () => {
        const held = JSON.stringify({
            items: [
                {
                    metadata: { name: podName },
                    status: {
                        containerStatuses: [
                            {
                                name: AGENT_CONTAINER,
                                state: {
                                    waiting: { reason: 'CreateContainerConfigError', message: 'secret "x" not found' },
                                },
                            },
                        ],
                    },
                },
            ],
        });
        const { request: base } = fakeRequest({ pods: { status: 200, body: held } });
        const request: K8sRequest = async (method, path, body) =>
            method === 'GET' && path === jobPath(namespace, runnerJobName(job))
                ? { status: 200, body: '{"status":{}}' }
                : base(method, path, body);
        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toMatchObject({
            name: 'StartupRefused',
            startupCause: 'config',
            message: expect.stringContaining('the executor container cannot start: CreateContainerConfigError'),
        });
    });

    // An agent that is running or ended has run: a container held beside it (an exporter whose Secret
    // went away) is no refused start of the run, never a fault that ends the task (Codex r2, class B).
    it('never reads a container held beside an agent that ran as a refused start', async () => {
        const held = JSON.stringify({
            items: [
                {
                    metadata: { name: podName },
                    status: {
                        containerStatuses: [
                            { name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } },
                            { name: SUPERVISOR_CONTAINER, state: { running: {} } },
                            {
                                name: EXPORTER_CONTAINER,
                                state: {
                                    waiting: { reason: 'CreateContainerConfigError', message: 'secret "x" not found' },
                                },
                            },
                        ],
                    },
                },
            ],
        });
        let polls = 0;
        const { request: base } = fakeRequest({ pods: { status: 200, body: held } });
        const request: K8sRequest = async (method, path, body) => {
            if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                polls += 1;
                return { status: 200, body: polls < 2 ? '{"status":{}}' : '{"status":{"succeeded":1}}' };
            }
            return base(method, path, body);
        };
        const ended = await runner(request)
            .run(job, { id: SESSION, resume: false })
            .catch((e: unknown) => e);
        expect(ended).not.toMatchObject({ name: 'StartupRefused' });
        expect(polls).toBeGreaterThan(1);
    });

    /*
     * The takeover pin: a leftover claim of an OLDER attempt (a driver that died holding it) is
     * released by the next claimant, conditionally on the exact incarnation it read — the uid
     * precondition is what keeps a stale attempt's delete from ever reaching a newer incarnation
     * of the claim. Attempt numbers order the attempts of one job; no clock is read anywhere.
     */
    it('takes over the leftover claim of an older attempt under a uid precondition, then creates', async () => {
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const claimPath = claimPathFor(job.id);
        const serve = claimServer();
        // A leftover from the older attempt: the first claim POST stores it under claim-uid-1.
        let seeded = false;
        const { request, calls } = routed((method, path, body) => {
            if (!seeded) {
                seeded = true;
                serve('POST', configmapsPath, {
                    metadata: { name: `factory-job-${job.id}-claim` },
                    data: { holder: job.leaseToken, claimSeq: '1' },
                });
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
            return serve(method, path, body);
        });

        const outcome = await supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {}
        ).run(newerJob, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // The takeover delete names the exact claim incarnation that was read.
        const takeover = calls.find((call) => call.method === 'DELETE' && call.path === claimPath);
        expect((takeover?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBe(
            'claim-uid-1'
        );
        expect(calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`)).toEqual([
            `POST ${configmapsPath}`,
            `GET ${claimPath}`,
            `DELETE ${claimPath}`,
            `POST ${configmapsPath}`,
            `GET ${jobsPath(namespace)}`,
            `GET /api/v1/namespaces/factory/pods`,
            // The Job created suspended, then the per-attempt Secret, kept with the group: `finish`
            // reaps it, not the run. The resume starts the pod after the post-create verify.
            `GET ${claimPath}`,
            ...taskVolumeCalls(),
            `POST ${jobsPath(namespace)}`,
            `POST /api/v1/namespaces/factory/secrets`,
            `GET ${claimPath}`,
            `PATCH ${jobPath(namespace, runnerJobName(newerJob))}`,
            `GET ${jobPath(namespace, runnerJobName(newerJob))}`,
            'GET /api/v1/namespaces/factory/pods',
            `GET /api/v1/namespaces/factory/pods/${podName}/log`,
            // The close-time claude-code turn read: one aux Job, polled, logged, reaped. It
            // rides THIS attempt, so its name hashes the token this run holds. The claim stays: the
            // group's end hands it back (issue #821).
        ]);
    });

    /*
     * Issue #32, race 1: both fences could observe an empty selector before either POST became
     * visible, and both attempts would create Jobs — two runners on one writable checkout, the
     * exact harm docs/jobs.md calls the single most important line in the board contract. Under
     * the claim protocol the second attempt's POST answers 409, it takes over only because its
     * attempt number is ahead, and the FIRST attempt — still inside its sweep, holding nothing
     * anymore — finds the claim no longer its own and stands down before creating anything.
     */
    it('admits one runner per checkout: the superseded attempt stands down mid-sweep', async () => {
        const olderJob: BoardJob = { ...job, attempts: 1, claimSeq: 1 };
        const newerJob: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const newerJobName = runnerJobName(newerJob);
        const liveJobs = new Set<string>();

        let signalOlderClaimed!: () => void;
        const olderClaimed = new Promise<void>((resolve) => {
            signalOlderClaimed = resolve;
        });
        let openOlderList!: () => void;
        const olderList = new Promise<void>((resolve) => {
            openOlderList = resolve;
        });

        // One fake for both attempts: they share its claim server, as they share the apiserver.
        const { request: shared, calls } = routed((method, path, body) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        items: [...liveJobs].map((name) => ({ metadata: { name, uid: `uid-${name}` } })),
                    }),
                };
            }
            if (method === 'POST' && path === jobsPath(namespace)) {
                liveJobs.add((body as { metadata?: { name?: string } })?.metadata?.name ?? '');
                return FAKE.create as K8sResponse;
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                liveJobs.delete(path.slice(jobsPath(namespace).length + 1).split('?')[0] ?? '');
                return { status: 200, body: '{}' };
            }
        });
        // The older attempt's fence: its first label list is held until the test has run the
        // newer attempt to completion, so the sweep sees the replacement's live Job.
        const olderRequest: K8sRequest = (method, path, body) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                // The claim is taken before the first list in the fixed code; signal then. Before
                // the fix there is no claim POST, so signal at the list instead — the test must
                // start the newer attempt either way.
                signalOlderClaimed();
                return olderClaimed.then(() => olderList).then(() => shared(method, path, body));
            }
            const result = shared(method, path, body);
            if (method === 'POST' && path === configmapsPath) {
                result.then(
                    () => signalOlderClaimed(),
                    () => signalOlderClaimed()
                );
            }
            return result;
        };

        const makeRunner = (request: K8sRequest) =>
            supervisedRunner(
                loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
                request,
                async () => {}
            );

        const olderRun = makeRunner(olderRequest).run(olderJob, { id: SESSION, resume: false });
        await olderClaimed;
        const newerOutcome = await makeRunner(shared).run(newerJob, { id: SESSION, resume: false });
        expect(newerOutcome.exitCode).toBe(0);
        openOlderList();
        await expect(olderRun).rejects.toThrow(/stands down/);

        // Exactly one runner Job was ever created, and it is the newer attempt's. Named by its
        // body: the close-time turn read posts its own aux Job here too.
        const jobPosts = calls.filter(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                (call.body as { metadata?: { name?: string } } | undefined)?.metadata?.name === newerJobName
        );
        expect(jobPosts).toHaveLength(1);
        expect((jobPosts[0]?.body as { metadata?: { name?: string } } | undefined)?.metadata?.name).toBe(newerJobName);
        // The superseded attempt never reached the winner's objects.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(newerJobName))).toBe(false);
    });

    // The env Secret this run creates precedes its first Job POST — and must SURVIVE the fence:
    // the Job references it by name, and a deleted one would start the pod silently without its
    // claim env. The fence sweeps JOBS by label and nothing else — and the Secret's name carries
    // this attempt's own lease token, so there is no previous attempt's Secret at this name.
    it('keeps the freshly created Secret across the label fence', async () => {
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        // Every delete but the claim's answers plainly; the claim keeps its uid precondition.
        const { request, calls } = routed((method, path) =>
            method === 'DELETE' && !path.startsWith(configmapsPath) ? { status: 200, body: '{}' } : undefined
        );

        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const outcome = await supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {}
        ).run(envJob, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // Created once, after the Job POST (suspended) and before its resume (issue #821).
        const secretPosts = calls.filter((c) => c.method === 'POST' && c.path === secretsPath);
        expect(secretPosts).toHaveLength(1);
        expect(calls.findIndex((c) => c.method === 'POST' && c.path === secretsPath)).toBeGreaterThan(
            calls.findIndex((c) => c.method === 'POST' && c.path === jobsPath(namespace))
        );
        expect(calls.findIndex((c) => c.method === 'POST' && c.path === secretsPath)).toBeLessThan(
            calls.findIndex((c) => c.method === 'PATCH' && c.path === jobPath(namespace, runnerJobName(envJob)))
        );
        // And NOT deleted between the fence and the Job POST.
        const fenceList = calls.findIndex((c) => c.method === 'GET' && c.path?.includes('labelSelector='));
        const rePost = calls.findIndex(
            (c, i) => i > fenceList && c.method === 'POST' && c.path === jobsPath(namespace)
        );
        const secretDeletesInTheFence = calls
            .slice(fenceList, rePost)
            .filter((c) => c.method === 'DELETE' && c.path?.includes('/secrets'));
        expect(secretDeletesInTheFence).toHaveLength(0);
    });

    /*
     * The sweep classifies NOTHING, so every Job the `factory.job` selector answers is deleted —
     * which is safe exactly because the claim is held: whoever the Jobs belonged to, the board
     * has superseded them, and a successor that reclaims while this sweep is in flight makes the
     * claim check answer not-ours and stands this attempt down before a single delete lands. No
     * timestamp makes a predecessor distinguishable — one can be younger than any cutoff, because
     * its attempt's fencing waited on the kubelet's unbounded garbage collection. Each is deleted
     * BY NAME with Foreground propagation; a collection DELETE is still never issued, because
     * the API server evaluates a selector at processing time and one in flight could reach Jobs
     * posted after the fence began — this attempt's own, once created.
     */
    it('fences every Job the label answers — leftover and fresh successor alike — by name, never as a collection DELETE', async () => {
        const now = Date.now();
        const oldName = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        const freshName = 'factory-job-11111111-1111-4111-8111-111111111111-newlease-runner';
        const oldJob = {
            metadata: { name: oldName, uid: 'uid-old', creationTimestamp: new Date(now - 10 * 60_000).toISOString() },
        };
        const freshJob = {
            metadata: { name: freshName, uid: 'uid-fresh', creationTimestamp: new Date(now).toISOString() },
        };
        let old = true;
        let fresh = true;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return {
                    status: 200,
                    body: JSON.stringify({ items: [old ? oldJob : null, fresh ? freshJob : null].filter(Boolean) }),
                };
            }
            // The API server evaluates a selector at processing time: a collection DELETE would
            // take EVERY Job of the id — including this attempt's own once created. The fence
            // must never issue one.
            if (method === 'DELETE' && path.includes('labelSelector=')) {
                old = false;
                fresh = false;
                return { status: 200, body: '{}' };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                if (path.startsWith(`${jobPath(namespace, oldName)}`)) old = false;
                if (path.startsWith(`${jobPath(namespace, freshName)}`)) fresh = false;
                return { status: 200, body: '{}' };
            }
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // No collection DELETE anywhere in the run: one whose selector would match this
        // attempt's own Job once created is exactly the delete this fence must never issue.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes('labelSelector='))).toBe(false);
        // Both Jobs go BY NAME, Foreground — the fresh successor's leftover too: its run
        // released the claim before this attempt acquired it, so its Job is sweepable.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, oldName)}?propagationPolicy=Foreground`,
            body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'uid-old' } },
        });
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, freshName)}?propagationPolicy=Foreground`,
            body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'uid-fresh' } },
        });
        // Claim, LIST ×2 (finds both in jobs; pods empty), claim confirmed ours, two deletes,
        // LIST ×2 (clean), claim re-verified before the create, create, claim verified again,
        // then the status poll, the pod list, the log, the claim release and the Secret's reap.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'DELETE',
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
    });

    /*
     * THE race the mutex closes: this attempt loses its lease while its own Secret creation and
     * fencing consume more than half of it. The predecessor's Job — a different lease token —
     * was created 7 seconds before the fence's deciding list under a 10s lease, so the
     * half-lease cutoff computed at fence entry classified it FRESH and spared it: two writers
     * on one checkout. No clock-derived predicate can classify that correctly — a Job stamped
     * fence-entry-fresh is exactly what the cutoff tested — so the fence no longer classifies
     * at all: any Job the label answers is deleted by name and awaited before the create. The
     * lease is pinned at the supported minimum to prove nothing timing-based remains
     * load-bearing.
     */
    it('deletes a live predecessor the age filter would have called fresh, and waits for it before creating', async () => {
        const predecessor = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        let predecessorAlive = true;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        items: predecessorAlive
                            ? [
                                  {
                                      metadata: {
                                          name: predecessor,
                                          uid: `uid-${predecessor}`,
                                          creationTimestamp: new Date().toISOString(),
                                      },
                                  },
                              ]
                            : [],
                    }),
                };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                if (path.startsWith(jobPath(namespace, predecessor))) predecessorAlive = false;
                return { status: 200, body: '{}' };
            }
        });

        // A 10s lease puts the entry-time cutoff 5s back: the predecessor — younger than that
        // at the deciding list — is a live writer on this checkout, and it must not survive.
        const r = supervisedRunner(
            loadDriverConfig({
                EXECUTOR: 'kubernetes',
                K8S_NAMESPACE: namespace,
                DRIVER_LEASE_SECONDS: '10',
                RUNNER_SERVICES: '0',
            }),
            request,
            async () => {}
        );
        const outcome = await r.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        // Deleted BY NAME, Foreground...
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, predecessor)}?propagationPolicy=Foreground`,
            body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: `uid-${predecessor}` } },
        });
        // ...and only once the claim is confirmed ours and the selector answers nothing does
        // this attempt create its own Job: claim, LIST ×2 (finds the predecessor in jobs; pods
        // empty), claim confirmed, DELETE, LIST ×2 (clean), claim re-verified, POST, claim
        // verified, then the status poll and the close-time reads.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
    });

    // A collection that answers 404 has nothing behind it to fence: straight to the create, no
    // second list, no deletes.
    it('treats a 404 from the label list as nothing left to fence', async () => {
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 404, body: '{"kind":"Status"}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            // Jobs 404s; the sweep goes on to the pods list, empty — the round is conclusive
            // and the checkout is free. The per-attempt Secret is written after the sweep,
            // before the claim that precedes the create — and reaped with it.
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
    });

    // A dropped connection says nothing about whether the objects are gone; the fence keeps
    // polling within the same bound instead of creating alongside what may still be there.
    it('keeps fencing through a transport failure on the list', async () => {
        let lists = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                // First read: the connection drops. Second: the selector answers nothing.
                return lists === 1
                    ? Promise.reject(new Error('connection reset'))
                    : Promise.resolve({ status: 200, body: JSON.stringify({ items: [] }) });
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            // Round one: the jobs list drops — the round is inconclusive, and the pods list
            // still runs before the retry.
            'GET',
            'GET',
            // Round two: jobs and pods both answer empty — free to create. The per-attempt
            // Secret is written after the sweep, before the claim — reaped with it.
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
    });

    /*
     * Release is conditional: the only claim this attempt may ever delete is the exact
     * incarnation it still holds, proved by a GET before the DELETE. Case (a): a finished run
     * releases its own claim, uid-preconditioned. Case (b): a claim that has moved on — taken
     * over, or already gone — is left entirely alone.
     */
    it('releases the claim when the run ends, and never releases a claim it no longer holds', async () => {
        const claimPath = claimPathFor(job.id);
        // (a) A finished group ends with the claim read and released, the last calls of its
        // `finish` — never of the run, which the group outlives (issue #821): the service fleet
        // outlives run() until the loop releases it, and the attempt's group, Secret and claim
        // until its `finish` confirms the group ended.
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const released = fakeRequest();
        const finishing = runner(released.request);
        await finishing.run(envJob, { id: SESSION, resume: false });
        expect(released.calls.some((call) => call.path === claimPath && call.method === 'DELETE')).toBe(false);
        await finishing.finish(envJob);
        const tail = released.calls.slice(-2);
        expect(tail[0]).toEqual({ method: 'GET', path: claimPath });
        expect(tail[1]?.method).toBe('DELETE');
        expect(tail[1]?.path).toBe(claimPath);
        expect((tail[1]?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBe(
            'claim-uid-1'
        );

        // (b) The claim answers gone at release time: no DELETE on the configmaps path at all.
        let reads = 0;
        const serve = claimServer();
        const { request, calls } = routed((method, path, body) => {
            const claimAnswer = serve(method, path, body);
            if (claimAnswer) {
                // The verify reads (our claim, still held) succeed; every later read — the
                // release's — answers 404, as if another attempt took the claim over and
                // finished its whole run in between.
                reads += 1;
                if (reads > 3) return { status: 404, body: '{"kind":"Status"}' };
                return claimAnswer;
            }
        });
        const gone = runner(request);
        const outcome = await gone.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        await gone.finish(job);
        // The acquire POST and the two verifies around the Job POST happened — reads 1 through
        // 3 — and the release read found the claim gone without deleting anything.
        expect(reads).toBeGreaterThan(3);
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    // A claim with no claim sequence — hand-made, or written by a driver from before the field
    // existed — cannot be ordered, so it is taken over only once the board proves this attempt
    // holds the job's live lease: its holder's lease is then gone. Standing down on garbage alone
    // would let a dead claim hold the checkout forever.
    it('takes over a claim object that carries no claim sequence once the board proves the lease', async () => {
        const claimPath = claimPathFor(job.id);
        const serve = claimServer();
        let seeded = false;
        const { request, calls } = routed((method, path, body) => {
            if (!seeded) {
                seeded = true;
                // A hand-made claim: a holder, but no attempt field at all.
                serve('POST', configmapsPath, {
                    metadata: { name: `factory-job-${job.id}-claim` },
                    data: { holder: OTHER_HOLDER },
                });
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
            return serve(method, path, body);
        });

        const outcome = await runner(request, {}, boardLease(job)).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // Taken over, not stood down: the holder was not a newer attempt.
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(true);
        // And the takeover was conditioned on the incarnation the GET read.
        expect(
            (
                calls.find((call) => call.method === 'DELETE' && call.path === claimPath)?.body as
                    | {
                          preconditions?: { uid?: string };
                      }
                    | undefined
            )?.preconditions?.uid
        ).toBe('claim-uid-1');
    });

    // The claim name is the one job-scoped object name this runner ever writes — asserted before
    // it joins an API path, the same way the Job's and the Secret's are.
    it('names the checkout claim after the job id alone, and refuses a job id that is not a uuid', () => {
        expect(claimName(job)).toBe(`factory-job-${job.id}-claim`);
        expect(() => claimName({ ...job, id: '../../etc/passwd' })).toThrow(/not a uuid/);
    });

    /*
     * The post-create verify is the bracket that closes race 1's residual window: a takeover
     * landing between the Job POST and the claim read is answered by the loser deleting its OWN
     * attempt-scoped Job and standing down — never by touching anything of the winner's.
     */
    it('stands down and removes its own Job when the claim is taken over between the Job POST and the verify', async () => {
        const claimPath = claimPathFor(job.id);
        let jobPosted = false;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === jobsPath(namespace)) {
                jobPosted = true;
                return FAKE.create as K8sResponse;
            }
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    // The claim is ours until this attempt's Job exists; the takeover lands the
                    // moment it is — exactly the window this bracket closes.
                    return Promise.resolve(
                        jobPosted
                            ? {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-9' },
                                      data: { holder: NEW_TOKEN, claimSeq: '2' },
                                  }),
                              }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-8' },
                                      data: { holder: job.leaseToken, claimSeq: '1' },
                                  }),
                              }
                    );
                }
                return { status: 200, body: '{}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /taken over before the runner could start/
        );
        // Its OWN Job, by name, Foreground.
        // By the uid its create answered (issue #821): that incarnation and no other.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, runnerJobName(job))}?propagationPolicy=Foreground`,
            body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'job-uid-1' } },
        });
        // And nothing of the winner's: no Job of the newer attempt is ever addressed.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(NEW_TOKEN))).toBe(false);
    });

    // A read that cannot name the incarnation it read is a bad read, and an UNCONDITIONED delete
    // of it could reach a newer claim — reopening both races through the takeover itself. The
    // runner refuses instead: fail loud, leave the job to its lease, delete nothing.
    it('refuses to release a claim it cannot identify, rather than deleting unconditioned', async () => {
        const claimPath = claimPathFor(job.id);
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 409, body: '{"reason":"AlreadyExists"}' };
            }
            if (path === claimPath && method === 'GET') {
                // An older holder by attempt number, but a body with no uid on it.
                return {
                    status: 200,
                    body: JSON.stringify({ data: { holder: OTHER_HOLDER, claimSeq: '0' } }),
                };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
            if (isClaimDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not be identified/
        );
        // No delete anywhere near the configmaps path, least of all an unconditioned one.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
        expect(calls.some((call) => call.method === 'DELETE' && call.body !== undefined)).toBe(false);
    });

    // A blink on the post-create verify is not proof the claim moved: the read runs with the
    // same bounded patience the status poll has, and only a definitive answer stands the run down.
    it('keeps the run through a transient failure on the post-create claim verify', async () => {
        const claimPath = claimPathFor(job.id);
        let reads = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // First read: the apiserver blinks right after the Job POST. Second: ours.
                    return Promise.resolve(
                        reads === 1
                            ? { status: 503, body: 'unavailable' }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, claimSeq: '1' },
                                  }),
                              }
                    );
                }
                return { status: 200, body: '{}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The 503 was retried, not acted on; the run created its Job and released its claim.
        expect(reads).toBeGreaterThanOrEqual(2);
        expect(
            calls.filter(
                (call) =>
                    call.method === 'POST' &&
                    call.path === jobsPath(namespace) &&
                    (call.body as { metadata?: { name?: string } } | undefined)?.metadata?.name === runnerJobName(job)
            )
        ).toHaveLength(1);
    });

    /*
     * The bracket's first half: a takeover already visible BEFORE the Job POST must meet a
     * create() that creates nothing — the older attempt never becomes a second writer on the
     * checkout, not even briefly. The claim read that answers the takeover is the one between
     * the sweep and the POST.
     */
    it('stands down before creating the runner job when the claim is taken over before the POST', async () => {
        const claimPath = claimPathFor(job.id);
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath && method === 'GET') {
                // The takeover lands between the sweep and the Job POST.
                return {
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'claim-uid-7' },
                        data: { holder: NEW_TOKEN, claimSeq: '2' },
                    }),
                };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return { status: 200, body: '{}' };
            }
            if (isClaimDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/stands down/);
        // The takeover was visible before the POST: no Job is ever created...
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        // ...and nothing on the jobs path is deleted — this attempt has nothing there to delete.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(jobsPath(namespace)))).toBe(
            false
        );
    });

    // The pre-create verify carries the same bounded patience as every verdict-carrying read: a
    // blink before the Job POST is waited out, not acted on — and the Job is posted exactly
    // once, only after the claim is confirmed.
    it('waits out a blink on the pre-create claim verify, and posts the Job only after it', async () => {
        const claimPath = claimPathFor(job.id);
        let reads = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    // The apiserver blinks on the FIRST claim read of the run — the pre-create
                    // verify's — and answers ours from then on.
                    return Promise.resolve(
                        reads === 1
                            ? { status: 503, body: 'unavailable' }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, claimSeq: '1' },
                                  }),
                              }
                    );
                }
                return { status: 200, body: '{}' };
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(
            calls.filter(
                (call) =>
                    call.method === 'POST' &&
                    call.path === jobsPath(namespace) &&
                    (call.body as { metadata?: { name?: string } } | undefined)?.metadata?.name === runnerJobName(job)
            )
        ).toHaveLength(1);
        const firstClaimRead = calls.findIndex((call) => call.method === 'GET' && call.path === claimPath);
        const jobPost = calls.findIndex((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(firstClaimRead).toBeGreaterThanOrEqual(0);
        expect(firstClaimRead).toBeLessThan(jobPost);
    });

    /*
     * The post-create verify matrix. No runner stays on a checkout its driver cannot verify: when
     * the post-create verify spends its whole patience without an answer — or answers but cannot
     * name a holder, neither provably ours nor a definitive loss — the loser best-effort deletes
     * its OWN Job (Foreground) and burns the attempt, the fence's own rule.
     *
     * The failed-delete rule: a stand-down whose own-Job DELETE answers neither 2xx nor 404 leaves
     * the Job's fate to the kubelet's deadline — and this attempt's runner may still be on the
     * checkout when a replacement claimant arrives. So the claim is NOT released: the next
     * claimant's stale-holder takeover (uid-preconditioned release, then a sweep of every
     * `factory.job=<id>` Job) is the documented route that reclaims both. A 404 is a SUCCESS (the
     * Job is already gone) and a 2xx the ordinary success: both release the claim,
     * uid-preconditioned as ever.
     */
    const ours = {
        status: 200,
        body: JSON.stringify({ metadata: { uid: 'claim-uid-1' }, data: { holder: job.leaseToken, claimSeq: '1' } }),
    };
    const noHolder = { status: 200, body: JSON.stringify({ metadata: { uid: 'claim-uid-x' } }) };
    // Read 1 is the pre-create verify (ours); reads 2 through POLL_MAX_CONSECUTIVE_FAILURES + 1 are
    // the post-create verify; anything after would be the release's read.
    const spent = (read: number): boolean => read > 1 + POLL_MAX_CONSECUTIVE_FAILURES;
    const verifyCases: {
        name: string;
        claimRead: (read: number) => { status: number; body: string };
        deleteStatus: number;
        error: RegExp;
        claim: 'held' | 'released';
    }[] = [
        {
            name: 'removes its own Job when the post-create claim verify exhausts its patience',
            // Every post-create read answers 503, the release's read too.
            claimRead: (read) => (read === 1 ? ours : { status: 503, body: 'unavailable' }),
            deleteStatus: 200,
            error: /in a row|unavailable|checkout claim/i,
            claim: 'held',
        },
        {
            name: 'removes its own Job when the post-create claim verify cannot name a holder',
            // Every later read answers 200 with a body that carries no holder at all.
            claimRead: (read) => (read === 1 ? ours : noHolder),
            deleteStatus: 200,
            error: /could not be confirmed/,
            claim: 'held',
        },
        {
            name: 'holds the claim when the post-create verify exhausts its patience and the own-Job delete fails',
            claimRead: (read) => (read === 1 || spent(read) ? ours : { status: 500, body: 'unavailable' }),
            deleteStatus: 500,
            error: /in a row/,
            claim: 'held',
        },
        {
            name: 'releases the claim when the own-Job delete answers 404 — already gone is a success',
            claimRead: (read) => (read === 1 || spent(read) ? ours : { status: 500, body: 'unavailable' }),
            deleteStatus: 404,
            error: /in a row/,
            claim: 'released',
        },
        {
            name: 'releases the claim when the own-Job delete succeeds after an exhausted post-create verify',
            claimRead: (read) => (read === 1 || spent(read) ? ours : { status: 500, body: 'unavailable' }),
            deleteStatus: 200,
            error: /in a row/,
            claim: 'released',
        },
        {
            // Uniformity: the unverifiable branch holds the claim on a failed delete exactly like
            // the exhausted-patience branch — and here the release read WOULD answer ours, so the
            // hold is the only thing standing between the claim and its release.
            name: 'holds the claim when the verify cannot name a holder and the own-Job delete fails',
            claimRead: (read) => (read === 2 ? noHolder : ours),
            deleteStatus: 500,
            error: /could not be confirmed/,
            claim: 'held',
        },
    ];
    it.each(verifyCases.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
        const { claimRead, deleteStatus, error, claim } = row;
        const claimPath = claimPathFor(job.id);
        let reads = 0;
        // A delete that answered 200 or 404 leaves the Job reading gone, as the apiserver does —
        // the acknowledged stand-down confirms that before the claim may go (issue #821).
        let jobGone = false;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath) {
                if (method === 'GET') {
                    reads += 1;
                    return Promise.resolve(claimRead(reads));
                }
                return { status: 200, body: '{}' };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                if (deleteStatus === 200 || deleteStatus === 404) jobGone = true;
                return { status: deleteStatus, body: deleteStatus === 404 ? '{"kind":"Status"}' : '{}' };
            }
            if (method === 'GET' && path === jobPath(namespace, runnerJobName(job)) && jobGone) {
                return { status: 404, body: '{"kind":"Status"}' };
            }
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(error);
        // The delete names only this attempt's own Job, Foreground — best-effort.
        // By the uid its create answered (issue #821): that incarnation and no other.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, runnerJobName(job))}?propagationPolicy=Foreground`,
            body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'job-uid-1' } },
        });
        if (claim === 'held') {
            expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
        } else {
            const release = calls.find((call) => call.method === 'DELETE' && call.path === claimPath);
            expect(release).toBeDefined();
            expect((release?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBe(
                'claim-uid-1'
            );
        }
    });

    /*
     * The taken-over branch sets the hold flag the same way, but the claim itself was never this
     * attempt's to release once a newer attempt holds it — releaseClaim was a no-op there before
     * the flag existed, and this pin keeps the uniform flag from regressing that: a failed delete
     * must not turn a no-op release into a delete of a claim this attempt does not hold.
     */
    it('leaves a taken-over claim untouched when the stand-down deletes nothing', async () => {
        const claimPath = claimPathFor(job.id);
        let jobPosted = false;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === jobsPath(namespace)) {
                jobPosted = true;
                return FAKE.create as K8sResponse;
            }
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPath && method === 'GET') {
                // The claim is ours until this attempt's Job exists; the takeover lands the
                // moment it is. Later reads — the release's — still answer the new holder.
                return Promise.resolve(
                    jobPosted
                        ? {
                              status: 200,
                              body: JSON.stringify({
                                  metadata: { uid: 'claim-uid-9' },
                                  data: { holder: NEW_TOKEN, claimSeq: '2' },
                              }),
                          }
                        : {
                              status: 200,
                              body: JSON.stringify({
                                  metadata: { uid: 'claim-uid-8' },
                                  data: { holder: job.leaseToken, claimSeq: '1' },
                              }),
                          }
                );
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return { status: 500, body: 'refused' };
            }
            if (isClaimDelete(method, path)) return noAnswer(method, path);
        });

        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /taken over before the runner could start/
        );
        // The stand-down did try its own Job delete — and only its own.
        // By the uid its create answered (issue #821): that incarnation and no other.
        expect(calls).toContainEqual({
            method: 'DELETE',
            path: `${jobPath(namespace, runnerJobName(job))}?propagationPolicy=Foreground`,
            body: { apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid: 'job-uid-1' } },
        });
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(NEW_TOKEN))).toBe(false);
        // And the claim that moved on is never deleted.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.startsWith(configmapsPath))).toBe(false);
    });

    // The sweep deletes only when the claim verify answers definitively: a blink on the claim
    // read is 'unknown' — nothing is deleted that round, and the fence looks again within its
    // bound, because deleting on a maybe is what would reach the winner's Job.
    it('deletes nothing on a round whose claim verify could not be confirmed, and looks again', async () => {
        const leftover = 'factory-job-11111111-1111-4111-8111-111111111111-oldlease-runner';
        let claimReads = 0;
        let lists = 0;
        const { request, calls } = routed((method, path) => {
            if (method === 'POST' && path === configmapsPath) {
                return { status: 201, body: '{}' };
            }
            if (path === claimPathFor(job.id)) {
                if (method === 'GET') {
                    claimReads += 1;
                    // The sweep's FIRST verify read: the apiserver blinks. The second (and every
                    // later read, including the post-create verify and the release) answers ours.
                    return Promise.resolve(
                        claimReads === 1
                            ? { status: 503, body: 'unavailable' }
                            : {
                                  status: 200,
                                  body: JSON.stringify({
                                      metadata: { uid: 'claim-uid-1' },
                                      data: { holder: job.leaseToken, claimSeq: '1' },
                                  }),
                              }
                    );
                }
                return { status: 200, body: '{}' };
            }
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                lists += 1;
                return {
                    status: 200,
                    body: JSON.stringify({
                        items: lists <= 2 ? [{ metadata: { name: leftover, uid: `uid-${leftover}` } }] : [],
                    }),
                };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                return { status: 200, body: '{}' };
            }
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // LIST ×2 (leftover in jobs; pods empty), verify 503 → no delete, LIST ×2 (leftover
        // again), verify ours → DELETE, LIST ×2 (clean), claim re-verified, create, verify,
        // poll, pods, log, release, release-delete, Secret reap.
        expect(calls.map((call) => call.method)).toEqual([
            'POST',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'GET',
            'DELETE',
            'GET',
            'GET',
            ...RUN_FROM_SECRET,
        ]);
        expect(calls[7]?.path).toBe(`${jobPath(namespace, leftover)}?propagationPolicy=Foreground`);
    });

    // The board refuses a complete POST that does not fit its body limit — an oversized report
    // would fail to report, leave the job to its lease, and re-run finished work until the job
    // went dead. The cap has to hold for the WORST log, not the average one: a character cap
    // counts UTF-16 units, and 64 Ki of CJK text is 192 KiB of UTF-8, while control characters
    // expand six-fold under JSON escaping.
    it('keeps the report under the board body limit even fully escaped', async () => {
        // CJK: three bytes per character in UTF-8. Control characters: up to six bytes once
        // JSON.stringify escapes them. Together, the worst case the report can face.
        const oversized = 'あ'.repeat(100 * 1024) + '\u0001'.repeat(100 * 1024);
        const { request } = fakeRequest({ log: { status: 200, body: oversized } });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        const body = JSON.stringify({
            leaseToken: job.leaseToken,
            status: 'succeeded',
            exitCode: 0,
            output: outcome.output,
        });
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(128 * 1024);
        // The tail, not the head: a run that fails says why at the end.
        expect(outcome.output.endsWith('\u0001')).toBe(true);
    });

    // A 503 during an apiserver upgrade, or a dropped connection, is not the run's verdict — the
    // pod may already have succeeded. The poll retries a bounded number of times instead of
    // abandoning the job to its lease and re-running it.
    it('keeps polling through transient API failures', async () => {
        let gets = 0;
        const { request } = routed((method, path) => {
            if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                gets += 1;
                if (gets <= 2) return { status: 503, body: 'unavailable' };
                return FAKE.job as K8sResponse;
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(gets).toBe(3);
    });

    // HTTP failures and transport exceptions take separate branches, but have the same bound and
    // cleanup contract: the run leaves the group to the loop's `finish`, which the loop calls on
    // every exit and which reaps the attempt's Secrets first — but a Job its driver cannot read is
    // no confirmed end, so the checkout claim is kept (issue #821) and the Job is not deleted (#869). One table keeps that contract
    // in one place instead of duplicating the whole attempt fixture.
    it.each(['http', 'transport'] as const)(
        'abandons after consecutive %s polling failures, reaps the attempt Secret on finish and keeps the unconfirmed claim',
        async (failure) => {
            const base = fakeRequest({ job: { status: 503, body: 'unavailable' } });
            let failedReads = 0;
            const request: K8sRequest = (method, path, body) => {
                if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                    failedReads += 1;
                    if (failure === 'transport') return Promise.reject(new Error('connection reset'));
                }
                return base.request(method, path, body);
            };
            const calls = base.calls;
            const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
            const attempt = supervisedRunner(
                loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
                request,
                async () => {}
            );
            await expect(attempt.run(envJob, { id: SESSION, resume: false })).rejects.toThrow(
                failure === 'http' ? /in a row/ : /connection reset/
            );

            expect(failedReads).toBe(POLL_MAX_CONSECUTIVE_FAILURES);
            const claimDeleted = (): boolean =>
                calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(envJob.id));
            expect(claimDeleted()).toBe(false);
            const secretPath = `/api/v1/namespaces/${namespace}/secrets/${secretName(envJob)}`;
            expect(calls.some((call) => call.method === 'DELETE' && call.path === secretPath)).toBe(false);

            await attempt.finish(envJob);
            const secretCreate = calls.findIndex((call) => call.method === 'POST' && call.path?.endsWith('/secrets'));
            const secretReap = calls.findIndex((call) => call.method === 'DELETE' && call.path === secretPath);
            const jobDelete = calls.findIndex(
                (call) => call.method === 'DELETE' && call.path?.startsWith(jobPath(namespace, runnerJobName(envJob)))
            );
            expect(secretReap).toBeGreaterThan(secretCreate);
            // A Job that never read is no evidence it ended: it is kept for a later read, never deleted (#869).
            expect(jobDelete).toBe(-1);
            expect(claimDeleted()).toBe(false);
        }
    );

    // Two outages of 10 reads each would trip the bound if the count carried across them — it
    // must not. One good read in between proves the job is alive and observable again.
    it('recounts after a good read, so separate outages do not add up', async () => {
        const outage = (): K8sResponse => ({ status: 503, body: 'unavailable' });
        const script: K8sResponse[] = [
            ...Array.from({ length: 10 }, outage),
            { status: 200, body: JSON.stringify({ status: {} }) },
            ...Array.from({ length: 10 }, outage),
            FAKE.job as K8sResponse,
        ];
        let served = 0;
        const { request } = routed((method, path) => {
            if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                return script[served++] ?? outage();
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
        expect(served).toBe(22);
    });

    /*
     * A completed pod can be garbage-collected before the list that reads its exit code. The Job
     * status is then the verdict: this Job runs one pod and never retries it, so the controller
     * can only have counted success on an exit-0 termination — and a null exit code would map to
     * `failed` in the loop, recording finished work as failed. A failed Job still reports failed.
     */
    it.each<[string, Record<string, unknown>, number | null]>([
        ['treats the Job status as the verdict when its pod is already gone', {}, 0],
        [
            'still reports a failed job when its pod is gone',
            { job: { status: 200, body: JSON.stringify({ status: { failed: 1 } }) } },
            null,
        ],
    ])('%s', async (_name, overrides, exitCode) => {
        const { request } = fakeRequest({ ...overrides, pods: { status: 200, body: JSON.stringify({ items: [] }) } });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode, timedOut: false, output: '' });
    });

    // After a re-claim, the replaced attempt's pod can still be listed while it terminates — same
    // job-name label, different run. Its exit code must never be reported as this run's verdict.
    it('skips a pod that is still terminating, rather than reporting its exit code', async () => {
        const { request } = fakeRequest({
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: `${podName}-old`, deletionTimestamp: '2026-08-29T12:06:00.000Z' },
                            status: {
                                containerStatuses: [{ name: AGENT_CONTAINER, state: { terminated: { exitCode: 7 } } }],
                            },
                        },
                        {
                            metadata: { name: podName },
                            status: {
                                containerStatuses: [{ name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } }],
                            },
                        },
                    ],
                }),
            },
        });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.exitCode).toBe(0);
    });

    // A vanished Job object is not a transient failure: its verdict can never arrive, so polling
    // on would hold a worker slot forever. Deleted by anything but this driver, it is a runner the
    // platform took away — an infrastructure loss, as docker's removed container is.
    it('reads a runner Job deleted under the run as an infrastructure loss', async () => {
        const { request } = fakeRequest({ job: { status: 404, body: '{"kind":"Status"}' } });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ started: true, exitCode: null, timedOut: false });
        expect(outcome.infraLoss).toBe(`the runner job ${runnerJobName(job)} was deleted before it exited`);
    });

    // Why the driver ends a run is recorded on the runner Job itself, for a claim that adopts it.
    it('records a kill reason as an annotation on the runner Job, and tolerates a Job already gone', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).recordKill(job, { reason: 'artifact_spool_full', detail: '2000000000 bytes' });
        expect(calls).toContainEqual({
            method: 'PATCH',
            path: jobPath(namespace, runnerJobName(job)),
            body: { metadata: { annotations: { 'factory.kill.artifact_spool_full': '2000000000 bytes' } } },
        });

        const gone = fakeRequest({ job: { status: 404, body: '{"kind":"Status"}' } });
        await expect(
            runner(gone.request).recordKill(job, { reason: 'artifact_spool_full', detail: '' })
        ).resolves.toBeUndefined();
    });

    // The supervisor's report is its finalization: a crash after it is no loss of the run, as on docker.
    it('takes a supervisor that reported and then crashed as finalized, never a loss', async () => {
        const steps = fakeSteps();
        steps.report({
            id: 'report-1',
            outcome: null,
            cause: null,
            agentExit: 0,
            agentEnd: 'exited',
            drained: true,
            serving: true,
        });
        // The runner Job still serves the attempt's steps; every other Job (the close-time read) ends.
        const active = { status: 200, body: JSON.stringify({ status: { active: 1 } }) };
        const { request } = routed(
            (method, path) =>
                method === 'GET' && path === jobPath(namespace, runnerJobName(job)) ? active : undefined,
            {
                pods: {
                    status: 200,
                    body: JSON.stringify({
                        items: [
                            {
                                metadata: { name: podName },
                                status: {
                                    containerStatuses: [
                                        { name: 'agent', state: { terminated: { exitCode: 0 } } },
                                        { name: 'supervisor', state: { terminated: { exitCode: 70 } } },
                                    ],
                                },
                            },
                        ],
                    }),
                },
            }
        );
        const outcome = await runner(request, {}, undefined, steps.sink).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(outcome).not.toHaveProperty('infraLoss');
    });

    // BEL-127: a node-killed pod's statuses are ContainerStatusUnknown with null times; the run reads
    // it as the supervisor's loss (an infrastructure loss), not as an unreadable pod list.
    it('ends a run whose killed pod left null container times as an infrastructure loss', async () => {
        const unknown = {
            terminated: { exitCode: 137, reason: 'ContainerStatusUnknown', startedAt: null, finishedAt: null },
        };
        const { request } = fakeRequest({
            job: { status: 200, body: JSON.stringify({ status: { failed: 1 } }) },
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName, creationTimestamp: null, deletionTimestamp: null },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [
                                    { name: AGENT_CONTAINER, state: unknown },
                                    { name: 'supervisor', state: unknown },
                                ],
                            },
                        },
                    ],
                }),
            },
        });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ started: true, infraLoss: expect.stringMatching(/ContainerStatusUnknown/) });
    });

    // The deadline is enforced by the kubelet, so the Job reports failed with the reason attached;
    // the driver maps that onto the same verdict `docker kill` after DRIVER_JOB_TIMEOUT_MS gets.
    // A current cluster marks the deadline `FailureTarget` first and `Failed` only once the pod is
    // gone; the runner reads the first terminal status it sees, so it must know both.
    it.each<[string, () => unknown]>([
        ['treats DeadlineExceeded as a timeout', () => FAKE.failed],
        [
            'treats a DeadlineExceeded FailureTarget as a timeout too',
            () => ({
                status: 200,
                body: JSON.stringify({
                    status: { failed: 1, conditions: [{ type: 'FailureTarget', reason: 'DeadlineExceeded' }] },
                }),
            }),
        ],
    ])('%s', async (_name, answer) => {
        const { request } = fakeRequest({ job: answer() });
        const outcome = await runner(request).run(job, { id: SESSION, resume: false });

        expect(outcome.timedOut).toBe(true);
    });

    // The runner never started — creation was refused. Reporting `failed` would blame the command
    // for the driver's problem, so the error propagates and the loop leaves the job to its lease.
    it('leaves a job to its lease when the job cannot be created', async () => {
        const { request } = fakeRequest({ create: { status: 500, body: 'nope' } });
        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/500/);
    });

    // The docker twin is pinned `it.fails` in docker.test.ts (#828, slice 1): a run that rejects once
    // its group exists ends nothing here (`k8s-runner.ts:415-420`) — neither the Job nor the
    // checkout claim — and the loop decides.
    it('a run that rejects leaves its group for the loop to decide', async () => {
        const { request, calls } = fakeRequest({ job: { status: 403, body: 'forbidden' } });
        await expect(runner(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /reading the runner job/
        );
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(true);
        expect(calls.filter((call) => call.method === 'DELETE' && call.path?.includes(runnerJobName(job)))).toEqual([]);
        expect(calls.filter((call) => call.method === 'DELETE' && call.path === claimPathFor(job.id))).toEqual([]);
    });

    it('keeps polling the pod list through transient API failures', async () => {
        let lists = 0;
        const { request } = routed((method, path) => {
            if (
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                decodeURIComponent(path).includes('job-name=')
            ) {
                lists += 1;
                // A 503 during an apiserver upgrade is not the run's verdict; the exit code is
                // still out there. The third read succeeds.
                return lists <= 2 ? { status: 503, body: 'unavailable' } : (FAKE.pods as K8sResponse);
            }
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The runner's poll: the claude turn read is a step, with no pod list of its own.
        expect(lists).toBe(3);
    });

    // A log read that fails outright — connection reset, pod gone — must not fail the report: the
    // exit code already carries the verdict, and re-running finished work is the worse outcome.
    it('keeps the verdict when the log read fails outright', async () => {
        const { request } = routed((method, path) => {
            if (path.includes('/log')) return Promise.reject(new Error('connection reset'));
            if (isJobDelete(method, path)) return noAnswer(method, path);
        });

        const outcome = await runner(request).run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        expect(outcome.output).toBe('');
    });

    it('kill deletes the job and tolerates it already being gone', async () => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path) => {
            calls.push({ method, path });
            // First call is the runner Secret's DELETE (200); everything after — the gate Secret,
            // the Job, its confirming reads, the service fleet's lease lists and their deletes —
            // answers 404, the ordinary end of nothing being there.
            return Promise.resolve({ status: calls.length === 1 ? 200 : 404, body: '{}' });
        };
        await runner(request).kill(job);
        await runner(request).kill(job);

        // The attempt's own teardown, Secrets first (issue #821) — by their own names: the
        // group's steps are over with the Job, and a 404 is the ordinary end — then the Job, its
        // confirming read, then the lease-scoped pod and service lists (and 404 deletes for
        // whatever they ever named).
        expect(calls.slice(0, 2)).toEqual([
            { method: 'DELETE', path: `/api/v1/namespaces/${namespace}/secrets/${secretName(job)}` },
            { method: 'DELETE', path: `${jobPath(namespace, runnerJobName(job))}?propagationPolicy=Foreground` },
        ]);
        expect(calls.filter((call) => call.path?.includes('/secrets'))).toHaveLength(2);
        expect(
            calls.every(
                (call) =>
                    call.method === 'DELETE' ||
                    call.path?.includes('?labelSelector=') ||
                    call.path === jobPath(namespace, runnerJobName(job)) ||
                    // The confirmed end's claim read: a claim already gone is left alone.
                    call.path === claimPathFor(job.id)
            )
        ).toBe(true);
    });

    // The id lands in the DELETE path the same way it lands in the create — asserted before it is
    // interpolated, whatever the call.
    it('kill refuses a job id that is not a uuid', async () => {
        const { request } = fakeRequest();
        await expect(runner(request).kill({ ...job, id: 'not-a-uuid' })).rejects.toThrow(/not a uuid/);
    });
});
