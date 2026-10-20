import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Board, BoardJob, ReviewClaim } from '../src/board.js';
import { type DriverConfig, loadDriverConfig } from '../src/config.js';
import {
    AGENT_CONTAINER,
    EXPORTER_CONTAINER,
    GO_MARKER,
    MAILBOXES,
    REVIEWER_CONTAINER,
    SUPERVISOR_CONTAINER,
    SUPERVISOR_CREDENTIAL_NAMES,
    SUPERVISOR_BINDING,
    SUPERVISOR_BINDING_PATH,
    SUPERVISOR_EXIT,
    SUPERVISOR_REPORT_PREFIX,
    SUPERVISOR_STEPS_MS,
    SUPERVISOR_WINDDOWN_MS,
    SERVICE_GENERATIONS,
    SERVICE_NOT_ACKED_EXIT,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from '../src/supervisor-contract.js';
import { StepChannelClosed, type StepSink } from '../src/step-control.js';
import { newJobState } from '../src/loop-attempt.js';
import { createReviewRelay } from '../src/loop-review.js';
import type { LoopRuntime } from '../src/loop-types.js';
import {
    claudeTurnsScript,
    claudeExportScript,
    gateLoopArgv,
    reviewLoopArgv,
    serviceProbeArgv,
    serviceRestartArgv,
} from '../src/container-scripts.js';
import {
    AdoptionBlocked,
    ARTIFACT_LIMIT,
    Inconclusive,
    commandMark,
    OPENCODE_EXPORT_LIMIT,
    SERVICE_LOG_TAIL_LINES,
} from '../src/runner.js';
import { lookupHelper } from '../src/helpers.js';
import { REVIEW_REPLY_PROBE_ID } from '../src/review-helpers.js';
import { receiptedAnswer, receiptOrder } from './fixtures/helper-receipt-steps.js';
import { claudeManagedSettings, opencodeOtelConfig } from '../src/telemetry-config.js';
import type { HelperPlan } from '../src/helpers.js';
import type { K8sDeps, K8sMethod, K8sRequest, K8sResponse } from '../src/k8s-transport.js';
import { LOG_TAIL_LINES, POLL_MAX_CONSECUTIVE_FAILURES, parsePodMetrics, POLL_MS } from '../src/k8s-transport.js';
import { GROUP_END_WAIT_MS } from '../src/k8s-teardown.js';
import { ledgerOf, RunnerKilled } from '../src/k8s-kill.js';
import { CLOSE_READ_DEADLINE_MS, REBIND_DEADLINE_MS } from '../src/runner.js';
import {
    auxVerdict,
    pollJobToTerminal,
    pollRunnerJobUntilTerminal,
    readImagePullStatus,
    readVerdict,
    runnerLossOf,
} from '../src/k8s-poll.js';
import { bindingBody, orphanBoundMs } from '../src/supervisor-plan.js';
import {
    claudeTurnsJobName,
    claudeTurnsJobSpec,
    jobsPath,
    opencodeReadoutJobName,
    opencodeReadoutJobSpec,
    runnerJobName,
    runnerJobSpec,
    secretName,
} from '../src/k8s-podspec.js';
import { claimName, jobPath, podLogPath } from '../src/k8s-auxspec.js';
import { KUBELET_RESTART_NOTE, readSidecars, sidecarStatuses } from '../src/k8s-services.js';
import { reclaimGroupSpec } from '../src/k8s-group.js';
import {
    GATE_GID,
    GATE_UID,
    GITHUB_CACHE_DIR,
    REVIEWER_HOME,
    REVIEWER_TREE_DIR,
    REVIEWER_UID,
    TOOL_UID,
} from '../src/claim.js';
import { reviewerRequests } from '../src/k8s-podfields.js';
import { createKubernetesReaper } from '../src/k8s-reaper.js';
import { createKubernetesRunner } from '../src/k8s-runner.js';
import { throughTransport } from './fixtures/k8s-transport-bridge.js';
import { type Call, k8sApiserver } from './fixtures/k8s-apiserver.js';
import {
    carriedPastLoss,
    decisionOf,
    LOSS_ROWS,
    TERMINATION_ROWS,
    type TerminationRow,
} from './fixtures/termination-table.js';
import { RETENTION_ROWS } from './fixtures/retention-table.js';
import { STARTUP_ROWS, type StartupRow, startupDecisionOf } from './fixtures/startup-table.js';
import { StartupRefused } from '../src/startup-cause.js';
import type { RunOutcome } from '../src/runner.js';
import { ServicesNotRunning } from '../src/service-restart.js';
import {
    CREDENTIAL_HELPER,
    gitProbeScript,
    gitWorktreeRemoveScript,
    gitWorktreeScript,
    toolTreeReleaseBoundedScript,
    toolTreeReleaseScript,
    TRANSIENT_SYNC_REASON,
} from '../src/publish.js';
import type { ServiceSpec } from '../src/services.js';

const MISMATCH_ROW = 'a run specced for another session than its group' as const;
const SILENT_ROW = 'a supervisor that started and never answered' as const;
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';

const USER = '44444444-4444-4444-8444-444444444444';
/** The Job's backstop beyond the agent's budget: the drain and the report, then the hours the group serves steps. */
const WINDDOWN_S = (SUPERVISOR_WINDDOWN_MS + SUPERVISOR_STEPS_MS) / 1000;

/** A fixed, valid Factory execution context — the shape master-prompt.test.ts pins; only its
 *  presence matters to this file's own tests, none of which assert its exact text. */
const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';

/** The control pair a run with a control endpoint carries for its supervisor, and the exporter's own token. */
const SUPERVISED: Pick<BoardJob, 'supervisorEnv'> = {
    supervisorEnv: {
        SUPERVISOR_CONTROL_URL: 'http://driver:7000',
        SUPERVISOR_CONTROL_TOKEN: 'tok-supervisor',
        SUPERVISOR_EXPORT_TOKEN: 'tok-export',
    },
};

/** The step channel every attempt here is reached through: the control token the fake sink is keyed by. */
const CONTROL_TOKEN = SUPERVISED.supervisorEnv!.SUPERVISOR_CONTROL_TOKEN!;

const job: BoardJob = {
    ...SUPERVISED,
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
    masterPrompt: MASTER_PROMPT,
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    rootCommand: 'fix the failing build',
};

const SESSION = '33333333-3333-4333-8333-333333333333';
const opencodeJob: BoardJob = { ...job, executorType: 'opencode' };

const spec = (env: NodeJS.ProcessEnv = {}) =>
    runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes', ...env }), job, { id: SESSION, resume: false });

describe('the group-end wait', () => {
    // A Foreground Job delete keeps the Job readable until the kubelet has ended its pod; a wait
    // shorter than the pod's grace period reads a slow shutdown as `held` and keeps the claim.
    it('outlasts the runner pod termination grace period by at least one poll', () => {
        const KUBERNETES_DEFAULT_GRACE_SECONDS = 30;
        for (const pod of [
            spec().spec.template.spec,
            reclaimGroupSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), job, job.leaseToken).spec.template.spec,
        ]) {
            const grace =
                (pod as { terminationGracePeriodSeconds?: number }).terminationGracePeriodSeconds ??
                KUBERNETES_DEFAULT_GRACE_SECONDS;
            expect(GROUP_END_WAIT_MS).toBeGreaterThanOrEqual(grace * 1000 + POLL_MS);
        }
    });
});

describe('the runner job spec', () => {
    it('is a batch/v1 Job named after the job id and lease token, within the label bound', () => {
        expect(spec().apiVersion).toBe('batch/v1');
        expect(spec().kind).toBe('Job');
        expect(spec().metadata.name).toBe(runnerJobName(job));
        // The apiserver stamps the Job's name onto the pod template as the `job-name` label, and
        // a label value is capped at 63 bytes — the raw `factory-job-<id>-<lease token>` is 85
        // and the create answers 422. Hashed, the name is 23; the pin is the BOUND, not today's
        // spelling, so a future name change cannot reintroduce the refusal.
        expect(spec().metadata.name.length).toBeLessThanOrEqual(63);
    });

    // The plan is pinned in runner-plan.test.ts; this is its kubernetes rendering: the CLI args as
    // the container's args (its env pairs are the literal values pinned below).
    it('runs the command as a prompt, with the same argv the docker runner passes after the image', () => {
        expect(spec().spec.template.spec.containers[0]!.args).toEqual([
            '--session-id',
            SESSION,
            '--append-system-prompt',
            MASTER_PROMPT,
            '--system-prompt-snapshot',
            'off',
            '-p',
            'fix the failing build',
        ]);
    });

    it("mounts the workspaces PVC and starts at the AUTHOR's workspace root", () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({ name: 'WORKDIR', value: `/workspaces/bellows/${USER}` });
        expect(spec().spec.template.spec.volumes).toContainEqual({
            name: 'workspaces',
            persistentVolumeClaim: { claimName: 'factory-ai_workspaces' },
        });
        // The mount is scoped to the job's own `<orgId>/<userId>` subtree — both segments
        // asserted — so the container's volume root is the member's tree, never the shared
        // parent every member's checkout lives under.
        expect(container.volumeMounts).toContainEqual({
            name: 'workspaces',
            mountPath: `/workspaces/bellows/${USER}`,
            subPath: `bellows/${USER}`,
        });
    });

    // Issue #452: the managed settings come from the per-attempt Secret, mounted read-only and
    // 0444 over /etc/claude-code — root-owned in the pod, so the agent (uid 1000) cannot rewrite
    // the scope that outranks every other.
    it('mounts the rendered managed settings read-only from the attempt Secret for a claude-code runner', () => {
        const s = spec();
        expect(s.spec.template.spec.volumes).toContainEqual({
            name: 'telemetry-config',
            secret: {
                secretName: secretName(job),
                items: [{ key: 'managed-settings.json', path: 'managed-settings.json' }],
                defaultMode: 0o444,
            },
        });
        expect(s.spec.template.spec.containers[0]!.volumeMounts).toContainEqual({
            name: 'telemetry-config',
            mountPath: '/etc/claude-code',
            readOnly: true,
        });
    });

    it('mounts the rendered otel.json read-only from the attempt Secret for an opencode runner', () => {
        const s = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), opencodeJob, null);
        expect(s.spec.template.spec.volumes).toContainEqual({
            name: 'telemetry-config',
            secret: {
                secretName: secretName(opencodeJob),
                items: [{ key: 'otel.json', path: 'otel.json' }],
                defaultMode: 0o444,
            },
        });
        expect(s.spec.template.spec.containers[0]!.volumeMounts).toContainEqual({
            name: 'telemetry-config',
            mountPath: '/etc/opencode-otel',
            readOnly: true,
        });
    });

    // Executor parity for the task worktree (issue #35): a repo job starts in the thread's
    // worktree here exactly as the docker runner does — same WORKDIR rule, one code path on the
    // board side.
    it('starts a repo job in its task worktree', () => {
        const repoSpec = runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes' }),
            { ...job, repo: 'Bellows-AI/factory' },
            {
                id: SESSION,
                resume: false,
            }
        );
        expect(repoSpec.spec.template.spec.containers[0]!.env).toContainEqual({
            name: 'WORKDIR',
            value: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
        });
    });

    it('refuses to run a repo job whose worktree path cannot be asserted', () => {
        expect(() =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                { ...job, repo: 'Bellows-AI/factory', rootJobId: 'not-a-uuid' },
                {
                    id: SESSION,
                    resume: false,
                }
            )
        ).toThrow(/worktree/);
    });

    it('refuses a thread root that is not a uuid before it becomes a path', () => {
        expect(() =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                { ...job, rootJobId: '../../etc' },
                {
                    id: SESSION,
                    resume: false,
                }
            )
        ).toThrow(/not a uuid/);
    });

    it('refuses a workspace path that is not <org>/<uuid>', () => {
        /*
         * The board is not something this process trusts with a fragment of a command line — the
         * same rule every board-supplied id is held to, and the stakes are higher here:
         * the value becomes the agent's working directory, and `..` in it points at the parent of
         * every member's tree.
         */
        for (const path of [
            '../../etc',
            'bellows/../../etc',
            'bellows/not-a-uuid',
            `/absolute/${USER}`,
            `bellows/${USER}/extra`,
            null,
        ]) {
            expect(
                () =>
                    runnerJobSpec(
                        loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                        { ...job, workspacePath: path },
                        { id: SESSION, resume: false }
                    ),
                String(path)
            ).toThrow(/no usable workspace path/);
        }
    });

    // The id becomes the Job object's name and lands in API paths — the same interpolation the
    // docker runner guards before a `docker run`, from the same kind of board.
    it('refuses a job id that is not a uuid, rather than interpolating it', () => {
        expect(() =>
            runnerJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes' }),
                { ...job, id: '../../etc/passwd' },
                {
                    id: SESSION,
                    resume: false,
                }
            )
        ).toThrow(/must be a uuid/);
    });

    // The k8s form of `-e NAME`: the NAMES travel and the values live in a Secret the cluster
    // already holds. A literal `value:` would put the credential in the pod spec, which anyone who
    // can `get pods` can read — the same audience every `ps` on the host has.
    it('names credentials by secretKeyRef, never by value', () => {
        const container = spec({ RUNNER_CREDENTIALS_SECRET: 'claude-credentials' }).spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({
            name: 'CLAUDE_CODE_OAUTH_TOKEN',
            valueFrom: {
                secretKeyRef: { name: 'claude-credentials', key: 'CLAUDE_CODE_OAUTH_TOKEN', optional: true },
            },
        });
        expect(container.env).toContainEqual({
            name: 'ANTHROPIC_API_KEY',
            valueFrom: { secretKeyRef: { name: 'claude-credentials', key: 'ANTHROPIC_API_KEY', optional: true } },
        });
        // WORKDIR, the OTLP endpoint, the board URL, the transcript store and the npm notice
        // switch are the only literal values a runner env carries, none of them secrets — the
        // object of the pin above.
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
            { name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' },
            {
                name: 'FACTORY_TRANSCRIPT_DIR',
                value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            },
            { name: 'BELLOWS_SESSION_ID', value: SESSION },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
            // The two mailbox paths the agent finds its supervisor through — paths, no credential.
            { name: 'FACTORY_CTL_IN', value: '/factory/in/agent' },
            { name: 'FACTORY_CTL_OUT', value: '/factory/out/agent' },
            { name: 'FACTORY_CTL_GO', value: GO_MARKER },
        ]);
    });

    // A default only: the claim's own value rides the Secret by reference, and the pod spec never
    // states the name a second time beside it.
    it('leaves the npm notice to a claim that names it', () => {
        const envJob: BoardJob = { ...job, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } };
        const env = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), envJob, { id: SESSION, resume: false })
            .spec.template.spec.containers[0]!.env;
        expect(env.filter((entry) => entry.name === 'NPM_CONFIG_UPDATE_NOTIFIER')).toEqual([
            {
                name: 'NPM_CONFIG_UPDATE_NOTIFIER',
                valueFrom: { secretKeyRef: { name: secretName(envJob), key: 'NPM_CONFIG_UPDATE_NOTIFIER' } },
            },
        ]);
    });

    // Where a runner's telemetry goes. A literal value like WORKDIR — an OTLP endpoint is a path,
    // not a credential — but unlike the compose world there is no network for a pod to join that
    // would make the image's baked `collector:4318` resolve, so this process has to name the
    // collector. RUNNER_OTEL_ENDPOINT overrides the compose-collector default; the pin is that it
    // lands as the runner's own `value`, readable in the pod spec like WORKDIR is.
    it('points the runner at a collector, overriding it when configured', () => {
        const def = spec().spec.template.spec.containers[0]!;
        expect(def.env).toContainEqual({ name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' });
        const configured = spec({ RUNNER_OTEL_ENDPOINT: 'http://telemetry.internal:4318' }).spec.template.spec
            .containers[0]!;
        expect(configured.env).toContainEqual({
            name: 'OTEL_EXPORTER_OTLP_ENDPOINT',
            value: 'http://telemetry.internal:4318',
        });
    });

    // `RUNNER_CREDENTIALS_SECRET` forwards nothing when unset: its names never appear. What the
    // spec DOES always carry is the runner's own attempt pair — the branch-ingest credential,
    // referenced into the per-attempt Secret below (its values ride the Secret, never the spec).
    it('forwards no user-configured credentials when no secret is configured', () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
            { name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' },
            {
                name: 'RUNNER_JOB_ID',
                valueFrom: {
                    secretKeyRef: { name: `factory-job-${job.id}-${job.leaseToken}-env`, key: 'RUNNER_JOB_ID' },
                },
            },
            {
                name: 'RUNNER_LEASE_TOKEN',
                valueFrom: {
                    secretKeyRef: { name: `factory-job-${job.id}-${job.leaseToken}-env`, key: 'RUNNER_LEASE_TOKEN' },
                },
            },
            {
                name: 'FACTORY_TRANSCRIPT_DIR',
                value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            },
            { name: 'BELLOWS_SESSION_ID', value: SESSION },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
            { name: 'FACTORY_CTL_IN', value: '/factory/in/agent' },
            { name: 'FACTORY_CTL_OUT', value: '/factory/out/agent' },
            { name: 'FACTORY_CTL_GO', value: GO_MARKER },
        ]);
    });

    // The claim env's VALUES never touch the pod spec — anyone who can `get pods` would read them.
    // They live in a per-attempt Secret the runner creates before the Job and reaps with it.
    it('references claim env by secretKeyRef into the per-job Secret, never by value', () => {
        const envJob: BoardJob = { ...job, env: { CORE_TOKEN: 'shh' } };
        const container = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), envJob, {
            id: SESSION,
            resume: false,
        }).spec.template.spec.containers[0]!;
        // NOT optional: the driver created this exact Secret moments before the Job, under this
        // attempt's own lease token — a missing key is a bug and must fail loud
        // (CreateContainerConfigError), not start the pod silently without its env.
        expect(container.env).toContainEqual({
            name: 'CORE_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(envJob), key: 'CORE_TOKEN' } },
        });
        expect(JSON.stringify(container.env)).not.toContain('shh');
    });

    // Issue #442: the run-control channel rides the same per-attempt Secret as the gate pair, so a
    // kubernetes runner's stop poller reaches the driver pod's endpoint exactly as a docker one does.
    it('names the run-control channel by secretKeyRef into the per-job Secret', () => {
        const controlled: BoardJob = {
            ...job,
            gateEnv: {
                BELLOWS_CONTROL_URL: 'http://10.1.2.3:41000',
                BELLOWS_CONTROL_TOKEN: 'ctl-secret',
            },
        };
        const container = runnerJobSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), controlled, {
            id: SESSION,
            resume: false,
        }).spec.template.spec.containers[0]!;
        for (const name of ['BELLOWS_CONTROL_URL', 'BELLOWS_CONTROL_TOKEN']) {
            expect(container.env).toContainEqual({
                name,
                valueFrom: { secretKeyRef: { name: secretName(controlled), key: name } },
            });
        }
        expect(JSON.stringify(container.env)).not.toContain('ctl-secret');
    });

    it('carries no claim env entries for an env-less claim', () => {
        const container = spec().spec.template.spec.containers[0]!;
        // The attempt pair names the per-attempt Secret now, always — that is the runner's own
        // credential, not claim env. What must not appear is anything MEMBER-configured.
        expect(JSON.stringify(container.env)).not.toContain('CORE_TOKEN');
        // The literal values: WORKDIR, the two URLs every runner is pointed somewhere by —
        // the collector for OTLP metrics, the board for the branch reporter's attribution
        // reports — the transcript store path and the npm notice switch, none of them
        // credentials, in a spec anyone with `get pods` can read.
        expect(container.env.filter((entry) => 'value' in entry)).toEqual([
            { name: 'WORKDIR', value: `/workspaces/bellows/${USER}` },
            { name: 'OTEL_EXPORTER_OTLP_ENDPOINT', value: 'http://collector:4318' },
            { name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' },
            {
                name: 'FACTORY_TRANSCRIPT_DIR',
                value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            },
            { name: 'BELLOWS_SESSION_ID', value: SESSION },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
            { name: 'FACTORY_CTL_IN', value: '/factory/in/agent' },
            { name: 'FACTORY_CTL_OUT', value: '/factory/out/agent' },
            { name: 'FACTORY_CTL_GO', value: GO_MARKER },
        ]);
    });

    // The branch reporter posts to the board's API; the same URL the docker runner forwards as
    // `-e FACTORY_STATS_URL`, defaulted from JOB_BOARD_URL and overridable for a split topology.
    it('names the board for the branch reporter, overridable', () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({ name: 'FACTORY_STATS_URL', value: 'http://127.0.0.1:8080' });
        expect(
            spec({ RUNNER_STATS_URL: 'http://stats.internal:8080' }).spec.template.spec.containers[0]!.env
        ).toContainEqual({ name: 'FACTORY_STATS_URL', value: 'http://stats.internal:8080' });
    });

    // The attempt pair is a credential — the lease token most of all — so the NAMES travel in
    // the pod spec and the VALUES ride the per-attempt Secret by reference, the same discipline
    // as every claim env entry. There is no opt-out: the pair is how the runner's branch
    // reporter authenticates at all.
    it('delivers the attempt pair by secret reference, never as a value', () => {
        const container = spec().spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({
            name: 'RUNNER_JOB_ID',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_JOB_ID' } },
        });
        expect(container.env).toContainEqual({
            name: 'RUNNER_LEASE_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'RUNNER_LEASE_TOKEN' } },
        });
        // No literal pair values in the spec: only valueFrom references.
        expect(
            container.env.filter((entry) => entry.name === 'RUNNER_JOB_ID' || entry.name === 'RUNNER_LEASE_TOKEN')
        ).toEqual(
            container.env.filter(
                (entry) =>
                    (entry.name === 'RUNNER_JOB_ID' || entry.name === 'RUNNER_LEASE_TOKEN') && 'valueFrom' in entry
            )
        );
    });

    // A failed runner pod must never be re-run by the cluster: a kubelet retry would re-send the
    // prompt and run the work twice. The board owns retries — the lease expires and the job is
    // offered again, which is visible in `attempts`.
    it('never restarts a failed runner', () => {
        expect(spec().spec.template.spec.restartPolicy).toBe('Never');
        expect(spec().spec.backoffLimit).toBe(0);
    });

    it('bounds the run with an active deadline', () => {
        // DRIVER_JOB_TIMEOUT_MS maps onto the kubelet-enforced deadline, so a runner that outlives
        // its driver still dies — the k8s form of `docker kill`. The supervisor ends the agent at the
        // budget itself; the kubelet's backstop adds the drain and the report on top.
        expect(spec({ DRIVER_JOB_TIMEOUT_MS: '45000' }).spec.activeDeadlineSeconds).toBe(45 + WINDDOWN_S);
    });

    // Issue #733: environment.setup ran before the agent, inside the same run budget.
    it('takes the time environment.setup spent off the active deadline', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', DRIVER_JOB_TIMEOUT_MS: '45000' });
        const setUp = runnerJobSpec(config, { ...job, setupMs: 15_000 }, { id: SESSION, resume: false });
        expect(setUp.spec.activeDeadlineSeconds).toBe(30 + WINDDOWN_S);
    });

    it('runs exactly one pod, and reaps the object when it is done', () => {
        expect(spec().spec.completions).toBe(1);
        expect(spec().spec.parallelism).toBe(1);
        expect(spec().spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    });

    // The same labels the docker runner passes as --label: factory.job is what lets `kubectl
    // get jobs -l factory.job=<id>` find a runner that outlived its driver — and what the
    // re-claim fence sweeps by; factory.lease scopes every per-attempt operation to its own
    // attempt's objects, the same split as the docker runner's two labels.
    it('labels the pod so an orphan can be found after the driver dies', () => {
        expect(spec().spec.template.metadata.labels).toMatchObject({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
        expect(spec().metadata.labels).toMatchObject({
            'factory.job': job.id,
            'factory.lease': job.leaseToken,
        });
    });

    // Every runner pod would otherwise auto-mount the driver's own ServiceAccount token — the
    // credentials that may create Jobs — into the Claude container. That is the docker socket
    // riding along with the dashboard, and it is refused here for the same reason.
    it('leaves no service account token in the runner', () => {
        expect(spec().spec.template.spec.automountServiceAccountToken).toBe(false);
    });

    /**
     * Kubernetes defaults to `Always` for an untagged or `:latest` image, which would reach past
     * the node's own local images to a registry that has never heard of `claude-executor` — the
     * docker runner's "use what the daemon has" behavior has to be stated, not assumed.
     */
    it('states the pull policy instead of letting kubernetes default to Always', () => {
        expect(spec().spec.template.spec.containers[0]!.imagePullPolicy).toBe('IfNotPresent');
        expect(spec({ RUNNER_IMAGE_PULL_POLICY: 'Always' }).spec.template.spec.containers[0]!.imagePullPolicy).toBe(
            'Always'
        );
    });

    /**
     * Issue #360: a pod with no requests is BestEffort — first evicted under node memory
     * pressure, and a zero-request pod the autoscaler never provisions capacity for. The
     * configured requests land on the container verbatim.
     */
    it('renders the configured requests and limits, so the pod is Burstable and the autoscaler can size for it', () => {
        expect(
            spec({
                RUNNER_CPU_REQUEST: '500m',
                RUNNER_MEMORY_REQUEST: '1Gi',
                RUNNER_CPU_LIMIT: '2',
                RUNNER_MEMORY_LIMIT: '4Gi',
            }).spec.template.spec.containers[0]!.resources
        ).toEqual({
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '2', memory: '4Gi' },
        });
    });

    // Limits off by default, the dashboard pod's own posture: a request only reserves, while a
    // memory limit on an agent run turns a big build into an OOM kill mid-work.
    it('renders requests only when limits are unset — the dashboard posture', () => {
        const container = spec({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' }).spec.template.spec
            .containers[0]!;
        expect(container.resources).toEqual({ requests: { cpu: '500m', memory: '1Gi' } });
        expect(container.resources?.limits).toBeUndefined();
    });

    it('renders no resources block at all when none are configured — the BestEffort pod this issue came from', () => {
        expect(spec().spec.template.spec.containers[0]!.resources).toBeUndefined();
    });
});

/*
 * Every pod the driver specs, by name: the runner, the ten aux builders (all through
 * `auxJobSpec`) and a declared service's sidecar. Each entry is a thunk, built inside the it
 * bodies — the file's `namespace` is declared below, and nothing here may build eagerly. A
 * builder that bypassed `auxJobSpec` altogether would need its own entry here, and the
 * admission policy is the backstop that refuses it at the apiserver either way.
 */
const POD_NAMES = [
    'the runner',
    'the gate sidecar',
    'the opencode session readout',
    'the claude turns readout',
    'the task supervisor',
    'the transcript exporter',
    'the reclaim group',
    'the service sidecar',
] as const;
type PodName = (typeof POD_NAMES)[number];

type JobSpecOf = ReturnType<typeof runnerJobSpec> | ReturnType<typeof claudeTurnsJobSpec>;
interface PodView {
    /** The Job object. */
    job: JobSpecOf;
    /** The POD's metadata: the Job's pod template. */
    meta: JobSpecOf['spec']['template']['metadata'];
    /** The pod spec, read only through the fields every pod shares. */
    pod: {
        restartPolicy: string;
        automountServiceAccountToken: boolean;
        securityContext?: { seccompProfile?: { type: string } };
        imagePullSecrets?: { name: string }[];
        nodeSelector?: unknown;
        tolerations?: unknown;
        affinity?: unknown;
        containers: {
            resources?: unknown;
            securityContext?: {
                capabilities?: { drop?: string[] };
                allowPrivilegeEscalation?: boolean;
                readOnlyRootFilesystem?: boolean;
            };
            volumeMounts?: { name: string; subPath?: string }[];
        }[];
    };
}
const jobView = (spec: JobSpecOf): PodView => ({
    job: spec,
    meta: spec.spec.template.metadata,
    pod: spec.spec.template.spec,
});

/**
 * One container of a claude-code run's pod, seen through the fields every pod shares: the same Job
 * and pod, with only the named container left in `containers` — so each per-container pin below
 * reads `containers[0]` for the supervisor and the exporter as it does for the agent.
 */
const containerView = (config: DriverConfig, of: BoardJob, name: string): PodView => {
    const spec = runnerJobSpec(
        config,
        { ...of, executorType: 'claude-code', ...SUPERVISED },
        { id: SESSION, resume: false }
    );
    const view = jobView(spec);
    const container = spec.spec.template.spec.containers.find((candidate) => candidate.name === name);
    if (!container) throw new Error(`the run's pod has no ${name} container`);
    return { ...view, pod: { ...view.pod, containers: [container] } };
};

/** The suite's job, with a checkout that declares a gate: its pod holds the gate sidecar (issue #773). */
const gatedOf = (of: BoardJob): BoardJob => ({
    ...of,
    repo: 'Bellows-AI/factory',
    gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
});

/** The gated run's pod, seen through its gate sidecar alone — as `containerView` sees one main container. */
const gateView = (config: DriverConfig, of: BoardJob): PodView => {
    const spec = runnerJobSpec(
        config,
        { ...gatedOf(of), executorType: 'claude-code', ...SUPERVISED },
        {
            id: SESSION,
            resume: false,
        }
    );
    const view = jobView(spec);
    const gate = spec.spec.template.spec.initContainers?.find((candidate) => candidate.name === 'gate');
    if (!gate) throw new Error("the gated run's pod has no gate sidecar");
    return { ...view, pod: { ...view.pod, containers: [gate] } };
};

/** A run's pod with one declared service, seen through its sidecar alone (issue #773). */
const serviceSidecarView = (config: DriverConfig, of: BoardJob): PodView => {
    const spec = runnerJobSpec(
        { ...config, servicesEnabled: true },
        { ...of, ...SUPERVISED, services: [{ name: 'cache', image: 'redis', environment: [] }] },
        { id: SESSION, resume: false }
    );
    const view = jobView(spec);
    const sidecar = spec.spec.template.spec.initContainers?.find((candidate) => candidate.name === 'svc-cache');
    if (!sidecar) throw new Error("the run's pod has no service sidecar");
    return { ...view, pod: { ...view.pod, containers: [sidecar] } };
};

const everyPodSpec = (env: NodeJS.ProcessEnv = {}, of: BoardJob = job): Record<PodName, () => PodView> => {
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, ...env });
    const repoJob: BoardJob = { ...of, repo: 'Bellows-AI/factory' };
    const startedAt = '2026-09-01T00:00:00Z';
    return {
        'the runner': () => jobView(runnerJobSpec(config, of, { id: SESSION, resume: false })),
        'the gate sidecar': () => gateView(config, of),
        'the opencode session readout': () => jobView(opencodeReadoutJobSpec(config, of, startedAt)),
        'the claude turns readout': () => jobView(claudeTurnsJobSpec(config, of, SESSION, startedAt)),
        'the task supervisor': () => containerView(config, of, SUPERVISOR_CONTAINER),
        'the transcript exporter': () => containerView(config, of, EXPORTER_CONTAINER),
        'the reclaim group': () => jobView(reclaimGroupSpec(config, repoJob, repoJob.leaseToken)),
        'the service sidecar': () => serviceSidecarView(config, of),
    };
};

describe('resources on every pod the driver specs', () => {
    // Issue #360: the autoscaler sizes the whole runner fleet, not just the runner pod — an
    // unschedulable sync or gate on a right-sized node strands the run. One config, every
    // builder: the requests render on each container from the same four variables. The one Pod
    // (not Job) in the fleet, a declared service under the attempt's headless Service, is sized
    // like everything else, or it lands wherever a pod slot is free.
    const REQUESTS = { requests: { cpu: '500m', memory: '1Gi' } };
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };

    // The runner's pod is sized by its agent: the supervisor and the exporter beside it are small
    // scripts, and a request on each would multiply the pod's reservation by three. The reclaim
    // group is a supervisor alone, so it carries no request at all.
    const SIDECARS: readonly PodName[] = ['the task supervisor', 'the transcript exporter', 'the reclaim group'];
    // The gate sidecar is sized by GATE_* and resized in place (issue #773): its own pins below.
    const SIZED_POD_NAMES = POD_NAMES.filter((name) => !SIDECARS.includes(name) && name !== 'the gate sidecar');

    it.each(SIDECARS)('leaves %s unsized: the pod is sized by its agent', (name) => {
        const { pod } = everyPodSpec({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' })[name]();
        expect(pod.containers[0]!.resources).toBeUndefined();
    });

    it.each(SIZED_POD_NAMES)('carries the same requests on %s', (name) => {
        const { pod } = everyPodSpec({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' })[name]();
        expect(pod.containers[0]!.resources).toEqual(REQUESTS);
    });

    // Issue #507 and #773 (D6): a gate runs the whole suite, so it is limited by GATE_* from the
    // start, and requests the idle loop's figures while the agent runs — resized up for verify, so
    // no memory limit is ever lowered under a running suite. An unset GATE_ slot is the runner's.
    it('sizes the gate sidecar idle under the GATE_* limits while the agent keeps the runner resources', () => {
        const config = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            RUNNER_CPU_REQUEST: '500m',
            RUNNER_MEMORY_REQUEST: '1Gi',
            RUNNER_CPU_LIMIT: '4',
            GATE_CPU_REQUEST: '2',
            GATE_MEMORY_REQUEST: '2Gi',
        });
        expect(gateView(config, job).pod.containers[0]!.resources).toEqual({
            requests: { cpu: '100m', memory: '128Mi' },
            limits: { cpu: '4' },
        });
        // The runner's pod keeps the runner's sizing, through its agent.
        const runnerPod = runnerJobSpec(config, repoJob, { id: SESSION, resume: false });
        expect(runnerPod.spec.template.spec.containers[0]!.resources).toEqual({
            requests: { cpu: '500m', memory: '1Gi' },
            limits: { cpu: '4' },
        });
    });

    it.each(SIZED_POD_NAMES)('carries no resources on %s when none are configured', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.resources).toBeUndefined();
    });

    // R1-6: the idle request never exceeds what the gate is configured to request or limited to.
    it('keeps the gate sidecar’s idle requests within limits set below the idle figures', () => {
        const config = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            GATE_CPU_LIMIT: '50m',
            GATE_MEMORY_LIMIT: '64Mi',
        });
        expect(gateView(config, job).pod.containers[0]!.resources).toEqual({
            requests: { cpu: '50m', memory: '64Mi' },
            limits: { cpu: '50m', memory: '64Mi' },
        });
        const unset = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });
        expect(gateView(unset, job).pod.containers[0]!.resources).toEqual({
            requests: { cpu: '100m', memory: '128Mi' },
        });
    });
});

// Every pod runs once and never talks to the apiserver: no restart, no service-account token.
// Every Job-backed pod is bounded by a deadline of its own, never retried, and reaped once done.
describe('the lifecycle of every pod the driver specs', () => {
    it.each(POD_NAMES)('runs %s once, without a service-account token', (name) => {
        const { pod } = everyPodSpec()[name]();
        expect(pod.restartPolicy).toBe('Never');
        expect(pod.automountServiceAccountToken).toBe(false);
    });

    it.each(POD_NAMES)('bounds %s with a deadline of its own, never retries it and reaps its pod', (name) => {
        const { job: jobObject } = everyPodSpec()[name]();
        expect(jobObject.spec.activeDeadlineSeconds).toBeGreaterThan(0);
        expect(jobObject.spec.backoffLimit).toBe(0);
        expect(jobObject.spec.ttlSecondsAfterFinished).toBeGreaterThan(0);
    });
});

/*
 * Issue #382. Every pod the driver specs runs code it did not write — the agent's commands, the
 * repository's scripts, a gate, a helper, a declared service's image. The hardening below is what
 * stands between that code and the node, and it is unconditional: there is no config knob, because
 * an operator who can turn it off is an operator who will find it off after an incident.
 *
 * What actually protects a NEW aux Job is not the list above — which is hand-written and can fall
 * behind — but the single spread inside `auxJobSpec`, which every aux builder goes through. This
 * suite pins that the spread exists and reaches all ten of today's aux builders (`runnerJobSpec`
 * has its own spread and never goes through it), and the declared service sidecar besides.
 */
describe('the pod hardening on every pod the driver specs (#382)', () => {
    // A capability is a slice of root the kernel hands a process without asking anyone. An agent
    // run needs none of them: it reads, writes and compiles inside its own worktree. Dropping ALL
    // is what makes `CAP_NET_RAW` (ARP spoofing a neighbour pod) and `CAP_DAC_OVERRIDE` (reading
    // past the file modes on the shared claim) unavailable rather than merely unused.
    it.each(POD_NAMES)('drops every capability on %s', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.securityContext?.capabilities?.drop).toEqual(['ALL']);
    });

    // Without this a setuid binary inside the image re-acquires what the drop above removed, and
    // the drop becomes decoration. The two are one control; they are asserted separately because
    // a regression reaches for one at a time.
    it.each(POD_NAMES)('refuses privilege escalation on %s', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.securityContext?.allowPrivilegeEscalation).toBe(false);
    });

    // Issue #814: the agent starts as root to launch its tool broker, with exactly the two
    // capabilities a uid switch needs; factory-launch drops both before the CLI starts.
    it('starts the agent as root with SETUID and SETGID added, and nothing else', () => {
        expect(
            containerView(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), job, AGENT_CONTAINER)
                .pod.containers[0]!.securityContext
        ).toEqual({
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'], add: ['SETUID', 'SETGID'] },
            runAsUser: 0,
            runAsGroup: 0,
        });
    });

    it.each(POD_NAMES)('adds no capability to any other container of %s, nor starts one as root', (name) => {
        const { pod } = everyPodSpec()[name]();
        const spec = pod as typeof pod & { initContainers?: typeof pod.containers };
        const others = [...spec.containers, ...(spec.initContainers ?? [])].filter(
            (container) => (container as { name?: string }).name !== AGENT_CONTAINER
        );
        for (const container of others) {
            const context = container.securityContext as { capabilities?: { add?: string[] }; runAsUser?: number };
            expect(context?.capabilities?.add).toBeUndefined();
            expect(context?.runAsUser).not.toBe(0);
        }
    });

    // Pod level, not container level: seccomp is a property of the whole pod's containers, and
    // naming it once is what keeps a future sidecar from being born unfiltered. RuntimeDefault is
    // the runtime's own profile — it blocks the syscalls a container has no business making
    // (keyctl, the kernel module calls) without the per-image tuning a Localhost profile needs.
    it.each(POD_NAMES)('runs %s under the runtime default seccomp profile', (name) => {
        expect(everyPodSpec()[name]().pod.securityContext?.seccompProfile).toEqual({ type: 'RuntimeDefault' });
    });

    // The deliberate absence, pinned so a future tightening reads the reason before it lands: an
    // agent run writes its caches, its HOME and its git worktree, and a read-only root filesystem
    // fails it on the first npm install. The workspace is the writable surface by design; see
    // docs/security.md, "What the hardening does not do".
    it.each(POD_NAMES)('sets no readOnlyRootFilesystem on %s, which an agent run needs', (name) => {
        expect(everyPodSpec()[name]().pod.containers[0]!.securityContext?.readOnlyRootFilesystem).toBeUndefined();
    });

    // A declared service is the one container in the fleet whose image the driver did not build: a
    // repository author names it in `.bellows.yaml` and the cluster pulls it. It is hardened like
    // everything else (the rows above), and the pod it shares with the agent carries no opt-out.
    it('hardens a declared service sidecar like every other container, its pod carrying no opt-out', () => {
        expect(everyPodSpec()['the service sidecar']().meta.labels['factory.unhardened']).toBeUndefined();
    });

    // The gate writes the shared worktree as a fixed uid:gid, on its own container: the pod's
    // securityContext keeps the seccomp profile alone, for every container of the pod.
    it('runs the gate sidecar as the gate uid:gid beside its hardening, the pod keeping the seccomp profile', () => {
        const { pod } = gateView(loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }), job);
        expect(pod.securityContext).toEqual({ seccompProfile: { type: 'RuntimeDefault' } });
        expect(pod.containers[0]!.securityContext).toEqual({
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            runAsUser: 1000,
            runAsGroup: 1000,
        });
    });
});

/*
 * The runner is tested against an injected request function — the same discipline board.test.ts
 * applies to fetch, and the reason this suite spawns nothing and needs no cluster. The fake is a
 * router over (method, path): everything it is not told about throws, so a test that passes is one
 * whose every call was accounted for.
 */
const namespace = 'factory';

const podName = `${runnerJobName(job)}-xxxxx`;

const { FAKE, claimServer, fakeRequest, routed } = k8sApiserver({ namespace, podName });

/**
 * The close-time claude-code turn read, appended to every claude-code run: one aux Job over the
 * PVC, its verdict poll, the pod log it answers through, and the reaping delete. The fake routes
 * the Job status and pod routes to the same canned answers the runner Job gets, so the read
 * "succeeds" with an unparseable log — agentTurns null, the unmeasured answer.
 */
const cturnsCalls = (j: BoardJob): string[] => [
    `POST ${jobsPath(namespace)}`,
    `GET ${jobPath(namespace, claudeTurnsJobName(j))}`,
    `GET /api/v1/namespaces/factory/pods`,
    `GET /api/v1/namespaces/factory/pods/${podName}/log`,
    `DELETE ${jobPath(namespace, claudeTurnsJobName(j))}`,
];

/**
 * The methods of a runner attempt after its sweep: the claim verify, the Job POST (suspended), the
 * Secret POST, the claim verify, the Job's resume, the status poll, the pod list and the log; then
 * the close-time claude-code turn read — one aux Job, posted, polled, its pod listed, logged and
 * reaped. The group's Secret is not reaped here, nor is the checkout claim released: the group's
 * end (`finish`) does both, once confirmed (issue #821). The fence tests spell out everything before it.
 */
const RUN_FROM_SECRET = [
    ...['GET', 'POST', 'POST', 'GET', 'PATCH', 'GET', 'GET', 'GET'],
    ...['POST', 'GET', 'GET', 'GET', 'DELETE'],
];

/** The teardown's writer-pod list (`writerPodsPath`): every pod of one (job, lease) pair. */
const isWriterPodList = (path: string): boolean =>
    /\/pods\?labelSelector=factory\.job=[^,]+,factory\.lease=[0-9a-f-]+$/.test(decodeURIComponent(path));

/** The answer a hand-written fake gave a call it did not script. */
const noAnswer = (method: K8sMethod, path: string): Promise<K8sResponse> =>
    Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
/** A DELETE of one Job by name — a `routed` fake whose original never scripted it rejects it. */
const isJobDelete = (method: K8sMethod, path: string): boolean =>
    method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`);
/** A DELETE of the checkout claim — likewise rejected where the original never scripted it. */
const isClaimDelete = (method: K8sMethod, path: string): boolean =>
    method === 'DELETE' && path.startsWith(`${configmapsPath}/`);

const stepOk = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

/** What the supervisor answers a step by default: the sync's verdict, otherwise a quiet success. */
const defaultStepAnswer = (step: StepRequest): StepResult =>
    stepOk(step.kind === 'sync' ? '{"ok":true,"reason":null}\n' : '');

/**
 * The supervised-step channel of an attempt (issue #771): records every step submitted, answers each
 * through `answer`, and reports only when the test says so — so a run's end is the Job's, as it is
 * for any test that scripts the Job status, unless a test calls `report`.
 */
function fakeSteps(answer: (step: StepRequest) => StepResult | Promise<StepResult> = defaultStepAnswer) {
    const submitted: StepRequest[] = [];
    const tokens = new Set<string>();
    const signals: (AbortSignal | undefined)[] = [];
    let report!: (r: SupervisorReport) => void;
    const reported = new Promise<SupervisorReport>((resolve) => {
        report = resolve;
    });
    const sink: StepSink = {
        submit: async (token, step, signal) => {
            tokens.add(token);
            signals.push(signal);
            if (signal?.aborted) throw new Error('the step was cancelled');
            submitted.push(step);
            return answer(step);
        },
        awaitReport: () => reported,
        contacted: () => true,
        release: () => undefined,
        attach: () => undefined,
        cancel: () => undefined,
    };
    return { sink, submitted, tokens, signals, report };
}
const kindsOf = (steps: { submitted: StepRequest[] }): string[] => steps.submitted.map((step) => step.kind);

/** createKubernetesRunner with a step channel wired in unless the test brings its own: no attempt runs without one. */
const supervisedRunner = (
    config: DriverConfig,
    request: K8sRequest,
    sleep: (ms: number) => Promise<void> = async () => {},
    wiring: Parameters<typeof createKubernetesRunner>[3] = {}
) => createKubernetesRunner(config, request, sleep, { steps: fakeSteps().sink, ...wiring });

const runner = (
    request: K8sRequest,
    env: Record<string, string> = {},
    leases?: Board['leases'],
    steps: StepSink = fakeSteps().sink
) =>
    supervisedRunner(
        loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0', ...env }),
        request,
        async () => {},
        { ...(leases ? { leases } : {}), steps }
    );

/** The board's lease lookup, answering that `held` holds the job's live lease. */
const boardLease =
    (held: BoardJob, leaseToken: string | null = held.leaseToken): Board['leases'] =>
    async (ids) =>
        ids.includes(held.id) ? [{ id: held.id, status: 'running', leaseToken }] : [];

/** A lease token distinct from the fixture job's, for the attempt that reclaimed a job. */
const NEW_TOKEN = '99999999-9999-4999-8999-999999999999';
/** Another attempt's lease: a claim's holder is always a lease token. */
const OTHER_HOLDER = '77777777-7777-4777-8777-777777777777';

/** The run start both close-time readouts bound their turn counts to. */
const START = '2026-08-20T06:00:00.000Z';

const configmapsPath = `/api/v1/namespaces/${namespace}/configmaps`;

/** The checkout claim's path: one ConfigMap per JOB id, shared by every attempt (issue #32). */
const claimPathFor = (id: string): string => `${configmapsPath}/factory-job-${id}-claim`;

describe('readVerdict', () => {
    const depsOf = (request: K8sRequest): K8sDeps => ({
        request,
        sleep: async () => {},
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
    });

    it('retries a plain-text 400 Bad Request like a 5xx and answers the eventual 2xx', async () => {
        let reads = 0;
        const request: K8sRequest = () => {
            reads += 1;
            return reads <= 2
                ? Promise.resolve({ status: 400, body: '400 Bad Request' })
                : Promise.resolve({ status: 200, body: JSON.stringify({ status: { succeeded: 1 } }) });
        };
        const response = await readVerdict(depsOf(request), jobPath(namespace, 'j'), 'reading the job j');
        expect(response.status).toBe(200);
        expect(reads).toBe(3);
    });

    it('does not retry a JSON Status 400 — the API refused, and retrying would only repeat it', async () => {
        let reads = 0;
        const request: K8sRequest = () => {
            reads += 1;
            return Promise.resolve({
                status: 400,
                body: '{"kind":"Status","status":"Failure","reason":"Invalid","message":"Job.batch is invalid"}',
            });
        };
        const response = await readVerdict(depsOf(request), jobPath(namespace, 'j'), 'reading the job j');
        expect(response.status).toBe(400);
        expect(reads).toBe(1);
    });

    it('throws with the body in the message when the malformed 400 never stops', async () => {
        const request: K8sRequest = () => Promise.resolve({ status: 400, body: '400 Bad Request' });
        await expect(readVerdict(depsOf(request), jobPath(namespace, 'j'), 'reading the job j')).rejects.toThrow(
            /answered 400 .* in a row.*400 Bad Request/s
        );
    });
});

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
    const WORKTREE = `/workspaces/bellows/${USER}/.worktrees/${repoJob.id}`;
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

    it('submits the worktree script as one sync step, naming the three paths as literals beside the claim env', async () => {
        const envJob: BoardJob = { ...repoJob, env: { CORE_TOKEN: 'shh' } };
        const steps = fakeSteps();
        expect(await sync(envJob, steps)).toEqual({ ok: true, reason: null });

        const step = syncOf(steps);
        expect(step.argv).toEqual(['node', '-e', gitWorktreeScript]);
        expect(step.env).toEqual({
            CORE_TOKEN: 'shh',
            REPO: `/workspaces/bellows/${USER}/factory`,
            WORKTREE,
            BRANCH: `factory/${repoJob.id}`,
        });
        expect(steps.tokens).toEqual(new Set([CONTROL_TOKEN]));
    });

    // The whole attempt in one pod (issues #771-#774): the sync, the setup, a gate, a declared
    // service, a review (snapshot, restore, run, export) and the caller's finish are steps of the
    // task Job's supervisor, so the cluster is asked for the task Job, its Secret and the claim
    // ConfigMap and for nothing else. A new object here is a regression, not an allowance.
    it('creates only the task Job, its Secret and the claim ConfigMap for a full attempt, review included', async () => {
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
        // The session readout Jobs of the close are split to issue #882 and are the only exception.
        const readouts = new Set([opencodeReadoutJobName(reviewing), claudeTurnsJobName(reviewing)]);
        const created = api.calls
            .filter((call) => call.method === 'POST')
            .map((call) => ({ path: call.path, name: (call.body as { metadata: { name: string } }).metadata.name }))
            .filter((call) => !readouts.has(call.name));
        // The claim is taken by the sync and again by the group's creation: one name, one object.
        const objects = [...new Map(created.map((call) => [`${call.path} ${call.name}`, call])).values()];
        expect(objects).toHaveLength(3);
        expect(objects).toEqual(
            expect.arrayContaining([
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
        const followUp = fakeSteps();
        await sync({ ...repoJob, followUp: true }, followUp, undefined, 't0k-3n');
        expect(syncOf(followUp).env.RESTORE).toBe('1');
        expect(syncOf(followUp).env).not.toHaveProperty('CRED_HELPER');
        expect(JSON.stringify(syncOf(followUp))).not.toContain('t0k-3n');

        // A parked job resumed (resumeSessionId without followUp) is the same mid-task hazard.
        const parked = fakeSteps();
        await sync({ ...repoJob, resumeSessionId: SESSION }, parked, undefined, 't0k-3n');
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
        expect(Object.keys(syncOf(steps).env).sort()).toEqual(['BRANCH', 'REPO', 'WORKTREE']);
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
        const verdict = { ok: false, reason: 'the repository clone /w/r does not exist', kind: 'missing_clone' };
        expect(await sync(repoJob, syncing(`${JSON.stringify(verdict)}\n`))).toMatchObject(verdict);
    });

    it('answers checkout contention with the transient reason, its claim already given back', async () => {
        const reason =
            'transient worktree sync: the checkout lock /w/.git/factory-sync.lock is still held after 20000ms';
        const { request, calls } = fakeRequest();

        const result = await sync(repoJob, syncing(`${JSON.stringify({ ok: false, reason })}\n`), request);

        expect(result.ok).toBe(false);
        expect(TRANSIENT_SYNC_REASON.test(result.reason ?? '')).toBe(true);
        expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(true);
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
     * Issue #559: a contention requeue refunds the attempt, so `attempts` can go DOWN between two
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
 * The terminal reclaim (issue #47), ported the same way the sync was: the remove script as a
 * supervised step, in a supervisor-only group of its own (the thread has no attempt to ask) under
 * a lease token it opens through the driver's endpoint. What it shares with the sync is the
 * checkout CLAIM: a thread that looks terminal can gain a follow-up between the board's answer
 * and the removal, and the follow-up's own sync is a writer on the same root-scoped tree — so
 * the reclaim takes the claim for its whole duration, and an acquire that answers 409 (a live
 * attempt holds the checkout) SKIPS the reclaim. Costing the reclaim is fine by contract;
 * costing a live run is not. No claim env: removing needs nothing the claim held.
 */
describe('the worktree reclaim', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory', env: { GITHUB_TOKEN: 't0k-3n' } };
    const WORKTREE = `/workspaces/bellows/${USER}/.worktrees/${repoJob.id}`;
    const RECLAIM_TOKEN = 'reclaim-token';
    const endpoint = {
        open: async () => ({ url: 'http://driver:8130', token: RECLAIM_TOKEN }),
        close: () => undefined,
    };
    const reclaimer = (request: K8sRequest, steps = fakeSteps(reclaimAnswer())) =>
        supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {},
            { steps: steps.sink, endpoint }
        );
    function reclaimAnswer(stdout = '{"ok":true,"removed":true,"reason":null}\n') {
        return (step: StepRequest): StepResult => (step.kind === 'reclaim' ? stepOk(stdout) : stepOk());
    }
    const groupOf = (calls: Call[]) =>
        calls.find((call) => call.method === 'POST' && call.path === jobsPath(namespace))!.body as ReturnType<
            typeof runnerJobSpec
        >;

    it('submits the remove script as a reclaim step, naming only the clone and the worktree', async () => {
        const steps = fakeSteps(reclaimAnswer());
        const result = await reclaimer(fakeRequest().request, steps).reclaimWorktree(repoJob);

        expect(result).toEqual({ ok: true, removed: true, reason: null });
        const step = steps.submitted.find((s) => s.kind === 'reclaim')!;
        expect(step.argv).toEqual(['node', '-e', gitWorktreeRemoveScript]);
        // No BRANCH, no credential-helper code, no claim env: reclaim authenticates nothing.
        expect(step.env).toEqual({
            REPO: `/workspaces/bellows/${USER}/factory`,
            WORKTREE,
            // The thread's review roots go with it (issue #774).
            REVIEW_ROOTS: `${WORKTREE}.reviews`,
        });
        expect(steps.tokens).toEqual(new Set([RECLAIM_TOKEN]));
    });

    it('runs in a supervisor-only group over the member’s own subtree, never the attempt’s group', async () => {
        const { request, calls } = fakeRequest();
        await reclaimer(request).reclaimWorktree(repoJob);

        const group = groupOf(calls);
        expect(group.metadata.name).toMatch(/^factory-reclaim-/);
        expect(group.metadata.name).not.toBe(runnerJobName(repoJob));
        expect(group.spec.template.spec.containers.map((c) => c.name)).toEqual([SUPERVISOR_CONTAINER]);
        expect(group.spec.template.spec.containers[0]!.volumeMounts).toContainEqual({
            name: 'workspaces',
            mountPath: `/workspaces/bellows/${USER}`,
            subPath: `bellows/${USER}`,
        });
        // The claim env is never the group's: not in its Secret, not in its spec.
        expect(JSON.stringify(calls.map((call) => call.body))).not.toContain('t0k-3n');
    });

    // Issue #814: before the supervisor, the tool uid gives what it closed group rwx, so the uid-1000
    // reclaim can empty it — hardened, no capability, the tree's path and nothing else.
    it('releases the tree as the tool uid in an init container before the supervisor starts', async () => {
        const { request, calls } = fakeRequest();
        await reclaimer(request).reclaimWorktree(repoJob);

        const [release, ...others] = groupOf(calls).spec.template.spec.initContainers ?? [];
        expect(others).toEqual([]);
        expect(release).toMatchObject({
            name: 'release',
            // Bounded like docker's release, and always 0: the reclaim's own verdict decides.
            command: ['sh', '-c', toolTreeReleaseBoundedScript, 'release', toolTreeReleaseScript],
            env: [
                { name: 'WORKTREE', value: WORKTREE },
                { name: 'RELEASE_DEADLINE_SECONDS', value: '300' },
            ],
            securityContext: {
                allowPrivilegeEscalation: false,
                capabilities: { drop: ['ALL'] },
                runAsUser: 1001,
                runAsGroup: 1000,
            },
        });
        expect(release!.securityContext.capabilities).not.toHaveProperty('add');
        expect(release!.volumeMounts).toEqual(
            groupOf(calls).spec.template.spec.containers[0]!.volumeMounts.filter((mount) => mount.name === 'workspaces')
        );
    });

    it('reclaims nothing for a worktree path it cannot assert', async () => {
        const { request, calls } = fakeRequest();
        const result = await reclaimer(request).reclaimWorktree({ ...repoJob, rootJobId: 'not-a-uuid' });
        expect(result).toEqual({ ok: true, removed: false, reason: null });
        expect(calls).toHaveLength(0);
    });

    it('takes the checkout claim before the group and releases it after the group is deleted', async () => {
        const { request, calls } = fakeRequest();
        const result = await reclaimer(request).reclaimWorktree(repoJob);

        expect(result).toEqual({ ok: true, removed: true, reason: null });
        // The claim brackets the group: acquired before the POST (so a follow-up's sync, itself
        // claim-taking, cannot interleave), released only after the group's delete.
        const name = groupOf(calls).metadata.name;
        const claimPost = calls.findIndex((call) => call.method === 'POST' && call.path === configmapsPath);
        const jobPost = calls.findIndex((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        // The group's own end, after its POST — the delete before it ends whatever an earlier
        // reclaim of the same holder left under the same derived name (issue #821).
        const jobDelete = calls.findLastIndex(
            (call) =>
                call.method === 'DELETE' && call.path === `${jobsPath(namespace)}/${name}?propagationPolicy=Foreground`
        );
        const claimDelete = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id)
        );
        expect(claimPost).toBeGreaterThanOrEqual(0);
        expect(jobPost).toBeGreaterThan(claimPost);
        expect(jobDelete).toBeGreaterThan(jobPost);
        expect(claimDelete).toBeGreaterThan(jobDelete);
    });

    it('skips the reclaim — ok:false, no group — when a live attempt holds the checkout claim', async () => {
        const { request, calls } = fakeRequest();
        // Another attempt holds the checkout: a claim whose attempt is at or ahead of ours —
        // a follow-up claimed and mid-sync, most likely. The acquire must refuse to take over.
        await request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '5' },
        });
        const steps = fakeSteps(reclaimAnswer());

        const result = await reclaimer(request, steps).reclaimWorktree(repoJob);

        expect(result.ok).toBe(false);
        expect(result.removed).toBe(false);
        expect(result.reason).toContain('held');
        expect(result.reason).toContain(WORKTREE);
        // Nothing was created against a checkout somebody else is writing.
        expect(calls.some((call) => call.method === 'POST' && call.path === jobsPath(namespace))).toBe(false);
        expect(steps.submitted).toEqual([]);
    });

    // The failure arms take the group down Foreground BEFORE the release, so a mid-flight
    // removal never outlives the claim it runs under. The thrown step is an ok:false answer
    // now — the reclaim's group is its own, there is no lease to leave the row to.
    it('releases the checkout claim only after the group is gone, even when the step throws', async () => {
        const base = fakeRequest();
        const completions: string[] = [];
        const gated: K8sRequest = async (method, path, body) => {
            const response = await base.request(method, path, body);
            if (method === 'DELETE' && path.includes('/jobs/') && path.endsWith('propagationPolicy=Foreground')) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                completions.push('group-gone');
            } else if (method === 'DELETE' && path === claimPathFor(repoJob.id)) {
                completions.push('claim-released');
            }
            return response;
        };
        const steps = fakeSteps((step) => {
            if (step.kind === 'reclaim') throw new Error('the step channel closed');
            return stepOk();
        });

        const result = await reclaimer(gated, steps).reclaimWorktree(repoJob);

        expect(result).toMatchObject({
            ok: false,
            removed: false,
            reason: expect.stringContaining('step channel closed'),
        });
        // Only the group's own: the derived name held nothing before its POST, so nothing was deleted then.
        expect(completions).toEqual(['group-gone', 'claim-released']);
    });

    // The group's own POST, the same transient-400 rule the polls have (issue #308): the answer
    // is the reclaim's ok:false — the reclaim never throws into the loop — with the checkout
    // handed back.
    it('answers ok:false, claim given back, when the group POST answers the pre-handler 400', async () => {
        const { request, calls } = fakeRequest({ create: { status: 400, body: '400 Bad Request' } });
        const result = await reclaimer(request).reclaimWorktree(repoJob);
        expect(result).toMatchObject({ ok: false, removed: false, reason: expect.stringContaining('answered 400') });
        expect(calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id))).toBe(true);
    });

    /*
     * Issue #302's reclaim twin: the same unpullable image holds the reclaim group's pod in
     * ImagePullBackOff and no supervisor comes up. The wait names the image the moment the pod does.
     */
    it('names an unpullable executor image instead of waiting out the supervisor', async () => {
        const { request } = fakeRequest({
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: 'reclaim-pod' },
                            status: {
                                containerStatuses: [
                                    {
                                        name: AGENT_CONTAINER,
                                        state: {
                                            waiting: {
                                                reason: 'ImagePullBackOff',
                                                message: 'pull access denied, repository does not exist',
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
        const steps = fakeSteps(reclaimAnswer());
        steps.sink.contacted = () => false;
        const result = await reclaimer(request, steps).reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.removed).toBe(false);
        expect(result.reason).toMatch(
            /the executor image "claude-executor" cannot be pulled: ImagePullBackOff — pull access denied/
        );
        expect(steps.submitted.filter((s) => s.kind === 'reclaim')).toEqual([]);
    });

    it('answers the script verdict when the reclaim script refuses', async () => {
        const result = await reclaimer(
            fakeRequest().request,
            fakeSteps(
                reclaimAnswer(
                    '{"ok":false,"removed":false,"reason":"refusing to remove /x: a git tree that is not a registered worktree"}\n'
                )
            )
        ).reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('registered worktree');
    });

    // Issue #344's reclaim twin: an unreadable reclaim verdict names why, the same way the sync's
    // does, and a step that ends badly says so in the tool's own words.
    it.each([
        [
            'a clean exit that printed no verdict',
            stepOk('something else\n'),
            /^the worktree reclaim answered nothing readable.*something else/,
        ],
        [
            'a non-zero exit',
            { exitCode: 1, stdout: '', stderr: 'rm: permission denied\n', timedOut: false },
            /^the worktree reclaim failed: rm: permission denied$/,
        ],
        [
            'a step ended at its bound',
            { exitCode: null, stdout: '', stderr: '', timedOut: true },
            /^the worktree reclaim failed: the step exceeded its \d+ms deadline$/,
        ],
    ] as const)('folds %s into the reclaim verdict', async (_what, answer, reason) => {
        const result = await reclaimer(
            fakeRequest().request,
            fakeSteps((step) => (step.kind === 'reclaim' ? answer : stepOk()))
        ).reclaimWorktree(repoJob);
        expect(result).toMatchObject({ ok: false, removed: false });
        expect(result.reason).toMatch(reason);
    });

    /*
     * Issue #344, the claim loop: a reclaim refused by the checkout claim used to leave only the
     * transport's raw 409 header dump — no claim name, no holder, no age. The refusal now carries
     * the claim's identity so the loop can name it — and, when the board proves the holder gone,
     * reap it.
     */
    it('reports the held claim’s identity when the checkout is held', async () => {
        const { request } = fakeRequest();
        await request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '5' },
        });

        const result = await runner(request).reclaimWorktree(repoJob);

        expect(result.ok).toBe(false);
        // The incarnation read rides along (issue #821): the reap may act on that one only.
        expect(result.heldClaim).toEqual({
            name: `factory-job-${repoJob.id}-claim`,
            claimSeq: '5',
            createdMs: expect.any(Number),
            uid: expect.stringMatching(/^claim-uid-/),
            holder: NEW_TOKEN,
        });
    });

    it('answers heldClaim undefined when the refusal was not the claim’s', async () => {
        // A transport failure in the acquire is not a claim refusal — no claim to read, and the
        // heldClaim read (which answers 404 here, nothing on the configmap path) stays undefined.
        const { request: base } = fakeRequest();
        const request: K8sRequest = (method, path, body) => {
            if (method === 'POST' && path === configmapsPath) {
                return Promise.reject(new Error('connection refused'));
            }
            return base(method, path, body);
        };
        const result = await runner(request).reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('the checkout is held');
        expect(result.heldClaim).toBeUndefined();
    });

    /** The claim as a refused reclaim reads it: the incarnation its reap may act on. */
    const observe = async (request: K8sRequest) => {
        const read = JSON.parse((await request('GET', claimPathFor(repoJob.id))).body) as {
            metadata: { uid: string };
            data: { holder: string };
        };
        return { uid: read.metadata.uid, holder: read.data.holder };
    };

    it('reaps an orphaned checkout claim by uid precondition', async () => {
        const { request, calls } = fakeRequest();
        await request('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '3' },
        });
        const observed = await observe(request);

        await expect(runner(request).reapOrphanedClaim?.(repoJob, observed)).resolves.toBe(true);
        // The delete names the exact incarnation it read — a claim replaced between the read and
        // the delete (a live claimant's takeover) is never the one that goes.
        const del = calls.find((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
        expect((del?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toMatch(
            /^claim-uid-/
        );
        // Gone: the second read answers 404 and the reap answers false — there was nothing to reap.
        await expect(runner(request).reapOrphanedClaim?.(repoJob, observed)).resolves.toBe(false);
    });

    it('answers false and deletes nothing when the claim was replaced between the read and the delete', async () => {
        const { request: base, calls } = fakeRequest();
        await base('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '3' },
        });
        const observed = await observe(base);
        const before = calls.length;
        // The read answers a stale incarnation: the claim was taken over (deleted and re-created
        // under a new uid) between the proof and the reap.
        const request: K8sRequest = (method, path, body) => {
            if (method === 'GET' && path === claimPathFor(repoJob.id)) {
                return base(method, path, body).then((res) => ({
                    status: res.status,
                    body: JSON.stringify({
                        ...JSON.parse(res.body),
                        metadata: { uid: 'claim-uid-stale-incarnation' },
                    }),
                }));
            }
            return base(method, path, body);
        };

        await expect(runner(request).reapOrphanedClaim?.(repoJob, observed)).resolves.toBe(false);

        // The incarnation changed since the refusal read it (issue #821): rejected before anything
        // is ended or deleted — no group of the holder, no claim. The real object is still there
        // for its holder's own release.
        expect(calls.slice(before).filter((call) => call.method === 'DELETE')).toEqual([]);
        await expect(runner(base).reapOrphanedClaim?.(repoJob, observed)).resolves.toBe(true);
    });

    it('answers createdMs null when the claim carries no creation stamp', async () => {
        const { request: base } = fakeRequest();
        await base('POST', configmapsPath, {
            apiVersion: 'v1',
            kind: 'ConfigMap',
            metadata: { name: `factory-job-${repoJob.id}-claim` },
            data: { holder: NEW_TOKEN, claimSeq: '5' },
        });
        const request: K8sRequest = (method, path, body) => {
            if (method === 'GET' && path === claimPathFor(repoJob.id)) {
                return base(method, path, body).then((res) => {
                    const parsed = JSON.parse(res.body) as { metadata: Record<string, unknown> };
                    delete parsed.metadata.creationTimestamp;
                    return { status: res.status, body: JSON.stringify(parsed) };
                });
            }
            return base(method, path, body);
        };

        const result = await runner(request).reclaimWorktree(repoJob);
        expect(result.heldClaim).toEqual({
            name: `factory-job-${repoJob.id}-claim`,
            claimSeq: '5',
            createdMs: null,
            uid: expect.stringMatching(/^claim-uid-/),
            holder: NEW_TOKEN,
        });
    });

    it('reclaims nothing for a job that names no repository', async () => {
        const { request, calls } = fakeRequest();
        expect(await runner(request).reclaimWorktree(job)).toEqual({ ok: true, removed: false, reason: null });
        // Not even a claim attempt: there is no tree and no checkout to fence.
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
    const WT = `/workspaces/bellows/${USER}/.worktrees/${ISSUE_JOB.id}`;
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

    // A step the supervisor never answers (the channel closed under it) is a transport failure
    // the loop can retry, never a verdict on the work.
    it('names a closed step channel a transport failure', async () => {
        const steps = scripted({
            step: (step) => {
                if (!step.argv.includes('push')) return null;
                throw new StepChannelClosed('the answer');
            },
        });
        const result = await publishing(steps).publishGit(ISSUE_JOB, 'ghs_fresh');
        expect(result).toMatchObject({ ok: false, published: false, cause: 'transport' });
    });
});

/*
 * The runner vitals under kubernetes: the metrics API is the docker stats twin, read from the
 * runner's own pod — and null, never an error, whenever there is nothing to read (no pod yet,
 * no metrics-server in the cluster, a body that is not metrics).
 */
describe('the runner vitals', () => {
    it('parses the PodMetrics object the metrics API answers', () => {
        expect(parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: '250m', memory: '150Mi' } }] }))).toEqual({
            cpuPercent: 25,
            memUsedMb: 150,
            memPercent: null,
        });
        // Nanocores and plain bytes — the other spellings metrics-server emits.
        expect(
            parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: '1250000n', memory: '5368709120' } }] }))
        ).toEqual({ cpuPercent: 0.125, memUsedMb: 5120, memPercent: null });
        // Whole cores and binary memory sizes.
        expect(parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: '1.5', memory: '2Gi' } }] }))).toEqual({
            cpuPercent: 150,
            memUsedMb: 2048,
            memPercent: null,
        });
        expect(parsePodMetrics('')).toBeNull();
        expect(parsePodMetrics('null')).toBeNull();
        expect(parsePodMetrics('{"containers":[]}')).toBeNull();
        expect(
            parsePodMetrics(JSON.stringify({ containers: [{ usage: { cpu: 'busy', memory: '150Mi' } }] }))
        ).toBeNull();
    });

    it('samples through the metrics API, and answers null when the cluster runs no metrics-server', async () => {
        const base = fakeRequest();
        const withMetrics: K8sRequest = (method, path, body) => {
            if (path === `/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${podName}`) {
                return Promise.resolve({
                    status: 200,
                    body: JSON.stringify({ containers: [{ usage: { cpu: '310m', memory: '96Mi' } }] }),
                });
            }
            return base.request(method, path, body);
        };
        expect(await runner(withMetrics).sampleRuntime(job)).toEqual({
            cpuPercent: 31,
            memUsedMb: 96,
            memPercent: null,
        });

        const noMetricsServer: K8sRequest = (method, path, body) => {
            if (path.startsWith('/apis/metrics.k8s.io/'))
                return Promise.resolve({ status: 404, body: 'no metrics-server' });
            return base.request(method, path, body);
        };
        expect(await runner(noMetricsServer).sampleRuntime(job)).toBeNull();
    });

    /**
     * The attempt's services ride the same sample (issue #60), read off the task pod's own sidecar
     * statuses (issue #773). THE kubernetes regression this exists for: a cluster with no
     * metrics-server (kind, for one) must not silence them — the sample carries null vitals beside
     * real service states rather than skipping the flush. A job that declared nothing reports
     * exactly what it reported before.
     */
    it('reports the service sidecars beside the vitals, with or without them', async () => {
        const declared: BoardJob = { ...job, services: [{ name: 'db', image: 'postgres:16', environment: [] }] };
        const pods = routed((method, path) =>
            method === 'GET' && decodeURIComponent(path).includes('job-name=')
                ? {
                      status: 200,
                      body: JSON.stringify({
                          items: [
                              {
                                  metadata: { name: podName },
                                  status: { initContainerStatuses: [{ name: 'svc-db', state: { running: {} } }] },
                              },
                          ],
                      }),
                  }
                : undefined
        );
        const withMetrics =
            (metrics: K8sResponse): K8sRequest =>
            (method, path, body) =>
                path.startsWith('/apis/metrics.k8s.io/') ? Promise.resolve(metrics) : pods.request(method, path, body);
        const metricsBody = {
            status: 200,
            body: JSON.stringify({ containers: [{ usage: { cpu: '310m', memory: '96Mi' } }] }),
        };
        const services = [{ name: 'db', image: 'postgres:16', state: 'running' }];

        expect(await runner(withMetrics(metricsBody), { RUNNER_SERVICES: '1' }).sampleRuntime(declared)).toEqual({
            cpuPercent: 31,
            memUsedMb: 96,
            memPercent: null,
            services,
        });
        // No metrics-server: the services still report, the numbers go honestly null.
        const noServer = withMetrics({ status: 404, body: 'no metrics-server' });
        expect(await runner(noServer, { RUNNER_SERVICES: '1' }).sampleRuntime(declared)).toEqual({
            cpuPercent: null,
            memUsedMb: null,
            memPercent: null,
            services,
        });
        // Nothing declared, or services off: no key, and without metrics nothing to report at all.
        expect(await runner(noServer, { RUNNER_SERVICES: '1' }).sampleRuntime(job)).toBeNull();
        expect(await runner(withMetrics(metricsBody)).sampleRuntime(declared)).toEqual({
            cpuPercent: 31,
            memUsedMb: 96,
            memPercent: null,
        });
    });

    describe('a pod list read as a typed answer (#869)', () => {
        const declared: BoardJob = { ...job, services: [{ name: 'db', image: 'postgres:16', environment: [] }] };
        const depsFor = (body: string): K8sDeps => ({
            request: async () => ({ status: 200, body }),
            sleep: async () => {},
            config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '1' }),
        });
        const listing = (init: unknown[], containers: unknown[] = []): string =>
            JSON.stringify({
                items: [
                    {
                        metadata: { name: podName },
                        status: { initContainerStatuses: init, containerStatuses: containers },
                    },
                ],
            });

        it('reads a 200 null pod list as unread, never as no pod', async () => {
            expect((await readImagePullStatus(depsFor('null'), 'factory-runner-x')).podState).toBe('unread');
        });

        it('reads a pod whose sidecar names an image that is not a string as unread, with no refusal', async () => {
            const held = {
                name: 'svc-db',
                image: 42,
                state: { waiting: { reason: 'ImagePullBackOff', message: 'no' } },
            };
            const read = await readImagePullStatus(depsFor(listing([held])), 'factory-runner-x');
            expect(read).toMatchObject({ podState: 'unread', blocked: null, held: null });
            held.image = 'postgres:16' as unknown as number;
            expect(await readImagePullStatus(depsFor(listing([held])), 'factory-runner-x')).toMatchObject({
                podState: 'starting',
                held: { image: 'postgres:16' },
            });
        });

        it.each([
            ['a terminated state without an exit code', { name: 'svc-db', state: { terminated: {} } }],
            ['a restart count below zero', { name: 'svc-db', state: { running: {} }, restartCount: -1 }],
            ['a restart count that is a fraction', { name: 'svc-db', state: { running: {} }, restartCount: 1.5 }],
            [
                'a previous ending without an exit code',
                { name: 'svc-db', state: { running: {} }, lastState: { terminated: {} } },
            ],
        ])('reads a sidecar with %s as Inconclusive, never as a service failure', async (_name, sidecar) => {
            await expect(readSidecars(depsFor(listing([sidecar])), declared)).rejects.toBeInstanceOf(Inconclusive);
            const ended = { name: 'svc-db', state: { terminated: { exitCode: 3 } } };
            expect((await readSidecars(depsFor(listing([ended])), declared))[0]?.state).toBe('exited');
        });

        it('reads a null task pod list as Inconclusive', async () => {
            await expect(readSidecars(depsFor('null'), declared)).rejects.toBeInstanceOf(Inconclusive);
        });

        it('samples no runtime and resizes nothing over a pod list that is null', async () => {
            const nulled = routed((method, path) =>
                method === 'GET' && decodeURIComponent(path).includes('job-name=')
                    ? { status: 200, body: 'null' }
                    : undefined
            );
            expect(await runner(nulled.request).sampleRuntime(job)).toBeNull();
            const gated: BoardJob = { ...gatedOf(job), ...SUPERVISED };
            expect(await runner(nulled.request).resizeGate(gated, 'verify')).toBe(false);
            expect(nulled.calls.some((call) => call.method === 'PATCH')).toBe(false);
        });
    });

    describe('sidecarStatuses (issue #773 D8)', () => {
        const specs = ['up', 'ended', 'looping', 'unpullable', 'creating', 'unlisted'].map((name) => ({
            name,
            image: `${name}:1`,
            environment: [],
        }));
        const pod = {
            status: {
                initContainerStatuses: [
                    { name: 'gate', state: { running: {} } },
                    { name: 'svc-up', state: { running: {} }, restartCount: 2 },
                    { name: 'svc-ended', state: { terminated: { exitCode: 3, reason: 'Error', message: 'boom' } } },
                    {
                        name: 'svc-looping',
                        state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off' } },
                        restartCount: 4,
                        lastState: { terminated: { exitCode: 1, reason: 'Error' } },
                    },
                    {
                        name: 'svc-unpullable',
                        state: { waiting: { reason: 'ImagePullBackOff', message: 'no manifest' } },
                    },
                    { name: 'svc-creating', state: { waiting: { reason: 'ContainerCreating' } } },
                ],
            },
        };

        it('reads each declared service off its sidecar: running, exited for a reason waiting cannot cure, else pending', () => {
            expect(sidecarStatuses(pod, specs)).toEqual([
                { name: 'up', image: 'up:1', state: 'running', restartCount: 2, exitCode: null, ending: null },
                {
                    name: 'ended',
                    image: 'ended:1',
                    state: 'exited',
                    restartCount: 0,
                    exitCode: 3,
                    ending: 'Error: boom',
                },
                { name: 'looping', image: 'looping:1', state: 'exited', restartCount: 4, exitCode: 1, ending: 'Error' },
                {
                    name: 'unpullable',
                    image: 'unpullable:1',
                    state: 'exited',
                    restartCount: 0,
                    exitCode: null,
                    ending: 'ImagePullBackOff: no manifest',
                },
                {
                    name: 'creating',
                    image: 'creating:1',
                    state: 'pending',
                    restartCount: 0,
                    exitCode: null,
                    ending: null,
                },
                {
                    name: 'unlisted',
                    image: 'unlisted:1',
                    state: 'pending',
                    restartCount: 0,
                    exitCode: null,
                    ending: null,
                },
            ]);
        });
    });
});

describe('the kubernetes runner and the task supervisor', () => {
    const exporting: BoardJob = {
        ...job,
        gateEnv: { BELLOWS_CONTROL_URL: 'http://driver:7000', BELLOWS_CONTROL_TOKEN: 'tok-agent' },
        ...SUPERVISED,
    };
    const containersOf = (body: unknown): string[] =>
        (body as ReturnType<typeof runnerJobSpec>).spec.template.spec.containers.map((c) => c.name);
    const jobBodies = (calls: Call[]) =>
        calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace)).map((c) => c.body);

    it('runs the supervisor, the agent and the exporter as one pod — no exporter Job beside it', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(exporting, { id: SESSION, resume: false });
        const names = jobBodies(calls).map((body) => (body as { metadata: { name: string } }).metadata.name);
        expect(names[0]).toBe(runnerJobName(exporting));
        expect(names.some((name) => name.startsWith('factory-cexport-'))).toBe(false);
        expect(containersOf(jobBodies(calls)[0]).sort()).toEqual(['agent', 'exporter', 'supervisor']);
        // Nothing deletes the pod while the supervisor drains: the pod ends once it has finalized.
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(runnerJobName(exporting)))).toBe(
            false
        );
    });

    // A run submits its steps over the control channel, so no run goes without one; the spec is
    // still pinned for a claim that carries none: the supervisor stays, the exporter is dropped.
    it('keeps the supervisor, and drops only the exporter, for a claim with no control endpoint', () => {
        const { supervisorEnv: _none, ...unsupervised } = job;
        const spec = runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            unsupervised,
            { id: SESSION, resume: false }
        );
        expect(containersOf(spec).sort()).toEqual(['agent', 'supervisor']);
    });

    it('keeps the supervisor’s control pair in the attempt Secret and out of the agent’s env', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(exporting, { id: SESSION, resume: false });
        const secret = calls.find((call) => call.method === 'POST' && call.path.endsWith('/secrets'))!;
        const data = JSON.stringify(secret.body);
        expect(data).toContain('tok-supervisor');
        const pod = jobBodies(calls)[0] as ReturnType<typeof runnerJobSpec>;
        const agent = pod.spec.template.spec.containers.find((c) => c.name === 'agent')!;
        expect(JSON.stringify(agent)).not.toMatch(/SUPERVISOR_CONTROL/);
        expect(JSON.stringify(agent.volumeMounts)).not.toMatch(/ctl-supervisor|ctl-export/);
    });

    it('kill deletes the whole pod: the agent, the supervisor and the exporter go together', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).kill(exporting);
        const deleted = calls.filter((call) => call.method === 'DELETE').map((call) => call.path ?? '');
        expect(deleted.some((path) => path.includes(runnerJobName(exporting)))).toBe(true);
    });

    // The loop raised the kill order; the supervisor ends the agent, drains the exporter and
    // finalizes, so the pod ends by itself — a stop that waits is not a delete.
    it('stopAgent waits for the supervisor to finalize and deletes nothing once the pod is done', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).stopAgent(exporting);
        expect(calls.some((call) => call.method === 'DELETE' && call.path?.includes(runnerJobName(exporting)))).toBe(
            false
        );
    });

    it('stopAgent falls back to deleting the pod when the supervisor never finishes', async () => {
        const { request, calls } = fakeRequest({
            job: { status: 200, body: JSON.stringify({ status: { active: 1 } }) },
        });
        await runner(request).stopAgent(exporting);
        expect(calls).toContainEqual(
            expect.objectContaining({
                method: 'DELETE',
                path: expect.stringContaining(jobPath(namespace, runnerJobName(exporting))),
            })
        );
    });

    it('a refused Job fails the run as infrastructure, with no second Job left over', async () => {
        const { request, calls } = fakeRequest({
            create: { status: 403, body: 'forbidden' },
        });
        await expect(runner(request).run(exporting, { id: SESSION, resume: false })).rejects.toThrow();
        expect(jobBodies(calls)).toHaveLength(1);
    });
});

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
            `POST ${jobsPath(namespace)}`,
            `POST /api/v1/namespaces/factory/secrets`,
            `GET ${claimPathFor(job.id)}`,
            `PATCH ${jobPath(namespace, runnerJobName(job))}`,
            `GET ${jobPath(namespace, runnerJobName(job))}`,
            'GET /api/v1/namespaces/factory/pods',
            `GET /api/v1/namespaces/factory/pods/${podName}/log`,
            // The close-time claude-code turn read: one aux Job, polled, logged, reaped.
            ...cturnsCalls(job),
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
    // URL, from which its entrypoint derives JIRA_API — and never a Jira credential, whatever the
    // claim carried.
    it('never puts a Jira credential in the per-attempt Secret or the pod env', async () => {
        const { request, calls } = fakeRequest();
        const withJira: BoardJob = {
            ...job,
            env: { ATLASSIAN_API_TOKEN: 'atlassian-secret', ATLASSIAN_EMAIL: 'agent@example.com' },
        };
        await runner(request).run(withJira, { id: SESSION, resume: false });
        const secretsPath = `/api/v1/namespaces/${namespace}/secrets`;
        const secretPost = calls.find((call) => call.method === 'POST' && call.path === secretsPath);
        const stringData = (secretPost?.body as { stringData?: Record<string, string> })?.stringData ?? {};
        expect(Object.keys(stringData).filter((key) => key.startsWith('ATLASSIAN'))).toEqual([]);
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
            ...cturnsCalls(newerJob),
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
        // The runner's poll plus the claude turn read's own pod list.
        expect(lists).toBe(4);
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

/** The runner pod's agent log read — the verdict's, and the live tail's. */
const isAgentLogRead = (path: string): boolean =>
    path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`) &&
    path.includes(`container=${AGENT_CONTAINER}`);

/** The kubelet's answer to a pod log read: the whole log, or its last `tailLines` lines when asked for. */
const kubeletLog =
    (log: string) =>
    (path: string): K8sResponse => {
        const tail = new URL(path, 'http://apiserver').searchParams.get('tailLines');
        return {
            status: 200,
            body:
                tail === null
                    ? log
                    : log
                          .split(/(?<=\n)/)
                          .slice(-Number(tail))
                          .join(''),
        };
    };

/** A fake whose agent log reads `answer` gives, everything else as fakeRequest answers it. */
const withAgentLog = (answer: (path: string) => K8sResponse) =>
    routed((method, path) => (method === 'GET' && isAgentLogRead(path) ? answer(path) : undefined));

const numberedLines = (count: number): string => Array.from({ length: count }, (_, i) => `line ${i}\n`).join('');

describe('the runner verdict log (#825)', () => {
    const run = (request: K8sRequest) => runner(request).run(job, { id: SESSION, resume: false });

    it('uploads a log past the 1,000-line tail whole, and complete', async () => {
        const whole = numberedLines(LOG_TAIL_LINES + 500);
        const { request, calls } = withAgentLog(kubeletLog(whole));

        const outcome = await run(request);

        expect(outcome.fullLog).toBe(whole);
        expect(outcome.logTruncated).toBe(false);
        const reads = calls.filter((call) => isAgentLogRead(call.path));
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every((call) => !call.path.includes('tailLines'))).toBe(true);
    });

    it('reports a log the transport cut as truncated, whatever bytes it kept', async () => {
        const { request } = withAgentLog(() => ({ status: 200, body: 'kept tail\n', truncated: true }));

        const outcome = await run(request);

        expect(outcome).toMatchObject({ fullLog: 'kept tail\n', logTruncated: true });
    });

    it('keeps a multibyte log under the cap byte-true, with no replacement character', async () => {
        const { request } = withAgentLog(() => ({ status: 200, body: '€'.repeat(ARTIFACT_LIMIT / 2) }));

        const outcome = await run(request);

        expect(outcome.logTruncated).toBe(true);
        expect(Buffer.byteLength(outcome.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(outcome.fullLog).not.toContain('�');
        expect(outcome.output).not.toContain('�');
    });

    it('calls a log of exactly ARTIFACT_LIMIT bytes complete, and one byte more truncated', async () => {
        for (const [size, truncated] of [
            [ARTIFACT_LIMIT, false],
            [ARTIFACT_LIMIT + 1, true],
        ] as const) {
            const { request } = withAgentLog(() => ({ status: 200, body: 'x'.repeat(size) }));

            const outcome = await run(request);

            expect(outcome.logTruncated).toBe(truncated);
            expect(Buffer.byteLength(outcome.fullLog ?? '')).toBe(ARTIFACT_LIMIT);
        }
    });

    it('reads the verdict log of the agent container alone, never the exporter or the supervisor beside it', async () => {
        const { request, calls } = fakeRequest();

        await run(request);

        const logs = calls.filter((call) =>
            call.path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)
        );
        expect(logs.some((call) => isAgentLogRead(call.path))).toBe(true);
        for (const other of [EXPORTER_CONTAINER, SUPERVISOR_CONTAINER]) {
            expect(logs.some((call) => call.path.includes(`container=${other}`))).toBe(false);
        }
    });
});

// ==============================================================================================
// Gates under kubernetes (issue #773): the declared image as a native sidecar of the attempt's
// pod, running the gate loop over the gate mailbox; a gate is a supervised step, never a Job.
// ==============================================================================================

const gatedConfig = loadDriverConfig({
    EXECUTOR: 'kubernetes',
    K8S_NAMESPACE: namespace,
    GATE_TIMEOUT_MS: '30000',
});

describe('the gate sidecar', () => {
    const podOf = (of: BoardJob, config: DriverConfig = gatedConfig) =>
        runnerJobSpec(config, { ...of, ...SUPERVISED }, { id: SESSION, resume: false }).spec.template.spec;
    const gateOf = (of: BoardJob, config: DriverConfig = gatedConfig) => {
        const gate = podOf(of, config).initContainers?.find((container) => container.name === 'gate');
        if (!gate) throw new Error('no gate sidecar');
        return gate;
    };
    const gated = gatedOf(job);

    it('runs the gate loop in the declared image as a native sidecar, up before the supervisor', () => {
        const gate = gateOf(gated);
        expect(gate.restartPolicy).toBe('Always');
        expect(gate.image).toBe('node:24');
        expect(gate.command).toEqual(gateLoopArgv());
        expect(podOf(gated).initContainers).toHaveLength(1);
    });

    // R2-2: the sync may delete and recreate the worktree, so each request names it; the sidecar
    // itself works in the mailbox.
    it('works in the gate mailbox: each request names its worktree', () => {
        expect(gateOf(gated).workingDir).toBe(MAILBOXES.gate.path);
    });

    it('mounts the member’s own subtree and the gate mailbox, and no other mailbox', () => {
        expect(gateOf(gated).volumeMounts).toEqual([
            { name: 'workspaces', mountPath: `/workspaces/bellows/${USER}`, subPath: `bellows/${USER}` },
            { name: MAILBOXES.gate.name, mountPath: MAILBOXES.gate.path },
        ]);
        expect(podOf(gated).volumes).toContainEqual({ name: MAILBOXES.gate.name, emptyDir: {} });
    });

    // The claim env and the GitHub token ride each request: anyone who can `get pods` reads this spec.
    it('carries the gate env’s own literals and no Secret reference', () => {
        const gate = gateOf(gated);
        expect(gate.env).toEqual([
            { name: 'HOME', value: '/tmp' },
            { name: 'NPM_CONFIG_UPDATE_NOTIFIER', value: 'false' },
        ]);
        expect(JSON.stringify(gate)).not.toContain('secretKeyRef');
        expect(JSON.stringify(gateOf({ ...gated, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } }).env)).toBe(
            JSON.stringify([{ name: 'HOME', value: '/tmp' }])
        );
    });

    // Issue #734: the gate and the agent name the same cache path, inside the one member mount.
    it('points each declared cache name into the repo cache, the same path the agent gets', () => {
        const cacheJob: BoardJob = {
            ...gated,
            repo: 'acme/widgets',
            gates: { image: 'node:24', cache: ['NPM_CONFIG_CACHE'], gates: [{ name: 't', command: 't' }] },
        };
        const path = `/workspaces/bellows/${USER}/.cache/acme/widgets/NPM_CONFIG_CACHE`;
        expect(gateOf(cacheJob).env).toContainEqual({ name: 'NPM_CONFIG_CACHE', value: path });
        const agent = podOf(cacheJob).containers.find((container) => container.name === 'agent')!;
        expect(agent.env).toContainEqual({ name: 'NPM_CONFIG_CACHE', value: path });
    });

    it('tells the supervisor its gate container is there, and gives the gate mailbox to it alone', () => {
        const pod = podOf(gated);
        const container = (name: string) => pod.containers.find((candidate) => candidate.name === name)!;
        expect(container('supervisor').env).toContainEqual({ name: 'SUPERVISOR_GATE', value: '1' });
        expect(container('supervisor').volumeMounts).toContainEqual({
            name: MAILBOXES.gate.name,
            mountPath: MAILBOXES.gate.path,
        });
        for (const name of ['agent', 'exporter']) {
            expect(JSON.stringify(container(name).volumeMounts), name).not.toContain(MAILBOXES.gate.name);
        }
    });

    it('specs no gate sidecar for a checkout that declares neither gates nor setup, or has no worktree', () => {
        const { repo: _repo, ...repoless } = gated;
        for (const of of [job, repoless, { ...gated, gates: { image: 'node:24', gates: [] } }]) {
            const pod = podOf(of);
            expect(pod.initContainers).toBeUndefined();
            const supervisor = pod.containers.find((candidate) => candidate.name === 'supervisor')!;
            expect(supervisor.env).not.toContainEqual({ name: 'SUPERVISOR_GATE', value: '1' });
        }
        expect(gateOf({ ...gated, gates: { image: 'node:24', setup: 'npm ci', gates: [] } }).name).toBe('gate');
    });

    // D11: the adopted run's group (made on demand, no agent) still runs its gates; the reclaim's
    // group is a supervisor alone whatever its checkout declares.
    it('specs the agentless group of an adopted run with the gate, and the reclaim group without one', () => {
        expect(gateOf({ ...gated, agent: false }).name).toBe('gate');
        const reclaim = reclaimGroupSpec(gatedConfig, gated, gated.leaseToken).spec.template.spec;
        expect(reclaim.initContainers?.map((container) => container.name)).toEqual(['release']);
        const { repo: _repo, ...treeless } = gated;
        const treelessSpec = reclaimGroupSpec(gatedConfig, treeless, gated.leaseToken);
        expect(treelessSpec.spec.template.spec.initContainers).toBeUndefined();
    });

    it('refuses a declared image that is not a plain image reference, before the spec exists', () => {
        expect(() => podOf({ ...gated, gates: { ...gated.gates!, image: '-flag-image' } })).toThrow(/image reference/);
    });
});

// ==============================================================================================
// The reviewer sidecar (issue #774): a claim that lists reviewer profiles gets one dormant
// reviewer container in the task pod, beside the supervisor, serving the review mailbox.
// ==============================================================================================

describe('the reviewer sidecar (issue #774)', () => {
    const reviewing: BoardJob = { ...gatedOf(job), ...SUPERVISED, reviewerProfiles: ['security'] };
    const podOf = (of: BoardJob, config: DriverConfig = gatedConfig) =>
        runnerJobSpec(config, of, { id: SESSION, resume: false }).spec.template.spec;
    const reviewerOf = (of: BoardJob = reviewing) => {
        const reviewer = podOf(of).initContainers?.find((container) => container.name === REVIEWER_CONTAINER);
        if (!reviewer) throw new Error('no reviewer sidecar');
        return reviewer;
    };

    it('a claim with reviewer profiles gets one dormant reviewer sidecar; none without', () => {
        const reviewer = reviewerOf();
        expect(reviewer.restartPolicy).toBe('Always');
        expect(reviewer.image).toBe(podOf(reviewing).containers.find((c) => c.name === 'agent')!.image);
        expect(reviewer.command).toEqual(reviewLoopArgv());
        expect(reviewer.workingDir).toBe(MAILBOXES.review.path);
        expect(podOf(reviewing).initContainers?.map((container) => container.name)).toEqual(['gate', 'reviewer']);
        for (const none of [undefined, []]) {
            const { reviewerProfiles: _profiles, ...rest } = reviewing;
            const pod = podOf(none ? { ...rest, reviewerProfiles: none } : rest);
            expect(pod.initContainers?.map((container) => container.name)).toEqual(['gate']);
            expect(JSON.stringify(pod)).not.toContain(MAILBOXES.review.name);
        }
    });

    it('the reviewer runs as REVIEWER_UID ≠ TOOL_UID, mounts only its read-only tree, its mailbox and its home', () => {
        const reviewer = reviewerOf();
        expect(REVIEWER_UID).not.toBe(TOOL_UID);
        expect(REVIEWER_UID).not.toBe(GATE_UID);
        expect(reviewer.securityContext).toMatchObject({ runAsUser: REVIEWER_UID, runAsGroup: GATE_GID });
        expect(reviewer.volumeMounts).toEqual([
            {
                name: 'workspaces',
                mountPath: `/workspaces/bellows/${USER}`,
                subPath: `bellows/${USER}`,
                readOnly: true,
            },
            { name: MAILBOXES.review.name, mountPath: MAILBOXES.review.path },
            {
                name: 'workspaces',
                mountPath: REVIEWER_HOME,
                subPath: `bellows/${USER}/${REVIEWER_TREE_DIR}`,
            },
        ]);
        expect(podOf(reviewing).volumes).toContainEqual({ name: MAILBOXES.review.name, emptyDir: {} });
    });

    it('the agent mounts none of the reviewer’s mounts, and the exporter and gate neither', () => {
        const pod = podOf(reviewing);
        for (const name of ['agent', 'exporter']) {
            const mounts = JSON.stringify(pod.containers.find((container) => container.name === name)?.volumeMounts);
            expect(mounts, name).not.toContain(MAILBOXES.review.name);
            expect(mounts, name).not.toContain(REVIEWER_TREE_DIR);
        }
        const gate = pod.initContainers?.find((container) => container.name === 'gate');
        expect(JSON.stringify(gate?.volumeMounts)).not.toContain(MAILBOXES.review.name);
        const supervisor = pod.containers.find((container) => container.name === 'supervisor');
        expect(supervisor?.volumeMounts).toContainEqual({
            name: MAILBOXES.review.name,
            mountPath: MAILBOXES.review.path,
        });
    });

    it('the reviewer’s env and mounts carry no publish token and no credential helper, no attempt-Secret ref', () => {
        const reviewer = reviewerOf({ ...reviewing, env: { SOME_TOKEN: 'claim-secret' } });
        expect(JSON.stringify(reviewer)).not.toContain('secretKeyRef');
        expect(JSON.stringify(reviewer)).not.toContain(secretName(reviewing));
        expect(JSON.stringify(reviewer)).not.toContain('claim-secret');
        // The command is the loop's own text, which names these words in its comments: env and mounts only.
        const text = JSON.stringify({ env: reviewer.env, mounts: reviewer.volumeMounts });
        expect(text).not.toMatch(/GITHUB_TOKEN|GH_TOKEN|PUBLISH|BELLOWS_|credential/i);
        expect(text).not.toContain(GITHUB_CACHE_DIR);
        expect(reviewer.env).toEqual([{ name: 'HOME', value: REVIEWER_HOME }]);
    });

    it('the reviewer reads the same model credentials as the agent from the credentials Secret, and no other Secret', () => {
        const config = loadDriverConfig({
            EXECUTOR: 'kubernetes',
            K8S_NAMESPACE: namespace,
            RUNNER_CREDENTIALS_SECRET: 'model-credentials',
            RUNNER_ENV: 'MODEL_KEY,OTHER_KEY',
        });
        const pod = podOf({ ...reviewing, env: { SOME_TOKEN: 'claim-secret' } }, config);
        const reviewer = pod.initContainers?.find((container) => container.name === REVIEWER_CONTAINER);
        const ref = (name: string) => ({
            name,
            valueFrom: { secretKeyRef: { name: 'model-credentials', key: name, optional: true } },
        });
        expect(reviewer?.env).toEqual([{ name: 'HOME', value: REVIEWER_HOME }, ref('MODEL_KEY'), ref('OTHER_KEY')]);
        const agentEnv = pod.containers.find((container) => container.name === 'agent')?.env ?? [];
        expect(agentEnv).toContainEqual(ref('MODEL_KEY'));
        expect(agentEnv).toContainEqual(ref('OTHER_KEY'));
        expect(JSON.stringify(reviewer)).not.toContain(secretName(reviewing));
        expect(JSON.stringify(reviewer)).not.toContain('envFrom');
    });

    it('sizes the reviewer idle-low at creation, with the runner’s limits', () => {
        const { resources } = reviewerOf();
        expect(resources?.requests).toEqual(reviewerRequests(gatedConfig, 'idle'));
        expect(reviewerRequests(gatedConfig, 'idle')).toEqual({ cpu: '50m', memory: '64Mi' });
    });

    /** fakeRequest, with every pod resize answered 200 and recorded. */
    const resizing = () => {
        const base = fakeRequest();
        const patches: { path: string; body: unknown; contentType: string | undefined }[] = [];
        const request: K8sRequest = (method, path, body, options) => {
            if (method === 'PATCH' && path.endsWith('/resize')) {
                patches.push({ path, body, contentType: options?.contentType });
                return Promise.resolve({ status: 200, body: '{}' });
            }
            return base.request(method, path, body);
        };
        return { request, patches };
    };

    it('resizes the reviewer alone, by a strategic merge patch naming its container', async () => {
        const api = resizing();
        const k8s = runner(api.request, { RUNNER_CPU_REQUEST: '2', RUNNER_MEMORY_REQUEST: '4Gi' });
        expect(await k8s.resizeReviewer(reviewing, 'run')).toBe(true);
        expect(api.patches).toEqual([
            {
                path: `/api/v1/namespaces/${namespace}/pods/${podName}/resize`,
                body: {
                    spec: {
                        initContainers: [{ name: 'reviewer', resources: { requests: { cpu: '2', memory: '4Gi' } } }],
                    },
                },
                contentType: 'application/strategic-merge-patch+json',
            },
        ]);
    });

    it('resizes no pod whose claim lists no reviewer', async () => {
        const api = resizing();
        const { reviewerProfiles: _profiles, ...plain } = reviewing;
        expect(await runner(api.request).resizeReviewer(plain, 'run')).toBe(false);
        expect(api.patches).toEqual([]);
    });
});

describe('the kubernetes runner and the gates', () => {
    const gated = { ...gatedOf(job), ...SUPERVISED };
    const gate = {
        command: 'npm test',
        cwd: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
        env: {},
        timeoutMs: 1000,
    };

    it('runs a gate as a step of the attempt’s own group, which it makes when none is up, and no Job or Secret of its own', async () => {
        const { request, calls } = fakeRequest();
        const steps = fakeSteps((step) => stepOk(step.kind === 'gate' ? 'passed' : ''));
        const k8s = runner(request, {}, undefined, steps.sink);

        expect(await k8s.runGate(gated, gate)).toEqual(stepOk('passed'));

        expect(steps.submitted.map((step) => step.kind)).toEqual(['gate']);
        expect(steps.submitted[0]).toMatchObject({ argv: ['npm test'], cwd: gate.cwd });
        const posts = calls.filter((call) => call.method === 'POST');
        const jobs = posts.filter((call) => call.path === jobsPath(namespace));
        expect(jobs.map((call) => (call.body as { metadata: { name: string } }).metadata.name)).toEqual([
            runnerJobName(gated),
        ]);
        const pod = (jobs[0]!.body as ReturnType<typeof runnerJobSpec>).spec.template.spec;
        expect(pod.initContainers?.map((container) => container.name)).toEqual(['gate']);
        const secrets = posts.filter((call) => call.path === `/api/v1/namespaces/${namespace}/secrets`);
        expect(secrets.map((call) => (call.body as { metadata: { name: string } }).metadata.name)).toEqual([
            secretName(gated),
        ]);
        expect(JSON.stringify(posts)).not.toContain('factory-gate-');
    });

    /** fakeRequest, with every pod resize answered `resize` and recorded with its patch type. */
    const resizing = (resize: K8sResponse = { status: 200, body: '{}' }) => {
        const base = fakeRequest();
        const patches: { path: string; body: unknown; contentType: string | undefined }[] = [];
        const order: string[] = [];
        const request: K8sRequest = (method, path, body, options) => {
            if (method === 'PATCH' && path.endsWith('/resize')) {
                patches.push({ path, body, contentType: options?.contentType });
                order.push('resize');
                return Promise.resolve(resize);
            }
            return base.request(method, path, body);
        };
        return { request, calls: base.calls, patches, order };
    };

    it('resizes the gate sidecar idle before it releases the agent', async () => {
        const api = resizing();
        const steps = fakeSteps((step) => {
            api.order.push(step.kind);
            return defaultStepAnswer(step);
        });
        await runner(api.request, {}, undefined, steps.sink).run(gated, { id: SESSION, resume: false });
        expect(api.order.slice(0, 2)).toEqual(['resize', 'go']);
        expect(api.patches[0]?.body).toEqual({
            spec: { initContainers: [{ name: 'gate', resources: { requests: { cpu: '100m', memory: '128Mi' } } }] },
        });
    });

    // R1-1: a merge patch would replace the whole init container list; the strategic merge patch
    // merges by container name, so only the gate's requests change.
    it('resizes for verify with a strategic merge patch naming the gate container alone', async () => {
        const api = resizing();
        const k8s = runner(api.request, { GATE_CPU_REQUEST: '2', GATE_MEMORY_REQUEST: '2Gi' });
        expect(await k8s.resizeGate(gated, 'verify')).toBe(true);
        expect(api.patches).toEqual([
            {
                path: `/api/v1/namespaces/${namespace}/pods/${podName}/resize`,
                body: {
                    spec: { initContainers: [{ name: 'gate', resources: { requests: { cpu: '2', memory: '2Gi' } } }] },
                },
                contentType: 'application/strategic-merge-patch+json',
            },
        ]);
    });

    it('answers a refused or impossible resize as not resized, never an error, and resizes no ungated pod', async () => {
        for (const status of [403, 422, 500]) {
            const api = resizing({ status, body: '{}' });
            expect(await runner(api.request).resizeGate(gated, 'verify'), String(status)).toBe(false);
        }
        const unlisted = routed((method, path) =>
            method === 'GET' && path.includes('/pods?') ? { status: 500, body: '' } : undefined
        );
        expect(await runner(unlisted.request).resizeGate(gated, 'verify')).toBe(false);
        expect(unlisted.calls.some((call) => call.method === 'PATCH')).toBe(false);
        const plain = resizing();
        expect(await runner(plain.request).resizeGate({ ...job, ...SUPERVISED }, 'idle')).toBe(false);
        expect(plain.calls).toEqual([]);
    });
});

// ==============================================================================================
// Auxiliary services under kubernetes: a native sidecar of the task pod per declared service,
// reached on the pod's loopback by its declared name, alive for exactly the group.
// ==============================================================================================

describe('the service sidecars (issue #773)', () => {
    const servicesConfig = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '1' });
    const db: ServiceSpec = {
        name: 'db',
        image: 'postgres:17',
        environment: [{ key: 'POSTGRES_PASSWORD', value: 'local' }],
        user: { uid: 999, gid: 999 },
    };
    const cache: ServiceSpec = { name: 'cache', image: 'redis', environment: [] };
    const declared: BoardJob = { ...gatedOf(job), ...SUPERVISED, services: [db, cache] };
    const podOf = (of: BoardJob, config: DriverConfig = servicesConfig) =>
        runnerJobSpec(config, of, { id: SESSION, resume: false }).spec.template.spec;
    const sidecarOf = (name: string, of: BoardJob = declared) => {
        const sidecar = podOf(of).initContainers?.find((container) => container.name === `svc-${name}`);
        if (!sidecar) throw new Error(`no svc-${name} sidecar`);
        return sidecar;
    };

    // Every init container starts, in order, before the main containers: no order spares the
    // supervisor a sidecar that never starts, so the gate leads and the services follow as declared.
    it('runs each declared service as a native sidecar after the gate, before the main containers', () => {
        expect(podOf(declared).initContainers?.map((container) => container.name)).toEqual([
            'gate',
            'svc-db',
            'svc-cache',
        ]);
        expect(sidecarOf('db')).toMatchObject({
            image: 'postgres:17',
            imagePullPolicy: 'IfNotPresent',
            restartPolicy: 'Always',
            env: [{ name: 'POSTGRES_PASSWORD', value: 'local' }],
        });
        const { gates: _gates, ...ungated } = declared;
        expect(podOf(ungated).initContainers?.map((container) => container.name)).toEqual(['svc-db', 'svc-cache']);
    });

    it('runs a service as its declared uid:gid with every capability dropped, and one that declared none as its image does', () => {
        expect(sidecarOf('db').securityContext).toEqual({
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            runAsNonRoot: true,
            runAsUser: 999,
            runAsGroup: 999,
        });
        expect(sidecarOf('cache').securityContext).toEqual({
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
        });
    });

    // R2-4: the sidecar reads the generations and speaks for itself alone; it mounts no worktree.
    it('mounts the generations read-only and its own acknowledgement volume, and nothing of the task', () => {
        expect(sidecarOf('db').volumeMounts).toEqual([
            { name: SERVICE_GENERATIONS.volume, mountPath: SERVICE_GENERATIONS.path, readOnly: true },
            { name: 'svc-ack-db', mountPath: SERVICE_GENERATIONS.ackPath },
        ]);
    });

    it('probes liveness with the generation probe every two seconds, failing at the first miss', () => {
        expect(sidecarOf('cache').livenessProbe).toEqual({
            exec: { command: serviceProbeArgv('cache') },
            periodSeconds: 2,
            failureThreshold: 1,
        });
    });

    it('gives the supervisor the generations and every acknowledgement, and no other container any of them', () => {
        const pod = podOf(declared);
        const supervisor = pod.containers.find((container) => container.name === 'supervisor')!;
        expect(supervisor.volumeMounts).toEqual(
            expect.arrayContaining([
                { name: SERVICE_GENERATIONS.volume, mountPath: SERVICE_GENERATIONS.path },
                { name: 'svc-ack-db', mountPath: `${SERVICE_GENERATIONS.ackRoot}/db` },
                { name: 'svc-ack-cache', mountPath: `${SERVICE_GENERATIONS.ackRoot}/cache` },
            ])
        );
        for (const container of [...pod.containers, ...(pod.initContainers ?? [])]) {
            if (container.name === 'supervisor' || container.name.startsWith('svc-')) continue;
            expect(JSON.stringify(container.volumeMounts), container.name).not.toMatch(/ctl-services|svc-ack-/);
        }
        for (const name of [SERVICE_GENERATIONS.volume, 'svc-ack-db', 'svc-ack-cache']) {
            expect(pod.volumes).toContainEqual({ name, emptyDir: {} });
        }
    });

    // The whole feature: `postgres://db:5432` from the agent and the gate reaches the sidecar on the
    // pod's own loopback. No DNS search domain, no headless Service, no subdomain.
    it('maps every declared name to 127.0.0.1 in the pod, with no search domain and no subdomain', () => {
        const pod = podOf(declared);
        expect(pod.hostAliases).toEqual([{ ip: '127.0.0.1', hostnames: ['db', 'cache'] }]);
        expect(pod).not.toHaveProperty('dnsConfig');
        expect(pod).not.toHaveProperty('subdomain');
        expect(pod).not.toHaveProperty('hostname');
    });

    it('specs no sidecar, alias or generation volume when services are off or none are declared', () => {
        const off = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
        const { services: _services, ...plain } = declared;
        for (const pod of [podOf(declared, off), podOf(plain)]) {
            expect(pod.initContainers?.map((container) => container.name)).toEqual(['gate']);
            expect(pod).not.toHaveProperty('hostAliases');
            expect(JSON.stringify(pod.volumes)).not.toMatch(/ctl-services|svc-ack-/);
        }
    });

    // D11: the adopted run's group (made on demand, no agent) still serves its services' gates; the
    // reclaim's group is a supervisor alone whatever its checkout declares.
    it('specs the agentless group of an adopted run with the services, and the reclaim group without them', () => {
        expect(sidecarOf('db', { ...declared, agent: false }).name).toBe('svc-db');
        const reclaim = reclaimGroupSpec(servicesConfig, declared, declared.leaseToken).spec.template.spec;
        expect(reclaim.initContainers?.map((container) => container.name)).toEqual(['release']);
        expect(reclaim).not.toHaveProperty('hostAliases');
        expect(JSON.stringify(reclaim.volumes)).not.toMatch(/ctl-services|svc-ack-/);
    });

    it('refuses a service env key that is not a name, before the spec exists', () => {
        const bad = { ...declared, services: [{ ...cache, environment: [{ key: 'not a key', value: 'x' }] }] };
        expect(() => podOf(bad)).toThrow(/not a valid environment variable name/);
    });
});

/** The suite's job with no services on the claim, for the block below that shadows `job`. */
const baseJob = job;

describe('the kubernetes services flow (issue #773)', () => {
    // Issue #769: the services ride on the claim — this block's `job` declares the one `cache` service.
    const CACHE: ServiceSpec = { name: 'cache', image: 'redis', environment: [] };
    const DB: ServiceSpec = { name: 'db', image: 'postgres:17', environment: [] };
    const job: BoardJob = { ...baseJob, repo: 'Bellows-AI/factory', services: [CACHE] };
    const fleet: BoardJob = { ...job, services: [DB, CACHE] };
    /** A restart's stand-down signal that never fires. */
    const live = new AbortController().signal;

    type Sidecar = { state: Record<string, unknown>; restartCount: number; lastState?: Record<string, unknown> };
    const running = (restartCount = 0, lastState?: Record<string, unknown>): Sidecar => ({
        state: { running: { startedAt: '2026-10-19T00:00:00Z' } },
        restartCount,
        ...(lastState ? { lastState } : {}),
    });

    /**
     * The task pod as the kubelet reports it: `sidecars` is read on every listing (a test moves it
     * on), `list` overrides the answer outright. Every other route is fakeRequest's.
     */
    const podFake = (sidecars: Record<string, Sidecar>, list?: () => K8sResponse | undefined) =>
        routed((method, path) => {
            if (method !== 'GET' || !decodeURIComponent(path).includes('job-name=')) return;
            const scripted = list?.();
            if (scripted) return scripted;
            const initContainerStatuses = Object.entries(sidecars).map(([name, sidecar]) => ({
                name: `svc-${name}`,
                image: 'redis',
                ...sidecar,
            }));
            return {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Succeeded',
                                initContainerStatuses,
                                containerStatuses: [{ name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } }],
                            },
                        },
                    ],
                }),
            };
        });

    /** The supervisor's answers to the `restart` steps: `acked` and `bump` scripted, every other step the default. */
    const restartSteps = (
        answer: { acked?: (names: string[]) => StepResult; bump?: (names: string[]) => StepResult } = {}
    ) =>
        fakeSteps((step) => {
            if (step.kind !== 'restart') return defaultStepAnswer(step);
            const [mode, , , ...names] = step.argv.slice(4);
            return (mode === 'bump' ? answer.bump : answer.acked)?.(names) ?? stepOk();
        });
    const modes = (steps: { submitted: StepRequest[] }) =>
        steps.submitted.filter((step) => step.kind === 'restart').map((step) => step.argv[4]);
    const notAcked = (...names: string[]): StepResult => ({
        exitCode: SERVICE_NOT_ACKED_EXIT,
        stdout: names.map((name) => `${name}\n`).join(''),
        stderr: '',
        timedOut: false,
    });
    const servicesOn = { RUNNER_SERVICES: '1' };
    const SESSION_RUN = { id: SESSION, resume: false };

    it('starts the services with the group the sync made, answering once every sidecar runs and acknowledged', async () => {
        const sidecars: Record<string, Sidecar> = {
            cache: { state: { waiting: { reason: 'PodInitializing' } }, restartCount: 0 },
        };
        const api = podFake(sidecars);
        let reads = 0;
        const steps = restartSteps({
            acked: (names) => {
                reads += 1;
                return reads === 1 ? notAcked(...names) : stepOk();
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        const listed = api.calls.length;
        sidecars.cache = running();

        expect(await k8s.startServices(job)).toBeNull();

        expect(modes(steps)).toEqual(['acked', 'acked']);
        expect(steps.submitted.find((step) => step.kind === 'restart')?.argv).toEqual(
            serviceRestartArgv('acked', ['cache'])
        );
        // Nothing is created for them: no pod, no Service, no Job beside the group's own.
        expect(api.calls.slice(listed).filter((call) => call.method !== 'GET')).toEqual([]);
        const posted = api.calls.filter((call) => call.method === 'POST').map((call) => call.path);
        expect(posted.some((path) => path.endsWith('/pods') || path.endsWith('/services'))).toBe(false);
    });

    // An adopted run synced nothing: its group is made now, the sidecars in it, and no agent.
    it('makes the group of an attempt that synced none, with its sidecars in it', async () => {
        const api = podFake({ cache: running() });
        const steps = restartSteps();
        expect(await runner(api.request, servicesOn, undefined, steps.sink).startServices(job)).toBeNull();
        const jobs = api.calls.filter((call) => call.method === 'POST' && call.path === jobsPath(namespace));
        expect(jobs).toHaveLength(1);
        const pod = (jobs[0]!.body as ReturnType<typeof runnerJobSpec>).spec.template.spec;
        expect(pod.initContainers?.map((container) => container.name)).toEqual(['svc-cache']);
        expect(pod.containers.map((container) => container.name)).not.toContain('agent');
    });

    it('rejects with ServicesNotRunning, in the kubelet’s words, when a sidecar crash-loops before it is ready', async () => {
        const api = podFake({
            cache: {
                state: { waiting: { reason: 'CrashLoopBackOff', message: 'back-off 40s' } },
                restartCount: 3,
                lastState: { terminated: { exitCode: 1, reason: 'Error' } },
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        const thrown = await k8s.startServices(job).catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(ServicesNotRunning);
        expect((thrown as Error).message).toBe(
            `service "cache" exited after the start (Error; ${KUBELET_RESTART_NOTE})`
        );
    });

    // R2-1: a pod that never answered proves nothing about its services.
    it('throws Inconclusive when the task pod cannot be read to the end of the budget', async () => {
        const api = podFake({ cache: running() });
        const steps = restartSteps();
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        const broken = podFake({}, () => ({ status: 503, body: 'overloaded' }));
        const thrown = await runner(broken.request, servicesOn, undefined, steps.sink)
            .startServices({ ...job, leaseToken: NEW_TOKEN })
            .catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(Inconclusive);
        expect(thrown).not.toBeInstanceOf(ServicesNotRunning);
    });

    it('finds none dead while every sidecar runs at the count it was ready at', async () => {
        const api = podFake({ cache: running(2) });
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await k8s.startServices(job);
        expect(await k8s.deadServices(job)).toEqual([]);
    });

    // D8: a liveness failure or a crash restarts a sidecar in place — running again, its restart count
    // past the baseline is the only trace, and its previous container's log the only evidence.
    it('reports a sidecar the kubelet restarted since it was ready, with its previous log and why', async () => {
        const sidecars: Record<string, Sidecar> = { cache: running() };
        const api = routed((method, path) => {
            if (method === 'GET' && path.includes(`/pods/${podName}/log?`)) {
                return { status: 200, body: `previous=${path.includes('previous=true')} ${path}` };
            }
        });
        const pods = podFake(sidecars);
        const request: K8sRequest = (method, path, body) =>
            path.includes(`/pods/${podName}/log?`) ? api.request(method, path, body) : pods.request(method, path, body);
        const k8s = runner(request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await k8s.startServices(job);
        sidecars.cache = running(1, { terminated: { exitCode: 137, reason: 'OOMKilled' } });

        const [dead, ...rest] = await k8s.deadServices(job);
        expect(rest).toEqual([]);
        expect(dead).toEqual({
            name: 'cache',
            image: 'redis',
            state: 'restarted',
            exitCode: 137,
            reason: `OOMKilled; ${KUBELET_RESTART_NOTE}`,
            logTail: `previous=true ${podLogPath(namespace, podName, SERVICE_LOG_TAIL_LINES, 'svc-cache')}&previous=true`,
        });
    });

    it('reports a terminated sidecar dead, and infers no death from a pod it cannot read', async () => {
        const sidecars: Record<string, Sidecar> = { cache: running() };
        let broken = false;
        const api = podFake(sidecars, () => (broken ? { status: 500, body: '' } : undefined));
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await k8s.startServices(job);
        sidecars.cache = { state: { terminated: { exitCode: 2, reason: 'Error' } }, restartCount: 0 };
        expect(await k8s.deadServices(job)).toMatchObject([{ name: 'cache', state: 'exited', exitCode: 2 }]);
        broken = true;
        await expect(k8s.deadServices(job)).rejects.toBeInstanceOf(Inconclusive);
    });

    // R1-4: a restart is the fleet's — the healthy sibling is bumped, restarted and reset too.
    it('restarts every declared service, a healthy sibling too, and resets the baseline for all', async () => {
        const sidecars: Record<string, Sidecar> = { db: running(), cache: running() };
        const api = podFake(sidecars);
        const bumped: string[][] = [];
        const steps = restartSteps({
            bump: (names) => {
                bumped.push(names);
                // The probes fail on the new generation: the kubelet restarts each sidecar once.
                sidecars.db = running(2);
                sidecars.cache = running(1);
                return stepOk();
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(fleet, undefined, SESSION_RUN);
        await k8s.startServices(fleet);
        sidecars.db = running(1, { terminated: { exitCode: 1, reason: 'Error' } });
        expect((await k8s.deadServices(fleet)).map(({ name }) => name)).toEqual(['db']);

        await k8s.restartServices(fleet, live);

        expect(bumped).toEqual([['db', 'cache']]);
        expect(steps.submitted.find((step) => step.argv[4] === 'bump')?.argv).toEqual(
            serviceRestartArgv('bump', ['db', 'cache'])
        );
        expect(await k8s.deadServices(fleet)).toEqual([]);
    });

    // R2-4: a restart asked before a probe ever acknowledged waits for it, and only then bumps.
    it('waits for every service to acknowledge its generation before it bumps', async () => {
        const sidecars: Record<string, Sidecar> = { cache: running() };
        const api = podFake(sidecars);
        let bumps = 0;
        const steps = restartSteps({
            bump: () => {
                bumps += 1;
                if (bumps < 3) return notAcked('cache');
                sidecars.cache = running(1);
                return stepOk();
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);

        await k8s.restartServices(job, live);

        expect(modes(steps).slice(0, 3)).toEqual(['bump', 'bump', 'bump']);
        expect(bumps).toBe(3);
    });

    it('fails naming a service that never acknowledges its generation, bumping nothing', async () => {
        const api = podFake({ cache: running() });
        const steps = restartSteps({ bump: () => notAcked('cache') });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        const thrown = await k8s.restartServices(job, live).catch((e: unknown) => e);
        expect(thrown).toBeInstanceOf(ServicesNotRunning);
        expect((thrown as Error).message).toBe('service "cache" never acknowledged its generation 300s on');
    });

    // #869: a bump nobody answered by the restart deadline proves nothing about the services.
    it('is inconclusive, not a services failure, when the bump goes unanswered until the restart deadline', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const api = podFake({ cache: running() });
            const steps = restartSteps();
            const sink: StepSink = {
                ...steps.sink,
                submit: async (token, step, signal) => {
                    if (step.kind === 'restart' && step.argv[4] === 'bump') {
                        vi.setSystemTime(Date.now() + 301_000);
                        throw new Error('the step was cancelled');
                    }
                    return steps.sink.submit(token, step, signal);
                },
            };
            const k8s = runner(api.request, servicesOn, undefined, sink);
            await k8s.syncCheckout(job, undefined, SESSION_RUN);
            await expect(k8s.restartServices(job, live)).rejects.toBeInstanceOf(Inconclusive);
        } finally {
            vi.useRealTimers();
        }
    });

    it('gives the pod read of a bump the time its budget has left, however slow the steps before it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const api = podFake({ cache: running() });
            const timeouts: (number | undefined)[] = [];
            const request: K8sRequest = (method, path, body, options) => {
                if (method === 'GET' && decodeURIComponent(path).includes('job-name='))
                    timeouts.push(options?.timeoutMs);
                return api.request(method, path, body, options);
            };
            let bumps = 0;
            const steps = restartSteps({
                bump: () => {
                    bumps += 1;
                    vi.setSystemTime(Date.now() + (bumps === 1 ? 299_000 : 2_000));
                    return notAcked('cache');
                },
            });
            const k8s = runner(request, servicesOn, undefined, steps.sink);
            await k8s.syncCheckout(job, undefined, SESSION_RUN);
            timeouts.length = 0;
            await expect(k8s.restartServices(job, live)).rejects.toBeInstanceOf(ServicesNotRunning);
            expect(timeouts[0]).toBeGreaterThan(0);
            expect(timeouts[1]).toBeLessThanOrEqual(1_000);
        } finally {
            vi.useRealTimers();
        }
    });

    it('fails naming a service that never restarts within the budget', async () => {
        const api = podFake({ cache: running() });
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await expect(k8s.restartServices(job, live)).rejects.toThrow(
            'service "cache" not running 300s after the restart'
        );
    });

    it('fails naming one that restarts again on its way back up: it crashed', async () => {
        const sidecars: Record<string, Sidecar> = { cache: running() };
        const api = podFake(sidecars);
        const steps = restartSteps({
            bump: () => {
                sidecars.cache = {
                    state: { waiting: { reason: 'CrashLoopBackOff' } },
                    restartCount: 2,
                    lastState: { terminated: { exitCode: 1, reason: 'Error' } },
                };
                return stepOk();
            },
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await expect(k8s.restartServices(job, live)).rejects.toBeInstanceOf(ServicesNotRunning);
    });

    // R2-1: a lost supervisor is the attempt's loss, thrown as it is for the loop to interrupt.
    it('throws a supervisor lost mid-restart as it is', async () => {
        const api = podFake({ cache: running() });
        const steps = fakeSteps((step) => {
            if (step.kind === 'restart') throw new StepChannelClosed('the service restart');
            return defaultStepAnswer(step);
        });
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        await expect(k8s.restartServices(job, live)).rejects.toBeInstanceOf(StepChannelClosed);
    });

    it('bumps nothing once the attempt stood down', async () => {
        const api = podFake({ cache: running() });
        const steps = restartSteps();
        const k8s = runner(api.request, servicesOn, undefined, steps.sink);
        await k8s.syncCheckout(job, undefined, SESSION_RUN);
        const stand = new AbortController();
        stand.abort();
        await expect(k8s.restartServices(job, stand.signal)).rejects.toThrow('the attempt stood down');
        expect(modes(steps)).toEqual([]);
    });

    it('samples the services off the task pod’s sidecars', async () => {
        const api = podFake({ cache: running() }, undefined);
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        const sample = await k8s.sampleRuntime(job);
        expect(sample?.services).toEqual([{ name: 'cache', image: 'redis', state: 'running' }]);
    });

    // The whole flow creates the one runner Job: the services are its pod's own sidecars.
    it('creates nothing but the runner Job and its Secret through a whole run with services', async () => {
        const api = podFake({ cache: running() });
        const k8s = runner(api.request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, { id: SESSION, resume: false });
        await k8s.startServices(job);
        expect((await k8s.run(job, { id: SESSION, resume: false })).exitCode).toBe(0);
        await k8s.releaseServices(job);
        const posts = api.calls.filter((call) => call.method === 'POST').map((call) => call.path);
        expect(posts.filter((path) => path.endsWith('/pods') || path.endsWith('/services'))).toEqual([]);
        const runnerJobs = api.calls.filter(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                (call.body as { metadata: { name: string } }).metadata.name === runnerJobName(job)
        );
        expect(runnerJobs).toHaveLength(1);
        expect(api.calls.some((call) => call.method === 'DELETE' && call.path.includes('/services'))).toBe(false);
    });

    it("reports a runner pod deleted mid-run as an infrastructure loss, not the agent's verdict (issue #560)", async () => {
        const api = podFake({ cache: running() });
        let vanished = false;
        const lost = routed((method, path) => {
            if (!vanished) return;
            if (method === 'GET' && path === `${jobsPath(namespace)}/${runnerJobName(job)}`) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        status: {
                            failed: 1,
                            conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded' }],
                        },
                    }),
                };
            }
            if (method === 'GET' && decodeURIComponent(path).includes(`job-name=${runnerJobName(job)}`)) {
                return { status: 200, body: '{"items":[]}' };
            }
        });
        const request: K8sRequest = (method, path, body) =>
            vanished ? lost.request(method, path, body) : api.request(method, path, body);
        const k8s = runner(request, servicesOn, undefined, restartSteps().sink);
        await k8s.syncCheckout(job, undefined, { id: SESSION, resume: false });
        await k8s.startServices(job);
        vanished = true;

        expect(await k8s.run(job, { id: SESSION, resume: false })).toMatchObject({
            exitCode: null,
            started: true,
            infraLoss: 'the runner pod was deleted before it exited (evicted, drained or its node removed)',
        });
    });

    it('starts nothing and asks the supervisor nothing when the claim carries no services, or services are off', async () => {
        for (const [of, env] of [
            [{ ...job, services: [] }, servicesOn],
            [job, { RUNNER_SERVICES: '0' }],
        ] as const) {
            const api = podFake({});
            const steps = restartSteps();
            const k8s = runner(api.request, env, undefined, steps.sink);
            expect(await k8s.startServices(of)).toBeNull();
            expect(await k8s.deadServices(of)).toEqual([]);
            await k8s.restartServices(of, live);
            expect(steps.submitted).toEqual([]);
            expect(api.calls).toEqual([]);
        }
    });
});

describe("scoping the kubernetes mounts to the job's own subtree", () => {
    // Every volumeMount this executor emits names the job's own `<orgId>/<userId>` subtree as
    // its subPath. That is what makes a missing target fail loud — the kubelet cannot start a
    // pod whose subPath does not exist and leaves it stuck in ContainerCreating — and what
    // makes a broader fallback mount structurally impossible: there is no spec shape here that
    // mounts the workspaces PVC without a subPath.
    // The supervisor runs the attempt's steps (the sync, the publish) on the task worktree (issue
    // #771), so it mounts the member's workspace — at the member's subtree like every other pod.
    it.each(POD_NAMES.filter((name) => name !== 'the service sidecar'))(
        'mounts nothing broader than the member subtree on %s — it names the exact target',
        (name) => {
            const { pod } = everyPodSpec({ RUNNER_SERVICES: '0' })[name]();
            const mount = pod.containers[0]!.volumeMounts?.find((m) => m.name === 'workspaces');
            expect(mount?.subPath).toBe(`bellows/${USER}`);
            expect(mount?.subPath?.split('/').length).toBe(2);
        }
    );

    // A claim whose workspace path fails the segment assertions is refused before any pod spec
    // exists — the mount can never name a path the assertions did not clear.
    it.each(POD_NAMES)('refuses to build %s for a claim with a malformed workspace path', (name) => {
        const build = everyPodSpec({ RUNNER_SERVICES: '0' }, { ...job, workspacePath: '../../etc' })[name];
        expect(build).toThrow(/workspace path/);
    });
});

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
            value: `/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}`,
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

describe('the opencode session readout job', () => {
    const config = loadDriverConfig({
        EXECUTOR: 'kubernetes',
        K8S_NAMESPACE: namespace,
        RUNNER_SERVICES: '0',
    });

    it('runs the readout script by content, with the database path as an env value', () => {
        const spec = opencodeReadoutJobSpec(config, job, START);
        const container = spec.spec.template.spec.containers[0]!;
        expect(spec.metadata.name).toBe(opencodeReadoutJobName(job));
        expect(spec.metadata.name).toMatch(/^factory-ocread-/);
        expect(container.command).toEqual(['node', '-e', expect.stringContaining('node:sqlite')]);
        expect(container.env).toEqual([
            {
                name: 'OPENCODE_DB',
                value: `/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}/opencode/opencode.db`,
            },
            {
                // The scope: only the session that ran in this job's working directory — the
                // member root here, since the fixture names no repo. The session database is per
                // member, and without the scope two concurrent tasks scrape each other's runs.
                name: 'OPENCODE_DIR',
                value: `/workspaces/bellows/${USER}`,
            },
            { name: 'RUN_STARTED_MS', value: String(Date.parse(START)) },
            { name: 'EXPORT_LIMIT_BYTES', value: String(OPENCODE_EXPORT_LIMIT) },
        ]);
    });

    it('scopes the readout to the task worktree when the job names a repo', () => {
        const spec = opencodeReadoutJobSpec(config, { ...job, repo: 'Bellows-AI/factory' }, START);
        expect(spec.spec.template.spec.containers[0]!.env).toContainEqual({
            name: 'OPENCODE_DIR',
            value: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
        });
    });

    it('mounts the workspaces volume READ-WRITE: a WAL needing recovery has to write it', () => {
        const spec = opencodeReadoutJobSpec(config, job, START);
        expect(spec.spec.template.spec.containers[0]!.volumeMounts).toEqual([
            { name: 'workspaces', mountPath: `/workspaces/bellows/${USER}`, subPath: `bellows/${USER}` },
        ]);
        expect(spec.spec.template.spec.containers[0]!.volumeMounts[0]!.readOnly).toBeUndefined();
    });

    it('refuses a job whose workspace path it cannot assert', () => {
        expect(() => opencodeReadoutJobSpec(config, { ...job, workspacePath: null }, START)).toThrow(/workspace path/);
    });
});

describe('the close-time claude-code turn read under kubernetes', () => {
    /**
     * The twin of docker's close-time read (executor parity): the same script, the same env
     * VALUES, one aux Job over the PVC instead of one throwaway container. The failure path —
     * the Job refused, deadlined, or answering nothing parseable — is exercised by every
     * runner test above, whose scripted logs parse as null: unmeasured, never zero.
     */
    const spec = claudeTurnsJobSpec(
        loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
        job,
        SESSION,
        START
    );

    it('runs the static script as one aux Job, its inputs by env', () => {
        const container = spec.spec.template.spec.containers[0]!;
        expect(spec.metadata.name).toBe(claudeTurnsJobName(job));
        expect(spec.metadata.name).toMatch(/^factory-cturns-/);
        expect(container.command).toEqual(['node', '-e', claudeTurnsScript]);
        expect(container.env).toEqual([
            {
                name: 'CLAUDE_TRANSCRIPT_DIR',
                value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            },
            { name: 'CLAUDE_SESSION_ID', value: SESSION },
            // The per-run delta bound: the transcript carries earlier runs' turns too.
            { name: 'RUN_STARTED_AT', value: START },
        ]);
        expect(container.volumeMounts).toEqual([
            { name: 'workspaces', mountPath: `/workspaces/bellows/${USER}`, subPath: `bellows/${USER}` },
        ]);
    });

    it('refuses a session id that is not a uuid', () => {
        expect(() =>
            claudeTurnsJobSpec(
                loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
                job,
                'not-a-uuid',
                START
            )
        ).toThrow(/not a session id/);
    });
});

describe('the transcript artifact Jobs under kubernetes (issue #325)', () => {
    /**
     * The twins of the two readout Jobs above (executor parity): the same aux-Job shape, the
     * same env-VALUES rule, exporting the run's transcript instead of counting it. Names are
     * distinct from the turns Jobs' — the hash key is the same (job, lease) pair, and one
     * attempt's transcript Job and its turn Job must not collide.
     */
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace });

    it('claude: the exporter is a container of the run’s pod with its own token by Secret reference, never a value', () => {
        const spec = runnerJobSpec(config, { ...job, ...SUPERVISED }, { id: SESSION, resume: false }, START);
        const container = spec.spec.template.spec.containers.find((c) => c.name === EXPORTER_CONTAINER)!;
        expect(container.command).toEqual(['node', '-e', claudeExportScript]);
        expect(container.env).toContainEqual({
            name: 'CLAUDE_TRANSCRIPT_DIR',
            value: `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
        });
        expect(container.env).toContainEqual({ name: 'RUN_STARTED_AT', value: START });
        expect(container.env).toContainEqual({ name: 'FACTORY_EXPORT_DIR', value: '/factory/export' });
        expect(container.env).toContainEqual({
            name: 'BELLOWS_CONTROL_TOKEN',
            valueFrom: { secretKeyRef: { name: secretName(job), key: 'SUPERVISOR_EXPORT_TOKEN' } },
        });
        // Each credential reaches its own container only: the exporter never references the
        // supervisor's token, the supervisor never the exporter's, the agent neither.
        const keysOf = (name: string) =>
            JSON.stringify(spec.spec.template.spec.containers.find((c) => c.name === name)?.env ?? []);
        expect(keysOf(EXPORTER_CONTAINER)).not.toContain('SUPERVISOR_CONTROL_TOKEN');
        expect(keysOf(SUPERVISOR_CONTAINER)).toContain('SUPERVISOR_CONTROL_TOKEN');
        expect(keysOf(SUPERVISOR_CONTAINER)).not.toContain('SUPERVISOR_EXPORT_TOKEN');
        for (const name of SUPERVISOR_CREDENTIAL_NAMES) expect(keysOf(AGENT_CONTAINER)).not.toContain(name);
        expect(JSON.stringify(spec)).not.toMatch(/"value":"[^"]*tok-/);
        // The member's subtree and the one mailbox it shares with the supervisor — nothing else.
        expect(container.volumeMounts).toEqual([
            { name: 'workspaces', mountPath: `/workspaces/bellows/${USER}`, subPath: `bellows/${USER}` },
            { name: 'ctl-export', mountPath: '/factory/export' },
        ]);
    });

    it('opencode: exports through the readout Job, not a Job of its own', () => {
        const spec = opencodeReadoutJobSpec(config, job, START);
        const container = spec.spec.template.spec.containers[0]!;
        expect(container.env).toContainEqual({ name: 'EXPORT_LIMIT_BYTES', value: String(OPENCODE_EXPORT_LIMIT) });
        expect(container.env).toContainEqual({
            name: 'OPENCODE_DB',
            value: `/workspaces/bellows/${USER}/.factory/opencode/${job.id}/opencode/opencode.db`,
        });
    });
});

describe('the kubernetes runner under opencode', () => {
    const ocreadName = opencodeReadoutJobName(job);
    const ocreadPod = `${ocreadName}-pod`;
    const ns = `/api/v1/namespaces/${namespace}`;

    const ok = (body: unknown) => Promise.resolve({ status: 200, body: JSON.stringify(body) });

    /**
     * A router scripted for one opencode run: the runner Job goes terminal succeeded, the
     * close-time readout Job runs and answers `readoutLog`. Every claim and teardown route
     * answers the boring way. The calls list is the audit.
     */
    const opencodeFake = (readout: { status?: 'failed'; log?: string; truncated?: true } = {}) => {
        const calls: Call[] = [];
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
            if (path === jobPath(namespace, ocreadName)) {
                return ok(readout.status === 'failed' ? { status: { failed: 1 } } : { status: { succeeded: 1 } });
            }
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
            if (path.startsWith(`${ns}/pods?`) && decodeURIComponent(path).includes(`job-name=${ocreadName}`)) {
                return ok({ items: [{ metadata: { name: ocreadPod } }] });
            }
            if (path === `${ns}/pods/${podName}/log`) return Promise.resolve({ status: 200, body: 'did the work\n' });
            if (path === `${ns}/pods/${ocreadPod}/log`) {
                return Promise.resolve({
                    status: 200,
                    body: readout.log ?? '',
                    ...(readout.truncated ? { truncated: readout.truncated } : {}),
                });
            }
            // The per-attempt Secret (the runner's attempt pair), created and reaped per attempt.
            if (path === `${ns}/secrets`) {
                if (method === 'DELETE') return Promise.resolve({ status: 200, body: '{}' });
                return Promise.resolve({ status: 201, body: JSON.stringify({ metadata: { uid: 'secret-uid' } }) });
            }
            return Promise.reject(new Error(`the fake has no answer for ${method} ${path}`));
        };
        return { request, calls };
    };

    const ocRunner = (request: K8sRequest) =>
        supervisedRunner(
            loadDriverConfig({
                EXECUTOR: 'kubernetes',
                K8S_NAMESPACE: namespace,
                RUNNER_SERVICES: '0',
            }),
            request,
            async () => {}
        );

    it('flags the transcript a cut readout log lost its head of (#825)', async () => {
        const normalized = JSON.stringify({ stream: 'normalized', event: { n: 2 } });
        const { request } = opencodeFake({
            log: ['t":{"n":1}}', normalized, JSON.stringify({ id: 'ses_n3w' })].join('\n'),
            truncated: true,
        });

        const outcome = await ocRunner(request).run(opencodeJob, null);

        expect(outcome.transcript).toBe(normalized);
        expect(outcome.transcriptTruncated).toBe(true);
    });

    it('scrapes the session the run minted, and rides it on the outcome', async () => {
        const { request, calls } = opencodeFake({
            log: JSON.stringify({
                id: 'ses_n3w',
                finish: 'stop',
                tokens: 4321,
                cost: 0.12,
                turns: 9,
                summary: 'Fixed the flaky test',
            }),
        });
        const outcome = await ocRunner(request).run(opencodeJob, null);

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

        // The readout Job was created, read, and reaped — after the runner Job existed.
        const created = calls.findIndex(
            (c) => c.method === 'POST' && (c.body as { metadata?: { name?: string } })?.metadata?.name === ocreadName
        );
        const deleted = calls.findIndex(
            (c) => c.method === 'DELETE' && c.path?.startsWith(jobPath(namespace, ocreadName))
        );
        expect(created).toBeGreaterThan(0);
        expect(deleted).toBeGreaterThan(created);
    });

    it('fails no verdict when the scrape cannot run: the error rides readoutError instead', async () => {
        const { request, calls } = opencodeFake({ status: 'failed' });
        const outcome = await ocRunner(request).run(opencodeJob, null);

        // The run's own verdict is untouched; only the follow-up-ability was lost, said out loud.
        expect(outcome.exitCode).toBe(0);
        expect(outcome.sessionId).toBeUndefined();
        expect(outcome.readoutError).toContain('the session readout job failed');
        // Retried to the end before giving up: three attempts, every one a POST of the readout.
        const scrapePosts = calls.filter(
            (c) => c.method === 'POST' && (c.body as { metadata?: { name?: string } })?.metadata?.name === ocreadName
        );
        expect(scrapePosts.length).toBe(3);
    });

    // The readout poll can now THROW (poll exhaustion is infrastructure, never a verdict) — and
    // the scrape wraps that throw, because a completed run's verdict must never burn over its
    // close-time read.
    it('fails no verdict when the readout poll exhausts: the error rides readoutError instead', async () => {
        const base = opencodeFake();
        const request: K8sRequest = (method, path, body) =>
            path === jobPath(namespace, ocreadName)
                ? Promise.resolve({ status: 400, body: '400 Bad Request' })
                : base.request(method, path, body);
        const outcome = await ocRunner(request).run(opencodeJob, null);

        expect(outcome.exitCode).toBe(0);
        expect(outcome.sessionId).toBeUndefined();
        expect(outcome.readoutError).toContain('in a row');
    });

    // The same guard one level down: a TRANSPORT rejection — the readout Job POST itself failing,
    // on the kind of connection the issue's 400s live on — is also the read's failure, never the
    // run's. (The runner Job's own POST rejecting is different: that run never started, and its
    // throw is what hands the job back to its lease.)
    it('fails no verdict when the readout Job POST rejects: the error rides readoutError instead', async () => {
        const base = opencodeFake();
        const request: K8sRequest = (method, path, body) =>
            method === 'POST' &&
            path === jobsPath(namespace) &&
            (body as { metadata?: { name?: string } })?.metadata?.name === ocreadName
                ? Promise.reject(new Error('the apiserver closed the connection'))
                : base.request(method, path, body);
        const outcome = await ocRunner(request).run(opencodeJob, null);

        expect(outcome.exitCode).toBe(0);
        expect(outcome.sessionId).toBeUndefined();
        expect(outcome.readoutError).toContain('the apiserver closed the connection');
    });

    it('scrapes nothing for a claude-code run, whose session is known at spawn', async () => {
        const { request, calls } = opencodeFake({ log: 'irrelevant' });
        await runner(request).run(job, { id: SESSION, resume: false });
        expect(calls.some((c) => decodeURIComponent(c.path ?? '').includes('ocread'))).toBe(false);
        expect(
            calls.some(
                (c) =>
                    c.method === 'POST' &&
                    (c.body as { metadata?: { name?: string } })?.metadata?.name?.startsWith('factory-ocread-')
            )
        ).toBe(false);
    });
});

describe('the block-helper transport (issue #207)', () => {
    const NOOP_DESCRIPTOR = lookupHelper('noop')!;
    const NOOP_VERDICT = JSON.stringify({ schema: 'helper-noop/v1', version: 1, ok: true, output: { echoed: true } });
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory', env: { GITHUB_TOKEN: 'claim-token' } };
    const WT = `/workspaces/bellows/${USER}/.worktrees/${job.id}`;
    const plan = (over: Partial<HelperPlan> = {}): HelperPlan => ({
        helperId: 'noop',
        phase: 'pre',
        input: { a: 1 },
        githubWriting: false,
        ...over,
    });
    const secretsPathFor = `/api/v1/namespaces/${namespace}/secrets`;
    const helperStepsOf = (steps: { submitted: StepRequest[] }) =>
        steps.submitted.filter((step) => step.kind === 'helper');
    const answering = () => fakeSteps((step) => (step.kind === 'helper' ? stepOk(NOOP_VERDICT) : stepOk()));

    // Since #771 a helper is a step of the attempt's supervisor: the content-passed script, the
    // literal bounded input and the task worktree are the step's, not a Job spec's.
    it('submits one helper step: content-passed script, literal bounded input, task worktree', async () => {
        const steps = answering();
        await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(repoJob, plan());
        const [step] = helperStepsOf(steps);
        expect(step).toMatchObject({
            kind: 'helper',
            argv: ['node', '-e', NOOP_DESCRIPTOR.scriptBody],
            cwd: WT,
            env: { HELPER_INPUT: JSON.stringify({ a: 1 }) },
        });
        expect(steps.tokens).toEqual(new Set([CONTROL_TOKEN]));

        // A command-only job (no repo): no working directory, the member root's own mount.
        const bare = answering();
        await runner(fakeRequest().request, {}, undefined, bare.sink).runHelper(job, plan());
        expect(helperStepsOf(bare)[0]!.cwd).toBeUndefined();
    });

    it('gives a read-only helper no claim env, and a github-writing one the fresh token over the claim env', async () => {
        const readOnly = answering();
        await runner(fakeRequest().request, {}, undefined, readOnly.sink).runHelper(repoJob, plan());
        expect(helperStepsOf(readOnly)[0]!.env).toEqual({ HELPER_INPUT: JSON.stringify({ a: 1 }) });

        const writing = answering();
        await runner(fakeRequest().request, {}, undefined, writing.sink).runHelper(
            repoJob,
            plan({ githubWriting: true }),
            { token: 'fresh-install-token' }
        );
        expect(helperStepsOf(writing)[0]!.env).toMatchObject({ GITHUB_TOKEN: 'fresh-install-token' });
        expect(JSON.stringify(helperStepsOf(writing)[0]!.env)).not.toContain('claim-token');
    });

    // Issue #826: a receipted helper given its effect runs bracketed by its receipt on the task
    // volume, and a lost supervisor is the attempt's loss, never a failed helper.
    it('brackets a receipted helper with its receipt in the task worktree, and throws a lost supervisor', async () => {
        const steps = fakeSteps(receiptedAnswer);
        // The receipt's MAC key: a driver without a board token keeps no receipt.
        await runner(fakeRequest().request, { JOB_BOARD_TOKEN: 'board-key' }, undefined, steps.sink).runHelper(
            repoJob,
            plan({ helperId: REVIEW_REPLY_PROBE_ID, githubWriting: true }),
            { token: 'fresh-install-token', effectId: 'effect-1' }
        );
        expect(receiptOrder(steps.submitted)).toEqual(['read', 'started', 'helper', 'done']);
        expect(steps.submitted[0]!.env).toMatchObject({ LEDGER: `${WT}/.factory/helpers.json`, OP: 'effect-1' });

        const lost = fakeSteps(async () => {
            throw new StepChannelClosed('the helper');
        });
        await expect(
            runner(fakeRequest().request, {}, undefined, lost.sink).runHelper(repoJob, plan())
        ).rejects.toBeInstanceOf(StepChannelClosed);
    });

    it('fails an unknown helper id before any step is submitted', async () => {
        const steps = answering();
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(
            job,
            plan({ helperId: 'not-a-real-helper' })
        );
        expect(result).toEqual({
            ok: false,
            reason: 'unknown_helper',
            message: expect.stringContaining('not-a-real-helper'),
        });
        expect(helperStepsOf(steps)).toEqual([]);
    });

    // A group the cluster refuses is a failed helper in the apiserver's own words — never a throw.
    it('fails a helper whose runner Job the cluster refuses, submitting no step', async () => {
        const steps = answering();
        const { request } = fakeRequest({ create: { status: 403, body: 'jobs is forbidden' } });
        const result = await runner(request, {}, undefined, steps.sink).runHelper(repoJob, plan());

        expect(result).toEqual({
            ok: false,
            reason: 'runner_error',
            message: expect.stringContaining('jobs is forbidden'),
        });
        expect(steps.submitted).toEqual([]);
    });

    it('runs the noop helper end to end as a step, creating no Job or Secret of its own', async () => {
        const steps = answering();
        const { request, calls } = fakeRequest();
        const result = await runner(request, {}, undefined, steps.sink).runHelper(job, plan());
        expect(result).toEqual({ ok: true, output: { echoed: true } });
        // The attempt had no group (an adopted run): one supervisor-only group, and nothing per helper.
        const created = calls.filter((c) => c.method === 'POST' && c.path === jobsPath(namespace));
        expect(created.map((c) => (c.body as { metadata: { name: string } }).metadata.name)).toEqual([
            runnerJobName(job),
        ]);
        expect(
            (created[0]!.body as ReturnType<typeof runnerJobSpec>).spec.template.spec.containers.map((c) => c.name)
        ).toEqual([SUPERVISOR_CONTAINER]);
        expect(calls.filter((c) => c.method === 'POST' && c.path === secretsPathFor)).toHaveLength(1);
    });

    it('ends a cancelled helper without submitting it when the stand-down signal is already aborted (issue #488)', async () => {
        const steps = answering();
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(
            repoJob,
            plan({ githubWriting: true }),
            { token: 'fresh-install-token', signal: AbortSignal.abort() }
        );
        expect(result).toEqual({ ok: false, reason: 'runner_error', message: expect.stringContaining('cancelled') });
        expect(helperStepsOf(steps)).toEqual([]);
    });

    it('never puts the fresh token in a Job, a Secret or any request body — only in the step', async () => {
        const steps = answering();
        const { request, calls } = fakeRequest();
        await runner(request, {}, undefined, steps.sink).runHelper(repoJob, plan({ githubWriting: true }), {
            token: 'super-secret-token',
        });
        expect(JSON.stringify(calls.map((c) => c.body))).not.toContain('super-secret-token');
        expect(helperStepsOf(steps)[0]!.env.GITHUB_TOKEN).toBe('super-secret-token');
    });

    it('mints a fresh step identity on every call, even for the identical plan run twice in a row', async () => {
        const steps = answering();
        const r = runner(fakeRequest().request, {}, undefined, steps.sink);
        await r.runHelper(job, plan());
        await r.runHelper(job, plan());
        const ids = helperStepsOf(steps).map((step) => step.id);
        expect(ids).toHaveLength(2);
        expect(ids[0]).not.toBe(ids[1]);
    });

    it('reports a named timeout failure when the supervisor ends the step at its bound', async () => {
        const steps = fakeSteps(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(job, plan());
        expect(result).toEqual({ ok: false, reason: 'timeout', message: expect.any(String) });
    });

    it('reports runner_error for an ordinary non-zero exit, distinct from a timeout', async () => {
        const steps = fakeSteps(() => ({ exitCode: 1, stdout: '', stderr: 'boom', timedOut: false }));
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(job, plan());
        expect(result).toEqual({ ok: false, reason: 'runner_error', message: expect.stringContaining('boom') });
    });

    it('reports runner_error for a step channel that fails, never letting it escape as an exception', async () => {
        const steps = fakeSteps(() => {
            throw new Error('the step channel connection reset');
        });
        const result = await runner(fakeRequest().request, {}, undefined, steps.sink).runHelper(job, plan());
        expect(result).toEqual({
            ok: false,
            reason: 'runner_error',
            message: expect.stringContaining('connection reset'),
        });
    });
});

// A private registry is the normal case in a cluster, and every pod this driver specs pulls on its
// own: the runner, each aux Job (sync shown — they all share `auxJobSpec`) and each service pod.
describe('RUNNER_IMAGE_PULL_SECRETS', () => {
    it.each(POD_NAMES)('names every configured secret on %s', (name) => {
        const { pod } = everyPodSpec({ RUNNER_IMAGE_PULL_SECRETS: 'regcred, mirror ,' })[name]();
        expect(pod.imagePullSecrets).toEqual([{ name: 'regcred' }, { name: 'mirror' }]);
    });

    it.each(POD_NAMES)('leaves the field off %s entirely when none are configured', (name) => {
        expect(everyPodSpec()[name]().pod).not.toHaveProperty('imagePullSecrets');
    });
});

// Issue #361: the chart's scheduling knobs reach the chart's own pods only; these are the runner
// group's — the tainted node group agent-written code is meant to land on and nothing else. Every
// pod the driver specs carries them: the runner, each aux Job and each service pod, exactly as
// RUNNER_IMAGE_PULL_SECRETS above does.
describe('RUNNER NODE SELECTOR / TOLERATIONS / AFFINITY', () => {
    const scheduled = {
        RUNNER_NODE_SELECTOR: '{"dedicated":"factory-runners"}',
        RUNNER_TOLERATIONS: '[{"key":"dedicated","operator":"Equal","value":"factory-runners","effect":"NoSchedule"}]',
        RUNNER_AFFINITY:
            '{"podAntiAffinity":{"preferredDuringSchedulingIgnoredDuringExecution":[{"weight":1,"podAffinityTerm":{"topologyKey":"topology.kubernetes.io/zone","labelSelector":{"matchLabels":{"app.kubernetes.io/name":"factory"}}}}]}}',
    };

    it.each(POD_NAMES)('schedules %s onto the configured node group', (name) => {
        const { pod } = everyPodSpec(scheduled)[name]();
        expect(pod.nodeSelector).toEqual({ dedicated: 'factory-runners' });
        expect(pod.tolerations).toEqual([
            { key: 'dedicated', operator: 'Equal', value: 'factory-runners', effect: 'NoSchedule' },
        ]);
        expect(pod.affinity).toMatchObject({ podAntiAffinity: expect.anything() });
    });

    it.each(POD_NAMES)('leaves the fields off %s entirely when none are configured', (name) => {
        const { pod } = everyPodSpec()[name]();
        expect(pod).not.toHaveProperty('nodeSelector');
        expect(pod).not.toHaveProperty('tolerations');
        expect(pod).not.toHaveProperty('affinity');
    });
});

// The chart's runner NetworkPolicy selects by release, so every pod the driver specs must carry
// the release label — not only the runner Job object, which is what bulk cleanup reads.
describe('K8S_RELEASE on pod templates', () => {
    it.each(POD_NAMES)('labels %s with the release', (name) => {
        expect(everyPodSpec({ K8S_RELEASE: 'dev' })[name]().meta.labels).toMatchObject({
            'app.kubernetes.io/instance': 'dev',
        });
    });
});

// Karpenter consolidation or a cluster-autoscaler scale-down voluntarily evicts a running runner
// pod mid-job (issue #362): nothing is corrupted — the lease expires, the board re-offers — but
// the work is redone, silently, visible only as a higher `attempts`. RUNNER_DO_NOT_DISRUPT is the
// opt-out from that voluntary disruption, and both annotation keys travel together: Karpenter
// reads the first, the cluster-autoscaler the second, and they are one switch. It is not a shield
// against everything: a Spot interruption or an external drain (a managed-nodegroup upgrade,
// kubectl drain) reclaims the pod regardless. Every pod the driver specs carries the annotations —
// a declared service's eviction ruins the attempt exactly like the runner's does.
describe('RUNNER_DO_NOT_DISRUPT on pod templates', () => {
    const ANNOTATIONS = {
        'karpenter.sh/do-not-disrupt': 'true',
        'cluster-autoscaler.kubernetes.io/safe-to-evict': 'false',
    };

    // The annotations name the POD: Job specs carry them on the pod template (Karpenter reads
    // pods, not Job objects).
    it.each(POD_NAMES)('annotates %s', (name) => {
        expect(everyPodSpec({ RUNNER_DO_NOT_DISRUPT: '1' })[name]().meta.annotations).toEqual(ANNOTATIONS);
    });

    // Annotating the Job object itself would be cargo cult — Karpenter reads pods. (The runner Job
    // carries its adoption marks, issue #792, and nothing of the disruption opt-out.)
    it.each(POD_NAMES)('leaves the Job object of %s without the disruption annotations', (name) => {
        const { job: jobObject } = everyPodSpec({ RUNNER_DO_NOT_DISRUPT: '1' })[name]();
        const annotations = (jobObject as { metadata: { annotations?: Record<string, string> } }).metadata.annotations;
        for (const key of Object.keys(ANNOTATIONS)) expect(annotations?.[key]).toBeUndefined();
    });

    it.each(POD_NAMES)('leaves the annotations off %s entirely when the switch is unset', (name) => {
        expect(everyPodSpec()[name]().meta).not.toHaveProperty('annotations');
    });
});

describe('the paused deadline for an agent question', () => {
    it('removes the deadline while waiting and restores it with the actual elapsed wait', async () => {
        const spec: { activeDeadlineSeconds?: number } = { activeDeadlineSeconds: 7200 };
        const annotations: Record<string, string> = {};
        const patches: unknown[] = [];
        const request: K8sRequest = async (method, _path, body) => {
            if (method === 'PATCH') {
                const patch = body as {
                    spec: { activeDeadlineSeconds: number | null };
                    metadata: { annotations: Record<string, string | null> };
                };
                // A merge patch removes a key set to null.
                if (patch.spec.activeDeadlineSeconds === null) delete spec.activeDeadlineSeconds;
                else spec.activeDeadlineSeconds = patch.spec.activeDeadlineSeconds;
                for (const [key, value] of Object.entries(patch.metadata.annotations)) {
                    if (value === null) delete annotations[key];
                    else annotations[key] = value;
                }
                patches.push(body);
            }
            return { status: 200, body: JSON.stringify({ spec, metadata: { uid: 'job-uid', annotations } }) };
        };
        const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            const r = runner(request);
            await Promise.all([r.pauseDeadline(job, true), r.pauseDeadline(job, true)]);
            expect(spec.activeDeadlineSeconds).toBeUndefined();
            expect(patches).toHaveLength(1);
            now.mockReturnValue(1000 + 48 * 3600 * 1000);
            await r.pauseDeadline(job, false);
            expect(spec.activeDeadlineSeconds).toBe(7200 + 48 * 3600);
            await r.pauseDeadline(job, false);
            expect(patches).toHaveLength(2);
        } finally {
            now.mockRestore();
        }
    });

    it('does nothing when the runner Job is gone', async () => {
        const request = vi.fn(async () => ({ status: 404, body: '{}' }));
        await runner(request).pauseDeadline(job, true);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it('rejects, sending no PATCH, when the Job GET answers null', async () => {
        const methods: string[] = [];
        const request: K8sRequest = async (method) => {
            methods.push(method);
            return { status: 200, body: 'null' };
        };
        await expect(runner(request).pauseDeadline(job, true)).rejects.toThrow(/reading the runner job/);
        expect(methods).toEqual(['GET']);
    });

    it.each(['not json', '{"deadline":"60","at":1}', '{"deadline":60}', 'null'])(
        'rejects, sending no PATCH, when a resume finds the saved annotation %s',
        async (saved) => {
            const methods: string[] = [];
            const request: K8sRequest = async (method) => {
                methods.push(method);
                return {
                    status: 200,
                    body: JSON.stringify({
                        metadata: { uid: 'job-uid', annotations: { 'bellows.ai/paused-deadline': saved } },
                    }),
                };
            };
            await expect(runner(request).pauseDeadline(job, false)).rejects.toThrow(/saved deadline/);
            expect(methods).toEqual(['GET']);
        }
    );

    it('rejects a refused pause so it can be retried', async () => {
        const request: K8sRequest = async (method) =>
            method === 'PATCH'
                ? { status: 403, body: '{}' }
                : {
                      status: 200,
                      body: JSON.stringify({ spec: { activeDeadlineSeconds: 60 }, metadata: { uid: 'job-uid' } }),
                  };
        await expect(runner(request).pauseDeadline(job, true)).rejects.toThrow(/pausing or resuming/);
    });

    it('preconditions the PATCH on the uid of the Job it read', async () => {
        const patches: { metadata: { uid?: string } }[] = [];
        const request: K8sRequest = async (method, _path, body) => {
            if (method === 'PATCH') patches.push(body as (typeof patches)[number]);
            return {
                status: 200,
                body: JSON.stringify({ spec: { activeDeadlineSeconds: 60 }, metadata: { uid: 'job-uid' } }),
            };
        };
        await runner(request).pauseDeadline(job, true);
        expect(patches.map((patch) => patch.metadata.uid)).toEqual(['job-uid']);
    });

    // A Job whose incarnation cannot be named could be a replacement under the name (#869): no write.
    it.each([
        ['no uid', { spec: { activeDeadlineSeconds: 120 }, metadata: {} }],
        ['no metadata', { spec: { activeDeadlineSeconds: 120 } }],
        ['an empty uid', { spec: { activeDeadlineSeconds: 120 }, metadata: { uid: '' } }],
        ['a deadline that is no number', { spec: { activeDeadlineSeconds: '120' }, metadata: { uid: 'job-uid' } }],
        ['annotations that are not strings', { spec: {}, metadata: { uid: 'job-uid', annotations: { a: 1 } } }],
    ])('rejects, sending no PATCH, when the Job GET answers %s', async (_name, body) => {
        const methods: string[] = [];
        const request: K8sRequest = async (method) => {
            methods.push(method);
            return { status: 200, body: JSON.stringify(body) };
        };
        await expect(runner(request).pauseDeadline(job, true)).rejects.toThrow(/reading the runner job/);
        expect(methods).toEqual(['GET']);
    });
});

describe('a Stop on kubernetes (issue #427)', () => {
    it('a Stop mid-run resolves run() as a killed outcome, as docker does', async () => {
        const base = fakeRequest({ job: { status: 200, body: JSON.stringify({ status: { active: 1 } }) } });
        let deleted = false;
        let r: ReturnType<typeof runner> | null = null;
        const request: K8sRequest = (method, path, body) => {
            if (path.startsWith(jobPath(namespace, runnerJobName(job)))) {
                if (method === 'DELETE') {
                    deleted = true;
                    return Promise.resolve({ status: 200, body: '{}' });
                }
                if (method === 'GET') {
                    // The heartbeat's Stop lands while the run is polling: the loop calls kill().
                    if (!deleted) void r?.kill(job);
                    if (deleted) return Promise.resolve({ status: 404, body: '{"kind":"Status"}' });
                }
            }
            return base.request(method, path, body);
        };
        r = runner(request);
        // Expected for parity with docker (whose killed container resolves exit 137): an outcome
        // the loop's stopped path can park. Observed: a rejection, which the loop treats as
        // "could not run, leaving it to the lease" — no session report, no artifacts, no suspend.
        await expect(r.run(job, { id: SESSION, resume: false })).resolves.toMatchObject({ started: true });
    });

    // U2: on Stop the loop's raceStep abandons a pre-helper and the heartbeat calls kill(job),
    // which deletes the runner Job and the services only. The helper's aux Job is deleted in
    // runHelper's finally, i.e. only once helperVerdict returns — the Job runs to completion.
    it('a Stop (kill) during a pre-helper deletes its aux Job promptly', async () => {
        const base = fakeRequest();
        const helperJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
        let helperName: string | null = null;
        let helperDeleted = false;
        let finished = false;
        const request: K8sRequest = (method, path, body) => {
            if (method === 'POST' && path === jobsPath(namespace) && helperName === null) {
                helperName = (body as { metadata: { name: string } }).metadata.name;
                return Promise.resolve({ status: 201, body: '{}' });
            }
            if (helperName !== null && path.startsWith(jobPath(namespace, helperName))) {
                if (method === 'DELETE') {
                    helperDeleted = true;
                    return Promise.resolve({ status: 200, body: '{}' });
                }
                // The helper is still running: pending on every poll, answered as a macrotask.
                const answer = finished
                    ? { status: 404, body: '{"kind":"Status"}' }
                    : { status: 200, body: JSON.stringify({ status: { active: 1 } }) };
                return new Promise((resolve) => setTimeout(() => resolve(answer), 1));
            }
            return base.request(method, path, body);
        };
        const r = runner(request);
        const helperPlan: HelperPlan = { helperId: 'noop', phase: 'pre', input: null, githubWriting: true };
        const running = r.runHelper(helperJob, helperPlan, { token: 'ghs_fresh' });
        try {
            while (helperName === null) await new Promise((resolve) => setTimeout(resolve, 1));
            await r.kill(helperJob); // the heartbeat's Stop
            await new Promise((resolve) => setTimeout(resolve, 50));

            expect(helperDeleted).toBe(true);
        } finally {
            finished = true;
            await running;
        }
    });
});

describe('a Job status read as a typed answer (#869)', () => {
    const malformed = JSON.stringify({ status: { succeeded: 'x' } });
    const depsOf = (): K8sDeps => ({
        request: async () => ({ status: 200, body: malformed }),
        sleep: async () => {},
        config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
    });

    it('reads malformed counters as Inconclusive on an aux verdict, never a TypeError or pending', async () => {
        await expect(auxVerdict(depsOf(), 'aux-job')).rejects.toBeInstanceOf(Inconclusive);
    });

    it('reads malformed counters as Inconclusive on the runner poll, never a TypeError or pending', async () => {
        await expect(pollRunnerJobUntilTerminal(depsOf(), job)).rejects.toBeInstanceOf(Inconclusive);
    });
});

describe('the close-read and run waits end on the clock (#869)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });
    const pendingBody = JSON.stringify({ status: { active: 1 } });
    const MAX_POLLS = 500;
    /** A pending Job forever; each pause moves the clock a poll on, and a runaway wait is cut loose. */
    const pendingDeps = (): K8sDeps => {
        vi.useFakeTimers({ toFake: ['Date'] });
        let pauses = 0;
        return {
            request: async () => ({ status: 200, body: pendingBody }),
            sleep: async (ms) => {
                pauses += 1;
                if (pauses > MAX_POLLS) throw new Error('the wait never ended');
                vi.setSystemTime(Date.now() + ms);
            },
            config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
        };
    };
    const messages = {
        what: 'the readout',
        notFound: (n: string) => `${n} gone`,
        errorStatus: () => 'error',
        failed: 'failed',
    };

    it('answers Inconclusive when an aux Job is still pending at the close-read bound', async () => {
        const started = Date.now();
        await expect(pollJobToTerminal(pendingDeps(), 'aux-job', messages)).rejects.toBeInstanceOf(Inconclusive);
        expect(Date.now() - started).toBeLessThan(CLOSE_READ_DEADLINE_MS + POLL_MS);
    });

    it('answers Inconclusive when an aux verdict is still pending at the close-read bound', async () => {
        const deps = pendingDeps();
        await expect(auxVerdict(deps, 'aux-job')).rejects.toBeInstanceOf(Inconclusive);
    });

    it('ends the runner poll promptly when the attempt is killed during its pause', async () => {
        const deps: K8sDeps = {
            request: async () => ({ status: 200, body: pendingBody }),
            sleep: (_ms, signal) =>
                new Promise((_resolve, reject) => {
                    signal?.addEventListener('abort', () => reject(new Error('woken by the abort')), { once: true });
                }),
            config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
        };
        const polling = pollRunnerJobUntilTerminal(deps, job);
        setTimeout(() => ledgerOf(deps).note(job, 'hard'), 10);
        await expect(polling).rejects.toBeInstanceOf(RunnerKilled);
    });
});

describe('runnerLossOf (issue #560)', () => {
    const exited = (exitCode: number) => ({
        metadata: { name: 'runner-pod' },
        status: { phase: 'Failed', containerStatuses: [{ state: { terminated: { exitCode } } }] },
    });

    it('is no loss when the live pod says the agent ended the run', () => {
        expect(runnerLossOf([exited(1)])).toBeNull();
    });

    it('names a pod the kubelet evicted, in its own words', () => {
        expect(
            runnerLossOf([
                { ...exited(137), status: { ...exited(137).status, reason: 'Evicted', message: 'low on memory' } },
            ])
        ).toBe('the runner pod was taken away before it exited (Evicted: low on memory)');
    });

    it('names a pod the control plane marked a disruption target', () => {
        const pod = {
            ...exited(137),
            status: {
                ...exited(137).status,
                conditions: [
                    {
                        type: 'DisruptionTarget',
                        status: 'True',
                        reason: 'DeletionByTaintManager',
                        message: 'node removed',
                    },
                ],
            },
        };
        expect(runnerLossOf([pod])).toBe(
            'the runner pod was taken away before it exited (DeletionByTaintManager: node removed)'
        );
    });

    it('names a runner with no live pod left as deleted', () => {
        expect(runnerLossOf([])).toBe(
            'the runner pod was deleted before it exited (evicted, drained or its node removed)'
        );
        expect(
            runnerLossOf([{ ...exited(137), metadata: { name: 'p', deletionTimestamp: '2026-01-01T00:00:00Z' } }])
        ).toBe('the runner pod was deleted before it exited (evicted, drained or its node removed)');
    });
});

/*
 * Issue #792: a runner that outlived its driver. The claim that superseded it finds it by the job
 * label, and a FINISHED one is read — verdict, log, session — before anything of it is deleted;
 * the run is never redone. A runner still running, or one the platform took away, is not adopted.
 */
describe('adopting a finished runner of an earlier claim (#792)', () => {
    const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
    const priorName = runnerJobName(job);
    const priorItem = (status: Record<string, unknown>, seq = '1', name = priorName, lease = job.leaseToken) => ({
        metadata: {
            name,
            uid: `uid-${name}`,
            labels: { 'factory.job': job.id, 'factory.lease': lease },
            annotations: {
                'factory.claim-seq': seq,
                'factory.session': SESSION,
                'factory.command': commandMark(job.command),
            },
        },
        spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
        status: { startTime: START, ...status },
    });

    const nameOf = (item: unknown): string => (item as { metadata: { name: string } }).metadata.name;
    /** A fake whose runner-Job listing answers `items`, each until its Job is deleted. */
    const withRunners = (items: unknown[], overrides: Record<string, unknown> = {}) => {
        let listed = items;
        return routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            const name =
                method === 'DELETE' ? listed.map(nameOf).find((n) => path.startsWith(jobPath(namespace, n))) : null;
            if (name) {
                listed = listed.filter((item) => nameOf(item) !== name);
                return { status: 200, body: '{}' };
            }
        }, overrides);
    };

    // The adopted run's Job is kept (issue #821): if this claim is lost before its verdict lands, the
    // next claim adopts the same run again; its Secrets go once it is read.
    it('reads its verdict, log and session, keeps its Job for the next claim, and holds the checkout', async () => {
        const { request, calls } = withRunners([priorItem({ succeeded: 1 })]);

        const adopted = await runner(request).adopt(adopter);

        expect(adopted).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, timedOut: false, sessionId: SESSION },
        });
        expect(adopted!.outcome.output).toContain('did the work');
        const logRead = calls.findIndex((call) =>
            call.path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`)
        );
        const deleted = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName))
        );
        const secretGone = calls.findIndex(
            (call) =>
                call.method === 'DELETE' && call.path === `/api/v1/namespaces/${namespace}/secrets/${secretName(job)}`
        );
        expect(logRead).toBeGreaterThanOrEqual(0);
        expect(deleted).toBe(-1);
        expect(secretGone).toBeGreaterThan(logRead);
        const held = await request('GET', claimPathFor(job.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: NEW_TOKEN } });
    });

    // Once its read succeeded the run is this attempt's (issue #821): a Secret delete refused
    // after it is cleanup for later — the Job stays as its anchor, the claim stays held, nothing
    // is run again; the reaper's Secret-first pass (or the owner reference) takes the Secret.
    it('answers the read run when its Secret cannot be deleted, keeping the Job as the cleanup anchor', async () => {
        const { request: base, calls } = withRunners([priorItem({ succeeded: 1 })]);
        const secretPath = `/api/v1/namespaces/${namespace}/secrets/${secretName(job)}`;
        let refusals = 1;
        const request: K8sRequest = (method, path, body) => {
            if (method === 'DELETE' && path === secretPath && refusals > 0) {
                refusals -= 1;
                calls.push({ method, path, body });
                return Promise.resolve({ status: 503, body: 'unavailable' });
            }
            return base(method, path, body);
        };

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });

        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        const held = await request('GET', claimPathFor(job.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: NEW_TOKEN } });
        // The Job is still listed: the reaper's pass over the job once it is gone takes the Secret first.
        const removed = await createKubernetesReaper({
            config: loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            request,
            sleep: async () => {},
        }).reap(
            { jobId: job.id, leaseToken: job.leaseToken, createdAtMs: 0, objects: [{ kind: 'job', name: priorName }] },
            'gone'
        );
        expect(removed).toContain(`secret ${secretName(job)}`);
    });

    it('adopts the newest of two finished runners by claim sequence', async () => {
        const OLDER = '55555555-5555-4555-8555-555555555555';
        const { request } = withRunners([
            priorItem({ succeeded: 1 }, '3'),
            priorItem({ succeeded: 1 }, '1', runnerJobName({ ...job, leaseToken: OLDER }), OLDER),
        ]);

        expect((await runner(request).adopt({ ...adopter, claimSeq: 4 }))?.claimSeq).toBe(3);
    });

    it("adopts the earlier runner's whole log, not a line tail (#825)", async () => {
        const whole = numberedLines(LOG_TAIL_LINES + 500);
        const { request: base } = withRunners([priorItem({ succeeded: 1 })]);
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && isAgentLogRead(path)
                ? Promise.resolve(kubeletLog(whole)(path))
                : base(method, path, body);

        const adopted = await runner(request).adopt(adopter);

        expect(adopted?.outcome).toMatchObject({ fullLog: whole, logTruncated: false });
    });

    // Failure injection at the transport boundary: a runner-Job list too big for a log's stream
    // buffer is still one whole answer — never a cut body that parses as "no earlier runner".
    it('adopts the earlier runner when its Job list outgrows a pod log stream buffer (#825)', async () => {
        const OLDER = '55555555-5555-4555-8555-555555555555';
        const HEAD_PAD = 1_000;
        const padded = (item: ReturnType<typeof priorItem>, pad: number) => ({
            ...item,
            metadata: { ...item.metadata, annotations: { ...item.metadata.annotations, pad: 'p'.repeat(pad) } },
        });
        // A body cut to its head and tail would read the finished runner's name and claim sequence
        // with the still-running older runner's status — a runner never adopted.
        const { request } = withRunners([
            padded(priorItem({ succeeded: 1 }), HEAD_PAD),
            padded(priorItem({ active: 1 }, '0', runnerJobName({ ...job, leaseToken: OLDER }), OLDER), ARTIFACT_LIMIT),
        ]);

        const adopted = await runner(throughTransport(request)).adopt(adopter);

        expect(adopted?.claimSeq).toBe(1);
    });

    // A runner marked at or after this claim's sequence is a newer contender's, never an earlier one.
    it('never adopts a runner of a claim at or after its own', async () => {
        const { request } = withRunners([priorItem({ succeeded: 1 }, '2')]);
        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    it('never adopts a runner that is still running, and deletes nothing', async () => {
        // The agent is running, as the pod of a run that has not ended says (the default pod list shows it exited).
        const { request, calls } = withRunners([priorItem({ active: 1 })], {
            pods: runnerPods({ running: {} }, { running: {} }),
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
        expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
        expect(calls.some((call) => call.method === 'POST' && call.path === configmapsPath)).toBe(false);
    });

    it('never adopts a runner the platform took away, leaving it to the launch sweep', async () => {
        const { request, calls } = withRunners([priorItem({ failed: 1 })], {
            job: jobAnswer({ failed: 1 }),
            pods: {
                status: 200,
                body: JSON.stringify({
                    // Deleted under the run: its containers killed, the pod over.
                    items: [
                        {
                            metadata: { name: podName, deletionTimestamp: '2026-01-01T00:00:00Z' },
                            status: { phase: 'Failed' },
                        },
                    ],
                }),
            },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        const held = await request('GET', claimPathFor(job.id));
        expect(held.status).toBe(404);
    });

    // A regression guard: the group's agent never ran, so its completed-looking end is no run to adopt.
    it('never adopts a group whose supervisor lost its driver before the agent was released', async () => {
        const { request, calls } = withRunners([priorItem({ failed: 1 })], {
            job: jobAnswer({ failed: 1 }),
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [
                                    { name: 'agent', state: { terminated: { exitCode: 0 } } },
                                    { name: 'supervisor', state: { terminated: { exitCode: SUPERVISOR_EXIT.lost } } },
                                ],
                            },
                        },
                    ],
                }),
            },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    /** A listed runner Job carrying the reasons its driver recorded for ending it. */
    const recorded = (item: ReturnType<typeof priorItem>, marks: Record<string, string>) => ({
        ...item,
        metadata: { ...item.metadata, annotations: { ...item.metadata.annotations, ...marks } },
    });
    const SPOOL_MARK = { 'factory.kill.artifact_spool_full': '2000000000 bytes' };

    // Why the lost driver ended the run was recorded on its Job before the stop: the adoption reads
    // the verdict the attached run would have.
    it('adopts a supervised stop its lost driver recorded for a full spool, with the spool fault', async () => {
        const { request } = withRunners([recorded(priorItem({ succeeded: 1 }), SPOOL_MARK)]);

        const adopted = await runner(request).adopt(adopter);

        expect(adopted?.outcome.artifactSpoolFull).toBe('2000000000 bytes');
        expect(adopted?.outcome).not.toHaveProperty('infraLoss');
    });

    // A full spool rides a supervised stop: its record never explains a supervisor lost after it.
    it('never takes a recorded full spool for the end of a supervisor that did not finalize', async () => {
        const { request } = withRunners([recorded(priorItem({ failed: 1 }), SPOOL_MARK)], {
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [
                                    { name: 'agent', state: { terminated: { exitCode: 137 } } },
                                    { name: 'supervisor', state: { terminated: { exitCode: 70 } } },
                                ],
                            },
                        },
                    ],
                }),
            },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    // Stated limit: a stop that fell back to the hard kill deleted the Job, its record with it —
    // nothing is left to adopt, and the job runs again with its checkout and session.
    it('finds nothing to adopt after the hard kill deleted a recorded runner', async () => {
        const { request, calls } = withRunners([recorded(priorItem({ active: 1 }), SPOOL_MARK)]);
        const lost = runner(request);
        await lost.recordKill(job, { reason: 'artifact_spool_full', detail: '2000000000 bytes' });
        await lost.kill(job);

        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(true);
        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    // A queued task's command can be edited after a handover: a run of the old command is not its run.
    it('never adopts a run of a command since edited', async () => {
        const { request } = withRunners([priorItem({ succeeded: 1 })]);
        expect(await runner(request).adopt({ ...adopter, command: 'another command' })).toBeNull();
    });

    // Issue #822: the runner of an interrupted attempt finished while its takeover or handover was
    // being claimed. The continuing claim carries the command the first claim ran, so the marks
    // that runner's Job was created with are its own, and the run is adopted, never redone.
    it('adopts, for a claim continuing an interrupted attempt, the runner its first claim launched', async () => {
        const listed = priorItem({ succeeded: 1 });
        const launched = { ...listed, metadata: { ...listed.metadata, annotations: spec().metadata.annotations } };
        const { request } = withRunners([launched]);
        const continuing = { ...adopter, resumeSessionId: SESSION, ownSession: true, continuesInterrupted: true };

        expect(await runner(request).adopt(continuing)).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, sessionId: SESSION },
        });
    });

    /*
     * Issue #824 (D13): the agent exited, and the lost driver's supervisor is still finalizing — it
     * drains, reports and ends by itself once its orphan bound passes. The next claim waits that out
     * and adopts the run instead of sweeping it, and reads the final report the supervisor logged.
     */
    const runnerPods = (agent: Record<string, unknown>, supervisor: Record<string, unknown>, metadata = {}) => ({
        status: 200,
        body: JSON.stringify({
            items: [
                {
                    metadata: { name: podName, ...metadata },
                    status: {
                        phase: 'Running',
                        containerStatuses: [
                            { name: AGENT_CONTAINER, state: agent },
                            { name: SUPERVISOR_CONTAINER, state: supervisor },
                        ],
                    },
                },
            ],
        }),
    });
    const FINALIZING = runnerPods({ terminated: { exitCode: 0 } }, { running: {} });
    const FINALIZED = runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 0 } });
    const jobAnswer = (status: Record<string, unknown>): K8sResponse => ({
        status: 200,
        body: JSON.stringify({ metadata: { name: priorName, uid: `uid-${priorName}` }, status }),
    });
    const STILL_FINALIZING = jobAnswer({ active: 1 });
    const reportLog = (report: Record<string, unknown>): K8sResponse => ({
        status: 200,
        body: `serving steps\n${SUPERVISOR_REPORT_PREFIX}${JSON.stringify({
            outcome: 'completed',
            cause: null,
            agentExit: 0,
            agentEnd: 'exit',
            drained: true,
            ...report,
        })}\n`,
    });
    const isSupervisorLogRead = (path: string): boolean =>
        path.startsWith(`/api/v1/namespaces/${namespace}/pods/${podName}/log`) &&
        path.includes(`container=${SUPERVISOR_CONTAINER}`);
    const isRunnerPodList = (path: string): boolean =>
        path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) && decodeURIComponent(path).includes('job-name=');
    const isPriorStatusRead = (method: K8sMethod, path: string): boolean =>
        method === 'GET' && path.split('?')[0] === jobPath(namespace, priorName);

    /**
     * withRunners over one earlier runner `item`, whose own status reads answer `statuses` in turn
     * (the last from then on) — a terminal one lands on the listed Job too, as the apiserver lists
     * it — whose supervisor log answers `supervisorLog`, and whose `onPoll` runs on each status read.
     */
    const earlier = ({
        item = priorItem({ active: 1 }),
        statuses = [STILL_FINALIZING],
        // The runner pod as the Job is: its supervisor running until the Job lists over.
        pods = () => ('succeeded' in item.status || 'failed' in item.status ? FINALIZED : FINALIZING),
        supervisorLog,
        onPoll,
    }: {
        item?: ReturnType<typeof priorItem>;
        statuses?: K8sResponse[];
        pods?: K8sResponse | (() => K8sResponse);
        supervisorLog?: K8sResponse | (() => K8sResponse);
        onPoll?: (poll: number, request: K8sRequest) => void | Promise<void>;
    } = {}) => {
        const base = withRunners([item], { pods: typeof pods === 'function' ? FINALIZING : pods });
        let polls = 0;
        const request: K8sRequest = async (method, path, body) => {
            if (typeof pods === 'function' && method === 'GET' && isRunnerPodList(path)) {
                base.calls.push({ method, path, body });
                return pods();
            }
            if (isPriorStatusRead(method, path)) {
                base.calls.push({ method, path, body });
                const answer = statuses[Math.min(polls, statuses.length - 1)]!;
                polls += 1;
                await onPoll?.(polls, request);
                const status =
                    (answer.status === 200 ? (JSON.parse(answer.body) as { status?: object } | null)?.status : null) ??
                    {};
                if ('succeeded' in status || 'failed' in status) item.status = { startTime: START, ...status };
                return answer;
            }
            if (method === 'GET' && supervisorLog && isSupervisorLogRead(path)) {
                base.calls.push({ method, path, body });
                return typeof supervisorLog === 'function' ? supervisorLog() : supervisorLog;
            }
            return base.request(method, path, body);
        };
        const polled = () => base.calls.filter((call) => isPriorStatusRead(call.method as K8sMethod, call.path));
        return { request, calls: base.calls, polled };
    };
    const deletedPrior = (calls: Call[]): boolean =>
        calls.some(
            (call) =>
                call.method === 'DELETE' &&
                (call.path.startsWith(jobPath(namespace, priorName)) ||
                    call.path.endsWith(`/secrets/${secretName(job)}`))
        );
    const claimedAt = (calls: Call[]): number =>
        calls.findIndex((call) => call.method === 'POST' && call.path === configmapsPath);

    it('waits out a supervisor still finalizing after its agent exited, then adopts its run (#824)', async () => {
        const { request, calls, polled } = earlier({
            statuses: [STILL_FINALIZING, STILL_FINALIZING, jobAnswer({ succeeded: 1 })],
        });

        const adopted = await runner(request).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true, sessionId: SESSION } });
        expect(polled()).toHaveLength(3);
        // The claim is taken before the wait: no other contender reads or sweeps the group alongside.
        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
        expect(calls.indexOf(polled()[0]!)).toBeGreaterThan(claimedAt(calls));
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
        const held = await request('GET', claimPathFor(job.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: NEW_TOKEN } });
    });

    // The docker twin's bound: a supervisor that never ends in its own wind-down is no run to adopt.
    it('leaves a supervisor that never finalizes in the bound to the sync’s sweep, its claim given back', async () => {
        const { request, calls, polled } = earlier();

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(polled().length).toBeGreaterThan(1);
        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // Failure injection: status reads that never answer are no confirmation the supervisor hangs.
    it('stands down, deleting nothing, when the finalizing runner cannot be read to its end', async () => {
        const { request, calls } = earlier({ statuses: [{ status: 503, body: 'unavailable' }] });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // #869: a status read that is no Job's — a corrupt count, no uid to tell the incarnation by — is not "still running".
    it.each([
        ['a corrupt count', jobAnswer({ failed: 'junk' })],
        ['no uid', { status: 200, body: JSON.stringify({ metadata: { name: priorName }, status: { active: 1 } }) }],
        ['no status', { status: 200, body: JSON.stringify({ metadata: { name: priorName, uid: 'u' } }) }],
    ])('stands down, deleting nothing, when the finalizing runner reads with %s', async (_name, answer) => {
        const { request, calls } = earlier({ statuses: [answer] });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    // An older claim's runner, its discovery fields as given: `seq` its claim sequence, `lease` its lease label.
    const pooledPrior = (seq: string, lease: string = job.leaseToken) =>
        priorItem({ succeeded: 1 }, seq, priorName, lease);

    /** The runner listing's `prior`, its metadata edited: a lease label, or an annotation, replaced or (undefined) removed. */
    const editedPrior = (edit: { lease?: string | null; annotations?: Record<string, string | undefined> }) => {
        const base = pooledPrior('1');
        const labels: Record<string, string> = { ...base.metadata.labels };
        if (edit.lease === null) delete labels['factory.lease'];
        const annotations: Record<string, string | undefined> = { ...base.metadata.annotations, ...edit.annotations };
        for (const key of Object.keys(annotations)) if (annotations[key] === undefined) delete annotations[key];
        return { ...base, metadata: { ...base.metadata, labels, annotations } };
    };

    // A valid command mark that is another command's: that run is not ours (a handover edited the command), not unreadable.
    it('skips a runner whose command mark is another valid mark, claiming nothing', async () => {
        const { request, calls } = earlier();
        const other = editedPrior({ annotations: { 'factory.command': '0123456789abcdef' } });
        const listed: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? Promise.resolve({ status: 200, body: JSON.stringify({ items: [other] }) })
                : request(method, path, body);

        expect(await runner(listed).adopt(adopter)).toBeNull();

        expect(claimedAt(calls)).toBe(-1);
        expect(deletedPrior(calls)).toBe(false);
    });

    // Issue #869: an earlier-runner listing with an entry that names nothing is no list to adopt from.
    it.each([
        ['an empty entry', {}],
        ['an entry named by a number', { metadata: { name: 5 } }],
        ['a runner whose claim sequence is corrupt', pooledPrior('corrupt')],
        ['a runner whose claim sequence is empty', pooledPrior('')],
        ['a runner whose claim sequence overflows the safe integers', pooledPrior('9'.repeat(400))],
        ['a runner with no claim sequence', editedPrior({ annotations: { 'factory.claim-seq': undefined } })],
        ['a runner with no lease label', editedPrior({ lease: null })],
        ['a runner whose command mark is unreadable', editedPrior({ annotations: { 'factory.command': 'zz' } })],
        ['a runner with no command mark', editedPrior({ annotations: { 'factory.command': undefined } })],
        ['a runner with no spec', { ...pooledPrior('1'), spec: undefined }],
        [
            'a runner whose container has no name',
            { ...pooledPrior('1'), spec: { template: { spec: { containers: [{}] } } } },
        ],
        ['a runner whose lease label is no lease', pooledPrior('1', 'corrupt')],
        ['a runner whose Job conditions are no list', priorItem({ failed: 1, conditions: 'Failed' })],
    ])('stands down, claiming nothing, when the earlier runners are listed with %s', async (_name, entry) => {
        const { request, calls } = earlier();
        const listed: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? Promise.resolve({ status: 200, body: JSON.stringify({ items: [entry] }) })
                : request(method, path, body);

        await expect(runner(listed).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
        expect(deletedPrior(calls)).toBe(false);
    });

    // #869: a runner pod whose phase or container statuses are not what the apiserver writes says nothing of its agent.
    it.each([
        ['a phase that is no string', { phase: 5 }],
        ['container statuses that are no list', { phase: 'Running', containerStatuses: 'x' }],
        ['a container status with no name', { phase: 'Running', containerStatuses: [{ state: { running: {} } }] }],
        [
            'a terminated state with a fractional exit code',
            {
                phase: 'Running',
                containerStatuses: [{ name: AGENT_CONTAINER, state: { terminated: { exitCode: 1.5 } } }],
            },
        ],
        [
            'a state that is no record',
            { phase: 'Running', containerStatuses: [{ name: AGENT_CONTAINER, state: 'terminated' }] },
        ],
        ['conditions that are no list', { phase: 'Running', conditions: 'DisruptionTarget' }],
        ['a condition with no type', { phase: 'Running', conditions: [{ status: 'True' }] }],
    ])('stands down, claiming nothing, when the runner pods are listed with %s', async (_name, status) => {
        const { request, calls } = earlier({
            pods: { status: 200, body: JSON.stringify({ items: [{ metadata: { name: podName }, status }] }) },
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
        expect(deletedPrior(calls)).toBe(false);
    });

    // Failure injection: a pod list that cannot be read cannot tell an exited agent from a running one.
    it('stands down, claiming nothing, when it cannot read whether the agent of a running Job ended', async () => {
        const { request, calls } = earlier({ pods: { status: 503, body: 'unavailable' } });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
        expect(deletedPrior(calls)).toBe(false);
    });

    it('takes a runner Job deleted while its supervisor finalized as taken away, its claim given back', async () => {
        const { request, calls } = earlier({
            statuses: [STILL_FINALIZING, { status: 404, body: '{"kind":"Status","reason":"NotFound"}' }],
        });

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // A pod being deleted is still the run's: one whose Job has not ended is waited out like any
    // other, and one that never ends in the bound is the sweep's, its claim given back.
    it('waits out a runner whose pod is being deleted while its Job has not ended', async () => {
        const { request, calls } = earlier({
            pods: runnerPods(
                { terminated: { exitCode: 0 } },
                { terminated: { exitCode: 137 } },
                { deletionTimestamp: '2026-01-01T00:00:00Z' }
            ),
        });

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // A Stop or a lost lease mid-wait: the abandoned adoption reads and deletes nothing more.
    it('abandons the wait when the attempt stands down, deleting nothing', async () => {
        const standDown = new AbortController();
        const { request, calls, polled } = earlier({
            onPoll: (poll) => {
                if (poll === 2) standDown.abort();
            },
        });

        await expect(runner(request).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);

        expect(polled()).toHaveLength(2);
        expect(deletedPrior(calls)).toBe(false);
    });

    // A newer claim took the checkout while this one waited: the run is no longer this attempt's.
    it('stands down, deleting nothing, when its claim is taken over while the supervisor finalized', async () => {
        const OTHER = '44444444-4444-4444-8444-444444444444';
        const { request, calls } = earlier({
            statuses: [STILL_FINALIZING, jobAnswer({ succeeded: 1 })],
            onPoll: async (poll, req) => {
                if (poll !== 2) return;
                await req('DELETE', claimPathFor(job.id));
                await req('POST', configmapsPath, {
                    metadata: { name: `factory-job-${job.id}-claim` },
                    data: { holder: OTHER, claimSeq: '3' },
                });
            },
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
        const held = await request('GET', claimPathFor(job.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: OTHER } });
    });

    it('adopts a full spool the supervisor raised itself, from its final report (#824)', async () => {
        const { request } = earlier({
            item: priorItem({ succeeded: 1 }),
            supervisorLog: reportLog({ outcome: 'failed', cause: 'artifact_spool_full', agentEnd: 'killed' }),
        });

        const adopted = await runner(request).adopt(adopter);

        expect(adopted?.outcome.artifactSpoolFull).toBe('the supervisor reported the spool full');
        expect(adopted?.outcome).not.toHaveProperty('infraLoss');
    });

    // The report is the supervisor's finalization: a crash after it does not unsay it.
    it('adopts a run whose supervisor crashed after logging its final report', async () => {
        const { request } = earlier({
            item: priorItem({ failed: 1 }),
            pods: runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 70 } }),
            supervisorLog: reportLog({}),
        });

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });
    });

    // A group whose driver was lost before it released the agent reports too, and exits 75: no run.
    it('never adopts a group whose logged report says its agent was never launched', async () => {
        const { request } = earlier({
            item: priorItem({ failed: 1 }),
            pods: runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: SUPERVISOR_EXIT.lost } }),
            supervisorLog: reportLog({
                outcome: 'lost',
                cause: 'driver_lost',
                agentExit: null,
                agentEnd: 'unlaunched',
            }),
        });

        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    // Failure injection: a log the apiserver would not serve is no answer — not "no report", which
    // would make a supervisor that reported and then crashed a loss, and the run swept unread.
    it('stands down, deleting nothing, when the supervisor log cannot be read', async () => {
        const { request, calls } = earlier({
            item: priorItem({ failed: 1 }),
            pods: runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 70 } }),
            supervisorLog: { status: 503, body: 'unavailable' },
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    it('reads the supervisor log again after a refusal, and adopts the run it reported', async () => {
        let refusals = 1;
        const { request } = earlier({
            item: priorItem({ failed: 1 }),
            pods: runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 70 } }),
            supervisorLog: () => (refusals-- > 0 ? { status: 503, body: 'unavailable' } : reportLog({})),
        });

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });
    });

    // A Stop during a finished run's close-time read: the abandoned adoption sweeps and deletes nothing.
    it('abandons the adoption of a finished run when the attempt stands down during its read', async () => {
        const standDown = new AbortController();
        const { request: base, calls } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) => {
            if (method === 'GET' && isAgentLogRead(path)) standDown.abort();
            return base(method, path, body);
        };

        await expect(runner(request).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);

        expect(deletedPrior(calls)).toBe(false);
    });

    // The bound is the wind-down in time: status reads that each take long end it sooner than polls would.
    it('ends the wait at the wind-down deadline however slowly the status reads answer', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const { request, polled } = earlier({
                onPoll: () => {
                    vi.setSystemTime(Date.now() + 60_000);
                },
            });

            expect(await runner(request).adopt(adopter)).toBeNull();

            expect(polled().length).toBeLessThanOrEqual(Math.ceil(SUPERVISOR_WINDDOWN_MS / 60_000) + 1);
        } finally {
            vi.useRealTimers();
        }
    });

    // The deadline bounds the reads too: an apiserver that never answers spends the wind-down, not
    // the verdict reads' own retries on top of every poll.
    it('stands down at the wind-down deadline when the status reads never answer', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            const { request, calls, polled } = earlier({
                statuses: [{ status: 503, body: 'unavailable' }],
                onPoll: () => {
                    vi.setSystemTime(Date.now() + 30_000);
                },
            });

            await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

            expect(polled().length).toBeLessThanOrEqual(Math.ceil(SUPERVISOR_WINDDOWN_MS / 30_000) + 1);
            expect(deletedPrior(calls)).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    // A Stop mid-sweep: the abandoned adoption deletes nothing past the request in flight.
    it('stops deleting the moment the attempt stands down during its sweep', async () => {
        const OLDER = '55555555-5555-4555-8555-555555555555';
        const olderPair = { ...job, leaseToken: OLDER };
        const standDown = new AbortController();
        const { request: base, calls } = withRunners([
            priorItem({ succeeded: 1 }),
            priorItem({ succeeded: 1 }, '0', runnerJobName(olderPair), OLDER),
        ]);
        const request: K8sRequest = (method, path, body) => {
            if (method === 'DELETE' && path.endsWith(`/secrets/${secretName(olderPair)}`)) standDown.abort();
            return base(method, path, body);
        };

        await expect(runner(request).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);

        const deletes = calls.filter((call) => call.method === 'DELETE' && !call.path.startsWith(configmapsPath));
        const aborted = deletes.findIndex((call) => call.path.endsWith(`/secrets/${secretName(olderPair)}`));
        expect(aborted).toBeGreaterThanOrEqual(0);
        expect(deletes.slice(aborted + 1)).toEqual([]);
    });

    // The Job controller marks a Job failed (FailureTarget) before its pod is over: a supervisor still
    // running is still finalizing, its report still to come — waited out, never read early.
    it('waits out a Job already marked failed while its supervisor still runs, then reads its report', async () => {
        let podReads = 0;
        let ended = false;
        const { request, calls } = earlier({
            item: priorItem({ failed: 1, conditions: [{ type: 'FailureTarget', reason: 'PodFailurePolicy' }] }),
            statuses: [jobAnswer({ failed: 1 })],
            pods: () => {
                podReads += 1;
                ended = podReads > 2;
                return ended
                    ? runnerPods({ terminated: { exitCode: 137 } }, { terminated: { exitCode: 0 } })
                    : runnerPods({ terminated: { exitCode: 137 } }, { running: {} });
            },
            supervisorLog: () =>
                ended
                    ? reportLog({ outcome: 'failed', cause: 'artifact_spool_full', agentEnd: 'killed' })
                    : { status: 200, body: 'serving steps\n' },
        });

        const adopted = await runner(request).adopt(adopter);

        expect(adopted?.outcome.artifactSpoolFull).toBe('the supervisor reported the spool full');
        expect(podReads).toBeGreaterThan(2);
        const secretGone = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.endsWith(`/secrets/${secretName(job)}`)
        );
        expect(secretGone).toBeGreaterThan(-1);
    });

    // Failure injection: a listing the apiserver refused for a moment is read again, never taken for
    // "nothing to adopt" or a reason to run afresh — whose fence would sweep a finalizing group unread.
    it('lists the earlier runners again after a refusal, and adopts the one it finds', async () => {
        let refusals = 1;
        const { request: base } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`) && refusals-- > 0
                ? Promise.resolve({ status: 503, body: 'unavailable' })
                : base(method, path, body);

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1 });
    });

    it('stands down, claiming nothing, when the earlier runners cannot be listed', async () => {
        const { request: base, calls } = earlier();
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? Promise.resolve({ status: 503, body: 'unavailable' })
                : base(method, path, body);

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
    });

    // A pod the kubelet rejected before any container started has no supervisor log to read (400):
    // no report, and a group nothing finalized — the run redone in its session, never a takeover
    // that stands down again and again.
    it('takes a runner pod rejected before its supervisor started as taken away, not unreadable', async () => {
        const rejected = {
            status: 200,
            body: JSON.stringify({
                items: [
                    {
                        metadata: { name: podName },
                        status: { phase: 'Failed', reason: 'UnexpectedAdmissionError', message: 'device unavailable' },
                    },
                ],
            }),
        };
        const { request, calls } = earlier({
            item: priorItem({ failed: 1 }),
            pods: rejected,
            supervisorLog: { status: 400, body: 'container "supervisor" in pod is not available' },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    // The lost driver can still record why it ended the run while this claim waits: the record on
    // the Job as it ends is the one read, as docker reads its markers after the wait.
    it('reads the kill record the Job carries once it ends, not the one it was listed with', async () => {
        const { request } = earlier({
            statuses: [
                STILL_FINALIZING,
                {
                    status: 200,
                    body: JSON.stringify({
                        metadata: {
                            uid: `uid-${priorName}`,
                            annotations: { 'factory.kill.artifact_spool_full': '2000000000 bytes' },
                        },
                        status: { succeeded: 1 },
                    }),
                },
            ],
        });

        const adopted = await runner(request).adopt(adopter);

        expect(adopted?.outcome.artifactSpoolFull).toBe('2000000000 bytes');
    });

    // Failure injection: a pod list that answers 200 with no list in it proves no pod over.
    it('stands down, deleting nothing, when the pod list of a finished Job answers malformed', async () => {
        let podReads = 0;
        const { request, calls } = earlier({
            statuses: [jobAnswer({ succeeded: 1 })],
            pods: () => (++podReads === 1 ? FINALIZING : { status: 200, body: '{"kind":"Status"}' }),
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    it('stands down, deleting nothing, when the pod list of a finished Job answers null', async () => {
        let podReads = 0;
        const { request, calls } = earlier({
            statuses: [jobAnswer({ succeeded: 1 })],
            pods: () => (++podReads === 1 ? FINALIZING : { status: 200, body: 'null' }),
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    // Once an earlier run is found, nothing unexpected may fall through to a fresh run, whose
    // sync's fence would sweep that run unread: any throw stands the attempt down.
    it('stands down, deleting nothing, on any unexpected throw once an earlier run is found', async () => {
        const { request: base, calls } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) =>
            method === 'POST' && path === configmapsPath
                ? Promise.reject(new TypeError('something unforeseen'))
                : base(method, path, body);

        const adopting = runner(request).adopt(adopter);

        await expect(adopting).rejects.toBeInstanceOf(AdoptionBlocked);
        await expect(adopting).rejects.toThrow('something unforeseen');
        expect(deletedPrior(calls)).toBe(false);
    });

    // A supervisor the kubelet could not start reads terminated (`StartError`), never having run.
    it('takes a supervisor that failed to start as never having run, not as an unreadable log', async () => {
        const { request, calls } = earlier({
            item: priorItem({ failed: 1 }),
            pods: {
                status: 200,
                body: JSON.stringify({
                    items: [
                        {
                            metadata: { name: podName },
                            status: {
                                phase: 'Failed',
                                containerStatuses: [
                                    { name: AGENT_CONTAINER, state: { waiting: { reason: 'PodInitializing' } } },
                                    {
                                        name: SUPERVISOR_CONTAINER,
                                        state: {
                                            terminated: { exitCode: 128, reason: 'StartError', message: 'exec failed' },
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                }),
            },
            supervisorLog: { status: 400, body: 'container "supervisor" in pod is not available' },
        });

        expect(await runner(request).adopt(adopter)).toBeNull();

        expect(deletedPrior(calls)).toBe(false);
        expect((await request('GET', claimPathFor(job.id))).status).toBe(404);
    });

    it('stands down, claiming nothing, when the earlier runner list answers malformed', async () => {
        const { request: base, calls } = earlier();
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? Promise.resolve({ status: 200, body: '{"kind":"Status"}' })
                : base(method, path, body);

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
    });

    /*
     * Class (a), #824: a read that is not confirmed is never taken for "none", "running" or "gone".
     * Each row answers one read of the adoption with something that proves nothing; the adoption
     * stands down, and nothing of the earlier run is deleted.
     */
    const ENDED_FAILED = runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 0 } });
    const nthPodList = (n: number, answer: K8sResponse) => {
        let reads = 0;
        return () => (++reads === n ? answer : ENDED_FAILED);
    };
    it.each<[string, Parameters<typeof earlier>[0], ((base: K8sRequest) => K8sRequest)?]>([
        ['a finalizing Job read answering {}', { statuses: [{ status: 200, body: '{}' }] }],
        [
            'a pod not over that says nothing of its supervisor',
            {
                item: priorItem({ succeeded: 1 }),
                statuses: [jobAnswer({ succeeded: 1 })],
                pods: {
                    status: 200,
                    body: JSON.stringify({
                        items: [
                            {
                                metadata: { name: podName },
                                status: {
                                    phase: 'Running',
                                    containerStatuses: [
                                        { name: AGENT_CONTAINER, state: { terminated: { exitCode: 0 } } },
                                    ],
                                },
                            },
                        ],
                    }),
                },
            },
        ],
        [
            'a runner Job list with a null entry',
            {},
            (base) => (method, path, body) =>
                method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                    ? Promise.resolve({ status: 200, body: '{"items":[null]}' })
                    : base(method, path, body),
        ],
        [
            'the verdict pod list answering {}',
            { item: priorItem({ failed: 1 }), pods: nthPodList(3, { status: 200, body: '{}' }) },
        ],
        [
            'an agent log that never answers',
            { item: priorItem({ succeeded: 1 }) },
            (base) => (method, path, body) =>
                method === 'GET' && isAgentLogRead(path)
                    ? Promise.resolve({ status: 503, body: 'unavailable' })
                    : base(method, path, body),
        ],
        [
            "the sweep's pod list answering {}",
            { item: priorItem({ succeeded: 1 }) },
            (base) => (method, path, body) =>
                method === 'GET' &&
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                decodeURIComponent(path).includes('factory.lease!=')
                    ? Promise.resolve({ status: 200, body: '{}' })
                    : base(method, path, body),
        ],
    ])('stands down, deleting nothing, on %s', async (_what, setup, wrap) => {
        const { request: base, calls } = earlier(setup);
        const request = wrap ? wrap(base) : base;

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(deletedPrior(calls)).toBe(false);
    });

    it('reads the agent log again after a refusal, and adopts the run with its output', async () => {
        let refusals = 1;
        const { request: base } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) =>
            method === 'GET' && isAgentLogRead(path) && refusals-- > 0
                ? Promise.resolve({ status: 503, body: 'unavailable' })
                : base(method, path, body);

        expect((await runner(request).adopt(adopter))?.outcome.output).toContain('did the work');
    });

    // A Stop while the earlier runners are read: no claim is taken, so no stale claim is deleted.
    it('takes no claim once the attempt stands down during discovery', async () => {
        const standDown = new AbortController();
        const { request: base, calls } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, body) => {
            if (method === 'GET' && isRunnerPodList(path)) standDown.abort();
            return base(method, path, body);
        };

        await expect(runner(request).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);

        expect(calls.some((call) => call.path.startsWith(configmapsPath) && call.method !== 'GET')).toBe(false);
    });

    // A node drained mid-finalization: the pod is terminating, its agent exited, its supervisor still
    // running — the group a claim must wait out, never sweep (#824).
    it('waits out a supervisor finalizing on a terminating pod, then adopts its run', async () => {
        let ended = false;
        const terminating = { deletionTimestamp: '2026-01-01T00:00:00Z' };
        const { request, calls } = earlier({
            statuses: [STILL_FINALIZING, jobAnswer({ succeeded: 1 })],
            pods: () =>
                ended
                    ? runnerPods({ terminated: { exitCode: 0 } }, { terminated: { exitCode: 0 } }, terminating)
                    : runnerPods({ terminated: { exitCode: 0 } }, { running: {} }, terminating),
            onPoll: (poll) => {
                ended = poll >= 2;
            },
            supervisorLog: reportLog({}),
        });

        const adopted = await runner(request).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true, sessionId: SESSION } });
        expect(adopted?.outcome.output).toContain('did the work');
        expect(adopted?.outcome).not.toHaveProperty('infraLoss');
        expect(calls.some((call) => isSupervisorLogRead(call.path))).toBe(true);
        expect(claimedAt(calls)).toBeGreaterThanOrEqual(0);
    });

    // The drain deleted the pod after its supervisor finalized: it is still listed, being deleted,
    // its report readable — the run it finished, read as such, never taken for a pod gone.
    it('adopts the run of a pod being deleted after its supervisor reported, with the report’s verdict', async () => {
        const { request, calls } = earlier({
            item: priorItem({ failed: 1 }),
            statuses: [jobAnswer({ failed: 1 })],
            pods: runnerPods(
                { terminated: { exitCode: 137 } },
                { terminated: { exitCode: 0 } },
                { deletionTimestamp: '2026-01-01T00:00:00Z' }
            ),
            supervisorLog: reportLog({
                outcome: 'failed',
                cause: 'artifact_spool_full',
                agentExit: 137,
                agentEnd: 'killed',
            }),
        });

        const adopted = await runner(request).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 137, started: true, sessionId: SESSION } });
        expect(adopted?.outcome.artifactSpoolFull).toBe('the supervisor reported the spool full');
        expect(adopted?.outcome.output).toContain('did the work');
        expect(adopted?.outcome).not.toHaveProperty('infraLoss');
        // The read run's Job is kept for a later claim (#821); only its Secrets go.
        expect(
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(jobPath(namespace, priorName)))
        ).toBe(false);
    });

    it.each([
        ['a 400 that is no never-started refusal stands down', 'Bad Request: invalid tailLines', true],
        ['a never-started agent is no log', 'container "agent" in pod "p" is waiting to start: PodInitializing', false],
    ])('reads an agent log answered 400: %s', async (_what, body, blocked) => {
        const { request: base, calls } = earlier({ item: priorItem({ succeeded: 1 }) });
        const request: K8sRequest = (method, path, b) =>
            method === 'GET' && isAgentLogRead(path)
                ? Promise.resolve({ status: 400, body: JSON.stringify({ kind: 'Status', message: body }) })
                : base(method, path, b);

        const adopting = runner(request).adopt(adopter);

        if (blocked) {
            await expect(adopting).rejects.toBeInstanceOf(AdoptionBlocked);
            expect(deletedPrior(calls)).toBe(false);
        } else {
            expect((await adopting)?.outcome.output).toBe('');
        }
    });

    // Discovery is contained too: a malformed field anywhere in what it reads stands the attempt down.
    it('stands down, claiming nothing, when discovery meets a malformed pod', async () => {
        const { request, calls } = earlier({
            pods: {
                status: 200,
                body: JSON.stringify({ items: [{ metadata: { name: podName }, status: { containerStatuses: 'x' } }] }),
            },
        });

        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);

        expect(claimedAt(calls)).toBe(-1);
    });

    it('answers null when this job has no earlier runner', async () => {
        const { request } = withRunners([]);
        expect(await runner(request).adopt(adopter)).toBeNull();
    });

    it('marks every runner Job with its claim sequence and session, for the next claim to read', () => {
        expect(spec().metadata.annotations).toEqual({
            'factory.claim-seq': '1',
            'factory.session': SESSION,
            'factory.command': commandMark(job.command),
        });
    });
});

describe('the bound a runner pod outlives a lost driver by', () => {
    it('is a quarter of the lease, clamped to [30 s, 90 s], so the group ends inside the lost driver’s lease', () => {
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '120' }))).toBe(30_000);
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '300' }))).toBe(75_000);
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '3600' }))).toBe(90_000);
    });

    // Issue #824: the adopting claim waits out a finalizing supervisor for its wind-down, longer than
    // the most an orphaned one keeps serving steps — a lost driver's group ends inside that wait.
    it('is shorter than the wind-down an adopting claim waits a finalizing supervisor out for', () => {
        expect(orphanBoundMs(loadDriverConfig({ DRIVER_LEASE_SECONDS: '3600' }))).toBeLessThan(SUPERVISOR_WINDDOWN_MS);
    });

    it('reaches the supervisor as its orphan bound and the exporter as its drain give-up', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', DRIVER_LEASE_SECONDS: '120' });
        const bound = String(orphanBoundMs(config));
        const pod = runnerJobSpec(
            config,
            { ...job, executorType: 'claude-code', ...SUPERVISED },
            { id: SESSION, resume: false }
        ).spec.template.spec;
        const envOf = (name: string) => pod.containers.find((container) => container.name === name)?.env;
        expect(envOf(SUPERVISOR_CONTAINER)).toContainEqual({ name: 'SUPERVISOR_ORPHAN_MS', value: bound });
        expect(envOf(EXPORTER_CONTAINER)).toContainEqual({ name: 'EXPORT_DRAIN_GIVEUP_MS', value: bound });
    });
});

describe('the holder a supervisor follows, on kubernetes', () => {
    it('reaches the supervisor container alone: its claim and the file a newer holder names itself in', () => {
        const pod = runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes' }),
            { ...job, executorType: 'claude-code', ...SUPERVISED },
            { id: SESSION, resume: false }
        ).spec.template.spec;
        const envOf = (name: string) => pod.containers.find((container) => container.name === name)?.env;
        expect(envOf(SUPERVISOR_CONTAINER)).toContainEqual({
            name: 'SUPERVISOR_CLAIM_SEQ',
            value: String(job.claimSeq),
        });
        expect(envOf(SUPERVISOR_CONTAINER)).toContainEqual({
            name: 'SUPERVISOR_BINDING_FILE',
            value: SUPERVISOR_BINDING_PATH,
        });
        const others = pod.containers.filter((container) => container.name !== SUPERVISOR_CONTAINER);
        expect(JSON.stringify(others)).not.toMatch(/SUPERVISOR_(CLAIM_SEQ|BINDING_FILE)/);
    });

    it('leaves a reclaim group without its claim and the binding: it follows no newer holder', () => {
        const pod = reclaimGroupSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), job, job.leaseToken).spec.template
            .spec;
        const names = pod.containers.flatMap((container) => (container.env ?? []).map((entry) => entry.name));
        expect(names).toContain('SUPERVISOR_ORPHAN_MS');
        expect(names.filter((name) => /^SUPERVISOR_(CLAIM_SEQ|BINDING_FILE)$/.test(name))).toEqual([]);
    });
});

describe('how a started run ends, on kubernetes (the conformance table)', () => {
    const session = { id: SESSION, resume: false };
    const runnerPath = () => jobPath(namespace, runnerJobName(job));
    /** The runner Job answers `answer`; every other Job — the close-time read — ends as the fake's own. */
    const onlyRunner = (answer: K8sResponse) => (_method: K8sMethod, path: string) =>
        path === runnerPath() ? answer : undefined;
    const podWith = (supervisorExit: number) => ({
        status: 200,
        body: JSON.stringify({
            items: [
                {
                    metadata: { name: podName },
                    status: {
                        containerStatuses: [
                            { name: 'agent', state: { terminated: { exitCode: 0 } } },
                            { name: 'supervisor', state: { terminated: { exitCode: supervisorExit } } },
                        ],
                    },
                },
            ],
        }),
    });
    const ACTIVE = { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: { active: 1 } }) };
    const GONE = { status: 404, body: '{"kind":"Status"}' };

    /** A Stop that lands while the run polls: the loop's kill deletes the runner Job. */
    const killedMidRun = () => {
        const base = fakeRequest({ job: ACTIVE });
        let deleted = false;
        let r: ReturnType<typeof runner> | null = null;
        const request: K8sRequest = (method, path, body) => {
            if (path.startsWith(runnerPath())) {
                if (method === 'DELETE') {
                    deleted = true;
                    return Promise.resolve({ status: 200, body: '{}' });
                }
                if (method === 'GET' && !deleted) void r?.kill(job);
                if (method === 'GET' && deleted) return Promise.resolve(GONE);
            }
            return base.request(method, path, body);
        };
        r = runner(request);
        return r.run(job, session);
    };

    const reportedThenCrashed = (agentEnd = 'exited') => {
        const steps = fakeSteps();
        steps.report({
            id: 'report-1',
            outcome: null,
            cause: null,
            agentExit: 0,
            agentEnd,
            drained: true,
            serving: true,
        });
        const { request } = routed(onlyRunner(ACTIVE), { pods: podWith(70) });
        return runner(request, {}, undefined, steps.sink).run(job, session);
    };

    /** The supervisor reports the budget ended the agent; the Job then reads 404 under the poll. */
    const vanishedAfterBudget = () => {
        const steps = fakeSteps();
        steps.report({
            id: 'report-1',
            outcome: 'timed_out',
            cause: 'timeout',
            agentExit: 137,
            agentEnd: 'killed',
            drained: true,
            serving: true,
        });
        return runner(fakeRequest({ job: GONE }).request, {}, undefined, steps.sink).run(job, session);
    };

    const vanishedAfterLost = () => {
        const steps = fakeSteps();
        steps.report({
            id: 'report-1',
            outcome: 'lost',
            cause: 'lost',
            agentExit: null,
            agentEnd: 'lost',
            drained: true,
            serving: true,
        });
        return runner(fakeRequest({ job: GONE }).request, {}, undefined, steps.sink).run(job, session);
    };

    const ends: Record<TerminationRow, () => Promise<RunOutcome>> = {
        'an agent that exits 0 under a finalizing supervisor': () => runner(fakeRequest().request).run(job, session),
        'an agent its run budget ended': () =>
            runner(routed(onlyRunner(FAKE.failed as K8sResponse)).request).run(job, session),
        'a group the driver hard-killed mid-run': killedMidRun,
        'a runner the platform took away mid-run': () => runner(fakeRequest({ job: GONE }).request).run(job, session),
        'a runner the platform took away after the budget ended its agent': vanishedAfterBudget,
        'a supervisor that ended without finalizing, nothing initiating it': () =>
            runner(
                routed(
                    onlyRunner({
                        status: 200,
                        body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: { failed: 1 } }),
                    }),
                    {
                        pods: podWith(70),
                    }
                ).request
            ).run(job, session),
        'a supervisor that reported, then crashed before the verdict read': () => reportedThenCrashed(),
        // A report that finalized nothing is no finalization (`reportFinalized`), attached or adopted.
        'a supervisor that reported an unlaunched group, then crashed': () => reportedThenCrashed('unlaunched'),
        // A lost agent is no finalized run either, attached or vanished under the poll.
        'a supervisor that reported its agent lost, then crashed': () => reportedThenCrashed('lost'),
        'a runner the platform took away after the supervisor reported its agent lost': () => vanishedAfterLost(),
    };

    it.each(TERMINATION_ROWS)('%s: %s', async (row, expected) => {
        expect(decisionOf(await ends[row]())).toBe(expected);
    });

    it.each(LOSS_ROWS)('%s: carries nothing past the loss', async (row) => {
        const outcome = await ends[row]();
        expect(outcome.infraLoss).toBeDefined();
        expect(carriedPastLoss(outcome)).toEqual([]);
    });
});

describe('what a closed run leaves for the next claim, on kubernetes (the retention conformance table, #828)', () => {
    const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
    const priorName = runnerJobName(job);
    const prior = {
        metadata: {
            name: priorName,
            uid: `uid-${priorName}`,
            labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
            annotations: {
                'factory.claim-seq': '1',
                'factory.session': SESSION,
                'factory.command': commandMark(job.command),
            },
        },
        spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
        status: { startTime: START, succeeded: 1 },
    };

    it.each(RETENTION_ROWS)('%s: %s', async (_row, expected) => {
        // One cluster for both claims: the runner Job is listed once the run closed, until it is deleted.
        let closed = false;
        let deleted = false;
        const { request } = routed((method, path) => {
            // The runner Job is tracked from before the run starts: closing the run must never delete it.
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/${priorName}`)) deleted = true;
            if (closed && method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: deleted ? [] : [prior] }) };
            }
        });

        const first = runner(request);
        await first.run(job, { id: SESSION, resume: false });
        closed = true;
        expect(deleted).toBe(false);

        const adopted = await runner(request).adopt(adopter);
        expect(adopted ? 'adoptable' : 'gone').toBe(expected);
        if (adopted) expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true } });
    });
});

/*
 * Issue #821 D16, the kubernetes half: every teardown of a runner Job — a kill, a finish, a sync
 * that failed or threw, a reclaim group — deletes the attempt's two Secrets first, each answer
 * read, then the Job, then confirms the Job gone and no writer pod left. Anything short of that
 * keeps the checkout claim: a refused Secret delete suspends the Job (still listed, so the next
 * pass can derive the Secrets from it) and never deletes it.
 */
describe('acknowledged Secret-first teardown (#821 D16)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const SESSION_OF = { id: SESSION, resume: false };
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const endpoint = {
        open: async () => ({ url: 'http://driver:8130', token: 'reclaim-token' }),
        close: () => undefined,
    };
    /** The reclaim group a lifecycle's cluster saw created: its names are its invocation's own. */
    const reclaimSeen: { name: string; pair: BoardJob } = { name: '', pair: repoJob };

    interface Faults {
        /** What a Secret delete answers, by the Secret's name: refused (500), a transport throw, or as ever. */
        secret?: (name: string) => 'refused' | 'throws' | null;
        jobDelete?: 'refused';
        /** The Job keeps reading present after its delete, through the whole bound. */
        jobLingers?: boolean;
        /** What the writer-pod list (`factory.job=…,factory.lease=…`) answers. */
        writerPods?: unknown[];
    }

    /** The cluster, its faults armed once the group's Job is POSTed: whatever ended before is unaffected. */
    const cluster = (jobName: string, faults: Faults, overrides: Record<string, unknown> = {}) => {
        let armed = false;
        reclaimSeen.name = '';
        // A reclaim group's name is random per invocation: the one created is the one watched.
        const watched = () => (jobName === '' ? reclaimSeen.name : jobName);
        return routed((method, path, body) => {
            if (method === 'POST' && path === jobsPath(namespace)) {
                const meta = (body as { metadata?: { name?: string; labels?: Record<string, string> } } | undefined)
                    ?.metadata;
                if (jobName === '' && meta?.name?.startsWith('factory-reclaim-')) {
                    reclaimSeen.name = meta.name;
                    reclaimSeen.pair = { ...repoJob, leaseToken: meta.labels?.['factory.lease'] ?? '' };
                }
                if (meta?.name !== undefined && meta.name === watched()) armed = true;
                return;
            }
            if (!armed) return;
            const jobAt = jobPath(namespace, watched());
            if (method === 'DELETE' && path.startsWith(`${secretsBase}/`)) {
                const fault = faults.secret?.(path.slice(secretsBase.length + 1));
                if (fault === 'throws') return Promise.reject(new Error('connection reset by peer'));
                if (fault === 'refused') return { status: 500, body: 'unavailable' };
            }
            if (method === 'DELETE' && path.startsWith(`${jobAt}?`) && faults.jobDelete === 'refused') {
                return { status: 500, body: 'unavailable' };
            }
            if (method === 'GET' && path === jobAt && faults.jobLingers) {
                return { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: {} }) };
            }
            if (method === 'GET' && faults.writerPods && isWriterPodList(path)) {
                return { status: 200, body: JSON.stringify({ items: faults.writerPods }) };
            }
        }, overrides);
    };

    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const build = (request: K8sRequest, steps = fakeSteps()) =>
        supervisedRunner(config, request, async () => {}, { steps: steps.sink, endpoint });

    interface Lifecycle {
        pair: BoardJob;
        jobName: string;
        drive(request: K8sRequest): Promise<void>;
        /** The fakeRequest answers the lifecycle runs against. */
        overrides?: Record<string, unknown>;
    }
    /** The cluster one lifecycle runs on, with `faults` armed once its group's Job is POSTed. */
    const clusterOf = (life: Lifecycle, faults: Faults) =>
        cluster(life === LIFECYCLES['reclaim group'] ? '' : life.jobName, faults, life.overrides);
    const runnerGroup = { pair: repoJob, jobName: runnerJobName(repoJob) };
    const LIFECYCLES: Record<string, Lifecycle> = {
        kill: {
            ...runnerGroup,
            async drive(request) {
                const r = build(request);
                await r.syncCheckout(repoJob, undefined, SESSION_OF);
                await r.kill(repoJob);
            },
        },
        // A group whose Job does not end by itself within the bound: the one `finish` ends destructively.
        finish: {
            ...runnerGroup,
            overrides: { job: { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: {} }) } },
            async drive(request) {
                const r = build(request);
                await r.syncCheckout(repoJob, undefined, SESSION_OF);
                await r.finish(repoJob);
            },
        },
        'failed sync': {
            ...runnerGroup,
            async drive(request) {
                const steps = fakeSteps((step) =>
                    stepOk(step.kind === 'sync' ? '{"ok":false,"reason":"worktree sync failed: no space left"}\n' : '')
                );
                expect((await build(request, steps).syncCheckout(repoJob, undefined, SESSION_OF)).ok).toBe(false);
            },
        },
        'thrown sync': {
            ...runnerGroup,
            async drive(request) {
                const steps = fakeSteps(() => {
                    throw new Error('the step channel closed');
                });
                await expect(build(request, steps).syncCheckout(repoJob, undefined, SESSION_OF)).rejects.toThrow(
                    /step channel closed/
                );
            },
        },
        'reclaim group': {
            get pair() {
                return reclaimSeen.pair;
            },
            get jobName() {
                return reclaimSeen.name;
            },
            async drive(request) {
                const steps = fakeSteps((step) =>
                    stepOk(step.kind === 'reclaim' ? '{"ok":true,"removed":true,"reason":null}\n' : '')
                );
                await build(request, steps).reclaimWorktree(repoJob);
            },
        },
    };
    const lifecycles = Object.entries(LIFECYCLES);

    const secretPaths = (pair: BoardJob) => [`${secretsBase}/${secretName(pair)}`];
    const jobDeletes = (calls: Call[], jobName: string) =>
        calls.flatMap((call, at) =>
            call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, jobName)}?`) ? [at] : []
        );
    const posted = (calls: Call[], jobName: string) =>
        calls.findIndex(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                (call.body as { metadata?: { name?: string } }).metadata?.name === jobName
        );
    const claimDeleted = (calls: Call[]) =>
        calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
    const suspended = (calls: Call[], jobName: string) =>
        calls.some(
            (call) =>
                call.method === 'PATCH' &&
                call.path === jobPath(namespace, jobName) &&
                (call.body as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend === true
        );

    it.each(lifecycles)('%s: deletes both Secrets before the Job, then gives the claim back', async (_n, life) => {
        const { request, calls } = clusterOf(life, {});
        await life.drive(request);

        const after = posted(calls, life.jobName);
        const deletes = jobDeletes(calls, life.jobName).filter((at) => at > after);
        expect(deletes).toHaveLength(1);
        for (const path of secretPaths(life.pair)) {
            const at = calls.findIndex((call, i) => i > after && call.method === 'DELETE' && call.path === path);
            expect(at).toBeGreaterThan(after);
            expect(at).toBeLessThan(deletes[0]!);
        }
        expect(claimDeleted(calls)).toBe(true);
    });

    it.each(lifecycles)(
        '%s: a refused Secret delete suspends the Job, never deletes it, and keeps the claim',
        async (_n, life) => {
            const { request, calls } = clusterOf(life, {
                secret: (name) => (name === secretName(life.pair) ? 'refused' : null),
            });
            await life.drive(request);

            const after = posted(calls, life.jobName);
            expect(jobDeletes(calls, life.jobName).filter((at) => at > after)).toEqual([]);
            expect(suspended(calls, life.jobName)).toBe(true);
            expect(claimDeleted(calls)).toBe(false);
            expect(JSON.parse((await request('GET', claimPathFor(repoJob.id))).body)).toMatchObject({
                data: { holder: repoJob.leaseToken },
            });
        }
    );

    it.each(lifecycles)('%s: Secrets deleted but the Job delete refused is held, the claim kept', async (_n, life) => {
        const { request, calls } = clusterOf(life, { jobDelete: 'refused' });
        await life.drive(request);

        expect(jobDeletes(calls, life.jobName).length).toBeGreaterThan(0);
        expect(suspended(calls, life.jobName)).toBe(false);
        expect(claimDeleted(calls)).toBe(false);
    });

    it.each(lifecycles)(
        '%s: a Job still read through the bound after its delete is held, the claim kept',
        async (_n, life) => {
            const { request, calls } = clusterOf(life, { jobLingers: true });
            await life.drive(request);
            expect(claimDeleted(calls)).toBe(false);
        }
    );

    it.each(lifecycles)(
        '%s: a writer pod still listed after the Job is gone is held, the claim kept',
        async (_n, life) => {
            const { request, calls } = clusterOf(life, { writerPods: [{ metadata: { name: 'a-gate-pod' } }] });
            await life.drive(request);

            // The confirmation asked for this attempt's writer pods by equality: every pod of the pair.
            expect(
                calls.some(
                    (call) =>
                        call.method === 'GET' &&
                        decodeURIComponent(call.path).endsWith(
                            `labelSelector=factory.job=${life.pair.id},factory.lease=${life.pair.leaseToken}`
                        )
                )
            ).toBe(true);
            expect(claimDeleted(calls)).toBe(false);
        }
    );

    it.each(lifecycles)('%s: a transport throw on the Secret delete leaves the Job listed', async (_n, life) => {
        const { request, calls } = clusterOf(life, {
            secret: (name) => (name === secretName(life.pair) ? 'throws' : null),
        });
        await life.drive(request);

        const after = posted(calls, life.jobName);
        expect(jobDeletes(calls, life.jobName).filter((at) => at > after)).toEqual([]);
        expect(suspended(calls, life.jobName)).toBe(true);
        expect(claimDeleted(calls)).toBe(false);
    });

    // A declared service pod mounts no worktree: it never holds the group's end, whatever its lease.
    // A kill whose Secret delete is refused leaves the Job suspended and listed, its supervisor
    // reporting nothing: the run still ends as the kill's at its very next poll.
    it('ends a run as killed within one poll when its kill could not delete the Job', async () => {
        const { request } = cluster(runnerJobName(repoJob), {
            secret: (name) => (name === secretName(repoJob) ? 'refused' : null),
            jobLingers: true,
        });
        let pollsAfterKill = 0;
        let killed = false;
        // Each poll yields to the timers, so the kill below gets its turn while the run polls.
        const sleep = async () => {
            if (killed) pollsAfterKill += 1;
            if (pollsAfterKill > 1) throw new Error('the run polled on past its kill');
            await new Promise((resolve) => setImmediate(resolve));
        };
        const r = supervisedRunner(config, request, sleep, { steps: fakeSteps().sink, endpoint });
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        const running = r.run(repoJob, SESSION_OF);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await r.kill(repoJob);
        killed = true;
        expect(await running).toMatchObject({ exitCode: 137, started: true });
        expect(pollsAfterKill).toBeLessThanOrEqual(1);
    });
});

/*
 * Issue #821, round 4: the checkout claim is released only once its group's end is confirmed —
 * through every lifecycle that outlives the agent (the run, its post-run steps, `finish`), a reclaim
 * retried under the same holder, an orphaned claim's reap, the fence's sweep and a post-create
 * stand-down.
 */
describe('claims of an unconfirmed group (#821)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const SESSION_OF = { id: SESSION, resume: false };
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const endpoint = {
        open: async () => ({ url: 'http://driver:8130', token: 'reclaim-token' }),
        close: () => undefined,
    };
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const build = (request: K8sRequest, steps = fakeSteps()) =>
        supervisedRunner(config, request, async () => {}, { steps: steps.sink, endpoint });
    const claimDeletes = (calls: Call[]) =>
        calls.filter((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
    const holderOf = async (request: K8sRequest) =>
        JSON.parse((await request('GET', claimPathFor(repoJob.id))).body)?.data?.holder as string | undefined;

    // F1: the run, a post-run step (the probe) and the finish all ride one group; a finish whose
    // teardown is refused keeps the claim, and nothing earlier in the lifecycle gave it back.
    it('keeps the claim through run → post-run step → a refused finish', async () => {
        let refuse = false;
        const { request, calls } = routed((method, path) =>
            refuse && method === 'DELETE' && path === `${secretsBase}/${secretName(repoJob)}`
                ? { status: 500, body: 'unavailable' }
                : undefined
        );
        const r = build(request);
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        await r.run(repoJob, SESSION_OF);
        expect(claimDeletes(calls)).toEqual([]);
        await r.probeTree(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        // The loop's hand-back while the group is live keeps it for the group's end.
        await r.releaseFence!(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        refuse = true;
        await r.finish(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        expect(await holderOf(request)).toBe(repoJob.leaseToken);
        // A later hand-back still finds the group unconfirmed: the claim stays.
        await r.releaseFence!(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
    });

    // F1: an agentless attempt's group, created on demand by its first step, gives the claim back
    // at its finish — never right after it was created.
    it('keeps the claim an on-demand group took until that group is finished', async () => {
        const { request, calls } = fakeRequest();
        const r = build(request);
        await r.probeTree(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        expect(await holderOf(request)).toBe(repoJob.leaseToken);
        await r.finish(repoJob);
        expect(claimDeletes(calls)).toHaveLength(1);
    });

    // F4 + step 5: a reclaim whose group could not be confirmed ended keeps the claim through the
    // outer reclaimWorktree's own release; the same driver's retry ends that group first, by the
    // identity it recorded, and refuses while it stays held. Another driver is held off only by a
    // group of the holder still writing: a suspended one is not, and its own group's names differ.
    it('refuses a reclaim retried under the same holder while its earlier group is held, and runs once it ends', async () => {
        // Refused for the first reclaim group's own Secret alone, once it exists.
        let refuse = true;
        let groupDeleted = false;
        let first: { name: string; secret: string } | null = null;
        const { request, calls } = routed((method, path, body) => {
            const meta = (body as { metadata?: { name?: string; labels?: Record<string, string> } } | undefined)
                ?.metadata;
            if (
                method === 'POST' &&
                path === jobsPath(namespace) &&
                meta?.name?.startsWith('factory-reclaim-') &&
                !first
            ) {
                first = {
                    name: meta.name,
                    secret: `${secretsBase}/${secretName({ ...repoJob, leaseToken: meta.labels?.['factory.lease'] ?? '' })}`,
                };
            }
            if (first && method === 'DELETE' && path.startsWith(`${jobPath(namespace, first.name)}?`))
                groupDeleted = true;
            // The held group's Job was suspended, not finished: it reads pending until it is deleted.
            if (first && method === 'GET' && path === jobPath(namespace, first.name) && !groupDeleted) {
                return { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: {} }) };
            }
            return refuse && first && method === 'DELETE' && path === first.secret
                ? { status: 500, body: 'unavailable' }
                : undefined;
        });
        const reclaimed = () =>
            fakeSteps((step) => stepOk(step.kind === 'reclaim' ? '{"ok":true,"removed":true,"reason":null}\n' : ''));
        const posts = () =>
            calls.filter(
                (call) =>
                    call.method === 'POST' &&
                    call.path === jobsPath(namespace) &&
                    (call.body as { metadata: { name: string } }).metadata.name.startsWith('factory-reclaim-')
            ).length;

        const driver = build(request, reclaimed());
        expect(await driver.reclaimWorktree(repoJob)).toMatchObject({ ok: false });
        expect(posts()).toBe(1);
        expect(claimDeletes(calls)).toEqual([]);
        // The same driver, the row offered again: its held group is retried first, and still held.
        expect(await driver.reclaimWorktree(repoJob)).toMatchObject({ ok: false });
        expect(posts()).toBe(1);
        expect(await holderOf(request)).toBe(repoJob.leaseToken);

        // Once the fault clears, the retry ends it by its recorded identity, then reclaims.
        refuse = false;
        expect(await driver.reclaimWorktree(repoJob)).toMatchObject({ ok: true, removed: true });
        expect(posts()).toBe(2);
        expect(claimDeletes(calls)).toHaveLength(1);
        const jobDeletes = calls.filter(
            (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, first!.name)}?`)
        );
        expect(jobDeletes.length).toBeGreaterThan(0);
        expect(jobDeletes.every((call) => (call.body as { preconditions?: unknown } | undefined)?.preconditions)).toBe(
            true
        );
    });

    // Step 6 + F3: the orphaned claim's holder can have left a runner group and a reclaim group;
    // both are derived from the claim alone and confirmed gone before the claim is deleted.
    it('keeps an orphaned claim while its holder still lists writer pods, and reaps it once both groups are gone', async () => {
        let podsLeft = true;
        const { request, calls } = routed((method, path) =>
            method === 'GET' && podsLeft && decodeURIComponent(path).endsWith(`factory.lease=${NEW_TOKEN}`)
                ? { status: 200, body: JSON.stringify({ items: [{ metadata: { name: 'still-writing' } }] }) }
                : undefined
        );
        await request('POST', configmapsPath, {
            metadata: { name: claimName(repoJob) },
            data: { holder: NEW_TOKEN, claimSeq: '3' },
        });
        const read = JSON.parse((await request('GET', claimPathFor(repoJob.id))).body);
        const observed = { uid: read.metadata.uid as string, holder: NEW_TOKEN };
        const r = build(request);

        await expect(r.reapOrphanedClaim!(repoJob, observed)).resolves.toBe(false);
        expect(claimDeletes(calls)).toEqual([]);
        const deletedJob = (jobName: string) =>
            calls.some((call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, jobName)}?`));
        expect(deletedJob(runnerJobName({ ...repoJob, leaseToken: NEW_TOKEN }))).toBe(true);
        // The holder's reclaim groups were looked up by its label: none was listed, so none was ended.
        expect(
            calls.some(
                (call) =>
                    call.method === 'GET' &&
                    call.path.startsWith(`${jobsPath(namespace)}?`) &&
                    decodeURIComponent(call.path).includes(`factory.holder=${NEW_TOKEN}`)
            )
        ).toBe(true);
        expect(calls.some((call) => call.method === 'DELETE' && call.path.includes('factory-reclaim-'))).toBe(false);

        podsLeft = false;
        await expect(r.reapOrphanedClaim!(repoJob, observed)).resolves.toBe(true);
        expect(claimDeletes(calls)).toHaveLength(1);
    });

    // Step 7: the fence's sweep deletes a leftover lease's Secrets, acknowledged, before its Job;
    // a refused one deletes nothing that round and leaves the Job listed for the next.
    it("sweeps a leftover lease's Secrets before its Job, and a refused one leaves the Job for the next round", async () => {
        const OLD = '55555555-5555-4555-8555-555555555555';
        const old = { ...repoJob, leaseToken: OLD };
        const leftover = {
            metadata: {
                name: runnerJobName(old),
                uid: `uid-${runnerJobName(old)}`,
                labels: { 'factory.job': repoJob.id, 'factory.lease': OLD },
            },
        };
        let listed = [leftover];
        let refusals = 1;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path === `${secretsBase}/${secretName(old)}` && refusals > 0) {
                refusals -= 1;
                return { status: 500, body: 'unavailable' };
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, runnerJobName(old))}?`)) {
                listed = [];
                return { status: 200, body: '{}' };
            }
        });

        await build(request).syncCheckout(repoJob, undefined, SESSION_OF);

        const deleteOf = (path: string) =>
            calls.flatMap((call, at) => (call.method === 'DELETE' && call.path === path ? [at] : []));
        const runnerSecret = deleteOf(`${secretsBase}/${secretName(old)}`);
        const jobDelete = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(old))}?`)
        );
        // Round one: the refused Secret, nothing else deleted. Round two: the Secret, then the Job.
        expect(runnerSecret).toHaveLength(2);
        expect(jobDelete).toBeGreaterThan(runnerSecret[1]!);
    });

    // F6: a post-create stand-down ends its own Job the acknowledged way; a delete refused there
    // keeps the claim through the sync's cleanup when that is refused too, and the cleanup's
    // confirmed end gives it back.
    it.each([
        ['keeps the claim when the stand-down and the sync cleanup are both refused', 2, false],
        ['gives the claim back once the sync cleanup confirms the stand-down Job ended', 1, true],
    ] as const)('%s', async (_name, refusedDeletes, released) => {
        let left: number = refusedDeletes;
        let claimReads = 0;
        const serve = claimServer();
        const { request, calls } = routed((method, path, body) => {
            if (path === claimPathFor(repoJob.id) && method === 'GET') {
                claimReads += 1;
                // The post-create verify (the third read, after the acquire's and the pre-create
                // verify's) answers the claim taken over.
                if (claimReads === 3) {
                    return {
                        status: 200,
                        body: JSON.stringify({ metadata: { uid: 'x' }, data: { holder: NEW_TOKEN } }),
                    };
                }
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, runnerJobName(repoJob))}?`) && left > 0) {
                left -= 1;
                return { status: 500, body: 'unavailable' };
            }
            return serve(method, path, body);
        });

        await expect(build(request).syncCheckout(repoJob, undefined, SESSION_OF)).rejects.toThrow(/stands down/);

        expect(
            calls.filter(
                (call) =>
                    call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(repoJob))}?`)
            )
        ).toHaveLength(2);
        expect(claimDeletes(calls)).toHaveLength(released ? 1 : 0);
    });

    // Step 7: adoption deletes the earlier attempt's Secrets, acknowledged, and keeps its Job — the
    // sweep spares a finished agent run — for a later claim should this one be lost.
    it("adopts with the earlier attempt's Secrets deleted and its Job kept", async () => {
        const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const prior = {
            metadata: {
                name: runnerJobName(job),
                uid: `uid-${runnerJobName(job)}`,
                labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                annotations: {
                    'factory.claim-seq': '1',
                    'factory.session': SESSION,
                    'factory.command': commandMark(job.command),
                },
            },
            spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
            status: { startTime: START, succeeded: 1 },
        };
        let listed: unknown[] = [prior];
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`)) {
                listed = [];
                return { status: 200, body: '{}' };
            }
        });

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1 });

        const jobDelete = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`)
        );
        const secretDeletes = calls.flatMap((call, at) =>
            call.method === 'DELETE' && call.path.startsWith(`${secretsBase}/`) ? [at] : []
        );
        expect(secretDeletes.map((at) => calls[at]!.path)).toEqual([`${secretsBase}/${secretName(job)}`]);
        expect(jobDelete).toBe(-1);
    });

    // A held kill leaves a suspended Job: never a finished run for the next claim to adopt.
    it('adopts no runner Job its driver suspended', async () => {
        const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const prior = {
            metadata: {
                name: runnerJobName(job),
                uid: `uid-${runnerJobName(job)}`,
                labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                annotations: {
                    'factory.claim-seq': '1',
                    'factory.session': SESSION,
                    'factory.command': commandMark(job.command),
                },
            },
            spec: {
                suspend: true,
                template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } },
            },
            status: { startTime: START, failed: 1 },
        };
        const { request } = routed((method, path) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? { status: 200, body: JSON.stringify({ items: [prior] }) }
                : undefined
        );
        expect(await runner(request).adopt(adopter)).toBeNull();
    });
});

/*
 * Issue #821 follow-up: a group whose Job ended by itself has no writer left, so `finish` confirms
 * its end without deleting it — its Secrets acknowledged, no live writer pod — and gives the claim
 * back, keeping the finished Job for a replacement claim to adopt should this driver be lost
 * before its verdict lands. Only a group that did not end within the bound is deleted.
 */
describe('finishing a group that ended by itself (#821)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const SESSION_OF = { id: SESSION, resume: false };
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const build = (request: K8sRequest) => supervisedRunner(config, request, async () => {});
    const runnerAt = jobPath(namespace, runnerJobName(repoJob));
    /** The finished runner Job as the label list answers it, its claim's marks on it. */
    const finished = {
        metadata: {
            name: runnerJobName(repoJob),
            uid: `uid-${runnerJobName(repoJob)}`,
            labels: { 'factory.job': repoJob.id, 'factory.lease': repoJob.leaseToken },
            annotations: {
                'factory.claim-seq': '1',
                'factory.session': SESSION,
                'factory.command': commandMark(repoJob.command),
            },
        },
        spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
        status: { startTime: START, succeeded: 1 },
    };
    const writers = (pods: unknown[]) => (method: K8sMethod, path: string) =>
        method === 'GET' && isWriterPodList(path) ? { status: 200, body: JSON.stringify({ items: pods }) } : undefined;
    const jobDeleted = (calls: Call[]) =>
        calls.some((call) => call.method === 'DELETE' && call.path.startsWith(`${runnerAt}?`));
    const claimDeleted = (calls: Call[]) =>
        calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));

    it('keeps the finished Job, deletes its Secrets, gives the claim back, and a replacement claim adopts it', async () => {
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                // The label selector honoured: the attempt's own fence lists every OTHER lease.
                const own = decodeURIComponent(path).includes(`factory.lease!=${repoJob.leaseToken}`);
                return { status: 200, body: JSON.stringify({ items: own || jobDeleted(calls) ? [] : [finished] }) };
            }
        });
        const first = build(request);
        await first.syncCheckout(repoJob, undefined, SESSION_OF);
        await first.finish(repoJob);

        expect(jobDeleted(calls)).toBe(false);
        expect(calls).toContainEqual(
            expect.objectContaining({ method: 'DELETE', path: `${secretsBase}/${secretName(repoJob)}` })
        );
        expect(claimDeleted(calls)).toBe(true);

        // This driver is lost before its verdict: the replacement claim reads the run it left.
        const adopter: BoardJob = { ...repoJob, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        expect(await build(request).adopt(adopter)).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, sessionId: SESSION },
        });
    });

    // Issue #821 (D1), the stated limit: a driver whose board took neither the staged conclusion nor
    // the verdict leaves its group and its checkout claim (no `finish`, no release). The next claim
    // takes the stale claim over — an older claim sequence — and adopts the finished run.
    it('takes a never-released claim over from an older attempt, then adopts the group it left', async () => {
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                const own = decodeURIComponent(path).includes(`factory.lease!=${repoJob.leaseToken}`);
                return { status: 200, body: JSON.stringify({ items: own || jobDeleted(calls) ? [] : [finished] }) };
            }
        });
        await build(request).syncCheckout(repoJob, undefined, SESSION_OF);
        const before = await request('GET', claimPathFor(repoJob.id));
        expect(JSON.parse(before.body)).toMatchObject({ data: { holder: repoJob.leaseToken } });

        const adopter: BoardJob = { ...repoJob, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        expect(await build(request).adopt(adopter)).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, sessionId: SESSION },
        });

        expect(jobDeleted(calls)).toBe(false);
        const held = await request('GET', claimPathFor(repoJob.id));
        expect(JSON.parse(held.body)).toMatchObject({ data: { holder: NEW_TOKEN } });
    });

    it('counts a finished pod as no writer, and keeps the claim while a live one is listed', async () => {
        const done = { metadata: { name: 'gate-done' }, status: { phase: 'Succeeded' } };
        const live = { metadata: { name: 'gate-live' }, status: { phase: 'Running' } };

        const released = routed(writers([done]));
        const r1 = build(released.request);
        await r1.syncCheckout(repoJob, undefined, SESSION_OF);
        await r1.finish(repoJob);
        expect(claimDeleted(released.calls)).toBe(true);

        const held = routed(writers([done, live]));
        const r2 = build(held.request);
        await r2.syncCheckout(repoJob, undefined, SESSION_OF);
        await r2.finish(repoJob);
        expect(jobDeleted(held.calls)).toBe(false);
        expect(claimDeleted(held.calls)).toBe(false);
    });

    it('deletes the Job of a group that did not end within the bound, Secrets first', async () => {
        const { request, calls } = routed(() => undefined, {
            job: { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: {} }) },
        });
        const r = build(request);
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        await r.finish(repoJob);
        const secretAt = calls.findIndex(
            (call) => call.method === 'DELETE' && call.path === `${secretsBase}/${secretName(repoJob)}`
        );
        const jobAt = calls.findIndex((call) => call.method === 'DELETE' && call.path.startsWith(`${runnerAt}?`));
        expect(secretAt).toBeGreaterThanOrEqual(0);
        expect(jobAt).toBeGreaterThan(secretAt);
    });
});

/*
 * Issue #821 review: a Secret never exists without a Job the fence and the reaper can derive it
 * from — the runner and reclaim Jobs are created suspended, their Secret after, and they are
 * resumed only once the post-create verify holds; and a Job create whose answer was lost is
 * reconciled through the acknowledged teardown before the claim goes back.
 */
describe('a Secret is never without its Job (#821)', () => {
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const build = (request: K8sRequest) => supervisedRunner(config, request, async () => {});
    const runnerAt = jobPath(namespace, runnerJobName(job));
    const isRunnerPost = (method: K8sMethod, path: string, body: unknown) =>
        method === 'POST' &&
        path === jobsPath(namespace) &&
        (body as { metadata?: { name?: string } } | undefined)?.metadata?.name === runnerJobName(job);
    const claimDeleted = (calls: Call[]) =>
        calls.some((call) => call.method === 'DELETE' && call.path === claimPathFor(job.id));

    it('creates the runner Job suspended, then its Secret, and resumes it only after the post-create verify', async () => {
        const { request, calls } = fakeRequest();
        await build(request).run(job, { id: SESSION, resume: false });

        const jobPost = calls.findIndex((call) => isRunnerPost(call.method as K8sMethod, call.path, call.body));
        const secretPost = calls.findIndex((call) => call.method === 'POST' && call.path === secretsBase);
        const resume = calls.findIndex(
            (call) =>
                call.method === 'PATCH' &&
                call.path === runnerAt &&
                (call.body as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend === false
        );
        expect((calls[jobPost]!.body as { spec: { suspend?: boolean } }).spec.suspend).toBe(true);
        expect(secretPost).toBeGreaterThan(jobPost);
        const verify = calls.findIndex(
            (call, at) => at > secretPost && call.method === 'GET' && call.path === claimPathFor(job.id)
        );
        expect(verify).toBeGreaterThan(secretPost);
        expect(resume).toBeGreaterThan(verify);
    });

    it('creates no Secret at all when the runner Job create is rejected', async () => {
        const { request, calls } = routed((method, path, body) =>
            isRunnerPost(method, path, body) ? { status: 422, body: '{"kind":"Status"}' } : undefined
        );
        await expect(build(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/422/);
        expect(calls.some((call) => call.method === 'POST' && call.path === secretsBase)).toBe(false);
    });

    it.each([
        ['ends the Job whose create answer was lost, Secrets first, before the claim goes back', false],
        ['keeps the claim when the Job whose create answer was lost cannot be deleted', true],
    ] as const)('%s', async (_name, refuseDelete) => {
        const base = fakeRequest();
        const request: K8sRequest = async (method, path, body) => {
            if (isRunnerPost(method, path, body)) {
                // Accepted by the apiserver, the answer lost on the way back.
                await base.request(method, path, body);
                throw new Error('socket hang up');
            }
            if (refuseDelete && method === 'DELETE' && path.startsWith(`${runnerAt}?`)) {
                base.calls.push({ method, path, body });
                return { status: 500, body: 'unavailable' };
            }
            return base.request(method, path, body);
        };
        await expect(build(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/socket hang up/);

        const jobDelete = base.calls.findIndex(
            (call) => call.method === 'DELETE' && call.path.startsWith(`${runnerAt}?`)
        );
        const secretDelete = base.calls.findIndex(
            (call) => call.method === 'DELETE' && call.path === `${secretsBase}/${secretName(job)}`
        );
        expect(jobDelete).toBeGreaterThanOrEqual(0);
        expect(secretDelete).toBeLessThan(jobDelete);
        expect(claimDeleted(base.calls)).toBe(!refuseDelete);
    });
});

describe('finish retries a teardown left unconfirmed (#821)', () => {
    it('ends a killed group whose Secret delete was refused at the next finish, and only then gives the claim back', async () => {
        const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
        let refusals = 1;
        let groupDeleted = false;
        const groupPath = jobPath(namespace, runnerJobName(repoJob));
        const { request, calls } = routed((method, path) => {
            if (method === 'DELETE' && path.startsWith(`${groupPath}?`)) groupDeleted = true;
            // The held group's Job was suspended, not finished: it reads pending until it is deleted.
            if (method === 'GET' && path === groupPath && !groupDeleted) {
                return { status: 200, body: JSON.stringify({ metadata: { uid: 'job-uid-1' }, status: {} }) };
            }
            if (
                method === 'DELETE' &&
                path === `/api/v1/namespaces/${namespace}/secrets/${secretName(repoJob)}` &&
                refusals > 0
            ) {
                refusals -= 1;
                return { status: 500, body: 'unavailable' };
            }
        });
        const r = supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {}
        );
        await r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false });
        await r.kill(repoJob);
        const claimDeletes = () =>
            calls.filter((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
        expect(claimDeletes()).toEqual([]);

        // The kill took the group out of memory; the loop's finish still finds the held end.
        await r.finish(repoJob);
        expect(
            calls.some(
                (call) =>
                    call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(repoJob))}?`)
            )
        ).toBe(true);
        expect(claimDeletes()).toHaveLength(1);
    });
});

/*
 * Issue #821 review, round 2: a Secret created after its Job carries an owner reference to that
 * Job's uid, so the API server collects it whatever happens to the Job; and only a Job that ran an
 * agent is a run to adopt — a supervisor-only group's is no evidence, and the adopted run's own
 * Job is kept until the verdict lands.
 */
describe('Secrets owned by their Job, and only agent runs adopted (#821)', () => {
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const endpoint = {
        open: async () => ({ url: 'http://driver:8130', token: 'reclaim-token' }),
        close: () => undefined,
    };
    const build = (request: K8sRequest, steps = fakeSteps()) =>
        supervisedRunner(config, request, async () => {}, { steps: steps.sink, endpoint });
    const created = (uid: string) => (method: K8sMethod, path: string) =>
        method === 'POST' && path === jobsPath(namespace)
            ? { status: 201, body: JSON.stringify({ metadata: { uid } }) }
            : undefined;
    const secretPostOf = (calls: Call[]) =>
        calls.find((call) => call.method === 'POST' && call.path === secretsBase)?.body as
            | { metadata: { ownerReferences?: unknown[] } }
            | undefined;

    it("owns the runner Secret by the runner Job's uid", async () => {
        const { request, calls } = routed(created('job-uid-1'));
        await build(request).run(job, { id: SESSION, resume: false });
        expect(secretPostOf(calls)?.metadata.ownerReferences).toEqual([
            { apiVersion: 'batch/v1', kind: 'Job', name: runnerJobName(job), uid: 'job-uid-1' },
        ]);
    });

    it("owns the reclaim group's Secret by the reclaim Job's uid", async () => {
        const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
        const { request, calls } = routed(created('job-uid-2'));
        const steps = fakeSteps((step) =>
            stepOk(step.kind === 'reclaim' ? '{"ok":true,"removed":true,"reason":null}\n' : '')
        );
        await build(request, steps).reclaimWorktree(repoJob);
        const posted = calls.find((call) => call.method === 'POST' && call.path === jobsPath(namespace))?.body as {
            metadata: { name: string };
        };
        expect(posted.metadata.name).toMatch(/^factory-reclaim-/);
        expect(secretPostOf(calls)?.metadata.ownerReferences).toEqual([
            { apiVersion: 'batch/v1', kind: 'Job', name: posted.metadata.name, uid: 'job-uid-2' },
        ]);
    });

    it('creates no Secret for a Job whose create answer names no uid, and ends that Job', async () => {
        const { request, calls } = routed((method, path) =>
            method === 'POST' && path === jobsPath(namespace) ? { status: 201, body: '{}' } : undefined
        );
        await expect(build(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/uid/);
        expect(secretPostOf(calls)).toBeUndefined();
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`)
            )
        ).toBe(true);
    });

    it('stands down on a Job create answered 201 null, with no TypeError and both deletes acknowledged', async () => {
        const { request, calls } = routed((method, path) =>
            method === 'POST' && path === jobsPath(namespace) ? { status: 201, body: 'null' } : undefined
        );
        await expect(build(request).run(job, { id: SESSION, resume: false })).rejects.toThrow(/answered no uid/);
        expect(secretPostOf(calls)).toBeUndefined();
        const deletes = calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
        expect(deletes.some((path) => path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`))).toBe(true);
        expect(deletes.some((path) => path.startsWith(secretsBase))).toBe(true);
    });

    const runnerItem = (lease: string, seq: string, containers: string[]) => ({
        metadata: {
            name: runnerJobName({ ...job, leaseToken: lease }),
            uid: `uid-${runnerJobName({ ...job, leaseToken: lease })}`,
            labels: { 'factory.job': job.id, 'factory.lease': lease },
            annotations: {
                'factory.claim-seq': seq,
                'factory.session': SESSION,
                'factory.command': commandMark(job.command),
            },
        },
        spec: { template: { spec: { containers: containers.map((name) => ({ name })) } } },
        status: { startTime: START, succeeded: 1 },
    });
    const AGENT_RUN = [SUPERVISOR_CONTAINER, AGENT_CONTAINER];

    it('never adopts a supervisor-only Job, whatever its claim sequence', async () => {
        let items = [runnerItem(job.leaseToken, '1', AGENT_RUN), runnerItem(NEW_TOKEN, '2', [SUPERVISOR_CONTAINER])];
        const { request } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items }) };
            }
            // The sweep deletes what is no run to keep: the supervisor-only Job goes.
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                items = items.filter((item) => !path.startsWith(jobPath(namespace, item.metadata.name)));
            }
        });
        const third: BoardJob = {
            ...job,
            leaseToken: '77777777-7777-4777-8777-777777777777',
            attempts: 3,
            claimSeq: 3,
        };
        expect(await build(request).adopt(third)).toMatchObject({ claimSeq: 1 });
    });

    it('keeps the adopted run’s Job until the verdict, and finish deletes the supervisor-only group it made', async () => {
        const adopter: BoardJob = {
            ...job,
            repo: 'Bellows-AI/factory',
            leaseToken: NEW_TOKEN,
            attempts: 2,
            claimSeq: 2,
        };
        const prior = runnerItem(job.leaseToken, '1', AGENT_RUN);
        const priorAt = jobPath(namespace, runnerJobName(job));
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                const gone = calls.some((call) => call.method === 'DELETE' && call.path.startsWith(`${priorAt}?`));
                return { status: 200, body: JSON.stringify({ items: gone ? [] : [prior] }) };
            }
        });
        const r = build(request);
        expect(await r.adopt(adopter)).toMatchObject({ claimSeq: 1 });
        // The post-adoption step runs in a supervisor-only group, which finish ends.
        await r.probeTree(adopter);
        await r.finish(adopter);

        expect(calls.some((call) => call.method === 'DELETE' && call.path.startsWith(`${priorAt}?`))).toBe(false);
        expect(
            calls.some(
                (call) =>
                    call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(adopter))}?`)
            )
        ).toBe(true);
        // Lost before its verdict: the next claim adopts the original run again.
        const third: BoardJob = {
            ...adopter,
            leaseToken: '77777777-7777-4777-8777-777777777777',
            attempts: 3,
            claimSeq: 3,
        };
        expect(await build(request).adopt(third)).toMatchObject({ claimSeq: 1, outcome: { sessionId: SESSION } });
    });
});

/*
 * Issue #821 review, round 3: a finished agent run is kept only for the claim that adopted it and
 * continues its outcome; any fresh sync sweeps it — acknowledged, before the checkout changes — so
 * no later claim adopts an older outcome onto a tree a fresh run has since moved.
 */
describe('a finished run is kept only for the claim that adopted it (#821)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory', leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
    const OLD = job.leaseToken;
    const oldName = runnerJobName({ ...job, leaseToken: OLD });
    const oldAt = jobPath(namespace, oldName);
    const finishedOld = {
        metadata: {
            name: oldName,
            uid: `uid-${oldName}`,
            labels: { 'factory.job': job.id, 'factory.lease': OLD },
            annotations: {
                'factory.claim-seq': '1',
                'factory.session': SESSION,
                'factory.command': commandMark(job.command),
            },
        },
        spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
        status: { startTime: START, succeeded: 1 },
    };
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const harness = (refuseDelete: boolean) => {
        let listed = [finishedOld];
        let syncAt = -1;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path.startsWith(`${oldAt}?`)) {
                if (refuseDelete) return { status: 500, body: 'unavailable' };
                listed = [];
                return { status: 200, body: '{}' };
            }
        });
        const steps = fakeSteps((step) => {
            if (step.kind === 'sync' && syncAt < 0) syncAt = calls.length;
            return stepOk(step.kind === 'sync' ? '{"ok":true,"reason":null}\n' : '');
        });
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        return { r, calls, steps, syncAt: () => syncAt };
    };

    it("sweeps an earlier claim's finished run before a fresh sync touches the checkout", async () => {
        const { r, calls, syncAt } = harness(false);
        // The run is not this claim's to adopt (its command was edited since): a fresh sync follows.
        expect(await r.adopt({ ...repoJob, command: 'an edited command' })).toBeNull();
        expect((await r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).ok).toBe(true);

        const deleted = calls.findIndex((call) => call.method === 'DELETE' && call.path.startsWith(`${oldAt}?`));
        expect(deleted).toBeGreaterThanOrEqual(0);
        expect(syncAt()).toBeGreaterThan(deleted);
    });

    // #869: the sweep spares the adopted Job only on evidence it is the run it read; a listing that
    // shows that Job without its spec or lease is no evidence, and nothing is deleted on it.
    it.each([
        ['no spec', { ...finishedOld, spec: undefined }],
        [
            'no lease label',
            { ...finishedOld, metadata: { ...finishedOld.metadata, labels: { 'factory.job': job.id } } },
        ],
        ['no status', { ...finishedOld, status: undefined }],
        ['an empty status', { ...finishedOld, status: {} }],
        ['no containers', { ...finishedOld, spec: { template: { spec: { containers: [] } } } }],
    ])('deletes nothing and never syncs when the adopted run is listed with %s', async (_name, listing) => {
        let listed: unknown[] = [finishedOld];
        const { request, calls } = routed((method, path) =>
            method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)
                ? { status: 200, body: JSON.stringify({ items: listed }) }
                : undefined
        );
        const steps = fakeSteps(() => stepOk('{"ok":true,"reason":null}\n'));
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        expect(await r.adopt(repoJob)).toMatchObject({ claimSeq: 1 });
        listed = [listing];

        await expect(r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).rejects.toThrow();

        expect(calls.some((call) => call.method === 'DELETE' && call.path.startsWith(`${oldAt}?`))).toBe(false);
        expect(steps.submitted.filter((step) => step.kind === 'sync')).toEqual([]);
    });

    // #869: a round whose Job listing proves nothing spares nothing, so it deletes nothing: the
    // adopted run's pod is never swept for want of the Job read that would have spared it.
    it.each([
        ['a 503', { status: 503, body: 'unavailable' }],
        ['an empty object', { status: 200, body: '{}' }],
        ['truncated JSON', { status: 200, body: '{"items":[' }],
        [
            'the adopted Job with an empty status',
            { status: 200, body: JSON.stringify({ items: [{ ...finishedOld, status: {} }] }) },
        ],
    ])('never deletes a pod of the adopted run when the sweep reads the Jobs as %s', async (_name, jobs) => {
        const pod = {
            metadata: {
                name: `${oldName}-pod`,
                uid: `uid-${oldName}-pod`,
                labels: { 'factory.job': job.id, 'factory.lease': OLD, 'job-name': oldName },
            },
        };
        let sweeping = false;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return sweeping ? jobs : { status: 200, body: JSON.stringify({ items: [finishedOld] }) };
            }
            if (sweeping && method === 'GET' && path.includes('/pods?')) {
                return { status: 200, body: JSON.stringify({ items: [pod] }) };
            }
        });
        const steps = fakeSteps(() => stepOk('{"ok":true,"reason":null}\n'));
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        expect(await r.adopt(repoJob)).toMatchObject({ claimSeq: 1 });
        sweeping = true;

        await expect(r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).rejects.toThrow();

        expect(calls.some((call) => call.method === 'GET' && call.path.includes('/pods?'))).toBe(true);
        // Nothing of the adopted run — its Job or its pod — is deleted.
        const deleted = calls.filter((call) => call.method === 'DELETE').map((call) => call.path);
        expect(deleted.filter((path) => path.includes(oldName))).toEqual([]);
        expect(steps.submitted.filter((step) => step.kind === 'sync')).toEqual([]);
    });

    // #869: a pod of the kept run is spared by its lease, never by its `job-name` label alone — a
    // pod listed without that label is still the adopted run's; one listed with neither cannot say
    // whose it is, and that round deletes nothing.
    it.each([
        ['its job-name label', { 'factory.job': job.id, 'factory.lease': OLD }],
        ['its job-name or lease label', { 'factory.job': job.id }],
    ])('never deletes a pod of the adopted run listed without %s', async (_name, labels) => {
        const pod = { metadata: { name: `${oldName}-pod`, uid: `uid-${oldName}-pod`, labels } };
        // The leftover pod is listed to the sweep only: the adoption read its run before it.
        let sweeping = false;
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: [finishedOld] }) };
            }
            if (sweeping && method === 'GET' && path.includes('/pods?')) {
                return { status: 200, body: JSON.stringify({ items: [pod] }) };
            }
        });
        const steps = fakeSteps(() => stepOk('{"ok":true,"reason":null}\n'));
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        expect(await r.adopt(repoJob)).toMatchObject({ claimSeq: 1 });
        sweeping = true;

        await r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false }).catch(() => undefined);

        expect(calls.some((call) => call.method === 'GET' && call.path.includes('/pods?'))).toBe(true);
        expect(calls.some((call) => call.method === 'DELETE' && call.path.includes(`/pods/${oldName}-pod`))).toBe(
            false
        );
    });

    it('never syncs while that finished run cannot be deleted', async () => {
        const { r, steps } = harness(true);
        await expect(r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).rejects.toThrow();
        expect(steps.submitted.filter((step) => step.kind === 'sync')).toEqual([]);
    });
});

/*
 * Issue #821 review, round 5: a teardown is pending from its first synchronous step, so a
 * concurrent hand-back never releases the claim mid-teardown; a reclaim's teardown names its own
 * incarnation by uid, so a late one never removes the replacement that took the same derived
 * names; and an adoption read is never undone by its finished lease's cleanup.
 */
describe('teardown ownership in time and incarnation (#821)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const SESSION_OF = { id: SESSION, resume: false };
    const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
    const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' });
    const endpoint = {
        open: async () => ({ url: 'http://driver:8130', token: 'reclaim-token' }),
        close: () => undefined,
    };
    const claimDeletes = (calls: Call[]) =>
        calls.filter((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

    it('keeps the claim through a kill whose Secret delete is still pending, against a concurrent hand-back', async () => {
        let unblock!: () => void;
        const blocked = new Promise<void>((resolve) => {
            unblock = resolve;
        });
        const { request, calls } = routed((method, path) =>
            method === 'DELETE' && path === `${secretsBase}/${secretName(repoJob)}`
                ? blocked.then(() => ({ status: 200, body: '{}' }))
                : undefined
        );
        const r = supervisedRunner(config, request, async () => {});
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        const killing = r.kill(repoJob);
        await tick();
        await r.releaseFence!(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        unblock();
        await killing;
        expect(claimDeletes(calls)).toHaveLength(1);
    });

    it('keeps the claim through a finish still waiting on its supervisor, against a concurrent hand-back', async () => {
        let unblock!: () => void;
        const blocked = new Promise<void>((resolve) => {
            unblock = resolve;
        });
        const steps = fakeSteps(async (step) => {
            if (step.kind === 'finish') await blocked;
            return stepOk(step.kind === 'sync' ? '{"ok":true,"reason":null}\n' : '');
        });
        const { request, calls } = fakeRequest();
        const r = supervisedRunner(config, request, async () => {}, { steps: steps.sink });
        await r.syncCheckout(repoJob, undefined, SESSION_OF);
        const finishing = r.finish(repoJob);
        await tick();
        await r.releaseFence!(repoJob);
        expect(claimDeletes(calls)).toEqual([]);
        unblock();
        await finishing;
        expect(claimDeletes(calls)).toHaveLength(1);
    });

    /**
     * A cluster that names every incarnation by uid, honours delete and patch preconditions, and
     * lists a live pod for every Job it holds that has not been deleted: the writers its holder
     * label and its lease select.
     */
    const incarnations = () => {
        const calls: Call[] = [];
        const serve = claimServer();
        const jobs = new Map<string, { uid: string; labels: Record<string, string> }>();
        const secrets = new Map<string, string>();
        let uids = 0;
        let loseNextCreate: 'job' | 'secret' | null = null;
        let failNextCreate: 'job' | 'secret' | null = null;
        const precondition = (body: unknown) =>
            (body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid ??
            (body as { metadata?: { uid?: string } } | undefined)?.metadata?.uid;
        const livePods = (selector: string) => {
            const terms = Object.fromEntries(
                selector
                    .split(',')
                    .filter((term) => term.includes('=') && !term.includes('!'))
                    .map((term) => term.split('=') as [string, string])
            );
            return [...jobs.values()]
                .filter(({ labels }) => Object.entries(terms).every(([key, value]) => labels[key] === value))
                .map((_, at) => ({ metadata: { name: `pod-${at}` }, status: { phase: 'Running' } }));
        };
        const request: K8sRequest = async (method, path, body) => {
            calls.push({ method, path, body });
            const claim = serve(method, path, body);
            if (claim) return claim;
            if (path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                const selector = decodeURIComponent(path.split('labelSelector=')[1] ?? '');
                return { status: 200, body: JSON.stringify({ items: livePods(selector) }) };
            }
            const name = path.split('?')[0]!.split('/').pop()!;
            const isJobs = path.startsWith(jobsPath(namespace));
            const isSecrets = path.startsWith(secretsBase);
            if (!isJobs && !isSecrets) return { status: 404, body: '{}' };
            if (method === 'POST') {
                const kind = isJobs ? 'job' : 'secret';
                if (failNextCreate === kind) {
                    failNextCreate = null;
                    return { status: 500, body: 'unavailable' };
                }
                const uid = `uid-${++uids}`;
                const meta = (body as { metadata: { name: string; labels?: Record<string, string> } }).metadata;
                if (isJobs) jobs.set(meta.name, { uid, labels: meta.labels ?? {} });
                else secrets.set(meta.name, uid);
                if (loseNextCreate === kind) {
                    loseNextCreate = null;
                    throw new Error('socket hang up');
                }
                return { status: 201, body: JSON.stringify({ metadata: { uid } }) };
            }
            if (path.includes('?labelSelector')) {
                const selector = decodeURIComponent(path.split('labelSelector=')[1] ?? '');
                return {
                    status: 200,
                    body: JSON.stringify({
                        items: isJobs
                            ? [...jobs.entries()]
                                  .filter(([, job]) =>
                                      selector
                                          .split(',')
                                          .filter((term) => term.includes('=') && !term.includes('!'))
                                          .every((term) => {
                                              const [key, value] = term.split('=');
                                              return job.labels[key!] === value;
                                          })
                                  )
                                  .map(([jobName, job]) => ({
                                      metadata: { name: jobName, uid: job.uid, labels: job.labels },
                                  }))
                            : [],
                    }),
                };
            }
            const current = isJobs ? jobs.get(name)?.uid : secrets.get(name);
            if (method === 'DELETE' || method === 'PATCH') {
                if (!current) return { status: 404, body: '{}' };
                const want = precondition(body);
                if (want && want !== current) return { status: 409, body: '{"reason":"Conflict"}' };
                if (method === 'DELETE') (isJobs ? jobs : secrets).delete(name);
                return { status: 200, body: '{}' };
            }
            if (isJobs && method === 'GET') {
                // Pending: a Job whose end went unconfirmed was suspended, never finished, and its pods still run.
                return current
                    ? { status: 200, body: JSON.stringify({ metadata: { uid: current }, status: {} }) }
                    : { status: 404, body: '{}' };
            }
            return { status: 404, body: '{}' };
        };
        const reclaimNames = () => [...jobs.keys()].filter((name) => name.startsWith('factory-reclaim-'));
        return {
            request,
            calls,
            jobs,
            secrets,
            reclaimNames,
            loseCreate: (kind: 'job' | 'secret') => {
                loseNextCreate = kind;
            },
            failCreate: (kind: 'job' | 'secret') => {
                failNextCreate = kind;
            },
        };
    };

    /** A step channel whose reclaim step and finish wait until released. */
    const gated = (stdout = '{"ok":true,"removed":true,"reason":null}\n') => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let finishRelease!: () => void;
        const finishHeld = new Promise<void>((resolve) => {
            finishRelease = resolve;
        });
        let holdFinish = false;
        const steps = fakeSteps(async (step) => {
            if (step.kind === 'reclaim') await held;
            if (step.kind === 'finish' && holdFinish) await finishHeld;
            return stepOk(step.kind === 'reclaim' ? stdout : '');
        });
        return {
            steps,
            release,
            holdFinish: () => {
                holdFinish = true;
            },
            releaseFinish: finishRelease,
        };
    };
    const reclaimRunner = (request: K8sRequest, steps: ReturnType<typeof fakeSteps>) =>
        supervisedRunner(config, request, async () => {}, { steps: steps.sink, endpoint });
    const reclaimed = () =>
        fakeSteps((step) => stepOk(step.kind === 'reclaim' ? '{"ok":true,"removed":true,"reason":null}\n' : ''));
    /** The reclaim Job a call list created, and the (job, lease) pair its Secrets are named by. */
    const reclaimPosted = (calls: Call[]) => {
        const body = calls.find(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                (call.body as { metadata: { name: string } }).metadata.name.startsWith('factory-reclaim-')
        )?.body as { metadata: { name: string; labels: Record<string, string> } } | undefined;
        if (!body) return;
        return { name: body.metadata.name, pair: { ...repoJob, leaseToken: body.metadata.labels['factory.lease']! } };
    };

    it('refuses a second reclaim of the same row while the first one’s group still writes, touching none of it', async () => {
        const cluster = incarnations();
        const first = gated();
        const late = reclaimRunner(cluster.request, first.steps).reclaimWorktree(repoJob);
        while (!first.steps.submitted.some((step) => step.kind === 'reclaim')) await tick();
        const [live] = cluster.reclaimNames();
        const posted = reclaimPosted(cluster.calls)!;
        const liveSecret = cluster.secrets.get(secretName(posted.pair));

        // The row offered again, to another driver: a pod of a group serving the same holder is live.
        const before = cluster.calls.length;
        expect(await reclaimRunner(cluster.request, gated().steps).reclaimWorktree(repoJob)).toMatchObject({
            ok: false,
        });
        expect(
            cluster.calls
                .slice(before)
                .filter(
                    (call) => call.method === 'DELETE' || (call.method === 'POST' && call.path === jobsPath(namespace))
                )
        ).toEqual([]);
        expect(cluster.jobs.get(live!)).toBeDefined();
        expect(cluster.secrets.get(secretName(posted.pair))).toBe(liveSecret);

        first.release();
        expect(await late).toMatchObject({ ok: true });
        expect(cluster.reclaimNames()).toEqual([]);
        expect(claimDeletes(cluster.calls)).toHaveLength(1);
    });

    it('gives every reclaim invocation names of its own, labelled with the holder it serves', async () => {
        const cluster = incarnations();
        await reclaimRunner(cluster.request, reclaimed()).reclaimWorktree(repoJob);
        await reclaimRunner(cluster.request, reclaimed()).reclaimWorktree(repoJob);
        const posts = cluster.calls.filter(
            (call) =>
                call.method === 'POST' &&
                call.path === jobsPath(namespace) &&
                (call.body as { metadata: { name: string } }).metadata.name.startsWith('factory-reclaim-')
        );
        const names = posts.map((call) => (call.body as { metadata: { name: string } }).metadata.name);
        expect(new Set(names).size).toBe(2);
        for (const call of posts) {
            const body = call.body as {
                metadata: { labels: Record<string, string> };
                spec: { template: { metadata: { labels: Record<string, string> } } };
            };
            expect(body.metadata.labels['factory.holder']).toBe(repoJob.leaseToken);
            expect(body.spec.template.metadata.labels['factory.holder']).toBe(repoJob.leaseToken);
        }
    });

    it('keeps the uid fences on a retry after a held end', async () => {
        const cluster = incarnations();
        let refuse = true;
        const request: K8sRequest = (method, path, body) =>
            refuse &&
            method === 'DELETE' &&
            path.startsWith(`${secretsBase}/factory-job-`) &&
            !path.includes(repoJob.leaseToken)
                ? Promise.resolve({ status: 500, body: 'unavailable' })
                : cluster.request(method, path, body);
        const r = reclaimRunner(request, reclaimed());
        expect(await r.reclaimWorktree(repoJob)).toMatchObject({ ok: false });
        const [name] = cluster.reclaimNames();
        const uid = cluster.jobs.get(name!)!.uid;
        refuse = false;

        expect(await r.reclaimWorktree(repoJob)).toMatchObject({ ok: true });
        const jobDelete = cluster.calls.find(
            (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, name!)}?`)
        );
        expect(jobDelete?.body).toEqual({ apiVersion: 'v1', kind: 'DeleteOptions', preconditions: { uid } });
    });

    it.each(['refused', 'lost'] as const)(
        'ends the reclaim Job by its uid when the Secret create after it was %s',
        async (how) => {
            const cluster = incarnations();
            if (how === 'refused') cluster.failCreate('secret');
            else cluster.loseCreate('secret');
            expect(await reclaimRunner(cluster.request, reclaimed()).reclaimWorktree(repoJob)).toMatchObject({
                ok: false,
            });
            const posted = reclaimPosted(cluster.calls)!;
            const jobDelete = cluster.calls.find(
                (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, posted.name)}?`)
            );
            expect((jobDelete?.body as { preconditions?: { uid?: string } } | undefined)?.preconditions?.uid).toMatch(
                /^uid-/
            );
            expect(cluster.reclaimNames()).toEqual([]);
            expect(claimDeletes(cluster.calls)).toHaveLength(1);
        }
    );

    it('ends its own reclaim Job whose create answer was lost: its name is its own alone', async () => {
        const cluster = incarnations();
        cluster.loseCreate('job');
        expect(await reclaimRunner(cluster.request, reclaimed()).reclaimWorktree(repoJob)).toMatchObject({ ok: false });
        expect(cluster.reclaimNames()).toEqual([]);
        expect(claimDeletes(cluster.calls)).toHaveLength(1);
    });

    it('never resumes a reclaim Job once the checkout claim it took was replaced, nor releases the replacement', async () => {
        const cluster = incarnations();
        let swapped = false;
        const request: K8sRequest = async (method, path, body) => {
            const answer = await cluster.request(method, path, body);
            const posted = (body as { metadata?: { name?: string } } | undefined)?.metadata?.name;
            if (
                !swapped &&
                method === 'POST' &&
                path === jobsPath(namespace) &&
                posted?.startsWith('factory-reclaim-')
            ) {
                // Delayed past a lease expiry: the row's other driver released and retook the claim.
                swapped = true;
                await cluster.request('DELETE', claimPathFor(repoJob.id));
                await cluster.request('POST', configmapsPath, {
                    metadata: { name: claimName(repoJob) },
                    data: { holder: repoJob.leaseToken, claimSeq: '1' },
                });
            }
            return answer;
        };
        const steps = reclaimed();
        expect(await reclaimRunner(request, steps).reclaimWorktree(repoJob)).toMatchObject({ ok: false });

        expect(
            cluster.calls.some(
                (call) =>
                    call.method === 'PATCH' &&
                    (call.body as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend === false
            )
        ).toBe(false);
        expect(steps.submitted.filter((step) => step.kind === 'reclaim')).toEqual([]);
        expect(cluster.reclaimNames()).toEqual([]);
        // The replacement's claim — same holder, another incarnation — is still there.
        const claim = await cluster.request('GET', claimPathFor(repoJob.id));
        expect(claim.status).toBe(200);
        expect(JSON.parse(claim.body).metadata.uid).not.toBe('claim-uid-1');
    });

    // Per-acquisition reclaim ownership (#821): a row re-offered after its lease ran out is a
    // different acquisition with a token of its own, so the first one's checkout claim fences it.
    it('stands a second acquisition of the row down on the first one’s claim, touching nothing of it', async () => {
        const cluster = incarnations();
        const first = gated();
        const late = reclaimRunner(cluster.request, first.steps).reclaimWorktree(repoJob);
        while (!first.steps.submitted.some((step) => step.kind === 'reclaim')) await tick();

        const before = cluster.calls.length;
        expect(
            await reclaimRunner(cluster.request, gated().steps).reclaimWorktree({ ...repoJob, leaseToken: NEW_TOKEN })
        ).toMatchObject({ ok: false });
        expect(
            cluster.calls
                .slice(before)
                .filter(
                    (call) => call.method === 'DELETE' || (call.method === 'POST' && call.path === jobsPath(namespace))
                )
        ).toEqual([]);

        first.release();
        expect(await late).toMatchObject({ ok: true });
        expect(claimDeletes(cluster.calls)).toHaveLength(1);
    });

    /** The cluster above, but a Job has a pod only once it is resumed — a suspended Job has none. */
    const podsOnResume = (cluster: ReturnType<typeof incarnations>) => {
        const resumed = new Set<string>();
        const resumes: { name: string; status: number }[] = [];
        const request: K8sRequest = async (method, path, body) => {
            if (method === 'GET' && path.startsWith(`/api/v1/namespaces/${namespace}/pods?`)) {
                cluster.calls.push({ method, path, body });
                const terms = decodeURIComponent(path.split('labelSelector=')[1] ?? '')
                    .split(',')
                    .filter((term) => term.includes('=') && !term.includes('!'))
                    .map((term) => term.split('=') as [string, string]);
                const items = [...cluster.jobs.entries()]
                    .filter(
                        ([name, job]) => resumed.has(name) && terms.every(([key, value]) => job.labels[key] === value)
                    )
                    .map(([name]) => ({ metadata: { name: `${name}-pod` }, status: { phase: 'Running' } }));
                return { status: 200, body: JSON.stringify({ items }) };
            }
            const answer = await cluster.request(method, path, body);
            if (method === 'PATCH' && (body as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend === false) {
                const name = path.split('?')[0]!.split('/').pop()!;
                resumes.push({ name, status: answer.status });
                if (answer.status < 300) resumed.add(name);
            }
            return answer;
        };
        return { request, resumes };
    };
    const claimOf = async (request: K8sRequest) => {
        const read = JSON.parse((await request('GET', claimPathFor(repoJob.id))).body);
        return {
            observed: { uid: read.metadata.uid as string, holder: repoJob.leaseToken },
            annotations: (read.metadata.annotations ?? {}) as Record<string, string>,
        };
    };
    const reaper = { ...repoJob, leaseToken: NEW_TOKEN };
    const callIndex = (calls: Call[], match: (call: Call) => boolean) => calls.findIndex(match);

    // The orphaned-claim reap revokes the claim before it lists the holder's groups (#821), and a
    // reclaim verifies the claim unrevoked before its group may start: every group of the stale
    // holder that can still be resumed existed before the reaper's list, and is ended before the
    // claim goes.
    it.each(['between its create and its verify', 'between its verify and its resume'] as const)(
        'ends a stale acquisition’s group the reaper meets %s, and that group never runs',
        async (window) => {
            const cluster = incarnations();
            const pods = podsOnResume(cluster);
            let release!: () => void;
            const held = new Promise<void>((resolve) => {
                release = resolve;
            });
            let paused = false;
            const at = (method: K8sMethod, path: string, body: unknown) =>
                window === 'between its create and its verify'
                    ? method === 'GET' &&
                      path === claimPathFor(repoJob.id) &&
                      reclaimPosted(cluster.calls) !== undefined
                    : method === 'PATCH' &&
                      (body as { spec?: { suspend?: boolean } } | undefined)?.spec?.suspend === false;
            const staleRequest: K8sRequest = async (method, path, body) => {
                if (!paused && at(method, path, body)) {
                    paused = true;
                    await held;
                }
                return pods.request(method, path, body);
            };
            const stale = reclaimed();
            const staleRun = reclaimRunner(staleRequest, stale).reclaimWorktree(repoJob);
            while (!paused) await tick();

            const { observed } = await claimOf(cluster.request);
            const before = cluster.calls.length;
            expect(await reclaimRunner(pods.request, reclaimed()).reapOrphanedClaim!(reaper, observed)).toBe(true);
            const reap = cluster.calls.slice(before);
            const posted = reclaimPosted(cluster.calls)!;
            const revoke = callIndex(reap, (call) => call.method === 'PATCH' && call.path === claimPathFor(repoJob.id));
            const listed = callIndex(
                reap,
                (call) =>
                    call.method === 'GET' &&
                    call.path.startsWith(`${jobsPath(namespace)}?`) &&
                    decodeURIComponent(call.path).includes(`factory.holder=${repoJob.leaseToken}`)
            );
            const ended = callIndex(
                reap,
                (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, posted.name)}?`)
            );
            const claimDeleted = callIndex(
                reap,
                (call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id)
            );
            expect(reap[revoke]?.body).toEqual({
                metadata: { uid: observed.uid, annotations: { 'factory.revoked': NEW_TOKEN } },
            });
            expect(revoke).toBeGreaterThanOrEqual(0);
            expect(listed).toBeGreaterThan(revoke);
            expect(ended).toBeGreaterThan(listed);
            expect(claimDeleted).toBeGreaterThan(ended);

            release();
            expect(await staleRun).toMatchObject({ ok: false });
            expect(pods.resumes.filter((resume) => resume.status < 300)).toEqual([]);
            expect(stale.submitted.filter((step) => step.kind === 'reclaim')).toEqual([]);
        }
    );

    it('refuses to start a group whose claim the reaper revoked after listing nothing of it', async () => {
        const cluster = incarnations();
        const pods = podsOnResume(cluster);
        let releaseCreate!: () => void;
        const createHeld = new Promise<void>((resolve) => {
            releaseCreate = resolve;
        });
        let creating = false;
        const staleRequest: K8sRequest = async (method, path, body) => {
            const name = (body as { metadata?: { name?: string } } | undefined)?.metadata?.name;
            if (
                !creating &&
                method === 'POST' &&
                path === jobsPath(namespace) &&
                name?.startsWith('factory-reclaim-')
            ) {
                creating = true;
                await createHeld;
            }
            return pods.request(method, path, body);
        };
        let releaseReap!: () => void;
        const reapHeld = new Promise<void>((resolve) => {
            releaseReap = resolve;
        });
        let listed = false;
        const reaperRequest: K8sRequest = async (method, path, body) => {
            const answer = await pods.request(method, path, body);
            if (
                !listed &&
                method === 'GET' &&
                path.startsWith(`${jobsPath(namespace)}?`) &&
                decodeURIComponent(path).includes(`factory.holder=${repoJob.leaseToken}`)
            ) {
                listed = true;
                await reapHeld;
            }
            return answer;
        };
        const stale = reclaimed();
        const staleRun = reclaimRunner(staleRequest, stale).reclaimWorktree(repoJob);
        while (!creating) await tick();
        const { observed } = await claimOf(cluster.request);
        const reaping = reclaimRunner(reaperRequest, reclaimed()).reapOrphanedClaim!(reaper, observed);
        while (!listed) await tick();

        // The stale acquisition's create lands after the reaper's list: only the revoke stops it.
        releaseCreate();
        expect(await staleRun).toMatchObject({ ok: false });
        releaseReap();
        await reaping;

        expect(pods.resumes).toEqual([]);
        expect(stale.submitted.filter((step) => step.kind === 'reclaim')).toEqual([]);
        expect(cluster.reclaimNames()).toEqual([]);
    });

    it('reaps nothing when its revoke is refused: the claim was replaced since it was read', async () => {
        const cluster = incarnations();
        await cluster.request('POST', configmapsPath, {
            metadata: { name: claimName(repoJob) },
            data: { holder: repoJob.leaseToken, claimSeq: '1' },
        });
        const { observed } = await claimOf(cluster.request);
        const before = cluster.calls.length;

        expect(
            await reclaimRunner(cluster.request, reclaimed()).reapOrphanedClaim!(reaper, {
                ...observed,
                uid: 'claim-uid-replaced',
            })
        ).toBe(false);

        const reap = cluster.calls.slice(before);
        expect(reap.filter((call) => call.method === 'DELETE')).toEqual([]);
        expect(reap.some((call) => call.method === 'GET' && call.path.startsWith(`${jobsPath(namespace)}?`))).toBe(
            false
        );
        expect((await claimOf(cluster.request)).annotations).toEqual({});
    });

    it('answers a read adoption whose finished lease left services whose Secrets cannot be deleted', async () => {
        const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 2, claimSeq: 2 };
        const prior = {
            metadata: {
                name: runnerJobName(job),
                uid: `uid-${runnerJobName(job)}`,
                labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                annotations: {
                    'factory.claim-seq': '1',
                    'factory.session': SESSION,
                    'factory.command': commandMark(job.command),
                },
            },
            spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
            status: { startTime: START, succeeded: 1 },
        };
        let services = [
            {
                metadata: {
                    name: 'factory-svc-left',
                    uid: 'uid-svc-left',
                    labels: { 'factory.job': job.id, 'factory.lease': job.leaseToken },
                },
            },
        ];
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: [prior] }) };
            }
            if (method === 'GET' && path.startsWith(`/api/v1/namespaces/${namespace}/services?`)) {
                return { status: 200, body: JSON.stringify({ items: services }) };
            }
            if (method === 'DELETE' && path.startsWith(`/api/v1/namespaces/${namespace}/services/`)) {
                services = [];
                return { status: 200, body: '{}' };
            }
            if (method === 'DELETE' && path.startsWith(`${secretsBase}/`)) return { status: 503, body: 'unavailable' };
        });

        expect(await runner(request).adopt(adopter)).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0 } });
        expect(
            calls.some(
                (call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, runnerJobName(job))}?`)
            )
        ).toBe(false);
    });

    it('stands an adoption down, never rerunning, when an earlier writer cannot be confirmed gone', async () => {
        const adopter: BoardJob = { ...job, leaseToken: NEW_TOKEN, attempts: 3, claimSeq: 3 };
        const OTHER = '55555555-5555-4555-8555-555555555555';
        const runnerItem = (lease: string, seq: string, status: Record<string, unknown>) => ({
            metadata: {
                name: runnerJobName({ ...job, leaseToken: lease }),
                uid: `uid-${runnerJobName({ ...job, leaseToken: lease })}`,
                labels: { 'factory.job': job.id, 'factory.lease': lease },
                annotations: {
                    'factory.claim-seq': seq,
                    'factory.session': SESSION,
                    'factory.command': commandMark(job.command),
                },
            },
            spec: { template: { spec: { containers: [{ name: SUPERVISOR_CONTAINER }, { name: AGENT_CONTAINER }] } } },
            status: { startTime: START, ...status },
        });
        const items = [runnerItem(job.leaseToken, '1', { succeeded: 1 }), runnerItem(OTHER, '2', { active: 1 })];
        const { request } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items }) };
            }
            if (
                method === 'DELETE' &&
                path.startsWith(`${jobPath(namespace, runnerJobName({ ...job, leaseToken: OTHER }))}?`)
            ) {
                return { status: 503, body: 'unavailable' };
            }
        });
        await expect(runner(request).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
    });
});

describe('the sweep deletes the incarnations it listed (#821)', () => {
    it('deletes a leftover Job by its listed uid, its Secrets first', async () => {
        const OLD = '55555555-5555-4555-8555-555555555555';
        const reclaimLeft = 'factory-reclaim-0123456789abcdef';
        let listed = [
            {
                metadata: {
                    name: runnerJobName({ ...job, leaseToken: OLD }),
                    uid: 'old-uid',
                    labels: { 'factory.job': job.id, 'factory.lease': OLD },
                },
            },
            {
                metadata: {
                    name: reclaimLeft,
                    uid: 'reclaim-uid',
                    labels: { 'factory.job': job.id, 'factory.lease': NEW_TOKEN },
                },
            },
        ];
        const { request, calls } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                return { status: 200, body: JSON.stringify({ items: listed }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobsPath(namespace)}/`)) {
                listed = listed.filter((item) => !path.startsWith(jobPath(namespace, item.metadata.name)));
                return { status: 200, body: '{}' };
            }
        });
        await runner(request).run(job, { id: SESSION, resume: false });
        const del = (name: string) =>
            calls.find((call) => call.method === 'DELETE' && call.path.startsWith(`${jobPath(namespace, name)}?`));
        expect(del(runnerJobName({ ...job, leaseToken: OLD }))?.body).toMatchObject({
            preconditions: { uid: 'old-uid' },
        });
        expect(del(reclaimLeft)?.body).toMatchObject({ preconditions: { uid: 'reclaim-uid' } });
        const secretsBase = `/api/v1/namespaces/${namespace}/secrets`;
        // A reclaim group's names are its invocation's own (random lease): its Secret goes too.
        expect(
            calls.some(
                (call) =>
                    call.method === 'DELETE' &&
                    call.path === `${secretsBase}/${secretName({ ...job, leaseToken: NEW_TOKEN })}`
            )
        ).toBe(true);
        expect(
            calls.some(
                (call) =>
                    call.method === 'DELETE' &&
                    call.path === `${secretsBase}/${secretName({ ...job, leaseToken: OLD })}`
            )
        ).toBe(true);
    });
});

/*
 * Issue #821 review, round 7: a 409 on a uid precondition means another incarnation now holds the
 * name — never that what blocks the checkout is gone. The sweep lists again, and only a fresh,
 * conclusive empty list lets the sync start.
 */
describe('the sweep proceeds only on a fresh empty list (#821)', () => {
    it('never syncs while a leftover recreated between its list and its delete is still there', async () => {
        const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
        const leftover = {
            metadata: {
                name: 'factory-reclaim-0123456789abcdef',
                uid: 'listed-uid',
                labels: { 'factory.job': job.id, 'factory.lease': NEW_TOKEN },
            },
        };
        const { request } = routed((method, path) => {
            if (method === 'GET' && path.startsWith(`${jobsPath(namespace)}?`)) {
                // Recreated each time it is deleted: the list keeps answering an incarnation.
                return { status: 200, body: JSON.stringify({ items: [leftover] }) };
            }
            if (method === 'DELETE' && path.startsWith(`${jobPath(namespace, leftover.metadata.name)}?`)) {
                return { status: 409, body: '{"reason":"Conflict"}' };
            }
        });
        const steps = fakeSteps();
        const r = supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {},
            { steps: steps.sink }
        );
        await expect(r.syncCheckout(repoJob, undefined, { id: SESSION, resume: false })).rejects.toThrow();
        expect(steps.submitted.filter((step) => step.kind === 'sync')).toEqual([]);
    });
});

/*
 * Issue #821 review, round 8: `ended` comes only from the writer-pod confirmation — a Job gone
 * with a pod of it still live is no end — and every mutation of a created Job names its uid.
 */
describe('one end, one identity (#821)', () => {
    it('resumes the runner Job by the uid its create answered', async () => {
        const { request, calls } = fakeRequest();
        await runner(request).run(job, { id: SESSION, resume: false });
        const resume = calls.find(
            (call) =>
                call.method === 'PATCH' &&
                call.path === jobPath(namespace, runnerJobName(job)) &&
                (call.body as { spec?: { suspend?: boolean } }).spec?.suspend === false
        );
        expect(resume?.body).toEqual({ metadata: { uid: 'job-uid-1' }, spec: { suspend: false } });
    });

    it('keeps an orphaned claim while a reclaim pod of its holder still runs, its Job already gone', async () => {
        const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
        let running = true;
        const { request, calls } = routed((method, path) => {
            const selector = decodeURIComponent(path);
            if (
                method === 'GET' &&
                running &&
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                selector.includes(`factory.holder=${NEW_TOKEN}`)
            ) {
                return {
                    status: 200,
                    body: JSON.stringify({
                        items: [{ metadata: { name: 'reclaim-pod' }, status: { phase: 'Running' } }],
                    }),
                };
            }
        });
        await request('POST', configmapsPath, {
            metadata: { name: claimName(repoJob) },
            data: { holder: NEW_TOKEN, claimSeq: '3' },
        });
        const read = JSON.parse((await request('GET', claimPathFor(repoJob.id))).body);
        const observed = { uid: read.metadata.uid as string, holder: NEW_TOKEN };
        const r = supervisedRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace, RUNNER_SERVICES: '0' }),
            request,
            async () => {}
        );
        const claimDeletes = () =>
            calls.filter((call) => call.method === 'DELETE' && call.path === claimPathFor(repoJob.id));

        await expect(r.reapOrphanedClaim!(repoJob, observed)).resolves.toBe(false);
        expect(claimDeletes()).toEqual([]);
        running = false;
        await expect(r.reapOrphanedClaim!(repoJob, observed)).resolves.toBe(true);
    });
});

/*
 * Issue #824 D11, the kubernetes half: the group's pod tells why it cannot start through its
 * containers' waiting reasons and messages, and the wait for its supervisor answers the proven
 * cause — read the same way docker reads its daemon's words.
 */
describe('how a refused group start ends, on kubernetes (the startup conformance table, #824 D11)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const SESSION_OF = { id: SESSION, resume: false };
    const pulled = (detail: string) =>
        `rpc error: code = Unknown desc = failed to pull and unpack image "registry.example/claude-executor:latest": ${detail}`;
    const waitingPod = (reason: string, message?: string) => ({
        metadata: { name: podName },
        status: {
            phase: 'Pending',
            containerStatuses: [{ name: 'supervisor', state: { waiting: message ? { reason, message } : { reason } } }],
        },
    });
    /** The kubelet's own reason and words for each refusal, on the group pod's supervisor container. */
    const refusals: Record<
        Exclude<StartupRow, typeof MISMATCH_ROW | typeof SILENT_ROW>,
        ReturnType<typeof waitingPod>
    > = {
        'the platform never brought the group up': waitingPod('ContainerCreating'),
        'a registry that timed out': waitingPod(
            'ErrImagePull',
            pulled(
                'failed to do request: Head "https://registry.example/v2/claude-executor/manifests/latest": dial tcp 10.0.0.1:443: i/o timeout'
            )
        ),
        'a registry rate limit': waitingPod(
            'ErrImagePull',
            pulled('unexpected status code: 429 Too Many Requests - Server message: toomanyrequests: rate limit')
        ),
        'a TLS handshake that timed out': waitingPod(
            'ErrImagePull',
            pulled('failed to do request: Head "https://registry.example/v2/": net/http: TLS handshake timeout')
        ),
        'a missing image': waitingPod(
            'ErrImagePull',
            'rpc error: code = NotFound desc = failed to pull and unpack image "registry.example/claude-executor:latest": failed to resolve reference "registry.example/claude-executor:latest": registry.example/claude-executor:latest: not found'
        ),
        'an invalid image reference': waitingPod(
            'InvalidImageName',
            'Failed to apply default image tag "Registry.Example//claude": couldn\'t parse image reference'
        ),
        'an unauthorized pull': waitingPod(
            'ErrImagePull',
            pulled('failed to authorize: failed to fetch anonymous token: unexpected status: 401 Unauthorized')
        ),
        'an untrusted registry certificate': waitingPod(
            'ErrImagePull',
            pulled('tls: failed to verify certificate: x509: certificate signed by unknown authority')
        ),
        'a container configuration the platform refuses': waitingPod(
            'CreateContainerConfigError',
            'secret "factory-env-x" not found'
        ),
        'a refusal whose words prove no cause': waitingPod(
            'ErrImagePull',
            'rpc error: code = Unknown desc = something the kubelet has never said before'
        ),
    };
    /** The group pod's lists answer `pods` in turn (the last one repeats); every other call as the fake does. */
    const podsInTurn = (pods: unknown[]) => {
        const base = fakeRequest();
        let reads = 0;
        const request: K8sRequest = async (method, path, body) => {
            if (
                method === 'GET' &&
                path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
                decodeURIComponent(path).includes('job-name=')
            ) {
                const pod = pods[Math.min(reads, pods.length - 1)];
                reads += 1;
                return { status: 200, body: JSON.stringify({ items: pod === undefined ? [] : [pod] }) };
            }
            return base.request(method, path, body);
        };
        return { request, reads: () => reads };
    };
    const runningPod = {
        metadata: { name: podName },
        status: { phase: 'Running', containerStatuses: [{ name: 'supervisor', state: { running: {} } }] },
    };
    /** The sync of a group whose supervisor never answers: what it threw, or null. */
    const refusedSync = (request: K8sRequest): Promise<unknown> => {
        const steps = fakeSteps();
        steps.sink.contacted = () => false;
        return runner(request, {}, undefined, steps.sink)
            .syncCheckout(repoJob, undefined, SESSION_OF)
            .then(
                () => null,
                (e: unknown) => e
            );
    };

    const startups: Record<StartupRow, () => Promise<unknown>> = {
        ...(Object.fromEntries(
            Object.entries(refusals).map(([row, pod]) => [row, () => refusedSync(podsInTurn([pod]).request)])
        ) as Record<Exclude<StartupRow, typeof MISMATCH_ROW | typeof SILENT_ROW>, () => Promise<unknown>>),
        [SILENT_ROW]: () => refusedSync(podsInTurn([runningPod]).request),
        [MISMATCH_ROW]: async () => {
            const r = runner(fakeRequest().request, {}, undefined, fakeSteps().sink);
            await r.syncCheckout(repoJob, undefined, SESSION_OF);
            return r.run(repoJob, { id: OTHER_SESSION, resume: false }).then(
                () => null,
                (e: unknown) => e
            );
        },
    };

    it.each(STARTUP_ROWS)('%s: %s', async (row, expected) => {
        const thrown = await startups[row]();
        expect(thrown).not.toBeNull();
        expect(startupDecisionOf(thrown)).toBe(expected);
    });

    // A back-off names no cause of its own: the wait reads on until the pull's own failure says one.
    it('reads past a back-off that names no cause, to the pull failure that does', async () => {
        const backOff = waitingPod(
            'ImagePullBackOff',
            'Back-off pulling image "registry.example/claude-executor:latest"'
        );
        const pods = podsInTurn([backOff, backOff, refusals['a missing image']]);
        const thrown = await refusedSync(pods.request);
        expect(thrown).toBeInstanceOf(StartupRefused);
        expect(thrown).toMatchObject({ startupCause: 'image' });
        expect(pods.reads()).toBe(3);
    });

    // A supervisor that runs and never answers is no evidence the platform is still bringing the
    // group up: it is no transient refusal, and the sync is left to the lease as before.
    it('reads no transient cause from a supervisor that runs and never answers', async () => {
        const thrown = await refusedSync(podsInTurn([runningPod]).request);
        expect(thrown).toBeInstanceOf(Error);
        expect(startupDecisionOf(thrown)).toBe('unclassified');
        expect((thrown as Error).message).toMatch(/never came up/);
    });

    // A driver kill ends the wait at once (#828 D4): a killed attempt's group is no longer worth waiting for.
    it('stops waiting for a supervisor once the job was killed during the first pod read', async () => {
        const pods = podsInTurn([waitingPod('ContainerCreating')]);
        const steps = fakeSteps();
        steps.sink.contacted = () => false;
        let killed = false;
        let r: ReturnType<typeof runner> | undefined;
        const request: K8sRequest = async (method, path, body) => {
            const answer = await pods.request(method, path, body);
            if (!killed && method === 'GET' && decodeURIComponent(path).includes('job-name=')) {
                killed = true;
                await r!.kill(repoJob);
            }
            return answer;
        };
        r = runner(request, {}, undefined, steps.sink);
        const thrown = await r.syncCheckout(repoJob, undefined, SESSION_OF).then(
            () => null,
            (e: unknown) => e
        );
        expect((thrown as Error).message).toMatch(/killed while its task group came up/);
        expect(pods.reads()).toBeLessThan(5);
    });

    it('reports the kill, not the refusal, when the kill lands while the pod read is pending', async () => {
        const pods = podsInTurn([refusals['a container configuration the platform refuses']]);
        const steps = fakeSteps();
        steps.sink.contacted = () => false;
        let r: ReturnType<typeof runner> | undefined;
        const request: K8sRequest = async (method, path, body) => {
            if (method === 'GET' && decodeURIComponent(path).includes('job-name=')) await r!.kill(repoJob);
            return pods.request(method, path, body);
        };
        r = runner(request, {}, undefined, steps.sink);
        const thrown = await r.syncCheckout(repoJob, undefined, SESSION_OF).then(
            () => null,
            (e: unknown) => e
        );
        expect(thrown).not.toBeInstanceOf(StartupRefused);
        expect((thrown as Error).message).toMatch(/killed while its task group came up/);
    });

    // A pod list that cannot be read proves nothing either way: no transient cause from silence.
    it('reads no transient cause from pod lists that never answered', async () => {
        const base = fakeRequest();
        const request: K8sRequest = async (method, path, body) =>
            method === 'GET' &&
            path.startsWith(`/api/v1/namespaces/${namespace}/pods?`) &&
            decodeURIComponent(path).includes('job-name=')
                ? { status: 503, body: 'unavailable' }
                : base.request(method, path, body);
        expect(startupDecisionOf(await refusedSync(request))).toBe('unclassified');
    });

    // The bound is elapsed time, not a count of polls: slow reads end the wait as surely as quick ones.
    it('ends the wait for the supervisor on elapsed time', async () => {
        const pods = podsInTurn([refusals['the platform never brought the group up']]);
        let now = 1_000_000;
        // The clock runs once the supervisor wait begins: the fence before it has its own bound.
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => {
            if (pods.reads() > 0) now += 120_000;
            return now;
        });
        try {
            expect(startupDecisionOf(await refusedSync(pods.request))).toBe('interruption');
        } finally {
            clock.mockRestore();
        }
        expect(pods.reads()).toBeLessThan(20);
    });
});

describe('the holder binding a supervisor reads, on kubernetes (#829)', () => {
    const BINDING = { claimSeq: 4, url: 'http://driver.example:8080', token: 'tok-new-holder' };
    const SENTINEL = 'sentinel-body-text';
    const SECRETS = ['tok-new-holder', 'driver.example', SENTINEL];
    const podOf = (group: BoardJob) =>
        runnerJobSpec(
            loadDriverConfig({ EXECUTOR: 'kubernetes' }),
            { ...group, executorType: 'claude-code' },
            { id: SESSION, resume: false }
        ).spec.template.spec;
    const mountsOf = (pod: ReturnType<typeof podOf>, name: string) =>
        pod.containers.find((container) => container.name === name)?.volumeMounts ?? [];
    const patchPath = `/api/v1/namespaces/${namespace}/secrets/${secretName(job)}`;
    const rebinder = (request: K8sRequest) =>
        createKubernetesRunner(
            loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: namespace }),
            request,
            async () => {}
        );
    const ok = (body = ''): Promise<K8sResponse> => Promise.resolve({ status: 200, body });

    it('mounts an optional read-only Secret item in the supervisor alone, without a subPath', () => {
        const pod = podOf({ ...job, ...SUPERVISED });
        expect(pod.volumes).toContainEqual({
            name: SUPERVISOR_BINDING.volume,
            secret: {
                secretName: secretName(job),
                items: [{ key: SUPERVISOR_BINDING.file, path: SUPERVISOR_BINDING.file }],
                defaultMode: 0o444,
                optional: true,
            },
        });
        for (const container of pod.containers) {
            const bound = mountsOf(pod, container.name).filter((mount) => mount.name === SUPERVISOR_BINDING.volume);
            if (container.name === SUPERVISOR_CONTAINER) {
                expect(bound).toEqual([
                    { name: SUPERVISOR_BINDING.volume, mountPath: SUPERVISOR_BINDING.dir, readOnly: true },
                ]);
            } else {
                expect(bound, container.name).toEqual([]);
            }
        }
    });

    it('gives a reclaim group no binding volume and no mount', () => {
        const pod = reclaimGroupSpec(loadDriverConfig({ EXECUTOR: 'kubernetes' }), job, job.leaseToken).spec.template
            .spec;
        expect(JSON.stringify(pod)).not.toContain(SUPERVISOR_BINDING.volume);
    });

    it('merge-patches only the binding key with data, bounded and with the signal', async () => {
        const seen: { method: string; path: string; body: unknown; options: unknown }[] = [];
        const signal = new AbortController().signal;
        await rebinder((method, path, body, options) => {
            seen.push({ method, path, body, options });
            return ok();
        }).rebind(job, BINDING, signal);
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ method: 'PATCH', path: patchPath });
        expect(seen[0]!.body).toEqual({
            data: { [SUPERVISOR_BINDING.file]: Buffer.from(bindingBody(BINDING)).toString('base64') },
        });
        const options = seen[0]!.options as { timeoutMs: number; signal: AbortSignal; contentType?: string };
        expect(options.timeoutMs).toBeLessThanOrEqual(REBIND_DEADLINE_MS);
        expect(options.signal.aborted).toBe(false);
        expect(options.contentType).toBeUndefined();
    });

    it('sends no request for an aborted signal', async () => {
        const request = vi.fn(() => ok());
        const controller = new AbortController();
        controller.abort();
        await expect(rebinder(request).rebind(job, BINDING, controller.signal)).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });

    it('rejects on 403, 404, 409, 500, a throw and a timeout, never naming the token or the answer', async () => {
        const answers: (() => Promise<K8sResponse>)[] = [
            ...[403, 404, 409, 500].map(
                (status) => () => Promise.resolve({ status, body: `${SENTINEL} tok-new-holder driver.example` })
            ),
            () => Promise.reject(new Error('connect ECONNREFUSED tok-new-holder driver.example')),
            () => Promise.reject(new Error('the call timed out sentinel-body-text')),
        ];
        for (const answer of answers) {
            const error = await rebinder(() => answer())
                .rebind(job, BINDING, new AbortController().signal)
                .catch((caught: Error) => caught);
            expect(error).toBeInstanceOf(Error);
            for (const secret of SECRETS) expect(String((error as Error).message)).not.toContain(secret);
        }
    });

    it('discards a 2xx answer unread and resolves only after the patch answered', async () => {
        let answer!: (res: K8sResponse) => void;
        let done = false;
        const pending = rebinder(() => new Promise<K8sResponse>((resolve) => (answer = resolve)))
            .rebind(job, BINDING, new AbortController().signal)
            .then((value) => {
                done = true;
                return value;
            });
        await new Promise((resolve) => setImmediate(resolve));
        expect(done).toBe(false);
        answer({ status: 200, body: '{not json tok-new-holder' });
        expect(await pending).toBeUndefined();
    });

    it('refuses an invalid binding before any request', async () => {
        const request = vi.fn(() => ok());
        await expect(
            rebinder(request).rebind(job, { ...BINDING, claimSeq: -1 }, new AbortController().signal)
        ).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
    });
});
