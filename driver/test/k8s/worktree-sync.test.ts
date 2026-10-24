import { describe, expect, it } from 'vitest';
import type { Board, BoardJob, ReviewClaim } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import {
    AGENT_CONTAINER,
    SUPERVISOR_CONTAINER,
    type StepRequest,
    type StepResult,
} from '../../src/supervisor-contract.js';
import { StepChannelClosed, type StepSink } from '../../src/step-control.js';
import { newJobState } from '../../src/loop/loop-attempt.js';
import { createReviewRelay } from '../../src/loop/loop-review.js';
import type { LoopRuntime } from '../../src/loop/loop-types.js';
import type { K8sRequest } from '../../src/k8s/k8s-transport.js';
import { jobsPath, runnerJobName, type runnerJobSpec, secretName } from '../../src/k8s/k8s-podspec.js';
import { jobPath } from '../../src/k8s/k8s-auxspec.js';
import type { Call } from '../fixtures/k8s-apiserver.js';
import { StartupRefused } from '../../src/startup-cause.js';
import { CREDENTIAL_HELPER, gitProbeScript, taskCheckoutScript } from '../../src/publish/publish.js';
import { TASK_MOUNT, TASK_ROOT_LABEL, taskVolumeName } from '../../src/task-volume.js';
import {
    SUPERVISED,
    CONTROL_TOKEN,
    job,
    SESSION,
    gatedOf,
    namespace,
    podName,
    fakeRequest,
    routed,
    stepOk,
    fakeSteps,
    runner,
    boardLease,
    NEW_TOKEN,
    OTHER_HOLDER,
    configmapsPath,
    claimPathFor,
} from '../fixtures/k8s-suite.js';

const kindsOf = (steps: { submitted: StepRequest[] }): string[] => steps.submitted.map((step) => step.kind);

/*
 * The startup sync (issue #35), ported: the docker runner creates the task worktree with a
 * `docker run` of the worktree script; here the same script is the same Job shape every other
 * aux Job uses — the declared image over the workspaces PVC, read-write this time, because the
 * whole point is creating the worktree the run will edit. Executor parity is why this exists:
 * without it, every claimed job fails at the loop's sync step.
 */
/*
 * The startup sync is the attempt's first supervised step (issue #771): the fence takes the checkout
 * claim, the attempt's group is created (one Job, its supervisor, its agent), and the sync is a
 * step the supervisor runs as a child process. What it asks and how its answer reads is pinned
 * here; the group's own lifecycle is k8s-group.test.ts.
 */
describe('the worktree sync', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const WORKTREE = '/task/factory';
    const syncOf = (steps: { submitted: StepRequest[] }): StepRequest =>
        steps.submitted.find((s) => s.kind === 'sync')!;
    const syncing = (stdout: string) => fakeSteps((step) => (step.kind === 'sync' ? stepOk(stdout) : stepOk()));
    const SESSION_OF = { id: SESSION, resume: false };
    const sync = (j: BoardJob, steps = fakeSteps(), request = fakeRequest().request, githubToken?: string) =>
        runner(request, {}, undefined, steps.sink).syncCheckout(j, undefined, SESSION_OF, githubToken);
    const deletedGroup = (calls: Call[], j: BoardJob, propagation: string) =>
        calls.findIndex(
            (call) =>
                call.method === 'DELETE' &&
                call.path === `${jobsPath(namespace)}/${runnerJobName(j)}?propagationPolicy=${propagation}`
        );

    it('submits the checkout script as one sync step, naming the checkout, the remote and the branch beside the claim env', async () => {
        const envJob: BoardJob = { ...repoJob, env: { CORE_TOKEN: 'shh' } };
        const steps = fakeSteps();
        expect(await sync(envJob, steps)).toEqual({ ok: true, reason: null });

        const step = syncOf(steps);
        expect(step.argv).toEqual(['node', '-e', taskCheckoutScript]);
        expect(step.env).toEqual({
            CORE_TOKEN: 'shh',
            CHECKOUT: WORKTREE,
            REMOTE: 'https://github.com/Bellows-AI/factory.git',
            BRANCH: `factory/${repoJob.id}`,
        });
        expect(steps.tokens).toEqual(new Set([CONTROL_TOKEN]));
    });

    // The whole attempt in one pod (issues #771-#774): the sync, the setup, a gate, a declared
    // service, a review (snapshot, restore, run, export) and the caller's finish are steps of the
    // task Job's supervisor, so the cluster is asked for the task Job, its Secret and the claim
    // ConfigMap and for nothing else. A new object here is a regression, not an allowance.
    it('creates only the task volume, the task Job, its Secret and the claim ConfigMap for a full attempt, review included', async () => {
        const reviewing: BoardJob = {
            ...gatedOf(repoJob),
            ...SUPERVISED,
            services: [{ name: 'cache', image: 'redis', environment: [] }],
            reviewerProfiles: ['security'],
        };
        const api = routed((method, path) => {
            if (method !== 'GET' || !decodeURIComponent(path).includes('job-name=')) return;
            return {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Running',
                                initContainerStatuses: [
                                    {
                                        name: 'svc-cache',
                                        image: 'redis',
                                        state: { running: { startedAt: '2026-10-19T00:00:00Z' } },
                                        restartCount: 0,
                                    },
                                ],
                                containerStatuses: [{ state: { running: {} } }],
                            },
                        },
                    ],
                }),
            };
        });
        const steps = fakeSteps((step) => {
            if (step.kind === 'sync') return stepOk('{"ok":true,"reason":null}\n');
            if (step.kind === 'probe') return stepOk(`${JSON.stringify({ cloned: true, fingerprint: 'h:1' })}\n`);
            if (step.kind === 'snapshot') return stepOk('{"ok":true}');
            return stepOk('done');
        });
        const k8s = runner(api.request, { RUNNER_SERVICES: '1' }, undefined, steps.sink);

        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });
        const reviewRow = {
            ...reviewing,
            id: '77777777-7777-4777-8777-777777777777',
            rootJobId: reviewing.id,
            leaseToken: NEW_TOKEN,
            executorType: 'claude-code',
            reviewRun: { profile: 'security', ref: 'refs/factory/review/root/sec-1', timeoutMinutes: 5 },
        } as unknown as ReviewClaim;
        const completed: unknown[] = [];
        // The board's real answers: a review is leased in-band with its claim, and completing it
        // answers no reclaim (the caller's thread owns the tree: amendment B6).
        const board = {
            requestReview: async () => ({
                result: 'ok',
                created: true,
                claim: reviewRow,
                review: { key: 'sec-1', evidence: { state: 'none' } },
            }),
            heartbeat: async () => ({ cancelRequested: false }),
            session: async () => undefined,
            complete: async (_row: unknown, body: unknown) => {
                completed.push(body);
                return { state: 'ok', reclaimId: null };
            },
        };
        const rt = {
            runner: k8s,
            board,
            config,
            log: () => undefined,
            sleep: () => new Promise<void>(() => undefined),
            gates: {
                server: { grantExporter: () => undefined, revokeExporter: () => undefined },
            },
        } as unknown as LoopRuntime;

        const state = newJobState();
        expect(await k8s.syncCheckout(reviewing, undefined, SESSION_OF)).toEqual({ ok: true, reason: null });
        const gateAt = { cwd: WORKTREE, env: {}, timeoutMs: 1000 };
        await k8s.runGate(reviewing, { command: 'npm ci', ...gateAt });
        await k8s.runGate(reviewing, { command: 'npm test', ...gateAt });
        expect(await k8s.startServices(reviewing)).toBeNull();
        const verdict = await createReviewRelay(rt, reviewing, state).request('sec-1', 'security');
        expect(verdict).toMatchObject({ created: true });
        await Promise.all([...state.reviews.values()].map((review) => review.settled));
        await k8s.finish(reviewing);

        expect(completed).toEqual([expect.objectContaining({ status: 'succeeded' })]);
        // setup and gate, the services' start, the review (home, restore, run, and the export the reviewer container runs), the finish.
        expect(kindsOf(steps)).toEqual([
            'sync',
            'gate',
            'gate',
            'restart',
            'probe',
            'snapshot',
            'sync',
            'sync',
            'review',
            'review',
            'finish',
        ]);
        const created = api.calls
            .filter((call) => call.method === 'POST')
            .map((call) => ({ path: call.path, name: (call.body as { metadata: { name: string } }).metadata.name }));
        // The claim is taken by the sync and again by the group's creation: one name, one object.
        const objects = [...new Map(created.map((call) => [`${call.path} ${call.name}`, call])).values()];
        expect(objects).toHaveLength(4);
        expect(objects).toEqual(
            expect.arrayContaining([
                { path: `/api/v1/namespaces/${namespace}/persistentvolumeclaims`, name: taskVolumeName(reviewing) },
                { path: configmapsPath, name: expect.any(String) },
                { path: `/api/v1/namespaces/${namespace}/secrets`, name: secretName(reviewing) },
                { path: jobsPath(namespace), name: runnerJobName(reviewing) },
            ])
        );
    });

    // The sync's fetch needs a credential helper to read the token git never reads from the
    // environment — but only beside the token the board minted for it (docs/connections.md): a
    // public repo must keep its plain unauthenticated fetch. What travels as the literal is helper
    // CODE, never the credential value — the token is the step's env alone.
    it("passes the sync the credential-helper code only beside the board's minted token", async () => {
        const withToken = fakeSteps();
        await sync(repoJob, withToken, undefined, 'ghs_minted');
        expect(syncOf(withToken).env.CRED_HELPER).toBe(CREDENTIAL_HELPER);
        expect(syncOf(withToken).env.GITHUB_TOKEN).toBe('ghs_minted');
        expect(syncOf(withToken).env.CRED_HELPER).not.toContain('ghs_minted');

        // A claim value under the reserved name is no token: dropped, never forwarded, no helper.
        const noToken = fakeSteps();
        await sync({ ...repoJob, env: { GITHUB_TOKEN: 't0k-3n', CORE_TOKEN: 'shh' } }, noToken);
        expect(syncOf(noToken).env).not.toHaveProperty('CRED_HELPER');
        expect(JSON.stringify(syncOf(noToken))).not.toContain('t0k-3n');

        // An EMPTY token is no token: the helper would answer an empty password and break the
        // public-repo plain fetch it exists to preserve.
        const emptyToken = fakeSteps();
        await sync(repoJob, emptyToken, undefined, '');
        expect(syncOf(emptyToken).env).not.toHaveProperty('CRED_HELPER');
    });

    // A claim that CONTINUES a session — a follow-up, or a parked job resumed — is mid-task, and
    // git operations that touch the remote belong to the task's beginning and end (issue #58).
    // Its sync is a RESTORE: the step carries the literal, no credential helper even with a
    // token, and no claim env at all.
    it('carries RESTORE for a claim that continues a session, with no helper and no claim env', async () => {
        // The thread's volume is there (a continuing claim with none is restored from a checkpoint instead).
        const held = () =>
            routed((method, path) =>
                method === 'GET' && path.startsWith(`/api/v1/namespaces/${namespace}/persistentvolumeclaims`)
                    ? {
                          status: 200,
                          body: JSON.stringify({
                              items: [
                                  {
                                      metadata: {
                                          name: taskVolumeName(repoJob),
                                          labels: { [TASK_ROOT_LABEL]: repoJob.id },
                                      },
                                  },
                              ],
                          }),
                      }
                    : undefined
            ).request;
        const followUp = fakeSteps();
        await sync({ ...repoJob, followUp: true }, followUp, held(), 't0k-3n');
        expect(syncOf(followUp).env.RESTORE).toBe('1');
        expect(syncOf(followUp).env).not.toHaveProperty('CRED_HELPER');
        expect(JSON.stringify(syncOf(followUp))).not.toContain('t0k-3n');

        // A parked job resumed (resumeSessionId without followUp) is the same mid-task hazard.
        const parked = fakeSteps();
        await sync({ ...repoJob, resumeSessionId: SESSION }, parked, held(), 't0k-3n');
        expect(syncOf(parked).env.RESTORE).toBe('1');
        expect(JSON.stringify(syncOf(parked))).not.toContain('t0k-3n');

        // A starting claim — even with a token — carries no RESTORE.
        const fresh = fakeSteps();
        await sync(repoJob, fresh, undefined, 't0k-3n');
        expect(syncOf(fresh).env).not.toHaveProperty('RESTORE');
    });

    it('carries no claim env for a claim that resolved to none', async () => {
        const steps = fakeSteps();
        await sync(repoJob, steps);
        expect(Object.keys(syncOf(steps).env).sort()).toEqual(['BRANCH', 'CHECKOUT', 'REMOTE']);
    });

    // No task worktree resolves for a thread root that is not a uuid, so there is nothing to sync;
    // the run that follows refuses it (the runner job spec's own refusal, above).
    it('submits nothing for a worktree path it cannot assert', async () => {
        const steps = fakeSteps();
        const { request, calls } = fakeRequest();
        expect(await sync({ ...repoJob, rootJobId: 'not-a-uuid' }, steps, request)).toEqual({ ok: true, reason: null });
        expect(steps.submitted).toEqual([]);
        expect(calls).toHaveLength(0);
    });

    it('takes the claim, then the attempt’s Secret and group, then submits the sync — and keeps all of it for the run', async () => {
        const { request, calls } = fakeRequest();
        const steps = fakeSteps();
        const result = await sync({ ...repoJob, env: { CORE_TOKEN: 'shh' } }, steps, request);

        expect(result).toEqual({ ok: true, reason: null });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const order = calls.map((call) => `${call.method} ${(call.path ?? '').split('?')[0]}`);
        const claimPost = order.indexOf(`POST ${configmapsPath}`);
        expect(claimPost).toBe(0);
        // The group's Job is created suspended, then its Secret, then resumed (issue #821): a Secret
        // never exists without a Job to derive it from, and no pod starts without its Secret.
        expect(claimPost).toBeLessThan(order.indexOf(`POST ${jobsPath(namespace)}`));
        expect(order.indexOf(`POST ${jobsPath(namespace)}`)).toBeLessThan(order.indexOf(`POST ${secretsPath}`));
        expect(order.indexOf(`POST ${secretsPath}`)).toBeLessThan(
            order.indexOf(`PATCH ${jobPath(namespace, runnerJobName(repoJob))}`)
        );
        expect(kindsOf(steps)).toEqual(['sync']);
        // Success KEEPS the claim, the group and its Secret: the run (and its steps after it) follow
        // within the same lease, and releasing here would open a window another claimant could use.
        expect(order).not.toContain(`DELETE ${claimPathFor(repoJob.id)}`);
        expect(calls.filter((call) => call.method === 'DELETE')).toEqual([]);
    });

    it('syncs nothing for a job that names no repository', async () => {
        const { request, calls } = fakeRequest();
        const steps = fakeSteps();
        expect(await sync(job, steps, request)).toEqual({ ok: true, reason: null });
        expect(calls).toHaveLength(0);
        expect(steps.submitted).toEqual([]);
    });

    it.each([
        [
            'the script’s own reason',
            stepOk('{"ok":false,"reason":"worktree sync failed: no space left"}\n'),
            /^worktree sync failed: no space left$/,
        ],
        [
            'the tool’s words when the step exits non-zero with no verdict',
            { exitCode: 2, stdout: '', stderr: 'fatal: could not read from remote repository\n', timedOut: false },
            /^the worktree sync failed: fatal: could not read from remote repository$/,
        ],
        [
            'a named deadline when the supervisor ends the step at its bound',
            { exitCode: null, stdout: '', stderr: '', timedOut: true },
            /^the worktree sync failed: the step exceeded its \d+ms deadline$/,
        ],
        [
            'the last output when a clean exit printed no verdict',
            stepOk('fetching origin\nsome other line\n'),
            /^the worktree sync answered nothing readable[\s\S]*some other line/,
        ],
    ] as const)('answers ok:false with %s', async (_what, answer, reason) => {
        const result = await sync(
            repoJob,
            fakeSteps(() => answer)
        );
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(reason);
    });

    it('carries the script’s failure kind through the step’s answer (issue #666)', async () => {
        const verdict = {
            ok: false,
            reason: 'the task checkout /task/factory does not exist',
            kind: 'branch_unrestorable',
        };
        expect(await sync(repoJob, syncing(`${JSON.stringify(verdict)}\n`))).toMatchObject(verdict);
    });

    // A failed sync means no runner follows, so nobody else would give the checkout back: the
    // claim goes, conditionally on this attempt still holding its exact incarnation.
    it('releases the claim when the sync fails after taking it', async () => {
        const { request, calls } = fakeRequest();
        const result = await sync(
            repoJob,
            syncing('{"ok":false,"reason":"worktree sync failed: no space left"}\n'),
            request
        );
        expect(result.ok).toBe(false);
        const release = calls.find((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
        expect(release).toBeDefined();
        // The uid precondition is what keeps a stale release from reaching a newer claim.
        expect((release?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toBeDefined();
    });

    /*
     * A failure hands the checkout over to a replacement — and a replacement's sync must not
     * overlap the failed attempt's group on the shared worktree. So the failure arms delete the
     * group with Foreground propagation (the delete returns only after the pod is gone) and AWAIT
     * it BEFORE releaseClaim. Modeled with a delay on the group's delete: a release issued before
     * the await would complete (and be recorded) first.
     */
    it('takes the group down Foreground, and only then releases the claim, when the sync fails', async () => {
        const base = fakeRequest();
        const completions: string[] = [];
        const gated: K8sRequest = async (method, path, body) => {
            const response = await base.request(method, path, body);
            if (
                method === 'DELETE' &&
                path === `${jobPath(namespace, runnerJobName(repoJob))}?propagationPolicy=Foreground`
            ) {
                // Foreground returns only once the dependents are gone — that takes time.
                await new Promise((resolve) => setTimeout(resolve, 20));
                completions.push('group-gone');
            } else if (method === 'DELETE' && path === claimPathFor(repoJob.id)) {
                completions.push('claim-released');
            }
            return response;
        };
        const result = await sync(
            repoJob,
            syncing('{"ok":false,"reason":"worktree sync failed: no space left"}\n'),
            gated
        );

        expect(result.ok).toBe(false);
        expect(completions).toEqual(['group-gone', 'claim-released']);
        // The Secret goes with it: nothing of the attempt is left behind a failed sync.
        expect(
            base.calls.some(
                (c) =>
                    c.method === 'DELETE' && c.path === `/api/v1/namespaces/${namespace}/secrets/${secretName(repoJob)}`
            )
        ).toBe(true);
    });

    // The same handover discipline on the THROW arm: a step whose answer never came (the channel
    // closed under it) leaves a group that may still be running, and the rethrow follows the
    // release — so the take-down must be complete before the claim goes.
    it('takes the group down Foreground, and only then releases the claim, when the sync step throws', async () => {
        const base = fakeRequest();
        const completions: string[] = [];
        const gated: K8sRequest = async (method, path, body) => {
            const response = await base.request(method, path, body);
            if (method === 'DELETE' && path.includes(runnerJobName(repoJob))) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                completions.push('group-gone');
            } else if (method === 'DELETE' && path === claimPathFor(repoJob.id)) {
                completions.push('claim-released');
            }
            return response;
        };
        const steps = fakeSteps(() => {
            throw new Error('the step channel closed');
        });
        await expect(sync(repoJob, steps, gated)).rejects.toThrow(/step channel closed/);
        expect(completions).toEqual(['group-gone', 'claim-released']);
    });

    // The mirror pin: success keeps ownership, so no delete of any kind is issued — the claim and
    // the group are held through the run, and `finish` ends the group.
    it('never deletes the group when the sync succeeds', async () => {
        const { request, calls } = fakeRequest();
        expect(await sync(repoJob, fakeSteps(), request)).toEqual({ ok: true, reason: null });
        expect(deletedGroup(calls, repoJob, 'Foreground')).toBe(-1);
        expect(calls.some((call) => call.method === 'DELETE' && call.path.includes(runnerJobName(repoJob)))).toBe(
            false
        );
    });

    // The group's creates, the same transient-400 rule the polls have (issue #308): a pre-handler
    // `400 Bad Request` is connection damage, never the sync's verdict — it throws, and the loop's
    // catch leaves the job to its lease; the throw still hands the checkout over cleanly.
    it.each([
        ['the pre-handler 400', { status: 400, body: '400 Bad Request' }, /creating the runner job answered 400/],
        [
            'a genuine API Status 400',
            {
                status: 400,
                body: '{"kind":"Status","status":"Failure","reason":"Invalid","message":"Job.batch is invalid"}',
            },
            /Job\.batch is invalid/,
        ],
    ])(
        'leaves the sync to the lease when the group POST answers %s, its claim given back',
        async (_what, create, error) => {
            const { request, calls } = fakeRequest({ create });
            await expect(sync(repoJob, fakeSteps(), request)).rejects.toThrow(error);
            expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(true);
        }
    );

    it('leaves the sync to the lease when the attempt’s Secret POST answers the pre-handler 400', async () => {
        const { request } = fakeRequest({ secretCreate: { status: 400, body: '400 Bad Request' } });
        await expect(sync(repoJob, fakeSteps(), request)).rejects.toThrow(/answered 400/);
    });

    /*
     * Issue #302: an executor image the node cannot pull holds the group's pod in ImagePullBackOff
     * and no supervisor ever comes up. The wait names the image the moment the pod does, not after
     * a timeout (the plain case is k8s-group.test.ts). It must not settle while the container is
     * merely WAITING: ContainerCreating covers the whole first pull, and a pull that fails after
     * that tick would otherwise go unnamed (review of issue #302).
     */
    it('keeps watching through ContainerCreating and names the image when the later pull fails', async () => {
        const base = fakeRequest();
        const waitingPod = (reason: string, message?: string): string =>
            JSON.stringify({
                items: [
                    {
                        metadata: { name: podName },
                        status: {
                            containerStatuses: [
                                {
                                    name: AGENT_CONTAINER,
                                    state: { waiting: message ? { reason, message } : { reason } },
                                },
                            ],
                        },
                    },
                ],
            });
        let podReads = 0;
        const request: K8sRequest = async (method, path, body) => {
            if (
                method === 'GET' &&
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                decodeURIComponent(path).includes('job-name=')
            ) {
                podReads += 1;
                return {
                    status: 200,
                    body: waitingPod(
                        podReads === 1 ? 'ContainerCreating' : 'ErrImagePull',
                        podReads === 1 ? undefined : 'pull access denied, repository does not exist'
                    ),
                };
            }
            return base.request(method, path, body);
        };
        const steps = fakeSteps();
        steps.sink.contacted = () => false;
        // Typed by the cause the pod's words prove (#824 D11): a refused credential, a configuration fault.
        const refused = sync(repoJob, steps, request);
        await expect(refused).rejects.toBeInstanceOf(StartupRefused);
        await expect(refused).rejects.toMatchObject({
            startupCause: 'auth',
            message: expect.stringMatching(
                /the executor image "claude-executor" cannot be pulled: ErrImagePull — pull access denied/
            ),
        });
        // Named on the SECOND round: the first round's ContainerCreating did not settle the watch.
        expect(podReads).toBe(2);
        expect(steps.submitted).toEqual([]);
    });

    /*
     * The fence before the sync (PR #46 review): the loop calls syncCheckout before run(), so the
     * sync is the FIRST writer on the task worktree — and the only mutual exclusion it can get is
     * the checkout claim, taken here under the same acquireClaim protocol prepare() runs. The
     * claim is then held through the run: prepare()'s acquire recognizes its own holder.
     */
    // The replacement-with-an-active-runner shape of the review comment: a claim POST that
    // answers 409 against a LIVE newer attempt is the run path's stand-down, and the sync must
    // honor it before creating anything — no Secret, no group, nothing to sweep later.
    it('stands down without creating anything when a live newer attempt holds the claim', async () => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 409, body: '{"reason":"AlreadyExists"}' });
            }
            if (path === claimPathFor(job.id) && method === 'GET') {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'claim-uid-9' },
                        data: { holder: NEW_TOKEN, claimSeq: '2' },
                    }),
                });
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        const steps = fakeSteps();
        await expect(sync(repoJob, steps, request)).rejects.toThrow(/stands down/);
        expect(calls.some((call) => call.method === 'POST' && call.path.includes('/secrets'))).toBe(false);
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        expect(steps.submitted).toEqual([]);
    });

    // #869: a claim the takeover cannot name a holder of proves nothing about its age; it is never deleted on.
    it.each([
        ['no holder', { claimSeq: '1' }],
        ['an empty holder', { holder: '', claimSeq: '1' }],
        ['a holder that is no lease', { holder: 'someone-else', claimSeq: '1' }],
        ['an empty claim sequence', { holder: OTHER_HOLDER, claimSeq: '' }],
        ['a claim sequence beyond the safe integers', { holder: OTHER_HOLDER, claimSeq: '9'.repeat(400) }],
    ])('never takes over a claim with %s', async (_name, data) => {
        const calls: Call[] = [];
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (method === 'POST' && path === configmapsPath) {
                return Promise.resolve({ status: 409, body: '{"reason":"AlreadyExists"}' });
            }
            if (path === claimPathFor(job.id) && method === 'GET') {
                return Promise.resolve({ status: 200, body: JSON.stringify({ metadata: { uid: 'u' }, data }) });
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        await expect(sync({ ...repoJob, claimSeq: 2 }, fakeSteps(), request)).rejects.toThrow();
        expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    });

    it('never takes over a claim whose claim sequence is not a number, even when the board proves the lease', async () => {
        const { request, calls } = fakeRequest();
        await request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: 'corrupt' },
        });
        await expect(
            runner(request, {}, boardLease(repoJob)).syncCheckout(repoJob, undefined, SESSION_OF)
        ).rejects.toThrow(/reading the checkout claim answered an unexpected shape/);
        expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(false);
    });

    /*
     * Issue #559: an interruption (a drain, a lost lease) refunds the attempt, so `attempts` can go DOWN between two
     * claims of one job. The claim is ordered by the claim sequence, which never does — a stale
     * worker whose attempt count is ahead of its replacement's still stands down, and a
     * replacement whose attempt was refunded still takes over the claim it supersedes.
     */
    const seedClaim = (request: K8sRequest, claimSeq: string) =>
        request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq },
        });

    it('stands a stale worker down against a newer claim even when its attempt count is ahead', async () => {
        const { request, calls } = fakeRequest();
        await seedClaim(request, '4');

        await expect(sync({ ...repoJob, attempts: 2, claimSeq: 3 }, fakeSteps(), request)).rejects.toThrow(
            /held by a newer claim \(4 >= 3\)/
        );
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
    });

    it('takes over an older claim after its attempt was refunded', async () => {
        const { request } = fakeRequest();
        await seedClaim(request, '3');
        const replacement: BoardJob = { ...repoJob, attempts: 1, claimSeq: 4 };

        expect(await sync(replacement, fakeSteps(), request)).toMatchObject({ ok: true });

        const held = await request('GET', claimPathFor(repoJob.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: replacement.leaseToken, claimSeq: '4' } });
    });

    // Review of PR #564: a claim a pre-#559 driver wrote carries no claimSeq, and is never taken
    // over on that absence alone — only when the board proves this attempt's lease is the live one.
    const seedLegacyClaim = (request: K8sRequest) =>
        request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, attempt: '1' },
        });

    it('takes over a claim with no claim sequence when the board proves this attempt holds the lease', async () => {
        const { request } = fakeRequest();
        await seedLegacyClaim(request);

        expect(
            await runner(request, {}, boardLease(repoJob)).syncCheckout(repoJob, undefined, SESSION_OF)
        ).toMatchObject({ ok: true });
    });

    it.each([
        ['the board names the claim’s holder as the live lease', boardLease(repoJob, NEW_TOKEN)],
        ['the board holds no live lease', boardLease(repoJob, null)],
        ['the board cannot answer', (async () => null) as Board['leases']],
        ['the lookup throws', (async () => Promise.reject(new Error('board unreachable'))) as Board['leases']],
        ['no lookup is wired', undefined],
    ] as const)('stands down on a claim with no claim sequence when %s', async (_what, leases) => {
        const { request, calls } = fakeRequest();
        await seedLegacyClaim(request);

        await expect(runner(request, {}, leases).syncCheckout(repoJob, undefined, SESSION_OF)).rejects.toThrow(
            /stands down/
        );
        expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(false);
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
    });

    // The sync takes the claim, the run follows within the same lease on the SAME group: the run's
    // acquire must read the claim it meets as ITS OWN (holder === lease token) and proceed, never
    // stand down against itself — and it creates no second group.
    it('hands the claim and the group to the run that follows without standing down against itself', async () => {
        const { request, calls } = fakeRequest();
        const r = runner(request);
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        const outcome = await r.run(repoJob, SESSION_OF);
        expect(outcome.exitCode).toBe(0);
        const groups = calls.filter(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                JSON.stringify(call.body).includes('"factory-runner-')
        );
        expect(groups).toHaveLength(1);
    });
});

/*
 * The terminal reclaim (issue #775): the thread's tree lives on its own task volume, which only the
 * reaper deletes, so the reclaim is an acknowledged no-op — no group, no Secret, no checkout claim,
 * no request at all, and nothing a live follow-up could be hurt by.
 */
describe('the terminal reclaim', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory', env: { GITHUB_TOKEN: 't0k-3n' } };

    it.each([
        ['a job with a repository', repoJob],
        ['a job that names none', job],
        ['a thread root that is no uuid', { ...repoJob, rootJobId: 'not-a-uuid' }],
    ])('acknowledges %s without asking the cluster anything', async (_what, of) => {
        const { request, calls } = fakeRequest();
        expect(await runner(request).reclaimWorktree(of)).toEqual({ ok: true, removed: false, reason: null });
        expect(calls).toHaveLength(0);
    });
});

/*
 * Publishing, ported (docs/jobs.md): the same publishCheckout workflow the docker runner runs, over
 * this executor's transport — one supervised step per publish step, in the attempt's group, the
 * claim env (and the board's fresh token) riding the step itself. The flow tests script each step's
 * (exit code, output) pair in order, because every step asks the same channel.
 */
describe('publishing the produced work', () => {
    const ISSUE_JOB: BoardJob = {
        ...job,
        command: '/fix https://github.com/Bellows-AI/factory/issues/10',
        repo: 'Bellows-AI/factory',
        env: { GITHUB_TOKEN: 't0k-3n' },
    };
    const WT = `${TASK_MOUNT}/factory`;
    const PR_URL = 'https://github.com/Bellows-AI/factory/pull/42';

    const DIRTY_ON_MAIN = {
        cloned: true,
        branch: 'main',
        defaultBranch: 'main',
        dirty: true,
        unpushed: 0,
        hasIdentity: false,
    };
    const HEAD_SHA = 'a'.repeat(40);
    const failed = (exitCode: number, stdout = ''): StepResult => ({ exitCode, stdout, stderr: '', timedOut: false });

    /**
     * The supervisor's answers to a publish, by what each step IS rather than by its place in the
     * sequence — the workflow orders its steps (publish.ts), this only answers them: the probe
     * with `probe`, HEAD with a sha, the publication ledger empty, `git switch` as a branch that
     * needs creating, no PR yet, the PR it opens, and every other step a quiet success unless
     * `step` overrides it.
     */
    const scripted = (over: { probe?: object; step?: (step: StepRequest) => StepResult | null } = {}) =>
        fakeSteps((step) => {
            const argv = step.argv;
            const has = (word: string) => argv.includes(word);
            const custom = over.step?.(step);
            if (custom) return custom;
            if (step.kind === 'sync' || step.kind === 'go') return stepOk();
            if (argv[2] === gitProbeScript) return stepOk(JSON.stringify(over.probe ?? DIRTY_ON_MAIN));
            if (has('rev-parse')) return stepOk(`${HEAD_SHA}\n`);
            if (step.env.ACTION) return stepOk(step.env.ACTION === 'read' ? '{}' : '');
            if (has('switch')) return has('-c') ? stepOk() : failed(1);
            if (has('pr') && has('view')) return failed(1);
            if (argv[2]?.includes('shortstat')) {
                return stepOk(JSON.stringify({ title: 'Fix the sync re-claim fence', body: '## Commits' }));
            }
            if (has('pr') && has('create')) return stepOk(`${PR_URL}\n`);
            return stepOk();
        });
    const publishing = (steps: { sink: StepSink }, request = fakeRequest().request) =>
        runner(request, {}, undefined, steps.sink);
    const publishStepsOf = (steps: { submitted: StepRequest[] }) =>
        steps.submitted.filter((step) => step.kind === 'publish');

    it('branches, commits, pushes and opens the PR — one step per git/gh call, in order', async () => {
        const steps = scripted();
        const { request, calls } = fakeRequest();
        const result = await publishing(steps, request).publishGit(ISSUE_JOB);

        expect(result).toEqual({
            ok: true,
            published: true,
            branch: 'fix/10',
            prUrl: PR_URL,
            reason: null,
            repository: 'Bellows-AI/factory',
            baseBranch: 'main',
            prNumber: 42,
            cause: null,
        });
        const sent = publishStepsOf(steps);
        // Each step has an identity of its own; the supervisor answers a retried one from its ledger.
        expect(new Set(sent.map((step) => step.id)).size).toBe(sent.length);
        // No Job per step: the one group of the attempt, and nothing else.
        const jobs = calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(jobs).toHaveLength(1);
        // The decisions are publishCheckout's (publish-checkout.test.ts); this is their rendering
        // as steps: each step's argv, the token never in one.
        const commands = sent.map((step) => step.argv);
        const order = (word: string): number => commands.findIndex((argv) => argv.includes(word));
        expect(order('switch')).toBeLessThan(order('add'));
        expect(order('add')).toBeLessThan(order('commit'));
        expect(order('commit')).toBeLessThan(order('push'));
        expect(order('push')).toBeLessThan(order('create'));
        const commit = commands.find((argv) => argv.includes('commit'));
        expect(commit).toContain('/fix https://github.com/Bellows-AI/factory/issues/10 (#10)');
        expect(commit).toContain('user.name=factory-ai');
        const push = commands.find((argv) => argv.includes('push'));
        expect(push!.join(' ')).toContain('credential.helper=');
        expect(push).toContain('--force-with-lease');
        // The summarizer is one step like every other (issue #82): node over the worktree, the
        // BASE ref and the backstop commit's subject as literal envs, and no credential — local
        // git reads only. Its worktree anchor is pinned explicitly, because its failure mode
        // without one is the quiet one: nulls, and the command title this issue removes.
        const summary = sent.find((step) => step.argv[2]?.includes('shortstat'));
        expect(summary).toBeDefined();
        expect(summary!.argv).toEqual(['node', '-e', expect.stringContaining('shortstat')]);
        expect(summary!.env).toEqual({
            BASE: 'origin/main',
            BACKSTOP_TITLE: '/fix https://github.com/Bellows-AI/factory/issues/10 (#10)',
        });
        expect(summary!.cwd).toBe(WT);
        const create = commands.find((argv) => argv.includes('pr') && argv.includes('create'));
        expect(create).toContain('--head');
        expect(create).toContain('fix/10');
        expect(create?.[create.indexOf('--title') + 1]).toBe('Fix the sync re-claim fence (#10)');
        expect(JSON.stringify(commands)).not.toContain('t0k-3n');
    });

    it('hands the claim env and the minted token to the steps that read them, and to no other', async () => {
        const steps = scripted();
        await publishing(steps).publishGit(ISSUE_JOB, 'ghs_minted');

        const sent = publishStepsOf(steps);
        const push = sent.find((step) => step.argv.includes('push'))!;
        expect(push.env.GITHUB_TOKEN).toBe('ghs_minted');
        const add = sent.find((step) => step.argv.includes('add'))!;
        expect(add.env).not.toHaveProperty('GITHUB_TOKEN');
        expect(add.cwd).toBe(WT);
        // The probe takes no working directory and only the REPO literal.
        const probe = sent[0]!;
        expect(probe.cwd).toBeUndefined();
        expect(probe.env).toEqual({ REPO: WT });
    });

    // The loop asks the board for a token right before the push (docs/connections.md); the step
    // must carry THAT credential, and a claim value under the reserved name never. Neither reaches
    // an object the cluster stores for the step.
    it("publishes with the board's minted token in the step env, never a claim value", async () => {
        const steps = scripted();
        const { request, calls } = fakeRequest();
        await publishing(steps, request).publishGit(ISSUE_JOB, 'ghs_fresh');

        const push = publishStepsOf(steps).find((step) => step.argv.includes('push'))!;
        expect(push.env.GITHUB_TOKEN).toBe('ghs_fresh');
        expect(JSON.stringify(publishStepsOf(steps))).not.toContain('t0k-3n');
        expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('ghs_fresh');
    });

    // The post-gate tree read: the publish's probe step alone, with no claim env.
    it('probes the tree fingerprint as one env-less step', async () => {
        const steps = scripted({ probe: { ...DIRTY_ON_MAIN, fingerprint: 'h:1' } });
        const { request, calls } = fakeRequest();

        expect(await publishing(steps, request).probeTree(ISSUE_JOB)).toBe('h:1');

        const probes = steps.submitted.filter((step) => step.kind === 'probe');
        expect(probes).toHaveLength(1);
        expect(probes[0]!.argv).toEqual(['node', '-e', gitProbeScript]);
        expect(probes[0]!.env).toEqual({ REPO: WT });
        expect(calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toHaveLength(1);
    });

    // A Stop while the probe step is still running must not wait for the step to finish on its own.
    it('abandons a pending probe once the stand-down signal aborts', async () => {
        const cancel = new AbortController();
        const sink: StepSink = {
            submit: (_token, step, signal) =>
                step.kind === 'probe'
                    ? new Promise((_resolve, reject) => {
                          signal?.addEventListener('abort', () => reject(new Error('the step was cancelled')));
                          cancel.abort();
                      })
                    : Promise.resolve(stepOk()),
            awaitReport: () => new Promise(() => undefined),
            agentEnded: () => undefined,
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };

        expect(await publishing({ sink }).probeTree(ISSUE_JOB, cancel.signal)).toBeNull();
    });

    it.each([
        ['a probe that answers no fingerprint', stepOk(JSON.stringify(DIRTY_ON_MAIN))],
        ['a probe that failed', failed(1, 'boom')],
    ])('answers null for %s', async (_label, answer) => {
        const steps = scripted({ step: (step) => (step.kind === 'probe' ? answer : null) });
        expect(await publishing(steps).probeTree(ISSUE_JOB)).toBeNull();
    });

    // The review snapshot of an attempt with no group yet (an adopted run): a supervisor-only group
    // is made for it, and its one `snapshot` step carries the stand-down signal.
    it('snapshots the tree as one snapshot step with the signal, making the supervisor-only group', async () => {
        const cancel = new AbortController();
        const steps = fakeSteps((step) => stepOk(step.kind === 'snapshot' ? '{"ok":true}' : ''));
        const { request, calls } = fakeRequest();

        expect(await publishing(steps, request).snapshotTree(ISSUE_JOB, 'review-1', cancel.signal)).toMatchObject({
            ok: true,
        });

        expect(kindsOf(steps)).toEqual(['snapshot']);
        expect(steps.signals).toEqual([cancel.signal]);
        const created = calls.filter((c) => c.method === 'POST' && c.path === jobsPath(namespace));
        expect(
            created.map((c) =>
                (c.body as ReturnType<typeof runnerJobSpec>).spec.template.spec.containers.map((x) => x.name)
            )
        ).toEqual([[SUPERVISOR_CONTAINER]]);
    });

    it('carries no claim env for an env-less claim', async () => {
        const steps = scripted({ probe: { cloned: false } });
        const { env: _env, ...envLess } = ISSUE_JOB;
        const result = await publishing(steps).publishGit(envLess);

        expect(result).toEqual({
            ok: true,
            published: false,
            branch: null,
            prUrl: null,
            reason: 'the checkout has not been cloned yet',
            repository: null,
            baseBranch: null,
            prNumber: null,
            cause: null,
        });
        expect(publishStepsOf(steps).every((step) => !('GITHUB_TOKEN' in step.env))).toBe(true);
    });

    // Executor parity for the publish flag (docs/workflows.md): the flag is read in exactly ONE
    // place — the loop, shared by both executors — so this transport must have no opinion of its
    // own. A `publish: false` claim that reached publishGit anyway would publish; the loop tests
    // pin that the loop never lets it through. If this runner grew its own gate, the flag would
    // live in two places and drift.
    it('leaves the publish decision to the loop: publishGit ignores a publish:false claim', async () => {
        const steps = scripted();
        const result = await publishing(steps).publishGit({ ...ISSUE_JOB, publish: false });

        expect(result.ok).toBe(true);
        expect(publishStepsOf(steps).some((step) => step.argv.includes('push'))).toBe(true);
    });

    // The step's own output is what its failure — and so its cause (#581) — is read from.
    it('fails with the step and the tool’s own words when the push is refused', async () => {
        const steps = scripted({
            step: (step) =>
                step.argv.includes('push')
                    ? {
                          exitCode: 128,
                          stdout: '',
                          stderr: 'remote: Permission to Bellows-AI/factory.git denied to bellows-ai[bot]\nfatal: Authentication failed\n',
                          timedOut: false,
                      }
                    : null,
        });
        const result = await publishing(steps).publishGit(ISSUE_JOB);

        expect(result.ok).toBe(false);
        expect(result.published).toBe(false);
        expect(result.reason).toContain('Permission to Bellows-AI/factory');
        expect(result.cause).toBe('denied');
    });

    // Issue #825, executor parity: a bound publish's tree check rides the supervisor's steps here
    // exactly as under docker — staged hook-free, the commit held to that tree.
    it.each([
        ['pushes when the commit holds the staged tree', 't'.repeat(40), true],
        ['refuses stale, pushing nothing, when a commit hook moved it', 'b'.repeat(40), false],
    ])('a bound publish %s', async (_case, committed, published) => {
        const steps = scripted({
            probe: { ...DIRTY_ON_MAIN, fingerprint: 'h:1' },
            step: (step) => {
                if (step.argv.includes('write-tree')) return stepOk(`${'t'.repeat(40)}\n`);
                return step.argv.includes('HEAD^{tree}') ? stepOk(`${committed}\n`) : null;
            },
        });

        const result = await publishing(steps).publishGit(ISSUE_JOB, undefined, { revision: 'h:1' });

        expect(result).toMatchObject(published ? { ok: true, published } : { ok: false, stale: true });
        const argvs = publishStepsOf(steps).map((step) => step.argv);
        expect(argvs.some((a) => a.includes('write-tree') && a.includes('core.hooksPath=/dev/null'))).toBe(true);
        expect(argvs.some((a) => a.includes('push'))).toBe(published);
    });

    // A step the supervisor never answers (the channel closed under it) is no verdict on the work:
    // it is thrown, and the loop hands the attempt back as an interruption (#925).
    it('throws a closed step channel instead of answering a failed publish', async () => {
        const steps = scripted({
            step: (step) => {
                if (!step.argv.includes('push')) return null;
                throw new StepChannelClosed('the answer');
            },
        });
        await expect(publishing(steps).publishGit(ISSUE_JOB, 'ghs_fresh')).rejects.toBeInstanceOf(StepChannelClosed);
    });
});
