import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import {
    AGENT_CONTAINER,
    EXPORTER_CONTAINER,
    EXPORT_RELAY_SOCKET,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_CREDENTIAL_NAMES,
    type StepRequest,
} from '../../src/supervisor-contract.js';
import { claudeTurnsScript, claudeExportScript, opencodeReadoutScript } from '../../src/container-scripts.js';
import { commandMark, OPENCODE_EXPORT_LIMIT } from '../../src/runner.js';
import type { K8sRequest, K8sResponse } from '../../src/k8s/k8s-transport.js';
import {
    claudeTurnsStep,
    jobsPath,
    opencodeReadoutStep,
    runnerJobName,
    runnerJobSpec,
    secretName,
} from '../../src/k8s/k8s-podspec.js';
import { jobPath } from '../../src/k8s/k8s-auxspec.js';
import type { Call } from '../fixtures/k8s-apiserver.js';
import { TASK_MOUNT, TASK_VOLUME } from '../../src/task-volume.js';
import {
    SUPERVISED,
    job,
    SESSION,
    opencodeJob,
    namespace,
    podName,
    FAKE,
    stepOk,
    defaultStepAnswer,
    fakeSteps,
    supervisedRunner,
    START,
    configmapsPath,
    claimPathFor,
} from '../fixtures/k8s-suite.js';

describe('the runner job spec under opencode', () => {
    const ocConfig = loadDriverConfig({
        EXECUTOR: 'kubernetes',
        K8S_NAMESPACE: namespace,
        RUNNER_SERVICES: '0',
    });

    // The plan is pinned in runner-plan.test.ts; this is the kubernetes rendering of opencode's:
    // the CLI args as the container's args, the env pairs as literal values, never a secretKeyRef.
    it('restores a follow-up session with run --session, the id the CLI itself minted', () => {
        const spec = runnerJobSpec(ocConfig, { ...opencodeJob, followUp: true }, { id: 'ses_abc123', resume: true });
        const container = spec.spec.template.spec.containers[0]!;
        expect(container.args).toEqual([
            'run',
            '--agent',
            'factory',
            '--session',
            'ses_abc123',
            'fix the failing build',
        ]);
        expect(container.env).toContainEqual({
            name: 'XDG_DATA_HOME',
            value: `${TASK_MOUNT}/.factory/opencode/${opencodeJob.id}`,
        });
        expect(container.env).toContainEqual({ name: 'BELLOWS_SESSION_ID', value: 'ses_abc123' });
        expect(container.env).toContainEqual({ name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' });
    });
});

// Issue #822: the permission to start a resumed session that was never written reaches the pod
// as a literal value, on both executors, for a resume of the row's own session (`ownSession`) and
// never for one inherited from an earlier row — docker renders the same plan (docker.test.ts).
describe('the runner pod of a resumed attempt', () => {
    const k8sConfig = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const UNWRITTEN = { name: 'BELLOWS_RESUME_MAY_BE_UNWRITTEN', value: '1' };
    const podEnv = (claimed: BoardJob, session: string) =>
        runnerJobSpec(k8sConfig, { ...claimed, resumeSessionId: session }, { id: session, resume: true }).spec.template
            .spec.containers[0]!.env;

    it.each([
        ['claude-code', job, SESSION],
        ['opencode', opencodeJob, 'ses_abc123'],
    ])(
        'tells a %s resume of its own session, never an inherited one, that it may be unwritten',
        (_name, claimed, session) => {
            expect(podEnv({ ...claimed, ownSession: true }, session)).toContainEqual(UNWRITTEN);
            // A sessionless follow-up's takeover: the session its own first attempt minted.
            expect(podEnv({ ...claimed, followUp: true, ownSession: true }, session)).toContainEqual(UNWRITTEN);
            // A follow-up resuming its parent's session.
            expect(
                podEnv({ ...claimed, followUp: true, ownSession: false }, session).map((entry) => entry.name)
            ).not.toContain(UNWRITTEN.name);
        }
    );

    // A claim continuing an interrupted attempt is framed in its prompt alone: the Job is marked
    // with the unframed command (`COMMAND_MARK`), as the interrupted attempt's runner Job was.
    it.each([
        ['claude-code', job, SESSION, { id: SESSION, resume: false }],
        ['opencode', opencodeJob, 'ses_abc123', null],
    ])(
        'frames a %s continuation into its prompt alone, marking the Job with the command the first claim ran',
        (_name, claimed, session, firstSession) => {
            const first = runnerJobSpec(k8sConfig, claimed, firstSession);
            const continuing = runnerJobSpec(
                k8sConfig,
                { ...claimed, claimSeq: 2, resumeSessionId: session, ownSession: true, continuesInterrupted: true },
                { id: session, resume: true }
            );

            const prompt = continuing.spec.template.spec.containers[0]!.args?.at(-1);
            expect(prompt?.startsWith('Your previous run of this task was interrupted')).toBe(true);
            expect(prompt?.endsWith(`The task, for reference:\n\n${claimed.command}`)).toBe(true);
            expect(continuing.metadata.annotations?.['factory.command']).toBe(commandMark(claimed.command));
            expect(continuing.metadata.annotations?.['factory.command']).toBe(
                first.metadata.annotations?.['factory.command']
            );
        }
    );
});

describe('the opencode session readout step', () => {
    it('runs the readout script by content, with the database path as an env value', () => {
        const step = opencodeReadoutStep(job, START);
        expect(step.argv).toEqual(['node', '-e', expect.stringContaining('node:sqlite')]);
        expect(step.env).toEqual({
            OPENCODE_DB: `${TASK_MOUNT}/.factory/opencode/${opencodeJob.id}/opencode/opencode.db`,
            // The scope: only the session that ran in this job's working directory — the
            // member root here, since the fixture names no repo.
            OPENCODE_DIR: TASK_MOUNT,
            RUN_STARTED_MS: String(Date.parse(START)),
            EXPORT_LIMIT_BYTES: String(OPENCODE_EXPORT_LIMIT),
        });
    });

    it('scopes the readout to the task worktree when the job names a repo', () => {
        expect(opencodeReadoutStep({ ...job, repo: 'Bellows-AI/bellows' }, START).env.OPENCODE_DIR).toBe(
            `${TASK_MOUNT}/bellows`
        );
    });

    it('refuses a job whose workspace path it cannot assert', () => {
        expect(() => opencodeReadoutStep({ ...job, workspacePath: null }, START)).toThrow(/workspace path/);
    });
});

describe('the close-time claude-code turn read under kubernetes', () => {
    /**
     * The twin of docker's close-time read (executor parity): the same script, the same env
     * VALUES, one supervised step of the task pod instead of one throwaway container. The failure
     * path — the step refused, deadlined, or answering nothing parseable — is exercised by every
     * runner test above, whose scripted logs parse as null: unmeasured, never zero.
     */
    it('runs the static script as one step, its inputs by env', () => {
        const step = claudeTurnsStep(job, SESSION, START);
        expect(step.argv).toEqual(['node', '-e', claudeTurnsScript]);
        expect(step.env).toEqual({
            CLAUDE_TRANSCRIPT_DIR: `${TASK_MOUNT}/.factory/transcripts/${job.id}`,
            CLAUDE_SESSION_ID: SESSION,
            // The per-run delta bound: the transcript carries earlier runs' turns too.
            RUN_STARTED_AT: START,
        });
    });

    it('refuses a session id that is not a uuid', () => {
        expect(() => claudeTurnsStep(job, 'not-a-uuid', START)).toThrow(/not a session id/);
    });
});

describe('the transcript artifact Jobs under kubernetes (issue #325)', () => {
    /**
     * Executor parity for the transcript artifact Jobs: the same aux-Job shape, the
     * same env-VALUES rule, exporting the run's transcript instead of counting it. Names are
     * distinct from the turns Jobs' — the hash key is the same (job, lease) pair, and one
     * attempt's transcript Job and its turn Job must not collide.
     */
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });

    it('claude: the exporter is a container of the run’s pod that holds no credential, only the supervisor’s relay socket', () => {
        const spec = runnerJobSpec(config, { ...job, ...SUPERVISED }, { id: SESSION, resume: false });
        const container = spec.spec.template.spec.containers.find((c) => c.name === EXPORTER_CONTAINER)!;
        expect(container.command).toEqual(['node', '-e', claudeExportScript]);
        expect(container.env).toContainEqual({
            name: 'CLAUDE_TRANSCRIPT_DIR',
            value: `${TASK_MOUNT}/.factory/transcripts/${job.id}`,
        });
        expect(container.env?.map((e) => e.name)).not.toContain('RUN_STARTED_AT');
        expect(container.env).toContainEqual({ name: 'FACTORY_EXPORT_DIR', value: '/factory/export' });
        expect(container.env).toContainEqual({ name: 'EXPORT_CONTROL_SOCKET', value: EXPORT_RELAY_SOCKET });
        expect(JSON.stringify(container.env)).not.toMatch(/secretKeyRef|BELLOWS_CONTROL/);
        // The supervisor holds the control pair and the two tokens it relays under (#829 S3c); the
        // exporter and the agent hold none of them.
        const keysOf = (name: string) =>
            JSON.stringify(spec.spec.template.spec.containers.find((c) => c.name === name)?.env ?? []);
        expect(keysOf(EXPORTER_CONTAINER)).not.toContain('SUPERVISOR_CONTROL_TOKEN');
        expect(keysOf(SUPERVISOR_CONTAINER)).toContain('SUPERVISOR_CONTROL_TOKEN');
        for (const name of ['SUPERVISOR_AGENT_TOKEN', 'SUPERVISOR_EXPORT_TOKEN']) {
            expect(container.env).not.toContainEqual(expect.objectContaining({ name }));
            expect(spec.spec.template.spec.containers.find((c) => c.name === SUPERVISOR_CONTAINER)?.env).toContainEqual(
                { name, valueFrom: { secretKeyRef: { name: secretName(job), key: name } } }
            );
        }
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(keysOf(AGENT_CONTAINER)).not.toContain(name);
        expect(JSON.stringify(spec)).not.toMatch(/"value":"[^"]*tok-/);
        // The member's subtree and the one mailbox it shares with the supervisor — nothing else.
        expect(container.volumeMounts).toEqual([
            { name: TASK_VOLUME, mountPath: TASK_MOUNT },
            { name: 'ctl-export', mountPath: '/factory/export' },
        ]);
    });

    it('opencode: exports through the readout step, not a container of its own', () => {
        const { env } = opencodeReadoutStep(job, START);
        expect(env.EXPORT_LIMIT_BYTES).toBe(String(OPENCODE_EXPORT_LIMIT));
        expect(env.OPENCODE_DB).toBe(`${TASK_MOUNT}/.factory/opencode/${job.id}/opencode/opencode.db`);
    });
});

describe('the kubernetes runner under opencode', () => {
    const ns = `/api/v1/namespaces/${namespace}`;

    const ok = (body: unknown) => Promise.resolve({ status: 200, body: JSON.stringify(body) });

    /**
     * A router scripted for one opencode run: the runner Job goes terminal succeeded, the
     * close-time readout is a supervised `probe` step answered with `readoutLog`. Every claim and teardown route
     * answers the boring way. The calls list is the audit.
     */
    const opencodeFake = (readout: { exitCode?: number; log?: string; reject?: Error } = {}) => {
        const calls: Call[] = [];
        const steps = fakeSteps(async (step) => {
            if (step.kind !== 'probe') return defaultStepAnswer(step);
            if (readout.reject) throw readout.reject;
            return { exitCode: readout.exitCode ?? 0, stdout: readout.log ?? '', stderr: '', timedOut: false };
        });
        const request: K8sRequest = (method, path, body) => {
            calls.push({ method, path, body });
            if (path === configmapsPath && method === 'POST') return Promise.resolve({ status: 201, body: '{}' });
            if (path === claimPathFor(job.id) && method === 'GET') {
                return ok({
                    metadata: { uid: 'u1' },
                    data: { holder: job.leaseToken, claimSeq: String(job.claimSeq) },
                });
            }
            if (path === claimPathFor(job.id) && method === 'DELETE') {
                return Promise.resolve({ status: 200, body: '{}' });
            }
            if (path.startsWith(`${jobsPath(namespace)}?`)) return ok({ items: [] });
            if (path.startsWith(`${ns}/pods?`) && decodeURIComponent(path).includes('factory.job=')) {
                return ok({ items: [] });
            }
            if (path.startsWith(`${ns}/services?`) || path.startsWith(`${ns}/services/`)) {
                return Promise.resolve({ status: 200, body: '{"items":[]}' });
            }
            if (path === jobsPath(namespace) && method === 'POST') {
                return Promise.resolve(FAKE.create as K8sResponse);
            }
            if (method === 'GET' && path === jobPath(namespace, runnerJobName(job))) {
                return ok({ status: { succeeded: 1 } });
            }
            // The resume of the runner Job, created suspended.
            if (method === 'PATCH' && path === jobPath(namespace, runnerJobName(job))) return ok({});
            if (path.startsWith(`${ns}/pods?`) && decodeURIComponent(path).includes(`job-name=${runnerJobName(job)}`)) {
                return ok({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                containerStatuses: [{ name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } }],
                            },
                        },
                    ],
                });
            }
            if (path === `${ns}/pods/${podName}/log`) return Promise.resolve({ status: 200, body: 'did the work\n' });
            // The thread's task volume: absent on the first read, created by the POST.
            if (path.startsWith(`${ns}/persistentvolumeclaims`)) {
                return Promise.resolve(
                    method === 'POST' ? { status: 201, body: '{}' } : { status: 200, body: '{"items":[]}' }
                );
            }
            // The per-attempt Secret (the runner's attempt pair), created and reaped per attempt.
            if (path === `${ns}/secrets`) {
                if (method === 'DELETE') return Promise.resolve({ status: 200, body: '{}' });
                return Promise.resolve({ status: 201, body: JSON.stringify({ metadata: { uid: 'secret-uid' } }) });
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        return { request, calls, steps };
    };

    const ocRunner = (request: K8sRequest, steps = fakeSteps()) =>
        supervisedRunner(
            loadDriverConfig({
                EXECUTOR: 'kubernetes',
                K8S_NAMESPACE: namespace,
                RUNNER_SERVICES: '0',
            }),
            request,
            async () => {},
            { steps: steps.sink }
        );

    /** The readout steps of a run: `probe` steps carrying the readout script. */
    const readoutsOf = (steps: { submitted: StepRequest[] }): StepRequest[] =>
        steps.submitted.filter((step) => step.kind === 'probe' && step.argv.includes(opencodeReadoutScript));

    it('flags the transcript a cut readout answer lost its head of (#825)', async () => {
        const normalized = JSON.stringify({ stream: 'normalized', event: { n: 2 } });
        const { request, steps } = opencodeFake({
            log: ['t":{"n":1}}', normalized, JSON.stringify({ id: 'ses_n3w' })].join('\n'),
        });

        const outcome = await ocRunner(request, steps).run(opencodeJob, null);

        expect(outcome.transcript).toBe(normalized);
        expect(outcome.transcriptTruncated).toBe(true);
    });

    it('scrapes the session the run minted, and rides it on the outcome', async () => {
        const { request, steps } = opencodeFake({
            log: JSON.stringify({
                id: 'ses_n3w',
                finish: 'stop',
                tokens: 4321,
                cost: 0.12,
                turns: 9,
                summary: 'Fixed the flaky test',
            }),
        });
        const outcome = await ocRunner(request, steps).run(opencodeJob, null);

        expect(outcome.sessionId).toBe('ses_n3w');
        expect(outcome.finishReason).toBe('stop');
        expect(outcome.contextTokens).toBe(4321);
        expect(outcome.costUsd).toBeCloseTo(0.12);
        // The turn count and the summary ride the same readout line, merged onto the outcome
        // exactly as the docker runner merges them (executor parity — the turn merge was once
        // missing here and opencode runs under this executor lost their count).
        expect(outcome.agentTurns).toBe(9);
        expect(outcome.summary).toBe('Fixed the flaky test');
        expect(outcome.readoutError).toBeUndefined();
        expect(outcome.exitCode).toBe(0);
        expect(outcome.started).toBe(true);

        // One step of the task pod, with the database path as env: no second pod ever mounts the volume.
        const [readout, ...more] = readoutsOf(steps);
        expect(more).toEqual([]);
        expect(readout!.env.OPENCODE_DB).toBe(opencodeReadoutStep(opencodeJob, START).env.OPENCODE_DB);
    });

    it('fails no verdict when the readout step fails: the error rides readoutError instead', async () => {
        const { request, steps } = opencodeFake({ exitCode: 1, log: 'no such column: role' });
        const outcome = await ocRunner(request, steps).run(opencodeJob, null);

        // The run's own verdict is untouched; only the follow-up-ability was lost, said out loud.
        expect(outcome.exitCode).toBe(0);
        expect(outcome.sessionId).toBeUndefined();
        expect(outcome.readoutError).toContain('the session readout step failed');
        // Retried to the end before giving up: three attempts, every one a step.
        expect(readoutsOf(steps)).toHaveLength(3);
    });

    // A lost supervisor is infrastructure, never the run's verdict: the step throws and the
    // readout answers as one more failed read.
    it('fails no verdict when the readout step is lost: the error rides readoutError instead', async () => {
        const { request, steps } = opencodeFake({ reject: new Error('the supervisor closed the channel') });
        const outcome = await ocRunner(request, steps).run(opencodeJob, null);

        expect(outcome.exitCode).toBe(0);
        expect(outcome.readoutError).toContain('the supervisor closed the channel');
    });

    it("reads a claude-code run's turns as one step of the task pod, never a pod of its own", async () => {
        const { request, calls } = opencodeFake();
        const steps = fakeSteps((step) =>
            step.kind === 'probe' ? stepOk('{"turns":7,"summary":"done"}\n') : defaultStepAnswer(step)
        );
        const outcome = await ocRunner(request, steps).run(job, { id: SESSION, resume: false });

        expect(outcome.agentTurns).toBe(7);
        expect(outcome.summary).toBe('done');
        const [read, ...more] = steps.submitted.filter((step) => step.argv.includes(claudeTurnsScript));
        expect(more).toEqual([]);
        expect(read!.kind).toBe('probe');
        expect(read!.env.CLAUDE_SESSION_ID).toBe(SESSION);
        // Nothing but the runner's own Job was created: a second pod would be Pending on a ReadWriteOncePod volume.
        const jobPosts = calls.filter((c) => c.method === 'POST' && c.path === jobsPath(namespace));
        expect(jobPosts).toHaveLength(1);
    });

    it('scrapes nothing for a claude-code run, whose session is known at spawn', async () => {
        const { request, steps } = opencodeFake({ log: 'irrelevant' });
        await ocRunner(request, steps).run(job, { id: SESSION, resume: false });
        expect(readoutsOf(steps)).toEqual([]);
    });
});
