import { afterEach, describe, expect, it, vitest } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import type { ChildProcess, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { BoardJob, ReviewClaim } from '../src/board.js';
import { executorImage, loadDriverConfig } from '../src/config.js';
import { ctlVolumeName, killMarkName } from '../src/docker-mailbox.js';
import {
    carriedPastLoss,
    decisionOf,
    LOSS_ROWS,
    TERMINATION_ROWS,
    type TerminationRow,
} from './fixtures/termination-table.js';
import { RETENTION_ROWS } from './fixtures/retention-table.js';
import { STARTUP_ROWS, type StartupRow, startupDecisionOf } from './fixtures/startup-table.js';
import {
    containerName,
    dockerArgs,
    envFilePath,
    opencodeSessionReadoutArgs,
    parseDockerServicePs,
    parseDockerStats,
    toolTreeReleaseArgs,
} from '../src/docker.js';
import { claimEnv, envFileBody, transcriptDir } from '../src/claim.js';
import {
    AdoptionBlocked,
    currentActivity,
    reportTail,
    type RunOutcome,
    type RunSession,
    stripAnsi,
    tailBytes,
    tailKept,
} from '../src/runner.js';
import { claudeTurnsArgs, opencodeCacheProbeArgs } from '../src/docker-close-read.js';
import {
    CACHE_WATCH_TURNS,
    CLAUDE_READ_NONE,
    cacheCollapse,
    parseClaudeCloseRead,
    parseOpencodeCacheProbe,
    parseOpencodeRunOutcome,
    readsAgentTurns,
} from '../src/close-read.js';
import {
    ARTIFACT_LIMIT,
    CLOSE_READ_DEADLINE_MS,
    commandMark,
    Inconclusive,
    OPENCODE_EXPORT_LIMIT,
    SERVICE_LOG_TAIL_LINES,
    SERVICE_RESTART_TIMEOUT_MS,
} from '../src/runner.js';
import { claudeTurnsScript, opencodeReadoutScript } from '../src/container-scripts.js';
import { createDockerRunner } from '../src/docker-runner.js';
import { ATTEMPT_COMMAND_TIMEOUT_MS } from '../src/docker-runner-support.js';
import { untilStandDown } from '../src/docker-runner-support.js';
import {
    exporterCreateArgs,
    exporterName,
    gateCreateArgs,
    gateName,
    reviewerName,
    supervisorCreateArgs,
} from '../src/docker-group.js';
import { supervisorName } from '../src/docker-mailbox.js';
import { HELPER_TIMEOUT_MS, lookupHelper, type HelperPlan } from '../src/helpers.js';
import { forgetDeclaredServices, type ServiceSpec, serviceContainerName, serviceRunArgs } from '../src/services.js';
import {
    idLines,
    listOtherAttemptsOrThrow,
    nameLines,
    readDocker,
    type RunnerFiles,
    startJobServices,
    tabRows,
} from '../src/docker-runner-support.js';
import { createStepBroker, StepChannelClosed, type StepSink, type SupervisorEndpoint } from '../src/step-control.js';
import { REVIEW_REPLY_PROBE_ID } from '../src/review-helpers.js';
import { receiptedAnswer, receiptOrder } from './fixtures/helper-receipt-steps.js';
import {
    MAILBOXES,
    SUPERVISOR_ENV,
    SUPERVISOR_EXIT,
    SUPERVISOR_REPORT_PREFIX,
    type StepKind,
    type StepRequest,
    type StepResult,
    type SupervisorReport,
} from '../src/supervisor-contract.js';
import { finalizeWaitMs, takeoverBoundMs } from '../src/supervisor-plan.js';
import { ServicesNotRunning } from '../src/service-restart.js';
import { telemetryConfig, telemetryConfigTar } from '../src/telemetry-config.js';
import {
    CREDENTIAL_HELPER,
    gitProbeScript,
    gitWorktreeRemoveScript,
    gitWorktreeScript,
    isBranchName,
    parseGitState,
    parsePrSummary,
    publishPlan,
    repoPath,
    SYNC_DEADLINE_MS,
    toolTreeReleaseScript,
    TRANSIENT_SYNC_REASON,
    worktreeBranch,
    worktreeDir,
    worktreeRelDir,
} from '../src/publish.js';

const MISMATCH_ROW = 'a run specced for another session than its group' as const;
const SILENT_ROW = 'a supervisor that started and never answered' as const;
const OTHER_SESSION = '44444444-4444-4444-8444-444444444444';

const USER = '44444444-4444-4444-8444-444444444444';
const CONTROL_TOKEN = 'supervisor-control-token';

/** A fixed, valid Factory execution context — the shape master-prompt.test.ts pins; only its
 *  presence matters to this file's own tests, none of which assert its exact text. */
const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';

const job: BoardJob = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    rootCommand: 'fix the failing build',
    attempts: 1,
    maxAttempts: 3,
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
    supervisorEnv: { [SUPERVISOR_ENV.controlUrl]: 'http://driver:8130', [SUPERVISOR_ENV.controlToken]: CONTROL_TOKEN },
};

const ok = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

/** A daemon call that never answers and rejects only when its own `signal` aborts (#869). */
const hangsUntilAborted = (options?: { signal?: AbortSignal }): Promise<never> =>
    new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });

/** A daemon call that never answers: it fails only at its own `timeout`, as execFile kills a stalled child (#869). */
const hangsUntilTimeout = (options?: { timeout?: number }): Promise<never> =>
    new Promise((_resolve, reject) => {
        if (options?.timeout !== undefined) setTimeout(() => reject(new Error('timed out')), options.timeout);
    });

/** Whether `pending` ended within a moment: a wait that ignores the kill signal stays pending. */
const endsSoon = (pending: Promise<unknown>): Promise<boolean> =>
    Promise.race([
        pending.then(
            () => true,
            () => true
        ),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
const FINALIZED: SupervisorReport = {
    id: 'report-1',
    outcome: null,
    cause: null,
    agentExit: 0,
    agentEnd: 'exited',
    drained: true,
    serving: true,
};

/**
 * The supervised-step channel stood in: every step is recorded (with the token it was submitted
 * under) and answered by `answer` — default exit 0, empty — and the supervisor's report is
 * `reported` at once, as a finalized run's would be.
 */
function fakeSteps(
    answer: (step: StepRequest) => StepResult | Promise<StepResult> = () => ok(),
    reported: SupervisorReport | Promise<SupervisorReport> = FINALIZED
) {
    const submitted: { token: string; step: StepRequest }[] = [];
    const released: string[] = [];
    const sink: StepSink = {
        submit: async (token, step) => {
            submitted.push({ token, step });
            return answer(step);
        },
        awaitReport: () => Promise.resolve(reported),
        contacted: () => true,
        release: (token) => {
            released.push(token);
        },
        attach: () => undefined,
        cancel: () => undefined,
    };
    const ofKind = (kind: StepKind) => submitted.filter((entry) => entry.step.kind === kind).map((entry) => entry.step);
    return { sink, submitted, released, steps: () => submitted.map((entry) => entry.step), ofKind };
}

/** A supervisor that answers every step with the sync's `stdout` — by default, a clean sync. */
const syncSteps = (stdout = '{"ok":true,"reason":null}') => fakeSteps(() => ok(stdout));

/** A daemon that answers every verb with nothing. */
const emptyDaemon = (async () => ({ stdout: '' })) as unknown as (args: string[]) => Promise<{ stdout: string }>;

const RECLAIM_TOKEN = 'reclaim-control-token';

/** The endpoint a supervisor-only group is served on, recording the tokens it closed. */
function reclaimEndpoint() {
    const closed: string[] = [];
    const endpoint: SupervisorEndpoint = {
        open: async () => ({ url: 'http://driver:8130', token: RECLAIM_TOKEN }),
        close: (token) => {
            closed.push(token);
        },
    };
    return { endpoint, closed };
}

/** A runner whose reclaim step prints `stdout`, over a group served by {@link reclaimEndpoint}. */
function reclaimRunner(stdout: string) {
    const supervised = fakeSteps((step) => ok(step.kind === 'reclaim' ? stdout : ''));
    const { endpoint, closed } = reclaimEndpoint();
    return { supervised, closed, runner: dockerRunner(emptyDaemon, { steps: supervised.sink, endpoint }) };
}

const SESSION = '33333333-3333-4333-8333-333333333333';
const PR_URL = 'https://github.com/Bellows-AI/factory/pull/42';
const opencodeJob: BoardJob = { ...job, executorType: 'opencode' };

/** One `docker ps --format '{{json .}}'` line for a service container, the fields the parse reads. */
const psLine = (service: { name: string; image: string; state: string }): string =>
    `${JSON.stringify({
        Command: '"sleep"',
        CreatedAt: '2026-09-14T10:00:00.000Z',
        ID: `id-${service.name}`,
        Image: service.image,
        Labels: `factory.job=${job.id},factory.lease=${job.leaseToken},factory.service=${service.name}`,
        Names: `factory-job-${job.id}-${job.leaseToken}-svc-${service.name}`,
        State: service.state,
        Status: `${service.state} (a minute ago)`,
    })}\n`;

/** A declared service's `docker run` (issue #773): detached, labelled with its service name. */
const isServiceRun = (args: string[]): boolean =>
    args[0] === 'run' && args.some((arg) => arg.startsWith('factory.service='));

const args = (env: NodeJS.ProcessEnv = {}, session: RunSession | null = { id: SESSION, resume: false }) =>
    dockerArgs(loadDriverConfig(env), job, session, { envFile: '/tmp/env-file' });

describe('the docker run arguments', () => {
    // The plan itself is pinned in runner-plan.test.ts; this is docker's rendering of it: every
    // env pair as `-e NAME=value` BEFORE the image — docker stops option parsing there, and an
    // `-e` past it would be the CLI's argv — and the CLI args verbatim after it.
    it('renders the runner plan: env pairs as -e before the image, the CLI args after it', () => {
        const envBeforeImage = (line: string[], image: string, pairs: string[]) => {
            for (const pair of pairs) {
                expect(line[line.indexOf(pair) - 1]).toBe('-e');
                expect(line.indexOf(pair)).toBeLessThan(line.indexOf(image));
            }
        };
        const claude = args();
        expect(claude.slice(-9)).toEqual([
            'claude-executor',
            '--session-id',
            SESSION,
            '--append-system-prompt',
            MASTER_PROMPT,
            '--system-prompt-snapshot',
            'off',
            '-p',
            'fix the failing build',
        ]);
        envBeforeImage(claude, 'claude-executor', [
            `FACTORY_TRANSCRIPT_DIR=/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            `BELLOWS_SESSION_ID=${SESSION}`,
            'NPM_CONFIG_UPDATE_NOTIFIER=false',
        ]);
        const opencode = dockerArgs(
            loadDriverConfig({}),
            { ...opencodeJob, followUp: true },
            { id: 'ses_f86188c3dffeZGYO4yZq4atba9', resume: true },
            { envFile: '/tmp/env-file' }
        );
        expect(opencode.slice(-7)).toEqual([
            'opencode-executor',
            'run',
            '--agent',
            'factory',
            '--session',
            'ses_f86188c3dffeZGYO4yZq4atba9',
            'fix the failing build',
        ]);
        envBeforeImage(opencode, 'opencode-executor', [
            `XDG_DATA_HOME=/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}`,
            'NPM_CONFIG_UPDATE_NOTIFIER=false',
            'BELLOWS_SESSION_ID=ses_f86188c3dffeZGYO4yZq4atba9',
        ]);
        expect(opencode).not.toContain('BELLOWS_RESUME_MAY_BE_UNWRITTEN=1');
        // A takeover (issue #822): the same plan, with the permission the pod spec carries too.
        const takeover = dockerArgs(
            loadDriverConfig({}),
            { ...job, resumeSessionId: SESSION, ownSession: true },
            { id: SESSION, resume: true },
            { envFile: '/tmp/env-file' }
        );
        envBeforeImage(takeover, 'claude-executor', ['BELLOWS_RESUME_MAY_BE_UNWRITTEN=1']);
    });

    it("mounts the checkouts volume and starts at the AUTHOR's workspace root", () => {
        // Was `/workspaces/<orgId>`, built from the driver's own ORG_ID — one tree every member's
        // agent shared. The board sends the path now, because it owns the layout; this process
        // only knows where the volume is mounted.
        //
        // The mount is scoped with volume-subpath to the job's own `<orgId>/<userId>` subtree:
        // the container's volume root is the member's tree, enforced by the mount itself, not by
        // where the WORKDIR happens to point.
        expect(args()).toEqual(
            expect.arrayContaining([
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
                `WORKDIR=/workspaces/bellows/${USER}`,
            ])
        );
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
                () => dockerArgs(loadDriverConfig({}), { ...job, workspacePath: path }, { id: SESSION, resume: false }),
                String(path)
            ).toThrow(/no usable workspace path/);
        }
    });

    it('adds no resource flags when none are configured — the dev daemon stays unthrottled', () => {
        expect(args()).not.toContain('--cpus');
        expect(args()).not.toContain('--memory');
        expect(args()).not.toContain('--memory-reservation');
        expect(args()).not.toContain('--cpu-shares');
    });

    // Stated limit, not an oversight: docker has no absolute CPU floor — `--cpu-shares` is a
    // relative weight, not a kubernetes request — and capping a dev runner at its request via
    // `--cpus` would throttle builds the kubernetes side leaves free.
    it('renders no cpu request flag — docker has no absolute CPU floor for a kubernetes request', () => {
        const requested = args({ RUNNER_CPU_REQUEST: '500m', RUNNER_MEMORY_REQUEST: '1Gi' });
        expect(requested).not.toContain('--cpus');
        expect(requested).not.toContain('--cpu-shares');
        expect(requested).toEqual(expect.arrayContaining(['--memory-reservation', '1073741824']));
    });

    // The same discipline the workspace reconcile applies to the git token: `-e NAME` makes docker
    // read the value from the driver's environment, where `-e NAME=value` would publish it to every
    // `ps` on the host.
    it('names credentials without ever putting their values on the command line', () => {
        const line = args({ RUNNER_ENV: 'CLAUDE_CODE_OAUTH_TOKEN' });
        expect(line).toEqual(expect.arrayContaining(['-e', 'CLAUDE_CODE_OAUTH_TOKEN']));
        expect(line.some((arg) => arg.includes('CLAUDE_CODE_OAUTH_TOKEN='))).toBe(false);
    });

    it('labels the container so an orphan can be found after the driver dies', () => {
        // The job label is what the fence sweeps and what finds an orphan after the driver dies;
        // the lease label is what makes every per-attempt operation resolve to THIS attempt's
        // containers only — the job label alone is shared by every attempt of the job, the lease
        // label never repeats.
        expect(args()).toEqual(
            expect.arrayContaining([
                '--name',
                containerName(job),
                '--label',
                `factory.job=${job.id}`,
                '--label',
                `factory.lease=${job.leaseToken}`,
            ])
        );
    });

    // Issue #773: the agent shares its group supervisor's network namespace, as a pod's containers
    // share one: the supervisor is on RUNNER_NETWORK with the hosts entries, and nothing of a
    // network is the agent's own — docker refuses --add-host and a second --network beside it.
    it('joins its group supervisor’s network namespace, and no network of its own', () => {
        for (const env of [{}, { RUNNER_NETWORK: 'factory-ai_default' }]) {
            const line = args(env);
            expect(line.filter((arg) => arg === '--network')).toHaveLength(1);
            expect(line[line.indexOf('--network') + 1]).toBe(
                `container:factory-supervisor-${job.id}-${job.leaseToken}`
            );
            expect(line).not.toContain('factory-ai_default');
            expect(line).not.toContain('--add-host');
        }
    });

    // The endpoint is always provided, defaulting to the compose collector when
    // RUNNER_OTEL_ENDPOINT is not set — the guarantee that a runner's telemetry reaches the
    // collector whether or not an operator named one. RUNNER_OTEL_ENDPOINT overrides it for a
    // collector the compose network cannot name.
    it('always points the runner at a collector, overriding it when configured', () => {
        expect(args()).toEqual(expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318']));
        expect(args({ RUNNER_OTEL_ENDPOINT: 'http://telemetry.internal:4318' })).toEqual(
            expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://telemetry.internal:4318'])
        );
    });

    // The branch reporter posts to the board's API, and the endpoint rides beside the OTEL one:
    // a URL, not a credential, defaulted from JOB_BOARD_URL.
    it('points the runner at the board so it can report its branch', () => {
        expect(args()).toEqual(expect.arrayContaining(['-e', 'FACTORY_STATS_URL=http://127.0.0.1:8080']));
        expect(args({ RUNNER_STATS_URL: 'http://stats.internal:8080' })).toEqual(
            expect.arrayContaining(['-e', 'FACTORY_STATS_URL=http://stats.internal:8080'])
        );
    });

    // A default only: a member who wants the notice back names it in claim env, and the driver's
    // `-e` — which would beat the env file — is not there to override it.
    it('leaves the npm notice to a claim that names it', () => {
        const envJob: BoardJob = { ...job, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } };
        const line = dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false }, { envFile: '/tmp/e' });
        expect(line.some((arg) => arg.startsWith('NPM_CONFIG_UPDATE_NOTIFIER'))).toBe(false);
        expect(envFileBody(envJob, loadDriverConfig({}))).toContain('NPM_CONFIG_UPDATE_NOTIFIER=true\n');
    });

    // --rm is gone deliberately: cleanup is explicit (a `docker rm` after close), so the runner
    // can ask the daemon whether a 125 run left a container behind before removing it.
    it('leaves nothing behind, by explicit cleanup rather than --rm', () => {
        expect(args()).not.toContain('--rm');
    });

    // Both halves are board-supplied and become one filesystem path inside a container that runs
    // the agent — asserted exactly like runWorkingDir's halves, with the root id getting the same
    // uuid assertion envFilePath applies to job.id.
    describe('transcriptDir', () => {
        const ROOT = '55555555-5555-4555-8555-555555555555';

        it('composes the per-thread-root store from the claim fields', () => {
            expect(transcriptDir(loadDriverConfig({}), job)).toBe(
                `/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`
            );
            // A follow-up is a NEW job row resuming the parent conversation: its store is the
            // thread's, keyed by the same root the worktree is keyed by.
            expect(transcriptDir(loadDriverConfig({}), { ...job, rootJobId: ROOT })).toBe(
                `/workspaces/bellows/${USER}/.factory/transcripts/${ROOT}`
            );
        });

        it('refuses a null workspace and a non-uuid thread root', () => {
            expect(() => transcriptDir(loadDriverConfig({}), { ...job, workspacePath: null })).toThrow(
                /no usable workspace path/
            );
            expect(() => transcriptDir(loadDriverConfig({}), { ...job, rootJobId: '../../etc' })).toThrow(/not a uuid/);
        });
    });
});

describe("the board's environment", () => {
    const envJob: BoardJob = {
        ...job,
        env: { MY_TOKEN: 'board-secret', WORKDIR: '/etc' },
    };

    it('reads a claim without an env field as no environment', () => {
        // A board that predates the field omits it — the established defensive read.
        expect(claimEnv(job)).toEqual({});
    });

    it('carries the claim env into the runner by env file, never through this process', () => {
        /*
         * `-e NAME` reads the value from the docker CLI's OWN environment — and claim names are
         * member-controlled. A member's PATH or DOCKER_HOST there steers the CLI the driver
         * executes on the host, which is host code execution, not "the runner's environment". So
         * the values travel in a --env-file the driver writes and removes, and this process's
         * environment stays exactly the operator's.
         */
        const line = dockerArgs(
            loadDriverConfig({}),
            envJob,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
        expect(line).not.toContain('MY_TOKEN');
        expect(line.some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    it('gives the claim precedence over the driver’s own forwarded names', () => {
        // docker gives `-e` precedence over `--env-file`, so a name the claim also carries must
        // not go out as `-e` — otherwise the driver's own value would silently win.
        const configured = loadDriverConfig({ RUNNER_ENV: 'MY_TOKEN,OTHER' });
        const line = dockerArgs(configured, envJob, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' });
        expect(line).toEqual(expect.arrayContaining(['-e', 'OTHER']));
        expect(line).not.toContain('MY_TOKEN');
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    // Issue #244: the collision check must read the SAME env the file is actually written from
    // (`runnerClaimEnv`), or an operator who names OPENCODE_CONFIG_CONTENT in RUNNER_ENV could
    // have `-e` (driver-process value, almost always unset) win over the reserved-agent merge —
    // docker gives `-e` precedence over `--env-file`.
    it('never forwards OPENCODE_CONFIG_CONTENT as -e for an opencode job — the merged value must win', () => {
        const configured = loadDriverConfig({ RUNNER_ENV: 'OPENCODE_CONFIG_CONTENT' });
        const line = dockerArgs(configured, opencodeJob, null, { envFile: '/tmp/env-file' });
        expect(line).not.toEqual(expect.arrayContaining(['-e', 'OPENCODE_CONFIG_CONTENT']));
    });

    it('still forwards OPENCODE_CONFIG_CONTENT as -e for a claude-code job with no claim env', () => {
        // Pins that runnerClaimEnv passes non-opencode claims through unchanged: this name is
        // ordinary for any other executor, and the collision rule must still apply to it.
        const configured = loadDriverConfig({ RUNNER_ENV: 'OPENCODE_CONFIG_CONTENT' });
        const line = dockerArgs(configured, job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' });
        expect(line).toEqual(expect.arrayContaining(['-e', 'OPENCODE_CONFIG_CONTENT']));
    });

    it('refuses to run a claim that carries env with no env file to put it in', () => {
        // A silent drop would run the job without the credentials it was queued against.
        expect(() => dockerArgs(loadDriverConfig({}), envJob, { id: SESSION, resume: false })).toThrow(/no env file/);
    });

    // The runner's branch-ingest credential is the attempt's job id + lease token pair: it rides
    // the 0600 env file as the last lines (docker's --env-file is last-duplicate-wins, so the
    // order is the precedence rule), and never appears on an argv any `ps` on the host can read.
    // The deployment-wide ingest token used to ride here too — it authorized nothing the runner
    // does any more once branch ingest moved to the pair, so it is gone.
    it('carries the attempt pair in the env file, last, and never on the argv', () => {
        expect(envFileBody(envJob, loadDriverConfig({}))).toBe(
            'MY_TOKEN=board-secret\nRUNNER_JOB_ID=11111111-1111-4111-8111-111111111111\nRUNNER_LEASE_TOKEN=22222222-2222-4222-8222-222222222222\n'
        );
        const line = dockerArgs(
            loadDriverConfig({}),
            envJob,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
        expect(line.some((arg) => arg.includes('RUNNER_LEASE_TOKEN'))).toBe(false);
    });

    // The pair rides every runner, claim env or not — it is the credential its attribution
    // reports authenticate with, so a runner without the file would be silently unauthenticated.
    // dockerArgs refuses to build that argv.
    it('always needs the env file: the pair rides it even for a claim with no env', () => {
        expect(() => dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false })).toThrow(/no env file/);
        const line = dockerArgs(
            loadDriverConfig({}),
            job,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    // The reporter's env names are the runner's own contract, like WORKDIR: a member value in
    // one of them steers where the report goes, what authenticates it, and which session it
    // claims — a cross-tenant write into the telemetry store.
    it('refuses the reporter env names from a claim', () => {
        expect(
            claimEnv({
                ...job,
                env: {
                    FACTORY_STATS_URL: 'http://evil',
                    RUNNER_JOB_ID: 'spoof',
                    RUNNER_LEASE_TOKEN: 'spoof',
                    BELLOWS_SESSION_ID: 'spoof',
                },
            })
        ).toEqual({});
    });

    // The driver alone grants a takeover's runner the unwritten-session fallback (issue #822): a
    // member value would hand it to a follow-up, whose missing transcript must stay a refusal.
    it('refuses the unwritten-resume permission from a claim', () => {
        expect(claimEnv({ ...job, env: { BELLOWS_RESUME_MAY_BE_UNWRITTEN: '1' } })).toEqual({});
    });

    // A Jira credential is a managed connection the board spends (docs/connections.md): even a
    // stale or hand-planted claim value never reaches the runner's env file, so a runner holds the
    // attempt pair and nothing that authenticates to Atlassian. Pinned beside the k8s Secret case.
    it('never writes a Jira credential to the env file, only the attempt pair', () => {
        const withJira: BoardJob = {
            ...envJob,
            env: {
                MY_TOKEN: 'board-secret',
                ATLASSIAN_SITE: 'https://example.atlassian.net',
                ATLASSIAN_EMAIL: 'agent@example.com',
                ATLASSIAN_API_TOKEN: 'atlassian-secret',
            },
        };
        const body = envFileBody(withJira, loadDriverConfig({}));
        expect(body).not.toContain('ATLASSIAN');
        expect(body).not.toContain('atlassian-secret');
        expect(body).toContain('RUNNER_LEASE_TOKEN=');
    });

    it('writes one NAME=value line per variable, reserved names dropped', () => {
        expect(envFileBody(envJob)).toBe('MY_TOKEN=board-secret\n');
        expect(envFileBody(job)).toBe('');
        // A value with a newline would corrupt the file's line structure — refused, not mangled.
        expect(() => envFileBody({ ...job, env: { BROKEN: 'line1\nline2' } })).toThrow(/newline/);
    });

    // The refusal must name WHICH half carries the newline: blaming the name for the value's
    // offence sends a reader hunting through the env scopes for a variable that is fine.
    it('names the newline offender, the name or the value', () => {
        expect(() => envFileBody({ ...job, env: { BROKEN: 'line1\nline2' } })).toThrow(
            /the value of "BROKEN" contains a newline/
        );
        expect(() => envFileBody({ ...job, env: { 'BRO\nKEN': 'fine' } })).toThrow(
            /the name of "BRO\nKEN" contains a newline/
        );
        // The gate lines are checked by the same rule.
        expect(() => envFileBody({ ...job, gateEnv: { BELLOWS_GATE_TOKEN: 'tok\ntok' } })).toThrow(
            /the value of "BELLOWS_GATE_TOKEN" contains a newline/
        );
    });

    // Issue #442: the run-control channel the loop mints per attempt rides the env file, after the
    // claim lines — and a member cannot mint it for themselves.
    it('writes the run-control channel after the claim lines, and drops a member-set one', () => {
        const controlled = {
            ...envJob,
            env: { MY_TOKEN: 'board-secret', BELLOWS_CONTROL_TOKEN: 'member-forged' },
            gateEnv: { BELLOWS_CONTROL_URL: 'http://driver:41000', BELLOWS_CONTROL_TOKEN: 'minted' },
        };
        expect(envFileBody(controlled)).toBe(
            'MY_TOKEN=board-secret\nBELLOWS_CONTROL_URL=http://driver:41000\nBELLOWS_CONTROL_TOKEN=minted\n'
        );
    });

    it('never forwards a name the runner itself claims', () => {
        expect(claimEnv(envJob)).toEqual({ MY_TOKEN: 'board-secret' });
        const line = dockerArgs(
            loadDriverConfig({}),
            envJob,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        // The one WORKDIR on the line is the runner's own, with the mount in it.
        expect(line.filter((arg) => arg === 'WORKDIR')).toHaveLength(0);
        expect(line).toEqual(expect.arrayContaining([`WORKDIR=/workspaces/bellows/${USER}`]));
    });

    it.each<[string, Record<string, string>]>([
        // CRED_HELPER is the sync fetch's credential-helper CODE, a value the driver alone
        // chooses; a member's `!` helper riding the claim env into the sync container would be
        // member-controlled code execution, run by git as helper code.
        ['CRED_HELPER', { CRED_HELPER: '!evil' }],
        // RESTORE is the sync's restore-mode switch (issue #58), and the claim env rides the
        // same sync container: a member value there would flip STARTING claims into restore
        // mode — no fetch, no rebase, a first attempt dead-ending on "the branch is gone" —
        // so the driver alone chooses it.
        ['RESTORE', { RESTORE: '1' }],
        // The startup sync lock's bounds (issue #307) are the script's defaults; a member value
        // riding the claim env into the sync container could shrink the wait to nothing or make
        // every sync steal its neighbour's live lock — so the names stay driver-owned, like
        // RESTORE beside them.
        ['SYNC_LOCK_*', { SYNC_LOCK_WAIT_MS: '1', SYNC_LOCK_STALE_MS: '1' }],
        // The transcript store's location is driver-composed (transcriptDir); a member value
        // would steer where headless transcripts are written — and, through the entrypoint's
        // redirect, where the CLI's whole config dir lands.
        ['FACTORY_TRANSCRIPT_DIR', { FACTORY_TRANSCRIPT_DIR: '/somewhere' }],
        // The turn context is board-rendered (runner-plan.ts); a member value would reach the
        // model through the UserPromptSubmit hook as Factory's own context.
        ['FACTORY_TURN_CONTEXT', { FACTORY_TURN_CONTEXT: 'spoof' }],
        // The agent container starts as root to launch the tool broker (issue #814): the glibc
        // loader honours these for that root /bin/sh, env and setpriv before any script line runs.
        [
            'loader variables',
            {
                LD_PRELOAD: '/w/evil.so',
                LD_LIBRARY_PATH: '/w',
                LD_AUDIT: '/w/evil.so',
                GCONV_PATH: '/w',
                GLIBC_TUNABLES: 'glibc.malloc.check=3',
                LOCPATH: '/w',
                NLSPATH: '/w',
                MALLOC_TRACE: '/w/trace',
            },
        ],
    ])('drops a member %s from the claim env and the env file', (_name, member) => {
        const hijacked = { ...job, env: { ...member, OTHER: 'fine' } };
        expect(claimEnv(hijacked)).toEqual({ OTHER: 'fine' });
        expect(envFileBody(hijacked)).toBe('OTHER=fine\n');
    });

    it('always writes the env file for the runner — the pair rides it even with no claim env', () => {
        // The claim-less body is exactly the pair: the runner's own credential, nothing else.
        expect(envFileBody(job, loadDriverConfig({}))).toBe(
            'RUNNER_JOB_ID=11111111-1111-4111-8111-111111111111\nRUNNER_LEASE_TOKEN=22222222-2222-4222-8222-222222222222\n'
        );
        const line = dockerArgs(
            loadDriverConfig({}),
            job,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });
});

const START = '2026-08-20T06:00:00.000Z';

describe('the close-time claude-code turn count', () => {
    /**
     * The read is the opencode readout's twin: a throwaway container over the workspaces
     * volume, reading the transcript the CLI wrote onto FACTORY_TRANSCRIPT_DIR while it lived.
     * Pure and pinned for the same reason opencodeSessionReadoutArgs is — the job container is
     * already gone, and the volume is the only thing that outlived it.
     */
    it('reads the transcript off the workspaces volume, session id by env, never in the script text', () => {
        const line = claudeTurnsArgs(loadDriverConfig({}), job, SESSION, START);
        expect(line.slice(0, 16)).toEqual([
            'run',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--rm',
            '--mount',
            `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            '-e',
            `CLAUDE_TRANSCRIPT_DIR=/workspaces/bellows/${USER}/.factory/transcripts/${job.id}`,
            '-e',
            `CLAUDE_SESSION_ID=${SESSION}`,
            // The per-run delta bound: a follow-up resumes this transcript, so only the
            // entries written at or after this run began are its turns.
            '-e',
            `RUN_STARTED_AT=${START}`,
            '--entrypoint',
            'node',
        ]);
        // The static script by content (what it reads: scripts-claude-turns.test.ts).
        expect(line.slice(16)).toEqual(['claude-executor', '-e', claudeTurnsScript]);
    });

    it('refuses a session id that is not a uuid — it names a file the script would read', () => {
        expect(() => claudeTurnsArgs(loadDriverConfig({}), job, '../../etc/passwd', START)).toThrow(/not a uuid/);
    });

    it('parses the count and summary the script answered, and answers nulls for anything else', () => {
        expect(parseClaudeCloseRead('{"turns":11,"summary":"Fixed the failing gates"}\n')).toEqual({
            turns: 11,
            summary: 'Fixed the failing gates',
            blocked: null,
        });
        // A genuine zero is a measurement — a conversation with no assistant response.
        expect(parseClaudeCloseRead('{"turns":0,"summary":null}')).toEqual({ turns: 0, summary: null, blocked: null });
        expect(parseClaudeCloseRead('{"turns":null,"summary":null,"error":"no transcript for session x"}')).toEqual({
            turns: null,
            summary: null,
            blocked: null,
        });
        // Fractional, negative, or garbage: unmeasured, never a wrong number.
        expect(parseClaudeCloseRead('{"turns":2.5,"summary":42}')).toEqual({
            turns: null,
            summary: null,
            blocked: null,
        });
        expect(parseClaudeCloseRead('{"turns":-3,"summary":"x"}')).toEqual({
            turns: null,
            summary: 'x',
            blocked: null,
        });
        expect(parseClaudeCloseRead('')).toEqual({ turns: null, summary: null, blocked: null });
        expect(parseClaudeCloseRead('node: nothing to run')).toEqual({ turns: null, summary: null, blocked: null });
        // The final message's blocked line rides beside the summary, read before its collapse.
        expect(parseClaudeCloseRead('{"turns":1,"summary":"a FACTORY_BLOCKED: b","blocked":"b"}')).toEqual({
            turns: 1,
            summary: 'a FACTORY_BLOCKED: b',
            blocked: 'b',
        });
    });

    it('answers the unmeasured read itself for a null last line or a non-JSON last line', () => {
        expect(parseClaudeCloseRead('null')).toBe(CLAUDE_READ_NONE);
        expect(parseClaudeCloseRead('{"turns":3,"summary":"x"}\nnoise')).toBe(CLAUDE_READ_NONE);
    });
});

describe('which runs get a close-time turn read', () => {
    /** The read is claude-code-only, and this decision is pure so it stays pinned as the runners evolve. */
    it('reads for a claude-code run with a session', () => {
        const session = { id: SESSION, resume: false };
        expect(readsAgentTurns(job, session)).toBe(true);
        // Opencode counts in its own readout; there is no second read for it.
        expect(readsAgentTurns(opencodeJob, session)).toBe(false);
        // No session minted — nothing to read a transcript for.
        expect(readsAgentTurns(job, null)).toBe(false);
        expect(readsAgentTurns(job, { id: 'not-a-uuid', resume: false })).toBe(false);
    });
});

describe('the transcript export reads (issue #325)', () => {
    it('opencode: has no transcript container of its own — the session readout carries the export', () => {
        const line = opencodeSessionReadoutArgs(loadDriverConfig({}), opencodeJob, START);
        expect(line).toContain(`EXPORT_LIMIT_BYTES=${OPENCODE_EXPORT_LIMIT}`);
        expect(line).toContain(opencodeReadoutScript);
    });
});

describe('an opencode runner', () => {
    const oc = (env: NodeJS.ProcessEnv = {}) =>
        dockerArgs(loadDriverConfig(env), opencodeJob, null, { envFile: '/tmp/env-file' });

    // Issue #244: the real runner's env file carries the reserved `factory` agent merged into
    // OPENCODE_CONFIG_CONTENT — the one place this happens, so a swap back to `claimEnv` here
    // would silently drop the master prompt from every OpenCode run.
    describe('the master prompt reaches the real runner only', () => {
        it('merges the reserved factory agent into the runner env file', () => {
            const body = envFileBody(opencodeJob, loadDriverConfig({}));
            expect(body).toContain(
                `OPENCODE_CONFIG_CONTENT={"agent":{"factory":{"mode":"primary","prompt":${JSON.stringify(MASTER_PROMPT)},"disable":false}}}`
            );
        });

        it('preserves the member’s own executor config alongside the reserved agent', () => {
            const withMemberConfig: BoardJob = {
                ...opencodeJob,
                env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'anthropic/claude-sonnet' }) },
            };
            const body = envFileBody(withMemberConfig, loadDriverConfig({}));
            const line = body.split('\n').find((l) => l.startsWith('OPENCODE_CONFIG_CONTENT='));
            const merged = JSON.parse(line!.slice('OPENCODE_CONFIG_CONTENT='.length));
            expect(merged.model).toBe('anthropic/claude-sonnet');
            expect(merged.agent.factory).toEqual({ mode: 'primary', prompt: MASTER_PROMPT, disable: false });
        });

        it('never merges into an aux container’s env (no config argument)', () => {
            // Sync, gates, publish and block-helper containers never run the agent CLI, so they
            // must never carry the reserved agent — and calling with no `config` must not throw
            // even though the claim's masterPrompt-dependent merge would otherwise need one.
            expect(envFileBody(opencodeJob)).not.toContain('OPENCODE_CONFIG_CONTENT');
        });
    });

    /**
     * The close path reads what the run left behind — the session id AND how the run's last
     * message ended. A zero exit code with finish `length` is the model's context limit cutting
     * the task short, and the outcome must carry that; only a reason the daemon's read actually
     * produced lands, a failed readout costing neither.
     */
    it('scrapes the finish reason beside the session id when an opencode run closes', async () => {
        const { exec } = entrypointAnswers(
            '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"length","tokens":90433,"cost":0.31}\n'
        );
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        const outcome = await runner.run({ ...opencodeJob, followUp: false }, null);
        expect(outcome).toMatchObject({
            exitCode: 0,
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            finishReason: 'length',
            contextTokens: 90433,
            costUsd: 0.31,
        });
    });

    // The retry and merge are pinned in close-read.test.ts; this is docker's transport failure —
    // a readout container the daemon refused rides the outcome. RUNNER_SERVICES=0: the stub
    // routes every `--entrypoint` run to one branch, and this is the SESSION readout.
    const ocServicesOff = { RUNNER_SERVICES: '0' } as const;

    it('carries a refused readout container on the outcome too', async () => {
        const { exec } = entrypointAnswers(() => {
            throw new Error('daemon refused the readout');
        });
        const runner = dockerRunner(exec, { env: ocServicesOff, spawn: spawnChild('done\n', '', 0) });

        const outcome = await runner.run({ ...opencodeJob, followUp: false }, null);
        expect(outcome.readoutError).toBe('the readout container failed: daemon refused the readout');
    });

    it('uses the image configured for its selected executor type', () => {
        // The image is the argument before the command; the default would read `opencode-executor`.
        expect(oc({ OPENCODE_EXECUTOR_IMAGE: 'registry/oc:2' }).slice(-5)).toEqual([
            'registry/oc:2',
            'run',
            '--agent',
            'factory',
            'fix the failing build',
        ]);
    });

    // The claude pins hold unchanged, because nothing about the docker-level posture depends on
    // which CLI is behind the image: workspace, label, name, and credentials by name only.
    it('keeps every docker-level invariant', () => {
        const line = oc({ RUNNER_ENV: 'ANTHROPIC_API_KEY' });
        expect(line).toEqual(
            expect.arrayContaining([
                '--name',
                containerName(job),
                '--label',
                `factory.job=${job.id}`,
                '--label',
                `factory.lease=${job.leaseToken}`,
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
                `WORKDIR=/workspaces/bellows/${USER}`,
                '-e',
                'ANTHROPIC_API_KEY',
            ])
        );
        expect(line.some((arg) => arg.includes('ANTHROPIC_API_KEY='))).toBe(false);
    });
});

describe('scraping the session opencode used', () => {
    /**
     * The readout is a throwaway container over the workspaces volume, entrypoint swapped for
     * node — the job container is already gone by the time it runs, and the driver has no host
     * path into a named volume. Pure and pinned for the same reason dockerArgs is.
     */
    it('refuses to build a readout argv for a claim whose workspace path cannot be asserted', () => {
        // The path lands in the mount's volume-subpath now, so it is asserted before any argv
        // exists — a malformed claim produces no container, not one mounted somewhere unintended.
        const broken = { ...opencodeJob, workspacePath: '../../etc' };
        expect(() => opencodeSessionReadoutArgs(loadDriverConfig({}), broken, START)).toThrow(/workspace path/);
        expect(() => opencodeCacheProbeArgs(loadDriverConfig({}), broken)).toThrow(/workspace path/);
    });

    it('reads the session database out of the member’s data directory, root sessions only', () => {
        const line = opencodeSessionReadoutArgs(loadDriverConfig({}), opencodeJob, START);
        expect(line.slice(0, 16)).toEqual([
            'run',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--rm',
            '--mount',
            `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            '-e',
            `OPENCODE_DB=/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}/opencode/opencode.db`,
            '-e',
            // The scope: the session database is per member, so the readout answers only the
            // session whose `directory` is the working directory the RUN container had — the
            // member root here, since this job names no repo. Without it, two concurrent tasks
            // of one member share the database and the newest-root-session scrape answers
            // whichever task closed last (observed 2026-09-11: two /fix tasks recorded one
            // session id, and both their follow-ups resumed the same conversation).
            `OPENCODE_DIR=/workspaces/bellows/${USER}`,
            '-e',
            // The per-run delta bound: a follow-up resumes the same root conversation, so the
            // turn count is bounded to the messages written at or after this run began.
            `RUN_STARTED_MS=${Date.parse(START)}`,
            '-e',
            `EXPORT_LIMIT_BYTES=${OPENCODE_EXPORT_LIMIT}`,
        ]);
        // The static script by content (what it answers: scripts-opencode-readout.test.ts).
        expect(line.slice(16)).toEqual(['--entrypoint', 'node', 'opencode-executor', '-e', opencodeReadoutScript]);
    });

    it('scopes the readout to the task worktree when the job names a repo', () => {
        const line = opencodeSessionReadoutArgs(
            loadDriverConfig({}),
            { ...opencodeJob, repo: 'Bellows-AI/factory' },
            START
        );
        expect(line).toContain(`OPENCODE_DIR=/workspaces/bellows/${USER}/.worktrees/${job.id}`);
    });

    it('pulls the session id, finish reason and context stats out of the readout’s answer', () => {
        expect(
            parseOpencodeRunOutcome(
                '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","finish":"length","tokens":90433.4,"cost":0.31}\n'
            )
        ).toEqual({
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            finishReason: 'length',
            contextTokens: 90433,
            costUsd: 0.31,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // A healthy run's closing word, and a free-tier cost of zero.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","finish":"stop","tokens":1200,"cost":0,"turns":7}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: 'stop',
            contextTokens: 1200,
            costUsd: 0,
            agentTurns: 7,
            summary: null,
            blocked: null,
            error: null,
        });
        // A message that never reported a finish or tokens reads as none, not as a reason.
        // A line with no turn count reads unmeasured — pre-change readouts, or a parse miss.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","finish":null,"tokens":null,"cost":null}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // The readout's own failure line: carried through as the reason, with no stats.
        expect(parseOpencodeRunOutcome('{"error":"no such column: role"}')).toEqual({
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: 'no such column: role',
        });
        expect(parseOpencodeRunOutcome('')).toEqual({
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // Not a session id: a path, an error line, or a uuid that would read as claude's.
        expect(parseOpencodeRunOutcome('ses_f86188c3dffeZGYO4yZq4atba9\n').sessionId).toBeNull();
        expect(parseOpencodeRunOutcome('Error: Session not found').sessionId).toBeNull();
        expect(
            parseOpencodeRunOutcome('{"id":"33333333-3333-4333-8333-333333333333","finish":"stop"}').sessionId
        ).toBeNull();
        // Negative or non-numeric context stats are not stats.
        // A negative or fractional turn count is not a count — unmeasured, never negative.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","tokens":-5,"cost":"free","turns":-1}')).toEqual({
            sessionId: 'ses_x1',
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        });
        // A session line that also carries the last provider error: both ride — the session makes
        // the task follow-up-able, the error is the premature stop's cause.
        expect(
            parseOpencodeRunOutcome(
                '{"id":"ses_x1","finish":"tool-calls","tokens":100016,"cost":0,"error":"Error from provider (Console): Rate limit exceeded. Please try again later."}'
            )
        ).toEqual({
            sessionId: 'ses_x1',
            finishReason: 'tool-calls',
            contextTokens: 100016,
            costUsd: 0,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: 'Error from provider (Console): Rate limit exceeded. Please try again later.',
        });
        // The final message's blocked line rides beside the summary, read before its collapse.
        expect(parseOpencodeRunOutcome('{"id":"ses_x1","summary":"a","blocked":"no access"}').blocked).toBe(
            'no access'
        );
    });
    it('answers every field unmeasured, and no export, for a null last line or a non-JSON last line', () => {
        const nothing = {
            sessionId: null,
            finishReason: null,
            contextTokens: null,
            costUsd: null,
            agentTurns: null,
            summary: null,
            blocked: null,
            error: null,
        };
        expect(parseOpencodeRunOutcome('null')).toStrictEqual(nothing);
        expect(
            parseOpencodeRunOutcome('{"stream":"raw","row":1}\n{"id":"ses_x1","finish":"stop"}\nnoise')
        ).toStrictEqual(nothing);
    });
});

describe('the cache watch', () => {
    const DEATH =
        '{"id":"ses_f86188c3dffeZGYO4yZq4atba9","turns":[' +
        '{"input":84000,"cacheRead":0,"ms":250000},' +
        '{"input":80000,"cacheRead":0,"ms":200000},' +
        '{"input":63000,"cacheRead":0,"ms":150000}]}';

    /**
     * The probe is a throwaway container over the workspaces volume, entrypoint swapped for node
     * — the live-run twin of the close-time readout. Pure and pinned for the same reason.
     */
    it('probes the newest root session of the member’s data directory, read-only', () => {
        const line = opencodeCacheProbeArgs(loadDriverConfig({}), opencodeJob);
        expect(line.slice(0, 12)).toEqual([
            'run',
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--rm',
            '--mount',
            `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            '-e',
            `OPENCODE_DB=/workspaces/bellows/${USER}/.factory/opencode/${opencodeJob.id}/opencode/opencode.db`,
            '-e',
            // The turn count rides from the driver's own constant, so the probe and the verdict
            // cannot drift apart.
            `CACHE_WATCH_TURNS=${CACHE_WATCH_TURNS}`,
        ]);
        expect(line.slice(12, 16)).toEqual(['--entrypoint', 'node', 'opencode-executor', '-e']);
        const script = line[16] as string;
        expect(script).toContain('process.env.OPENCODE_DB');
        expect(script).toContain('process.env.CACHE_WATCH_TURNS');
        // Newest-first, so the probe can answer from the run's last handful of messages without
        // reading the session whole.
        expect(script).toContain('order by id desc');
        expect(script).toContain('parent_id is null');
        expect(script).toContain("d.role !== 'assistant'");
        expect(script).toContain('readOnly');
        expect(script).toContain('{ error:');
    });

    it('parses the probe’s answer, error lines included', () => {
        expect(parseOpencodeCacheProbe(`${DEATH}\n`)).toEqual({
            sessionId: 'ses_f86188c3dffeZGYO4yZq4atba9',
            turns: [
                { input: 84000, cacheRead: 0, ms: 250000 },
                { input: 80000, cacheRead: 0, ms: 200000 },
                { input: 63000, cacheRead: 0, ms: 150000 },
            ],
            error: null,
        });
        // Not yet: no session, no turns, no error.
        expect(parseOpencodeCacheProbe('')).toEqual({ sessionId: null, turns: [], error: null });
        expect(parseOpencodeCacheProbe('{"error":"database is locked"}')).toEqual({
            sessionId: null,
            turns: [],
            error: 'database is locked',
        });
        // Malformed turns are not turns.
        expect(parseOpencodeCacheProbe('{"id":"ses_x1","turns":[{"input":-1},{"input":5}]}').turns).toEqual([]);
    });

    it('answers nothing for a null last line or a non-JSON last line', () => {
        expect(parseOpencodeCacheProbe('null')).toEqual({ sessionId: null, turns: [], error: null });
        expect(parseOpencodeCacheProbe('{"cloned":true}\nnoise')).toEqual({ sessionId: null, turns: [], error: null });
    });

    it('fires only on three consecutive dead, real-context, slow turns', () => {
        const turn = (over: Partial<{ input: number; cacheRead: number; ms: number }> = {}) => ({
            input: 80000,
            cacheRead: 0,
            ms: 200000,
            ...over,
        });
        // Fewer than three: not yet, whatever the turns look like.
        expect(cacheCollapse([turn(), turn()])).toBeNull();
        // The collapse itself, with the observed shape of the first incident.
        const verdict = cacheCollapse([turn({ ms: 250000 }), turn({ ms: 200000 }), turn({ ms: 150000 })]);
        expect(verdict).toContain('3 consecutive turns with no prompt-cache reads');
        expect(verdict).toContain('80k/80k/80k');
        expect(verdict).toContain('150-250s');
        // Cache hits, fast turns, or a tiny context each break the chain — the watch fires on a
        // provider that stopped CACHING INTO A WALL, not on a model that never cached and answers
        // quickly anyway.
        expect(cacheCollapse([turn({ cacheRead: 5000 }), turn(), turn()])).toBeNull();
        expect(cacheCollapse([turn({ ms: 1000 }), turn(), turn()])).toBeNull();
        expect(cacheCollapse([turn({ input: 500 }), turn(), turn()])).toBeNull();
        expect(cacheCollapse([turn(), turn({ ms: 1000 }), turn()])).toBeNull();
    });

    // A controllable child: stays open while the probe interval ticks, closed by the test once
    // the daemon has seen what the assertions need. The runner's own `docker run` goes through
    // spawnFn; every daemon call goes through the exec seam below.
    const openChild = () => {
        const c = new EventEmitter() as ChildProcess;
        c.stdout = new EventEmitter() as Readable;
        c.stderr = new EventEmitter() as Readable;
        return {
            spawn: (() => c) as unknown as typeof spawn,
            close: (code: number | null) => {
                process.nextTick(() => c.emit('close', code));
            },
        };
    };

    it('kills the run when the probe reports a dead cache, and carries the reason', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: DEATH };
            // The kill resolves its runner through its own label pair; the lease filter marks
            // this attempt's ps, and answering it with a container id is what lets the mock see
            // the `docker kill` itself.
            if (args[0] === 'ps' && args.some((a) => a.startsWith('label=factory.lease'))) {
                return { stdout: 'a0a0a0a0a001\n' };
            }
            // The hard kill takes the supervisor down with the agent: its exit is the kill's 137.
            if (args[0] === 'wait') return { stdout: '137\n' };
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const { spawn: childSpawn, close } = openChild();
        const runner = dockerRunner(exec, {
            env: {
                RUNNER_CACHE_WATCH: '1',
                RUNNER_CACHE_WATCH_POLL_MS: '250',
            },
            spawn: childSpawn,
            // The supervisor dies in the kill: no report ever comes.
            steps: fakeSteps(undefined, new Promise<never>(() => undefined)).sink,
        });

        const pending = runner.run({ ...opencodeJob, followUp: false }, null);
        while (!calls.some((a) => a[0] === 'kill')) await new Promise((r) => setTimeout(r, 5));
        close(137);
        const outcome = await pending;

        expect(outcome.exitCode).toBe(137);
        expect(outcome.cacheLost).toContain('3 consecutive turns with no prompt-cache reads');
        expect(outcome.timedOut).toBe(false);
        // The driver's own kill is the run's end, never a supervisor the platform took away.
        expect(outcome).not.toHaveProperty('infraLoss');
        // The reason is recorded on the attempt before the kill, for a claim adopting the run.
        const mark = `factory.kill.cache_lost=${outcome.cacheLost as string}`;
        const recorded = calls.findIndex((a) => a[0] === 'volume' && a[1] === 'create' && a.includes(mark));
        expect(recorded).toBeGreaterThanOrEqual(0);
        expect(recorded).toBeLessThan(calls.findIndex((a) => a[0] === 'kill'));
    });

    it('leaves the daemon alone while the watch is off', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const { spawn: childSpawn, close } = openChild();
        const runner = dockerRunner(exec, { spawn: childSpawn });

        const pending = runner.run({ ...opencodeJob, followUp: false }, null);
        // Two poll periods of a live run, had the watch been armed at the same 250ms the armed
        // test uses — then an ordinary clean exit.
        await new Promise((r) => setTimeout(r, 500));
        close(0);
        await pending;

        // The close-time readout does run; the mid-run probe never does.
        expect(calls.some((a) => a[0] === 'run' && a.includes('order by id desc'))).toBe(false);
    });

    it('does not probe Claude Code tasks when the mixed-task driver has the OpenCode watch enabled', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const { spawn: childSpawn, close } = openChild();
        const runner = dockerRunner(exec, {
            env: { RUNNER_CACHE_WATCH: '1', RUNNER_CACHE_WATCH_POLL_MS: '250' },
            spawn: childSpawn,
        });

        const pending = runner.run(job, { id: SESSION, resume: false });
        await new Promise((r) => setTimeout(r, 500));
        close(0);
        await pending;

        expect(calls.some((a) => a[0] === 'run' && a.includes('order by id desc'))).toBe(false);
    });
});

describe('the runner env for a gated job', () => {
    const gated: BoardJob = {
        ...job,
        repo: 'Bellows-AI/factory',
        gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
        env: { CLAIM_TOKEN: 'board-secret' },
        gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' },
    };

    it('carries the gate credentials after the claim env, so the claim cannot spoof them', () => {
        // docker's --env-file is last-duplicate-wins: the gate lines are appended after the
        // claim's, so a member-configured BELLOWS_GATE_TOKEN in any scope loses to the driver's.
        const body = envFileBody(gated).split('\n').filter(Boolean);
        expect(body).toEqual([
            'CLAIM_TOKEN=board-secret',
            'BELLOWS_GATE_URL=http://host.docker.internal:9099',
            'BELLOWS_GATE_TOKEN=tok',
        ]);
    });

    /**
     * A claim can resolve to nothing — no env configured in any scope — while the job still
     * declares gates. The loop mints BELLOWS_GATE_URL/TOKEN for exactly such a job, and a runner
     * that keyed the env file on the claim alone would spawn with neither: no ad-hoc gate call
     * possible, and the run's own verification unreadable to the agent.
     */
    const gateOnly: BoardJob = {
        ...job,
        repo: 'Bellows-AI/factory',
        gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
        gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' },
    };

    it('mounts the env file when the only env is the gate credentials', () => {
        expect(envFileBody(gateOnly)).toBe(
            'BELLOWS_GATE_URL=http://host.docker.internal:9099\nBELLOWS_GATE_TOKEN=tok\n'
        );
        const line = dockerArgs(
            loadDriverConfig({}),
            gateOnly,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['--env-file', '/tmp/env-file']));
    });

    it('refuses to run a job whose only env is gate credentials with no env file to carry them', () => {
        // The same silent drop the claim-env refusal prevents — the credentials it was spawned
        // against never reach the container.
        expect(() => dockerArgs(loadDriverConfig({}), gateOnly, { id: SESSION, resume: false })).toThrow(/no env file/);
    });

    // The default gate URL's host gateway mapping is the supervisor's, whose namespace and hosts
    // file the agent shares (issue #773): docker refuses --add-host on a container-mode network.
    it('leaves the host gateway mapping to the supervisor whose namespace it shares', () => {
        expect(
            dockerArgs(loadDriverConfig({}), gated, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).not.toContain('--add-host');
    });

    it('never puts a gate value on the command line', () => {
        const line = dockerArgs(
            loadDriverConfig({}),
            gated,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(line.some((arg) => arg.includes('tok'))).toBe(false);
        expect(line.some((arg) => arg.includes('host.docker.internal:9099'))).toBe(false);
    });

    // Regression pin for the feature boundary: a claim without gates builds exactly the argv it
    // always did.
    it('builds byte-identical argv for a job without gates', () => {
        expect(
            dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).toEqual(
            dockerArgs(
                loadDriverConfig({}),
                { ...job, gates: null },
                { id: SESSION, resume: false },
                { envFile: '/tmp/env-file' }
            )
        );
    });

    // opencode's plugin reads its endpoint from otel.json, not from OTEL_EXPORTER_OTLP_ENDPOINT —
    // the driver renders that file (telemetry-config.ts). The env var still reaches the runner,
    // for this CLI no less than for claude-code.
    it('forwards the OTEL endpoint to the opencode runner too', () => {
        const line = dockerArgs(
            loadDriverConfig({ RUNNER_OTEL_ENDPOINT: 'http://collector:4318' }),
            opencodeJob,
            null,
            { envFile: '/tmp/env-file' }
        );
        expect(line).toEqual(expect.arrayContaining(['-e', 'OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318']));
    });
});

/*
 * The report has to fit the board's 128 KiB body limit whatever the log contained — a refused
 * report leaves the job to its lease and re-runs finished work, which is worse than a short log.
 * A character count cannot state that bound: 64 Ki of CJK text is 192 KiB of UTF-8, and a control
 * character expands six-fold under JSON escaping. Hence bytes.
 */
describe('the report tail', () => {
    it('answers nothing for a log that already fits', () => {
        expect(tailBytes('hello', 64)).toBe('hello');
        // Multibyte text, well under the limit, comes back exactly as it went in.
        expect(tailBytes('café ☕', 64)).toBe('café ☕');
    });

    it('caps by UTF-8 bytes, not by characters', () => {
        // Each ☕ is three bytes: 10_000 of them are 30_000 bytes in only 10_000 characters.
        const log = '☕'.repeat(10_000);
        const tail = tailBytes(log, 16 * 1024);

        expect(tail.length).toBeLessThan(log.length);
        expect(Buffer.byteLength(tail, 'utf8')).toBeLessThanOrEqual(16 * 1024);
    });

    it('keeps the tail, not the head', () => {
        expect(tailBytes('head-head-head-tail', 4)).toBe('tail');
    });

    it('cuts at a character boundary: a multibyte character split by the limit is dropped whole (#825)', () => {
        // Each ☕ is three bytes, so a 4-byte limit lands inside the second-to-last one.
        expect(tailBytes('☕'.repeat(100), 4)).toBe('☕');
        const kept = tailKept('€'.repeat(ARTIFACT_LIMIT), ARTIFACT_LIMIT);
        expect(kept.truncated).toBe(true);
        expect(Buffer.byteLength(kept.content, 'utf8')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(kept.content).not.toContain('�');
    });

    it('reportTail fits a JSON-escaped complete POST under the board body limit', () => {
        // The worst log: three-byte characters, then control characters that JSON escaping
        // expands six-fold.
        const worst = 'あ\u0001'.repeat(64 * 1024);
        const body = JSON.stringify({
            leaseToken: '22222222-2222-4222-8222-222222222222',
            status: 'succeeded',
            exitCode: 0,
            output: reportTail(worst),
        });
        expect(Buffer.byteLength(body, 'utf8')).toBeLessThan(128 * 1024);
    });
});

/**
 * A child that streams the given text and exits, the way `spawn`'s product behaves — enough of
 * one for the runner, which reads two streams and a close event and nothing else.
 */
function fakeChild(stdout: string, stderr: string, code: number | null): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stream = (text: string) => {
        const s = new EventEmitter() as Readable;
        if (text) process.nextTick(() => s.emit('data', Buffer.from(text)));
        return s;
    };
    child.stdout = stream(stdout);
    child.stderr = stream(stderr);
    process.nextTick(() => child.emit('close', code));
    return child;
}

/** A child whose stdout arrives as exactly these byte chunks and ends, in one tick, before it exits `code`. */
function chunkedChild(chunks: Buffer[], code = 0): ChildProcess {
    const child = new EventEmitter() as ChildProcess;
    const stdout = new EventEmitter() as Readable;
    child.stdout = stdout;
    child.stderr = new EventEmitter() as Readable;
    process.nextTick(() => {
        for (const chunk of chunks) stdout.emit('data', chunk);
        stdout.emit('end');
        child.emit('close', code);
    });
    return child;
}

/** A log whose stream ends inside a `€`: its last two bytes begin a character that never completes. */
const CUT_SHORT = [Buffer.concat([Buffer.from('ok'), Buffer.from('€').subarray(0, 2)])];

/**
 * `body` then a `€` split across two chunks after its first byte (issue #825): decoded chunk by
 * chunk, each half would read as U+FFFD.
 */
const splitEuro = (body: string): Buffer[] => {
    const euro = Buffer.from('€');
    return [
        Buffer.concat([Buffer.from(body), euro.subarray(0, 1)]),
        Buffer.concat([euro.subarray(1), Buffer.from('\n')]),
    ];
};
/** Below the artifact cap, and above it in multibyte text: [body, the truncated flag it earns]. */
const SPLIT_EURO_CASES = [
    ['a', false],
    ['€'.repeat(ARTIFACT_LIMIT / 2), true],
] as const;
const expectWholeEuro = (outcome: RunOutcome | undefined, truncated: boolean): void => {
    expect(outcome?.fullLog?.endsWith('€\n')).toBe(true);
    expect(outcome?.fullLog).not.toContain('�');
    expect(outcome?.output).not.toContain('�');
    expect(Buffer.byteLength(outcome?.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
    expect(outcome?.logTruncated).toBe(truncated);
};

/** A spawn whose every call hands back one {@link fakeChild}. */
function spawnChild(stdout: string, stderr?: string, code?: number | null): typeof spawn {
    return (() => fakeChild(stdout, stderr as string, code as number | null)) as unknown as typeof spawn;
}

/**
 * A stateful daemon: containers live in a map keyed by id/name with their labels, `ps` honors
 * `--filter label=` pairs, and `rm -f` removes exactly what it is told. Service containers and
 * every `docker create` register
 * through the exec seam, so cross-attempt "B is untouched" assertions are state, not argv. The
 * throwaway `run … --entrypoint` container answers `readout` (default: the sync's success
 * verdict). `fail`, when given, turns the matching call into an execFile-shaped rejection —
 * stderr on the error, the way the promisified execFile carries a daemon refusal.
 */
/**
 * The readiness wait's `docker ps --format '{{json .}}'` answer: every service container the
 * daemon was asked to run (`--network-alias`, labelled `factory.service`), running.
 */
function runningServicesPs(calls: readonly string[][]): { stdout: string } {
    const names = calls
        .filter((a) => isServiceRun(a))
        .flatMap((a) => a.filter((arg) => arg.startsWith('factory.service=')));
    return {
        stdout: names.map((label) => JSON.stringify({ Labels: label, Image: 'svc:1', State: 'running' })).join('\n'),
    };
}

/** A container's id as the daemon prints it: 12 lowercase hex characters, derived from its name. */
const idOf = (name: string): string => createHash('sha256').update(name).digest('hex').slice(0, 12);

/**
 * A `ps` answer naming one container: the fence's `--format` listing renders each id beside its
 * lease label — an older attempt's, as every container of a job carries one — a bare `-q`/`-aq`
 * listing the id alone.
 */
const psListing = (args: string[], id: string): string =>
    args.includes('--format') ? `${id}\taaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\n` : `${id}\n`;

function labelDaemon({
    readout = '{"ok":true,"reason":null}',
    fail,
}: {
    readout?: string;
    fail?: (args: string[]) => string | null;
} = {}) {
    const containers = new Map<string, Record<string, string>>();
    const calls: string[][] = [];
    const labelsOf = (args: string[]): Record<string, string> => {
        const labels: Record<string, string> = {};
        for (let i = 0; i < args.length; i += 1) {
            if (args[i] === '--label') {
                const [key, value] = (args[i + 1] ?? '').split('=');
                if (key && value !== undefined) labels[key] = value;
            }
        }
        return labels;
    };
    // `label=key=value` matches the value, `label=key` the key's presence — docker's two spellings.
    const filtersOf = (args: string[]): [string, string | null][] => {
        const filters: [string, string | null][] = [];
        for (let i = 0; i < args.length; i += 1) {
            if (args[i] === '--filter' && (args[i + 1] ?? '').startsWith('label=')) {
                const [key, value] = (args[i + 1] ?? '').slice('label='.length).split('=');
                if (key) filters.push([key, value ?? null]);
            }
        }
        return filters;
    };
    const matches = (labels: Record<string, string>, filters: [string, string | null][]): boolean =>
        filters.every(([key, value]) => (value === null ? key in labels : labels[key] === value));
    const listed = (entries: Map<string, Record<string, string>>, args: string[]) => {
        const filters = filtersOf(args);
        if (args.includes('{{json .}}')) {
            // The readiness wait's listing: every matching service container, running.
            const services = [...entries.values()].filter(
                (labels) => labels['factory.service'] && matches(labels, filters)
            );
            return {
                stdout: services
                    .map((labels) =>
                        JSON.stringify({
                            Labels: `factory.service=${labels['factory.service']}`,
                            Image: 'svc:1',
                            State: 'running',
                        })
                    )
                    .join('\n'),
            };
        }
        // The fence's `--format` asks for each object's lease label beside its name or its id, as
        // docker renders it: a container's id is the daemon's 12 hex characters, never its name.
        const format = args[args.indexOf('--format') + 1] ?? '';
        const withLease = format.includes('factory.lease');
        const first = (name: string): string => (format.startsWith('{{.ID}}') ? idOf(name) : name);
        return {
            stdout: [...entries.entries()]
                .filter(([, labels]) => matches(labels, filters))
                .map(([name, labels]) => (withLease ? `${first(name)}\t${labels['factory.lease'] ?? ''}` : first(name)))
                .join('\n'),
        };
    };
    const exec = vitest.fn(async (args: string[]) => {
        calls.push(args);
        const refused = fail?.(args);
        if (refused) {
            throw Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), { stderr: refused });
        }
        if (args[0] === 'ps') return listed(containers, args);
        if (args[0] === 'rm' && args[1] === '-f') {
            for (const id of args.slice(2)) {
                containers.delete(id);
                for (const name of containers.keys()) if (idOf(name) === id) containers.delete(name);
            }
            return { stdout: '' };
        }
        if (args[0] === 'run' && args.includes('--entrypoint')) return { stdout: readout };
        if (isServiceRun(args) || args[0] === 'create') {
            containers.set(args[args.indexOf('--name') + 1]!, labelsOf(args));
            return { stdout: '' };
        }
        return { stdout: '' };
    }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
    return { containers, calls, exec };
}

/**
 * The common daemon stub: the throwaway `run … --entrypoint` container (a readout, a sync)
 * prints `answer` — a function sees the argv and may throw, as a refusing daemon does — and
 * every other docker verb answers empty. Every argv is recorded in `calls`.
 */
function entrypointAnswers(answer: string | ((args: string[]) => string)): {
    exec: (args: string[]) => Promise<{ stdout: string }>;
    calls: string[][];
} {
    const calls: string[][] = [];
    const exec = vitest.fn(async (args: string[]) => {
        calls.push(args);
        if (args[0] === 'run' && args.includes('--entrypoint')) {
            return { stdout: typeof answer === 'string' ? answer : answer(args) };
        }
        return { stdout: '' };
    });
    return { exec, calls };
}

/**
 * The runner under test: configured from `env`, the daemon stood in by `exec`, and a spawn whose
 * child prints nothing and exits 0 unless the test hands its own.
 */
function dockerRunner(
    exec: Parameters<typeof createDockerRunner>[2],
    {
        env = {},
        spawn: spawnFn = spawnChild('', '', 0),
        files,
        steps = fakeSteps().sink,
        endpoint,
        sleep = async () => {},
    }: {
        env?: Parameters<typeof loadDriverConfig>[0];
        spawn?: typeof spawn;
        files?: RunnerFiles;
        steps?: StepSink;
        endpoint?: SupervisorEndpoint;
        sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    } = {}
): ReturnType<typeof createDockerRunner> {
    return createDockerRunner(loadDriverConfig(env), spawnFn, exec, {
        ...(files ? { files } : {}),
        steps,
        ...(endpoint ? { endpoint } : {}),
        // No test waits out a real pause: a test that is about one passes its own.
        sleep,
    });
}

describe('the docker runner', () => {
    // The daemon is stood in by `execDocker`, so the suite never shells out: the fence and the
    // cleanup `rm` answer empty, and the `inspect` that classifies a 125 close is scripted per
    // test. The fake child carries whatever the run itself printed.
    const noContainer = (args: string[]) => {
        if (args[0] === 'inspect') throw new Error('Error: No such object');
        // The task supervisor finalized: the group's `wait` answers its exit status.
        return Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
    };

    it('reads a daemon refusal as a container that never started', async () => {
        // The run printed the daemon's error — and so would a command that echoed it. The
        // classifier does not read this stream at all: the daemon says no container exists.
        const runner = dockerRunner(noContainer, {
            spawn: spawnChild(
                '',
                'docker: Error response from daemon: Conflict. The container name is already in use\n',
                125
            ),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
    });

    // Issue #452: the runner is created, handed its managed settings as a root-owned 0444
    // archive, and only then started attached. Nothing inside the container — which runs as the
    // agent's uid — ever writes the file.
    it('creates a claude-code runner, copies its rendered managed settings in, then starts it attached', async () => {
        const calls: { args: string[]; input?: Buffer }[] = [];
        const exec = (args: string[], options?: { input?: Buffer }) => {
            calls.push({ args, ...(options?.input ? { input: options.input } : {}) });
            return noContainer(args);
        };
        const spawnFn = vitest.fn(() => fakeChild('', '', 0));
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0', RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' },
            spawn: spawnFn as unknown as typeof spawn,
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const verbs = calls.map((call) => call.args[0]);
        // The supervisor's group is created first; the agent's own create is the one that names it.
        const create = calls.find((call) => call.args[0] === 'create' && call.args.includes(containerName(job)));
        expect(create).toBeDefined();
        expect(calls.findIndex((call) => call.args.includes(supervisorName(job)))).toBeLessThan(calls.indexOf(create!));
        const cp = calls.find((call) => call.args[0] === 'cp');
        expect(cp?.args).toEqual(['cp', '-', `${containerName(job)}:/etc`]);
        expect(cp?.input?.equals(telemetryConfigTar(telemetryConfig('claude-code', 'http://otel.example:4318')))).toBe(
            true
        );
        expect(verbs.indexOf('create')).toBeLessThan(verbs.indexOf('cp'));
        expect(spawnFn.mock.calls).toEqual([['docker', ['start', '-a', containerName(job)], expect.anything()]]);
    });

    it('copies the rendered otel.json into an opencode runner, where its plugin is pointed', async () => {
        const calls: { args: string[]; input?: Buffer }[] = [];
        const exec = (args: string[], options?: { input?: Buffer }) => {
            calls.push({ args, ...(options?.input ? { input: options.input } : {}) });
            return noContainer(args);
        };
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0', RUNNER_OTEL_ENDPOINT: 'http://otel.example:4318' },
        });
        await runner.run(opencodeJob, null);
        const cp = calls.find((call) => call.args[0] === 'cp');
        expect(cp?.args).toEqual(['cp', '-', `${containerName(opencodeJob)}:/etc`]);
        expect(cp?.input?.equals(telemetryConfigTar(telemetryConfig('opencode', 'http://otel.example:4318')))).toBe(
            true
        );
    });

    // The exited runner container is the evidence a replacement claim adopts a finished run from
    // (`exitedRunners`): the close reads its verdict and leaves it; only the attempt's end removes it.
    it('leaves the exited runner container for the attempt end, not the verdict read (#828)', async () => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            return noContainer(args);
        };
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('done\n', '', 0) });

        expect(await runner.run(job, { id: SESSION, resume: false })).toMatchObject({ exitCode: 0, started: true });
        expect(calls).not.toContainEqual(['rm', '-f', containerName(job)]);

        await runner.finish(job);
        expect(calls).toContainEqual(['rm', '-f', containerName(job)]);
    });

    // The daemon refusing the create (a name conflict, a missing image) or the copy is what a
    // refused `docker run` was: a container that never started, nothing spawned, the leftover
    // removed, and the daemon's own words in the output.
    it.each(['create', 'cp'])('reads a refused %s as a container that never started', async (verb) => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            if (args[0] === verb && (verb !== 'create' || args.includes(containerName(job)))) {
                return Promise.reject(
                    Object.assign(new Error('Command failed'), { stderr: 'Error response from daemon: Conflict\n' })
                );
            }
            return noContainer(args);
        };
        const spawnFn = vitest.fn(() => fakeChild('', '', 0));
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnFn as unknown as typeof spawn });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
        expect(outcome.output).toContain('Error response from daemon: Conflict');
        expect(spawnFn).not.toHaveBeenCalled();
        expect(calls).toContainEqual(['rm', '-f', containerName(job)]);
    });

    // `docker start -a` exits 1 — not run's 125 — when the runtime cannot start the process
    // (a bad mount, a missing binary). The daemon still holds the container as `created`: never
    // started, so the attempt is left to its lease rather than reported as a failed run.
    it('reads a start the runtime refused as a container that never started', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"created","ExitCode":0}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: failed to create task for container\n', 1),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: false });
        // The runtime's words prove no cause: the never-started recovery stands (#824 D11).
        expect(outcome).not.toHaveProperty('startupCause');
    });

    // Issue #824 D11: a container the daemon confirms never started carries the cause its refusal
    // proves, for the loop's one startup decision — on a refused create and a refused attached start
    // alike. A container that ran is a verdict whatever it printed.
    it('stamps the cause a refused agent create proves', async () => {
        const exec = (args: string[]) =>
            args[0] === 'create' && args.includes(containerName(job))
                ? Promise.reject(
                      Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), {
                          stderr: 'Error response from daemon: manifest for claude-executor:latest not found: manifest unknown\n',
                      })
                  )
                : noContainer(args);
        const outcome = await dockerRunner(exec, { env: { RUNNER_SERVICES: '0' } }).run(job, {
            id: SESSION,
            resume: false,
        });
        expect(outcome).toMatchObject({ exitCode: 125, started: false, startupCause: 'image' });
    });

    it('stamps the cause a refused attached start proves', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"created","ExitCode":0}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild(
                '',
                'Error response from daemon: Get "https://registry/v2/": net/http: TLS handshake timeout\n',
                1
            ),
        });
        expect(await runner.run(job, { id: SESSION, resume: false })).toMatchObject({
            started: false,
            startupCause: 'transient',
        });
    });

    // An inspect that could not answer proves no container never ran: what printed may be the agent's
    // own words, so the never-started recovery stands unclassified (Codex r1, class B).
    it('stamps no cause when the daemon could not say the container never ran', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.reject(
                      Object.assign(new Error('Command failed: docker inspect'), {
                          stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.',
                      })
                  )
                : Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: manifest unknown\n', 125),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
        expect(outcome).not.toHaveProperty('startupCause');
    });

    // A start the daemon refused, proven, ran no agent: no report can come, so the refusal is decided
    // before the supervisor's wind-down and no supervisor loss rides on it (Codex r1, class C).
    it('decides a proven start refusal before the supervisor wait, with no loss beside it', async () => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            if (args[0] === 'inspect') return Promise.resolve({ stdout: '{"Status":"created","ExitCode":0}\n' });
            // A supervisor that ended without finalizing, had it been waited for.
            return Promise.resolve({ stdout: args[0] === 'wait' ? '70\n' : '' });
        };
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: invalid mount config for type "bind"\n', 1),
            steps: fakeSteps(undefined, new Promise<never>(() => undefined)).sink,
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ started: false, startupCause: 'config' });
        expect(outcome).not.toHaveProperty('infraLoss');
        expect(calls.some((args) => args[0] === 'wait')).toBe(false);
    });

    // A status alone is no proof a container never ran: one that started and is now `dead` closes
    // 125 too, and what it printed is the agent's own (Codex r2, class B).
    it('reads a container with a start time as one that ran, whatever its status', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"dead","StartedAt":"2026-10-01T00:00:00Z","ExitCode":125}\n' })
                : Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'unauthorized: authentication required\n', 125),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: true });
        expect(outcome).not.toHaveProperty('startupCause');
    });

    // The refusal proven before the wait is the verdict's: the daemon is not asked again, so a later
    // inspect that cannot answer never turns the refused start into a run that failed (Codex r2, class C).
    it('keeps the proven refusal for the verdict, asking the daemon once', async () => {
        let inspects = 0;
        const exec = (args: string[]) => {
            if (args[0] !== 'inspect') return Promise.resolve({ stdout: '' });
            inspects += 1;
            return inspects === 1
                ? Promise.resolve({ stdout: '{"Status":"created","StartedAt":"0001-01-01T00:00:00Z"}\n' })
                : Promise.reject(new Error('daemon unreachable'));
        };
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: invalid mount config for type "bind"\n', 1),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: false, startupCause: 'config' });
        expect(inspects).toBe(1);
    });

    it('stamps no cause on a run that started, whatever it printed', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"exited","ExitCode":1}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', 'Error response from daemon: manifest unknown\n', 1),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: true });
        expect(outcome).not.toHaveProperty('startupCause');
    });

    it('still reads a run that exited non-zero as a verdict', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"exited","ExitCode":1}\n' })
                : Promise.resolve({ stdout: '' });
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('', 'boom\n', 1) });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: true });
    });

    // A runner container removed under the run (issue #560) — `docker rm -f` by hand, a host
    // cleanup — exits the attached start 137, but the agent never ended it: the driver's own kill
    // only kills, so a container the daemon no longer knows is an infrastructure loss.
    it('reads a runner container removed mid-run as an infrastructure loss', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.reject(
                      Object.assign(new Error('Command failed'), {
                          stderr: `Error: No such object: ${containerName(job)}\n`,
                      })
                  )
                : Promise.resolve({ stdout: '' });
        // The supervisor never finalized: a finalizing report would leave nothing for the removal to explain.
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', '', 137),
            steps: fakeSteps(undefined, new Promise<never>(() => undefined)).sink,
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({
            exitCode: 137,
            started: true,
            infraLoss: 'the runner container was removed before it exited (exit 137)',
        });
    });

    // A run the platform took away has no container left to read: no throwaway `docker run` runs.
    it.each([
        ['claude-code with a session', job],
        ['opencode', opencodeJob],
    ])('issues no close-time read for a %s run the platform took away', async (_name, lostJob) => {
        const runs: string[][] = [];
        const exec = (args: string[]) => {
            if (args[0] === 'run') runs.push(args);
            return args[0] === 'inspect'
                ? Promise.reject(
                      Object.assign(new Error('Command failed'), {
                          stderr: `Error: No such object: ${containerName(lostJob)}\n`,
                      })
                  )
                : Promise.resolve({ stdout: '' });
        };
        const runner = dockerRunner(exec, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild('', '', 137),
            steps: fakeSteps(undefined, new Promise<never>(() => undefined)).sink,
        });
        const outcome = await runner.run(lostJob, lostJob === job ? { id: SESSION, resume: false } : null);
        expect(outcome.infraLoss).toBeDefined();
        expect(runs).toEqual([]);
    });

    it('reads an inspect that fails for any other reason as no loss', async () => {
        const exec = (args: string[]) =>
            args[0] === 'inspect'
                ? Promise.reject(new Error('daemon unreachable'))
                : Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('', '', 1) });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 1, started: true });
        expect(outcome).not.toHaveProperty('infraLoss');
    });

    // The full-log accumulator (issue #325): everything the stream printed, tail-kept at the
    // artifact cap — the artifact the loop uploads at close, of which the verdict's rolling tail
    // is only the end. The refused-start path carries neither.
    it('carries the full log on the outcome, capped tail-true, beside the unchanged report tail', async () => {
        // Past the artifact cap (512 KiB), so the accumulator really has to cut.
        const fullOutput = `${'head\n'.repeat(20)}${'body line\n'.repeat(60_000)}`;
        const runner = dockerRunner(noContainer, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild(fullOutput, '', 0),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);
        // The full log is the whole stream tail-kept at the cap: its last line survives, its
        // head was cut, and the flag says so.
        expect(outcome.logTruncated).toBe(true);
        expect(outcome.fullLog?.endsWith('body line\n')).toBe(true);
        expect(Buffer.byteLength(outcome.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        // The rolling tail is unchanged: still the report's 16 KiB window.
        expect(outcome.output.length).toBeLessThanOrEqual(16 * 1024);
        expect(outcome.output.endsWith('body line\n')).toBe(true);
    });

    it('keeps the full log byte-true under the cap when the run never exceeded it', async () => {
        const fullOutput = 'short run\n';
        const runner = dockerRunner(noContainer, {
            env: { RUNNER_SERVICES: '0' },
            spawn: spawnChild(fullOutput, '', 0),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.fullLog).toBe('short run\n');
        expect(outcome.logTruncated).toBe(false);
    });

    it('calls a log of exactly ARTIFACT_LIMIT bytes complete, and one byte more truncated (#825)', async () => {
        for (const [size, truncated] of [
            [ARTIFACT_LIMIT, false],
            [ARTIFACT_LIMIT + 1, true],
        ] as const) {
            const runner = dockerRunner(noContainer, {
                env: { RUNNER_SERVICES: '0' },
                spawn: spawnChild('x'.repeat(size), '', 0),
            });
            const outcome = await runner.run(job, { id: SESSION, resume: false });
            expect(outcome.logTruncated).toBe(truncated);
            expect(Buffer.byteLength(outcome.fullLog ?? '')).toBe(ARTIFACT_LIMIT);
        }
    });

    it('keeps the bytes of a stream that ended inside a character, never drops them (#825)', async () => {
        const runner = dockerRunner(noContainer, {
            env: { RUNNER_SERVICES: '0' },
            spawn: (() => chunkedChild(CUT_SHORT)) as unknown as typeof spawn,
        });

        const outcome = await runner.run(job, { id: SESSION, resume: false });

        expect(outcome.fullLog).toBe('ok\uFFFD');
        expect(outcome.logTruncated).toBe(false);
    });

    it('decodes a multibyte character split across two stream chunks once, whole — below and above the cap (#825)', async () => {
        for (const [body, truncated] of SPLIT_EURO_CASES) {
            const runner = dockerRunner(noContainer, {
                env: { RUNNER_SERVICES: '0' },
                spawn: (() => chunkedChild(splitEuro(body))) as unknown as typeof spawn,
            });

            expectWholeEuro(await runner.run(job, { id: SESSION, resume: false }), truncated);
        }
    });

    // The security constraint the issue states (docs/security.md): forwarded env secrets must
    // not leak into the stored artifacts. The full log is the child's own stream and NOTHING
    // else — pinned by strict equality, so any driver-side injection on the artifact path (the
    // env file's values included) would break it.
    it('makes the full log exactly the stream — no claim env value can enter the artifact', async () => {
        const stdout = 'plain run output\nwith a second line\n';
        const runner = dockerRunner(noContainer, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild(stdout, '', 0) });
        const outcome = await runner.run(
            { ...job, env: { SENTINEL_SECRET: 'shh-do-not-store' } },
            { id: SESSION, resume: false }
        );
        expect(outcome.fullLog).toBe(stdout);
        expect(outcome.fullLog).not.toContain('shh-do-not-store');
    });

    it('reads a container that ran and exited 125 as a verdict, not an infrastructure refusal', async () => {
        // The exact case a stderr signature gets wrong: the command prints `docker: ` itself —
        // an agent reproducing an error, say — and exits 125. The daemon saw the container run
        // and exit, so `started` is true and the code is reported as the command's verdict.
        const inspect = vitest.fn((args: string[]) =>
            args[0] === 'inspect'
                ? Promise.resolve({ stdout: '{"Status":"exited","ExitCode":125}\n' })
                : Promise.resolve({ stdout: '' })
        );
        const runner = dockerRunner(inspect as unknown as (args: string[]) => Promise<{ stdout: string }>, {
            spawn: spawnChild('work done\n', 'reproduced: docker: Error response from daemon: Conflict\n', 125),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: true });
        expect(inspect).toHaveBeenCalled();
    });

    it('never asks the daemon about a run whose exit code is unambiguous', async () => {
        const inspect = vitest.fn((_args: string[]) => Promise.resolve({ stdout: '' }));
        const runner = dockerRunner(inspect as unknown as (args: string[]) => Promise<{ stdout: string }>, {
            spawn: spawnChild('done\n', '', 0),
        });
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        // The fence and the cleanup `rm` go through the same seam; only the inspect is the
        // classifier, and an unambiguous exit code must not pay for one.
        expect(inspect.mock.calls.filter((call) => call[0][0] === 'inspect')).toHaveLength(0);
    });

    it('spawns docker with the claim env in a file, and its own environment untouched', async () => {
        // The values reach the container through the --env-file, so the docker CLI's own
        // environment stays the operator's — a member-configured PATH or DOCKER_* can never steer
        // the CLI this driver executes.
        const spawnFn = vitest.fn((_cmd: string, _argv: string[], _options?: object) => fakeChild('', '', 0));
        let create: string[] = [];
        const exec = (args: string[]) => {
            if (args[0] === 'create' && args.includes(containerName(job))) create = args;
            return noContainer(args);
        };
        const runner = dockerRunner(exec, { spawn: spawnFn as unknown as typeof spawn });
        const outcome = await runner.run({ ...job, env: { MY_TOKEN: 'board-secret' } }, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0 });
        const [cmd, argv, options] = spawnFn.mock.calls[0]!;
        expect(cmd).toBe('docker');
        const fileArg = create[create.indexOf('--env-file') + 1];
        expect(create).toContain('--env-file');
        expect(fileArg).toBeTruthy();
        // The file existed and carried the value while the CLI ran; it is gone once the run is.
        expect(existsSync(fileArg!)).toBe(false);
        // The CLI's environment is inherited, never merged with claim values.
        expect(options && 'env' in options).toBe(false);
        expect([...create, ...(argv as string[])].some((arg) => arg.includes('board-secret'))).toBe(false);
    });

    /**
     * The live-output hook: every chunk that arrives is handed to the caller as the newest tail —
     * the same string a complete report would carry, growing. One call per chunk; throttling is
     * the loop's business.
     */
    it('hands every chunk it reads to the output stream', async () => {
        const tails: string[] = [];
        const runner = dockerRunner(noContainer, { spawn: spawnChild('step one\n', 'warn\n', 0) });

        const outcome = await runner.run(job, { id: SESSION, resume: false }, (tail) => tails.push(tail));

        expect(outcome.exitCode).toBe(0);
        expect(tails).toEqual(['step one\n', 'step one\nwarn\n']);
    });

    /**
     * The vitals sample goes through the same daemon seam as everything else, named by this
     * attempt's lease token — a sample can only ever resolve its own attempt's runner. A daemon
     * that refuses (the container exited between the ask and the read) is null, never a throw:
     * a missed sample costs freshness, not the run.
     */
    it('samples the runner container vitals through the daemon seam', async () => {
        const exec = vitest.fn((args: string[]) => {
            if (args[0] === 'stats') {
                expect(args.slice(1, 4)).toEqual(['--no-stream', '--format', '{{json .}}']);
                expect(args[4]).toBe(containerName(job));
                return Promise.resolve({
                    stdout: '{"CPUPerc":"93.00%","MemPerc":"7.02%","MemUsage":"544MiB / 7.754GiB","Name":"x"}\n',
                });
            }
            // The fleet read answers nothing here: the pin is the vitals shape alone.
            expect(args[0]).toBe('ps');
            return Promise.resolve({ stdout: '' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
        });
    });

    /**
     * The attempt's service fleet rides the same sample (issue #60): the dashboard can answer
     * "did db come up" while the run is going. The read is scoped by the job AND lease label —
     * the attempt-scoping every other per-attempt call leans on — and requires the
     * `factory.service` key, so the runner and gate containers never answer it. `-a` so exited
     * containers report: "did it come up and die" is exactly the honest answer wanted here.
     */
    it('samples the service fleet beside the vitals', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn((args: string[]) => {
            calls.push(args);
            if (args[0] === 'stats') {
                return Promise.resolve({
                    stdout: '{"CPUPerc":"93.00%","MemPerc":"7.02%","MemUsage":"544MiB / 7.754GiB","Name":"x"}\n',
                });
            }
            expect(args[0]).toBe('ps');
            return Promise.resolve({
                stdout:
                    psLine({ name: 'db', image: 'postgres:16', state: 'running' }) +
                    psLine({ name: 'cache', image: 'redis:7', state: 'exited' }),
            });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
            services: [
                { name: 'cache', image: 'redis:7', state: 'exited' },
                { name: 'db', image: 'postgres:16', state: 'running' },
            ],
        });
        const ps = calls.find((args) => args[0] === 'ps')!;
        expect(ps).toContain('-a');
        expect(ps).toContain(`label=factory.job=${job.id}`);
        expect(ps).toContain(`label=factory.lease=${job.leaseToken}`);
        expect(ps).toContain('label=factory.service');
    });

    /**
     * Each half of the sample stands on its own: a fleet read that fails costs the fleet, not the
     * vitals — and never the sample; unreadable vitals must not silence the fleet (null numbers,
     * real states); and only when both reads fail is the sample null.
     */
    const STATS = '{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB","MemPerc":"7.02%"}';
    const refused = new Error('daemon refused');
    it.each<[string, string | Error, string | Error, unknown]>([
        [
            'keeps the vitals when the service read fails',
            STATS,
            refused,
            { cpuPercent: 93, memUsedMb: 544, memPercent: 7.02 },
        ],
        [
            'reports the service fleet even when the vitals read fails',
            refused,
            psLine({ name: 'db', image: 'postgres:16', state: 'running' }),
            {
                cpuPercent: null,
                memUsedMb: null,
                memPercent: null,
                services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
            },
        ],
        ['answers null when the vitals sample cannot be taken', refused, refused, null],
    ])('%s', async (_label, stats, ps, expected) => {
        const answer = (value: string | Error) =>
            value instanceof Error ? Promise.reject(value) : Promise.resolve({ stdout: value });
        const exec = vitest.fn((args: string[]) => answer(args[0] === 'stats' ? stats : ps)) as unknown as (
            args: string[]
        ) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual(expected);
    });

    /** Services off: the sample is exactly what it was before services were sampled. */
    it('does not ask the daemon about services when they are off', async () => {
        const commands: string[] = [];
        const exec = vitest.fn((args: string[]) => {
            commands.push(args[0]!);
            return Promise.resolve({ stdout: '{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB","MemPerc":"7.02%"}' });
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('done\n', '', 0) });

        await expect(runner.sampleRuntime(job)).resolves.toEqual({
            cpuPercent: 93,
            memUsedMb: 544,
            memPercent: 7.02,
        });
        expect(commands).toEqual(['stats']);
    });

    /**
     * The dead half of the fleet (issue #423): an exited or dead service, with the daemon's exit
     * code and reason and the container's last log lines — stdout and stderr both, because an
     * entrypoint's `chown` refusal lands on stderr. Read over the sample's own label scoping; a
     * running service is never inspected.
     */
    it('reads each dead service with its exit, reason and log tail', async () => {
        const calls: string[][] = [];
        const mongo = `factory-job-${job.id}-${job.leaseToken}-svc-mongo`;
        const exec = vitest.fn((args: string[]) => {
            calls.push(args);
            if (args[0] === 'ps') {
                return Promise.resolve({
                    stdout:
                        psLine({ name: 'mongo', image: 'mongo:8', state: 'exited' }) +
                        psLine({ name: 'cache', image: 'redis:7', state: 'dead' }) +
                        psLine({ name: 'db', image: 'postgres:16', state: 'running' }),
                });
            }
            if (args[0] === 'inspect') {
                return Promise.resolve({
                    stdout:
                        args.at(-1) === mongo
                            ? '{"ExitCode":1,"OOMKilled":false,"Error":""}\n'
                            : '{"ExitCode":137,"OOMKilled":true,"Error":""}\n',
                });
            }
            expect(args.slice(0, 3)).toEqual(['logs', '--tail', String(SERVICE_LOG_TAIL_LINES)]);
            return Promise.resolve(
                args.at(-1) === mongo
                    ? { stdout: 'starting\n', stderr: 'chown: Operation not permitted\n' }
                    : { stdout: '' }
            );
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild('done\n', '', 0) });

        await expect(runner.deadServices(job)).resolves.toEqual([
            { name: 'cache', image: 'redis:7', state: 'dead', exitCode: 137, reason: 'OOMKilled', logTail: '' },
            {
                name: 'mongo',
                image: 'mongo:8',
                state: 'exited',
                exitCode: 1,
                reason: null,
                logTail: 'starting\nchown: Operation not permitted\n',
            },
        ]);
        const ps = calls.find((args) => args[0] === 'ps')!;
        expect(ps).toContain('-a');
        expect(ps).toContain(`label=factory.job=${job.id}`);
        expect(ps).toContain(`label=factory.lease=${job.leaseToken}`);
        expect(ps).toContain('label=factory.service');
        expect(calls.some((args) => args.at(-1)?.endsWith('-svc-db'))).toBe(false);
    });

    it('keeps a dead service whose inspect fails, and throws on an unreadable fleet', async () => {
        const fleet = vitest.fn((args: string[]) =>
            args[0] === 'ps'
                ? Promise.resolve({ stdout: psLine({ name: 'mongo', image: 'mongo:8', state: 'exited' }) })
                : Promise.reject(new Error('No such container'))
        ) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        await expect(dockerRunner(fleet, { spawn: spawnChild('done\n', '', 0) }).deadServices(job)).resolves.toEqual([
            { name: 'mongo', image: 'mongo:8', state: 'exited', exitCode: null, reason: null, logTail: '' },
        ]);

        const refused = vitest.fn(() => Promise.reject(new Error('daemon refused'))) as unknown as (
            args: string[]
        ) => Promise<{ stdout: string }>;
        await expect(dockerRunner(refused, { spawn: spawnChild('done\n', '', 0) }).deadServices(job)).rejects.toThrow(
            'daemon refused'
        );
    });

    it('rejects Inconclusive when the fleet listing has a malformed row', async () => {
        const garbage = vitest.fn(() => Promise.resolve({ stdout: '<html>\n' })) as unknown as (
            args: string[]
        ) => Promise<{ stdout: string }>;
        await expect(
            dockerRunner(garbage, { spawn: spawnChild('done\n', '', 0) }).deadServices(job)
        ).rejects.toBeInstanceOf(Inconclusive);
    });

    it('answers no dead services without asking the daemon when services are off', async () => {
        const exec = vitest.fn(() => Promise.resolve({ stdout: '' }));
        const runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnChild('done\n', '', 0) });

        await expect(runner.deadServices(job)).resolves.toEqual([]);
        expect(exec).not.toHaveBeenCalled();
    });

    describe('parseDockerStats', () => {
        // The stats fields are display strings; the parse is worth its own pin.
        it('reads the JSON line the daemon prints', () => {
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB","MemPerc":"7.02%"}')).toEqual({
                cpuPercent: 93,
                memUsedMb: 544,
                memPercent: 7.02,
            });
        });

        it('converts every memory unit to MiB, binary and decimal spellings alike', () => {
            expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"1.5GiB / 8GiB"}')).toMatchObject({
                memUsedMb: 1536,
            });
            expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"512KiB / 8GiB"}')).toMatchObject({
                memUsedMb: 0.5,
            });
            expect(parseDockerStats('{"CPUPerc":"0.00%","MemUsage":"2000kB / 8GiB"}')).toMatchObject({
                memUsedMb: 2,
            });
        });

        it('takes null for a percentage the daemon did not report, and null for garbage', () => {
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB"}')).toMatchObject({
                memPercent: null,
            });
            expect(parseDockerStats('')).toBeNull();
            expect(parseDockerStats('not json')).toBeNull();
            expect(parseDockerStats('{"MemUsage":"544MiB / 7.754GiB"}')).toBeNull();
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"? / 8GiB"}')).toBeNull();
        });

        it('takes null for a null last line, and for valid JSON followed by a non-JSON last line', () => {
            expect(parseDockerStats('null')).toBeNull();
            expect(parseDockerStats('{"CPUPerc":"93.00%","MemUsage":"544MiB / 7.754GiB"}\nnoise')).toBeNull();
        });
    });

    describe('parseDockerServicePs', () => {
        it('reads name, image and state off one ps line', () => {
            expect(parseDockerServicePs(psLine({ name: 'db', image: 'postgres:16', state: 'running' }))).toEqual([
                { name: 'db', image: 'postgres:16', state: 'running' },
            ]);
        });

        it('reads every line, sorted by name', () => {
            const out = parseDockerServicePs(
                `${psLine({ name: 'db', image: 'postgres:16', state: 'running' })}${psLine({ name: 'cache', image: 'redis:7', state: 'exited' })}`
            );
            expect(out).toEqual([
                { name: 'cache', image: 'redis:7', state: 'exited' },
                { name: 'db', image: 'postgres:16', state: 'running' },
            ]);
        });

        it('answers null when any row lacks the service label, an image or a state, or is not a record', () => {
            const good = psLine({ name: 'db', image: 'postgres:16', state: 'running' });
            const unlabeled = good.replace(/factory\.service=db,?/, '');
            expect(parseDockerServicePs(unlabeled)).toBeNull();
            expect(parseDockerServicePs(`${good}<html>\n`)).toBeNull();
            expect(parseDockerServicePs(`${good}not json\n`)).toBeNull();
            expect(parseDockerServicePs(`${good}[]\n`)).toBeNull();
            expect(parseDockerServicePs(`${good}${psLine({ name: 'ok', image: '', state: 'running' })}`)).toBeNull();
            expect(parseDockerServicePs(`${good}${psLine({ name: 'ok2', image: 'redis:7', state: '' })}`)).toBeNull();
        });

        it('answers empty for empty output', () => {
            expect(parseDockerServicePs('')).toEqual([]);
            expect(parseDockerServicePs('\n\n')).toEqual([]);
        });
    });

    describe('currentActivity', () => {
        // The activity line is the stream's last non-empty line with its escapes stripped — the
        // tool call most of the time. A heuristic on purpose: the stream is the CLI's to format.
        it('strips ANSI escapes and takes the last non-empty line', () => {
            expect(currentActivity('$ npm test\n\x1b[32m→ Read src/x.ts\x1b[0m\n')).toBe('→ Read src/x.ts');
            expect(currentActivity('one\n\n  \ntwo')).toBe('two');
        });

        it('caps the line and takes null for a tail that says nothing', () => {
            expect(currentActivity('x'.repeat(500))!.length).toBe(200);
            expect(currentActivity(null)).toBeNull();
            expect(currentActivity('\n\n')).toBeNull();
            expect(stripAnsi('\x1b]0;title\x07after')).toBe('after');
        });
    });

    // A gated job whose claim resolves to no variables still needs the minted gate credentials:
    // keyed on the claim alone, the file would not exist and the runner could never call a gate.
    it('writes the gate credentials into the env file of a job whose claim env is empty', async () => {
        let fileBody: string | null = null;
        let create: string[] = [];
        const exec = (args: string[]) => {
            // Read at create time, through the argv: what the CLI could see is what counts.
            if (args[0] === 'create' && args.includes(containerName(job))) {
                create = args;
                fileBody = readFileSync(args[args.indexOf('--env-file') + 1]!, 'utf8');
            }
            return noContainer(args);
        };
        const runner = dockerRunner(exec);

        const outcome = await runner.run(
            { ...job, gateEnv: { BELLOWS_GATE_URL: 'http://host.docker.internal:9099', BELLOWS_GATE_TOKEN: 'tok' } },
            { id: SESSION, resume: false }
        );

        expect(outcome).toMatchObject({ exitCode: 0 });
        expect(create).toContain('--env-file');
        expect(fileBody).toBe(
            'BELLOWS_GATE_URL=http://host.docker.internal:9099\nBELLOWS_GATE_TOKEN=tok\n' +
                `RUNNER_JOB_ID=${job.id}\nRUNNER_LEASE_TOKEN=${job.leaseToken}\n`
        );
    });

    // The lease lost DURING the env-file write: the kill-check just above the write has already
    // passed, and the write's await breaks the synchronous gap the setup promises. Without one
    // more check, the runner spawns over a dead lease — its job-derived container name colliding
    // with the replacement's. On that abort the just-written file must go too: the cleanup around
    // the outcome only covers a settled run, and this throw precedes it.
    //
    // The env-file write is INJECTED here (the constructor's `files` seam) rather than observed
    // through a node:fs/promises mock: under isolate:false that mock only binds when docker.js
    // first executes in a worker, and a copy cached by scripts.test.ts's import once bypassed
    // this park entirely — the run completed, and the test waited on a write that never came.
    it('spawns nothing when the lease is lost during the env-file write, and leaves no file behind', async () => {
        let releaseWrite: (() => void) | null = null;
        const writeReleased = new Promise<void>((resolve) => {
            releaseWrite = resolve;
        });
        let markWrite: (() => void) | null = null;
        const writeUnderway = new Promise<void>((resolve) => {
            markWrite = resolve;
        });
        let writtenTo: string | null = null;
        const files: RunnerFiles = {
            writeFile: async (path, data, options) => {
                writtenTo = String(path);
                markWrite!();
                await writeReleased;
                return writeFile(path, data, options);
            },
            rm,
        };

        const spawnSpy = vitest.fn(() => fakeChild('', '', 0));
        const runner = dockerRunner(noContainer, { spawn: spawnSpy as unknown as typeof spawn, files: files });

        const pending = runner.run({ ...job, env: { MY_TOKEN: 'board-secret' } }, { id: SESSION, resume: false });
        await writeUnderway; // the run is parked inside the env-file write

        await runner.kill(job); // the lease dies while the write is pending
        releaseWrite!(); // the write lands; the run now learns its lease is gone

        await expect(pending).rejects.toThrow(/killed while (setting up services|its task group came up)/);
        expect(spawnSpy).not.toHaveBeenCalled();
        // No leak: the file the write just created is removed on the abort path.
        expect(writtenTo).toBeTruthy();
        expect(existsSync(writtenTo!)).toBe(false);
    });

    // Issue #452 split the launch into create → cp → start, and the create and the copy are
    // awaits too: a lease lost behind them must not reach the start. The created container is
    // this attempt's own leftover, removed by name, and the env file goes with it.
    it('starts nothing when the lease is lost during the create, and leaves no container or file behind', async () => {
        const calls: string[][] = [];
        let envFile: string | null = null;
        let runner: ReturnType<typeof createDockerRunner> | null = null;
        const exec = async (args: string[]) => {
            calls.push(args);
            if (args[0] === 'create' && args.includes(containerName(job))) {
                envFile = args[args.indexOf('--env-file') + 1]!;
                await runner!.kill(job); // the lease dies while the create is pending
            }
            return noContainer(args);
        };
        const spawnSpy = vitest.fn(() => fakeChild('', '', 0));
        runner = dockerRunner(exec, { env: { RUNNER_SERVICES: '0' }, spawn: spawnSpy as unknown as typeof spawn });

        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /killed while setting up services/
        );
        expect(spawnSpy).not.toHaveBeenCalled();
        expect(calls).toContainEqual(['rm', '-f', containerName(job)]);
        expect(envFile).toBeTruthy();
        expect(existsSync(envFile!)).toBe(false);
    });
});

/** The suite's job with no services on the claim, for the block below that shadows `job`. */
const baseJob = job;

/*
 * Auxiliary services (issue #6, resolved at claim time by issue #769). The switch is on in this
 * whole block, and the daemon is scripted on argv shape: the service runs (they carry
 * --network-alias) answer created, the label `ps` answers one container id, and everything else
 * succeeds empty. The spawn stands in for the runner container itself and records the argv it was
 * given. The services ride on the claim: this block's `job` declares the one `stub` service.
 */
describe('auxiliary services (RUNNER_SERVICES)', () => {
    const STUB: ServiceSpec = { name: 'stub', image: 'stub-svc:1', environment: [] };
    // A repo, as every claim that carries services has: the loop's sync creates the group first.
    const job: BoardJob = { ...baseJob, repo: 'Bellows-AI/factory', services: [STUB] };
    // The declared fleet is process-wide and the suite runs isolate: false — a failed test must not leak it.
    afterEach(() => forgetDeclaredServices(job));
    /** A restart's stand-down signal that never fires. */
    const live = new AbortController().signal;

    const daemon = (opts: { serviceFails?: boolean } = {}) =>
        vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) {
                if (opts.serviceFails) throw new Error('daemon refused the service');
                return { stdout: '' };
            }
            // The readiness wait's listing: the declared stub, running.
            if (args[0] === 'ps' && args.includes('{{json .}}')) {
                return {
                    stdout: JSON.stringify({ Labels: 'factory.service=stub', Image: 'stub-svc:1', State: 'running' }),
                };
            }
            // The attempt's own service: what the fence's lease-labelled listing shows for it.
            if (args[0] === 'ps')
                return { stdout: args.includes('--format') ? `c0ffee000001\t${job.leaseToken}\n` : 'c0ffee000001\n' };
            // The task supervisor finalized: the group's `wait` answers its exit status.
            if (args[0] === 'wait') return { stdout: '0\n' };
            return { stdout: '' };
        });

    const spawnRecording = (stdout: string, code: number | null) => {
        const seen: string[][] = [];
        const fn = ((_command: string, argv: string[]) => {
            seen.push(argv);
            const c = new EventEmitter() as ChildProcess;
            const stream = (text: string) => {
                const s = new EventEmitter() as Readable;
                if (text) process.nextTick(() => s.emit('data', Buffer.from(text)));
                return s;
            };
            c.stdout = stream(stdout);
            c.stderr = stream('');
            process.nextTick(() => c.emit('close', code));
            return c;
        }) as unknown as typeof spawn;
        return { fn, seen };
    };

    /**
     * The loop's order (PR 737): its setup phase starts the services — before the gate
     * environment's setup — and run() spawns the runner. A refused start ends there.
     */
    let startingServices = 0;
    const asLoop = (runner: ReturnType<typeof createDockerRunner>): ReturnType<typeof createDockerRunner> => ({
        ...runner,
        run: async (j, session, onOutput) => {
            await runner.syncCheckout(j, undefined, session);
            startingServices += 1;
            let refused: Awaited<ReturnType<typeof runner.startServices>>;
            try {
                refused = await runner.startServices(j);
            } finally {
                startingServices -= 1;
            }
            return refused ?? runner.run(j, session, onOutput);
        },
    });
    /**
     * The fakes below script `docker ps` for the fence, teardown and probes; while a start waits for
     * its fleet, the readiness listing answers every service the daemon was asked to run, running —
     * what docker would say once they are up. Outside a start the fake's own answer stands.
     */
    const readyWhileStarting = (exec: unknown): Parameters<typeof createDockerRunner>[2] => {
        const seen: string[][] = [];
        const inner = exec as (args: string[], options?: object) => Promise<{ stdout: string }>;
        return (async (args: string[], options?: object) => {
            seen.push(args);
            if (startingServices > 0 && args[0] === 'ps' && args.includes('{{json .}}')) return runningServicesPs(seen);
            return inner(args, options);
        }) as Parameters<typeof createDockerRunner>[2];
    };
    const bareServicesRunner = (exec: ReturnType<typeof daemon>, fn: typeof spawn) =>
        dockerRunner(readyWhileStarting(exec), {
            env: { RUNNER_SERVICES: '1' },
            spawn: fn,
        });
    const servicesRunner = (exec: ReturnType<typeof daemon>, fn: typeof spawn) => asLoop(bareServicesRunner(exec, fn));

    // A spawn stub whose children never emit on their own: each spawn hands the test a fire
    // function, so the interleaving — one attempt's error or close landing after another
    // attempt's fleet is already up — is the test's to pace. `track`, when given, sees every
    // spawned argv: it is how the cross-instance tests register the runner container on the
    // scripted daemon, whose `docker run` goes through spawnFn and never through the exec seam.
    const gatedSpawns = (track?: (argv: string[]) => void) => {
        const fires: ((what: 'error' | 'close', payload?: unknown) => void)[] = [];
        const fn = ((_command: string, argv: string[]) => {
            track?.(argv);
            const c = new EventEmitter() as ChildProcess;
            const stream = () => {
                const s = new EventEmitter() as Readable;
                return s;
            };
            c.stdout = stream();
            c.stderr = stream();
            fires.push((what, payload) => process.nextTick(() => c.emit(what, payload)));
            return c;
        }) as unknown as typeof spawn;
        const childAt = async (index: number): Promise<(what: 'error' | 'close', payload?: unknown) => void> => {
            // A macrotask per turn, never a bare microtask wait: the runner now always writes its
            // env file (real fs) between setup and spawn, and a wait that never leaves the
            // microtask queue would starve the event loop — the I/O completion the next spawn
            // waits behind could never run.
            while (fires.length <= index) await new Promise((r) => setImmediate(r));
            return fires[index]!;
        };
        return { fn, fires, childAt };
    };

    /*
     * The attempt-scoping helpers. Two attempts of one job — the stale-race cast, used by every
     * test below that replays an interleaving between an attempt A and its replacement B. The
     * lease-aware ps answer is what makes "A's removals never carry B's id" assertable: a `ps`
     * whose filters carry a lease label answers with that attempt's own id only (idFor mints it
     * from the token's first letter), while a job-scoped `ps` — the fence's — answers with both
     * attempts'. touchesB is the blanket assertion: no argv element of a stale attempt may
     * contain any of B's identifiers.
     */
    const ATTEMPT_A = 'aaaaaaa2-2222-4222-8222-222222222222';
    const ATTEMPT_B = 'bbbbbbb3-3333-4333-8333-333333333333';
    const attemptA: BoardJob = { ...job, leaseToken: ATTEMPT_A };
    const attemptB: BoardJob = { ...job, leaseToken: ATTEMPT_B };
    const idFor = (token: string): string => token.slice(0, 1).repeat(12);
    const touchesB = (args: string[]): boolean => args.some((arg) => arg.includes(ATTEMPT_B) || arg === 'bbbbbbbbbbbb');
    const psAnswer = (args: string[]): string => {
        const lease = args.find((arg) => arg.startsWith('label=factory.lease='))?.split('=')[2];
        // A lease-scoped ps answers with that attempt's own id; a job-scoped one — the fence's —
        // answers with a neutral leftover, because the fence legitimately removes EVERYTHING the
        // job label covers: that is its role, and it runs before anything is created.
        return lease ? `${idFor(lease)}\n` : psListing(args, 'a6a6a6a6a6a6');
    };

    // Issue #773: the service joins its group supervisor's network namespace, so the group — its
    // supervisor started, its hosts file naming the service on loopback — comes first.
    it('starts the claim’s service in its started group’s namespace, and the runner joins it too', async () => {
        const exec = daemon();
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await servicesRunner(exec, fn).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        const supervisorAt = calls.findIndex((a) => a.join(' ') === `start ${supervisorName(job)}`);
        const serviceAt = calls.findIndex((a) => isServiceRun(a));
        expect(supervisorAt).toBeGreaterThanOrEqual(0);
        expect(serviceAt).toBeGreaterThan(supervisorAt);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
        expect(calls[serviceAt]).toEqual(serviceRunArgs(job, STUB, supervisorName(job)));
        // The runner shares the namespace — that is the whole feature: inside the job, `stub`
        // resolves to the service on loopback.
        expect(seen[0]).toEqual(['start', '-a', containerName(job)]);
        expect(calls.find((a) => a[0] === 'create' && a.includes(containerName(job)))).toEqual(
            dockerArgs(
                loadDriverConfig({ RUNNER_SERVICES: '1' }),
                job,
                { id: SESSION, resume: false },
                { envFile: envFilePath(job) }
            )
        );
    });

    it('starts every service the claim carries, a declared port changing no argv', async () => {
        const planned: BoardJob = {
            ...job,
            services: [
                { name: 'postgres', image: 'postgres:1', environment: [], ports: [5432] },
                { name: 'redis', image: 'redis:1', environment: [], user: { uid: 999, gid: 999 } },
            ],
        };
        const exec = daemon();
        const outcome = await servicesRunner(exec, spawnRecording('ran\n', 0).fn).run(planned, {
            id: SESSION,
            resume: false,
        });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const started = exec.mock.calls.map((call) => call[0]).filter((a) => isServiceRun(a));
        expect(started).toEqual([
            serviceRunArgs(
                planned,
                { name: 'postgres', image: 'postgres:1', environment: [] },
                supervisorName(planned)
            ),
            serviceRunArgs(
                planned,
                { name: 'redis', image: 'redis:1', environment: [], user: { uid: 999, gid: 999 } },
                supervisorName(planned)
            ),
        ]);
        expect(started.every((a) => !a.includes('5432'))).toBe(true);
    });

    // An attempt that synced none (an adopted run) gets its group made first: a supervisor to join.
    it('runs nothing but the services, and creates no network: no readout container is ever run', async () => {
        const exec = daemon();
        const runner = bareServicesRunner(exec, spawnRecording('', 0).fn);
        await expect(runner.startServices(job)).resolves.toBeNull();

        const calls = exec.mock.calls.map((call) => call[0]);
        const runs = calls.filter((a) => a[0] === 'run');
        expect(runs).toEqual([serviceRunArgs(job, STUB, supervisorName(job))]);
        expect(runs.some((a) => a.includes('--entrypoint') || a.includes('sh'))).toBe(false);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
        expect(calls.findIndex((a) => a.join(' ') === `start ${supervisorName(job)}`)).toBeLessThan(
            calls.findIndex((a) => isServiceRun(a))
        );
    });

    it('starts nothing and changes no argv when the claim carries no services', async () => {
        // The path every existing repo takes: no services on the claim, no network, byte-identical
        // runner argv, exercised end to end rather than only at the dockerArgs parameter.
        const exec = daemon();
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await servicesRunner(exec, fn).run(baseJob, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(seen[0]).toEqual(['start', '-a', containerName(baseJob)]);
        expect(calls.find((a) => a[0] === 'create' && a.includes(containerName(baseJob)))).toEqual(
            dockerArgs(
                loadDriverConfig({ RUNNER_SERVICES: '1' }),
                baseJob,
                { id: SESSION, resume: false },
                { envFile: envFilePath(baseJob) }
            )
        );
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
        expect(calls.every((a) => !isServiceRun(a))).toBe(true);
    });

    /*
     * The fleet outlives run(): the loop runs the declared gates after it, and those are what
     * test against the services. The close tears down only the runner container; the loop's
     * releaseServices takes the fleet down once the gates are done.
     */
    it('keeps the services up past the run, and tears them down on release', async () => {
        const exec = daemon();
        const runner = servicesRunner(exec, spawnRecording('', 1).fn);
        await runner.run(job, { id: SESSION, resume: false });

        const serviceAt = exec.mock.calls.findIndex((call) => isServiceRun(call[0]));
        const afterSetup = exec.mock.calls.slice(serviceAt).map((call) => call[0]);
        expect(afterSetup).not.toContainEqual(['rm', '-f', 'c0ffee000001']);

        const releasedAt = exec.mock.calls.length;
        await runner.releaseServices(job);
        const released = exec.mock.calls.slice(releasedAt).map((call) => call[0]);
        expect(released).toContainEqual(['rm', '-f', 'c0ffee000001']);
        expect(released.some((a) => a[0] === 'network')).toBe(false);
    });

    // Review: setup must not race a fleet still starting — the start answers only once every
    // service runs, and one that never does is a ServicesNotRunning, as in the restart.
    const readinessDaemon = (states: string[]) => {
        const base = daemon();
        let polls = 0;
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps' && args.includes('{{json .}}')) {
                const State = states[Math.min(polls++, states.length - 1)];
                return { stdout: JSON.stringify({ Labels: 'factory.service=stub', Image: 'stub-svc:1', State }) };
            }
            return base(args);
        });
        return { exec, polls: () => polls };
    };
    const startWith = (
        exec: ReturnType<typeof readinessDaemon>['exec'],
        signal?: AbortSignal,
        kill: AbortSignal = new AbortController().signal
    ) =>
        startJobServices(
            job,
            loadDriverConfig({ RUNNER_SERVICES: '1' }),
            {
                execDocker: exec as unknown as (args: string[]) => Promise<{ stdout: string; stderr: string }>,
                ledger: { was: () => ({ stopped: false, hard: false }), signal: () => kill },
                serviceTeardown: async () => {},
                sleep: async () => {},
            },
            signal
        );

    it('startServices answers only once every service runs', async () => {
        const d = readinessDaemon(['created', 'running']);
        await expect(startWith(d.exec)).resolves.toBeNull();
        expect(d.polls()).toBe(2);
    });

    it('startServices rejects with ServicesNotRunning when a service exits', async () => {
        const d = readinessDaemon(['exited']);
        await expect(startWith(d.exec)).rejects.toBeInstanceOf(ServicesNotRunning);
    });

    // #869: the listing the readiness wait reads ends on the supplied stand-down and on the attempt's kill.
    it.each(['the supplied stand-down', 'the attempt’s kill'])(
        'startServices ends a pending listing on %s',
        async (who) => {
            const stand = new AbortController();
            const kill = new AbortController();
            const hang = vitest.fn((args: string[], options?: { signal?: AbortSignal }) =>
                args[0] === 'ps' && args.includes('{{json .}}') ? hangsUntilAborted(options) : daemon()(args)
            );
            const pending = startWith(hang as never, stand.signal, kill.signal);
            await vitest.waitFor(() => expect(hang.mock.calls.some((call) => call[0]![0] === 'ps')).toBe(true));
            (who === 'the supplied stand-down' ? stand : kill).abort();
            expect(await endsSoon(pending)).toBe(true);
        }
    );

    // Review (PR 737): the loop starts the services before the gate environment's setup, so run()
    // must neither start them again nor fence them away; the runner joins their namespace.
    it('run() starts no services after the loop started them, and the runner joins their namespace', async () => {
        const exec = daemon();
        const runner = bareServicesRunner(exec, spawnRecording('', 0).fn);
        await runner.syncCheckout(job, undefined, { id: SESSION, resume: false });
        await expect(runner.startServices(job)).resolves.toBeNull();
        const startedAt = exec.mock.calls.length;
        await runner.run(job, { id: SESSION, resume: false });

        const during = exec.mock.calls.slice(startedAt).map((call) => call[0]);
        expect(during.some((a) => a[0] === 'network')).toBe(false);
        const readsBellows = (a: string[]) => a.some((arg) => arg.startsWith('BELLOWS_ROOT='));
        expect(during.some((a) => a[0] === 'run' && (isServiceRun(a) || readsBellows(a)))).toBe(false);
        const created = during.find((a) => a[0] === 'create' && a.includes(containerName(job)));
        expect(created?.[created.indexOf('--network') + 1]).toBe(`container:${supervisorName(job)}`);
    });

    // Issue #773: no network is an attempt's, so the fence lists none.
    it("run()'s fence spares this attempt's own containers, and lists no network", async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps' && args.includes('--format')) {
                return {
                    stdout: `b0b0b0b0b001\t${job.leaseToken}\nb0b0b0b0b002\taaaaaaaa-1111-4111-8111-aaaaaaaaaaaa\n`,
                };
            }
            return { stdout: '' };
        });
        await bareServicesRunner(exec, spawnRecording('', 0).fn).run(job, { id: SESSION, resume: false });

        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['rm', '-f', 'b0b0b0b0b002']);
        expect(calls).not.toContainEqual(['rm', '-f', 'b0b0b0b0b001']);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
    });

    // The fence takes other attempts' leftovers before the group exists; this lease's own are
    // the service start's to clear, before the first service runs.
    it('clears leftover services before the first service starts', async () => {
        const exec = daemon();
        await servicesRunner(exec, spawnRecording('', 0).fn).run(job, { id: SESSION, resume: false });

        const calls = exec.mock.calls.map((call) => call[0]);
        const firstPsAt = calls.findIndex((a) => a[0] === 'ps');
        const serviceAt = calls.findIndex((a) => isServiceRun(a));
        expect(firstPsAt).toBeGreaterThanOrEqual(0);
        expect(firstPsAt).toBeLessThan(calls.findIndex((a) => a[0] === 'create'));
        expect(calls.slice(0, serviceAt).some((a) => a[0] === 'rm' && a[1] === '-f' && a[2] === 'c0ffee000001')).toBe(
            true
        );
    });

    it('sends a refused service to the lease, after tearing down what did start', async () => {
        const exec = daemon({ serviceFails: true });
        const { fn, seen } = spawnRecording('', 0);
        await expect(servicesRunner(exec, fn).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not start service "stub"/
        );
        expect(seen).toHaveLength(0);
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(['rm', '-f', 'c0ffee000001']);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
    });

    it('kill() stops the runner at once and leaves the services to end(): releaseServices reclaims them', async () => {
        const exec = daemon();
        await servicesRunner(exec, spawnRecording('', 0).fn).kill(job);
        const calls = exec.mock.calls.map((call) => call[0]);
        // The runner is resolved through this attempt's own labels and killed by ID — never by
        // name, which a stale attempt's kill could otherwise compute against a replacement's
        // container. The hard kill takes the whole group: the supervisor and the exporter too.
        expect(calls).toContainEqual([
            'ps',
            '-aq',
            '--filter',
            `label=factory.job=${job.id}`,
            '--filter',
            `label=factory.lease=${job.leaseToken}`,
        ]);
        expect(calls).toContainEqual(['kill', 'c0ffee000001']);
        // The recovery evidence outlives the safety kill: the services go with end()'s retention-gated release.
        expect(calls).not.toContainEqual(['rm', '-f', 'c0ffee000001']);
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.releaseServices(job);
        expect(exec.mock.calls.map((call) => call[0])).toContainEqual(['rm', '-f', 'c0ffee000001']);
        expect(exec.mock.calls.map((call) => call[0]).some((a) => a[0] === 'network')).toBe(false);
    });

    // A lost lease fires kill() while the setup may still be awaiting the daemon. Throwing is the
    // loop's contract for it — the outcome of a lost lease is discarded, and the next attempt's
    // fence removes whatever was already created — so the abort's only job is to stop THIS
    // attempt from creating more resources and from spawning the runner over a lease that is gone.
    it('aborts the setup, creating nothing more and spawning nothing, when the job is killed mid-setup', async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) {
                // The lease is lost while the service start is in flight; kill() is what the loop
                // calls, and it must be recorded before the start resolves.
                await handle.kill!(job);
                return { stdout: '' };
            }
            if (args[0] === 'ps') return { stdout: psListing(args, 'c0ffee000001') };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /killed while setting up services/
        );
        // The start in flight when the kill landed is the last thing the attempt created.
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls.filter((a) => isServiceRun(a))).toHaveLength(1);
        expect(seen).toHaveLength(0);
    });

    it('removes nothing when the job is killed while the fence is still listing the leftovers', async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps' && args.includes('-a')) {
                await handle.kill!(job);
                return { stdout: psListing(args, 'c0ffee000001') };
            }
            return { stdout: '' };
        });
        const { fn } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow();

        expect(exec.mock.calls.map((call) => call[0]).filter((a) => a.includes('c0ffee000001'))).toEqual([]);
    });

    // The two-attempt race: A loses its lease mid-setup and B claims the same job id before A
    // aborts — the loop dedups by nothing. A kill names ATTEMPT A; B carries a fresh lease
    // token that was never killed, so B must proceed, and A must stay aborted. Keyed by job
    // id, one marker serves both attempts: B's claim would either be aborted by a kill meant
    // for A, or wipe the marker and revive A to compete for the same containers.
    it('aborts only the killed attempt when a sibling attempt of the same id claims the job', async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        let killedA = false;
        let releaseA: (() => void) | null = null;
        const killRecorded = new Promise<void>((resolve) => {
            releaseA = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) {
                if (!killedA) {
                    // A's lease is lost while its service start is in flight; the loop's kill()
                    // must be on record before the start resolves.
                    killedA = true;
                    await handle.kill!(attemptA);
                    releaseA!();
                }
                return { stdout: '' };
            }
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        // runA rejects as soon as its kill lands — before the test observes it — so mark it
        // handled now; an interim unhandled-rejection state here derails the test worker.
        runA.catch(() => undefined);
        await killRecorded;
        // Everything issued so far is A's: the kill window closes here, before B starts.
        const aEnd = exec.mock.calls.length;
        // B's claim lands while A is still between awaited steps — nothing stops it.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });

        // A was the attempt the loop killed: it aborts.
        await expect(runA).rejects.toThrow(/killed while setting up services/);
        // And nothing A issued on its way out — kill and teardown included — named anything of
        // B's: the ps filters carry A's lease, and B's token appears in no argv.
        const aCalls = exec.mock.calls.slice(0, aEnd).map((call) => call[0]);
        expect(aCalls.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(aCalls.every((a) => !touchesB(a))).toBe(true);

        // B was never killed, whatever happened to A: group, service, spawn all happen —
        // under B's OWN names, since every name carries B's token.
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
        // A's start was in flight when its kill landed; it went no further. B started its own
        // service, in its own supervisor's namespace — labeled like everything the attempt stands up.
        const services = exec.mock.calls.map((call) => call[0]).filter((a) => isServiceRun(a));
        expect(services).toEqual([
            serviceRunArgs(attemptA, STUB, supervisorName(attemptA)),
            serviceRunArgs(attemptB, STUB, supervisorName(attemptB)),
        ]);
        expect(seen).toHaveLength(1);
    });

    // The abort must not disturb a sibling attempt's fleet. In the gated world that needed a
    // teardown-FREE abort; in the scoped world the kill's teardown ISSUES its daemon calls and
    // is safe because of what it names: every ps carries A's lease, every removal carries A's
    // id. B claims with a fresh token and stands its fleet up afterwards,
    // untouched — nothing A issued could resolve to it.
    it("scopes a killed attempt's teardown to its own lease, leaving a sibling attempt's fleet alone", async () => {
        const handle: { kill: ((j: BoardJob) => Promise<void>) | null } = { kill: null };
        let killedA = false;
        let releaseKill: (() => void) | null = null;
        const killSettled = new Promise<void>((resolve) => {
            releaseKill = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) {
                if (!killedA) {
                    // A's lease is lost while its service start is in flight; kill() — its own
                    // teardown included — must be fully settled before the start resolves.
                    killedA = true;
                    await handle.kill!(attemptA);
                    releaseKill!();
                }
                return { stdout: '' };
            }
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = servicesRunner(exec, fn);
        handle.kill = runner.kill;

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        // runA rejects as soon as its kill lands — before the test observes it — so mark it
        // handled now; an interim unhandled-rejection state here derails the test worker.
        runA.catch(() => undefined);
        await killSettled;
        await expect(runA).rejects.toThrow(/killed while setting up services/);

        // Everything so far is A's: the kill and its teardown ran — and every call of them is
        // scoped to A. The ps filters carry A's lease, the removals carry A's id, and no argv
        // element names anything of B's.
        const aCalls = exec.mock.calls.map((call) => call[0]);
        expect(aCalls.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(aCalls).toContainEqual(['kill', idFor(ATTEMPT_A)]);
        expect(aCalls).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(aCalls.some((a) => a[0] === 'network')).toBe(false);
        expect(aCalls.every((a) => !touchesB(a))).toBe(true);

        // B, the newer attempt for the same job id: fence, group, service start and runner
        // spawn all happen after A's abort — and nothing A did on the way out disturbed
        // them.
        const outcome = await runner.run(attemptB, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        expect(calls).toContainEqual(serviceRunArgs(attemptB, STUB, supervisorName(attemptB)));
        expect(seen).toHaveLength(1);
    });

    // A's close that lands LATE, over B's live fleet, two ways:
    // - killed: A was killed — kill() tore A's own fleet down while it was still legitimately A's
    //   own — and the loop re-claimed the job as B before A's CLI client finally exited (137).
    // - natural close: NO kill anywhere — the lease expires server-side and the board re-claims
    //   the job as B before any heartbeat delivers 'lost', so A's `killed` marker is never
    //   recorded. B's fence removes A's leftovers, which closes A's CLI client (0). Not-killed is
    //   not a free pass to skip the release — it runs unconditionally.
    // Either way the loop's release after A's verdict still runs its teardown, gate-free: the
    // teardown is scoped to A's lease, so whatever it names is A's own, and B's live fleet is
    // structurally unaddressable no matter how late the close lands.
    it.each([
        ["a killed attempt's", true, 137],
        ["a natural close's", false, 0],
    ])(
        'scopes %s late verdict teardown to its own lease when the replacement has stood its fleet up',
        async (_label, killA, closeCode) => {
            // Both children hold their close until released, so the interleaving — A still alive
            // while B stands its fleet up, then A's close landing over it — is the test's to pace.
            const closers: (() => void)[] = [];
            const gatedSpawn = ((_command: string, _argv: string[]) => {
                const c = new EventEmitter() as ChildProcess;
                const stream = () => {
                    const s = new EventEmitter() as Readable;
                    return s;
                };
                c.stdout = stream();
                c.stderr = stream();
                closers.push(() => process.nextTick(() => c.emit('close', closeCode)));
                return c;
            }) as unknown as typeof spawn;
            const closeOf = async (index: number): Promise<() => void> => {
                // Same macrotask yield as childAt above: the runner's env-file write is real fs on the
                // way to each spawn, and a microtask-only wait would starve it.
                while (closers.length <= index) await new Promise((r) => setImmediate(r));
                return closers[index]!;
            };

            const exec = vitest.fn(async (args: string[]) => {
                if (isServiceRun(args)) return { stdout: '' };
                if (args[0] === 'ps') return { stdout: psAnswer(args) };
                return { stdout: '' };
            });
            const runner = servicesRunner(exec, gatedSpawn);

            const runA = runner.run(attemptA, { id: SESSION, resume: false });
            const closeA = await closeOf(0); // A spawned; its CLI client is alive
            // Killed: the loop loses A's lease and kills the attempt — A's own fleet torn down while
            // it is still legitimately A's. Natural close: no kill in between; the heartbeat has not
            // yet told the loop A's lease is gone, and B's fence removes A's leftovers by label.
            if (killA) await runner.kill(attemptA);
            // B re-claims the same job id and stands a fresh fleet up.
            const runB = runner.run(attemptB, { id: SESSION, resume: false });
            await closeOf(1); // B spawned; its group and service are live
            const afterBCreation = exec.mock.calls.length;

            // A's CLI client only now exits — daemon slowness, or B's fence, makes the close
            // arbitrarily late — and its verdict lands over B's live fleet; the loop releases A's
            // services after it.
            closeA();
            await runA;
            await runner.releaseServices(attemptA);

            const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
            // The teardown ran — and every call of it is A's: the ps filters carry A's lease, the
            // removals carry A's id, and nothing names B.
            expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
            expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
            expect(late.some((a) => a[0] === 'network')).toBe(false);
            expect(late.every((a) => !touchesB(a))).toBe(true);

            // B is untouched and still finishes under its own verdict.
            closers[1]!();
            await expect(runB).resolves.toMatchObject({ exitCode: closeCode, started: true });
        }
    );

    // The late-kill twin of the two close tests above: the kill itself arrives AFTER the
    // replacement claimed the job and stood its fleet up — the heartbeat can be arbitrarily
    // slow to deliver the lease loss, and the claim loop has no per-job dedupe. There is no
    // gate to stop the kill, and none is needed: the kill resolves its target through A's own
    // lease label and kills by id, so the only container it can name is A's, and its teardown
    // is scoped the same way.
    it("scopes a kill that lands after the replacement stood its fleet up to the killed attempt's own lease", async () => {
        const { fn, fires, childAt } = gatedSpawns();
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its CLI client is alive
        // B re-claims the same job id and stands a fresh fleet up BEFORE the loop learns of
        // A's lost lease.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its group and service are live
        const afterBCreation = exec.mock.calls.length;

        // Only now does the loop's kill for A fire — over a daemon where B's fleet is live.
        await runner.kill(attemptA);

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        // The kill resolved its runner through A's lease label and killed by id — never by
        // name — and the teardown behind it is A-scoped too. Nothing names B.
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late).toContainEqual(['kill', idFor(ATTEMPT_A)]);
        // The safety kill leaves the services to end(); its release is scoped to A's lease the same way.
        expect(late).not.toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        await runner.releaseServices(attemptA);
        const released = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(released).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(released.every((a) => !touchesB(a))).toBe(true);
        expect(late.some((a) => a[0] === 'network')).toBe(false);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // A still winds down by its own killed marker, and B is untouched, finishing under
        // its own verdict.
        fires[0]!('close', 137);
        await runA;
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // A spawn failure is a fact the run throws, at once: it tears nothing down (#828) — the services
    // it started are the loop's `releaseServices` to take down, which still finds and removes them.
    it('rejects a spawn error at once, leaving the services for the loop to release', async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'ps') return { stdout: psListing(args, 'c0ffee000001') };
            return { stdout: '' };
        });
        // A child that never closes: the CLI could not even be spawned, which is the 'error'
        // event and nothing else.
        const erroring = (() => {
            const c = new EventEmitter() as ChildProcess;
            process.nextTick(() => c.emit('error', new Error('spawn docker ENOENT')));
            return c;
        }) as unknown as typeof spawn;
        const runner = servicesRunner(exec, erroring);
        await expect(runner.run(job, { id: SESSION, resume: false })).rejects.toThrow(/ENOENT/);
        const removals = () => exec.mock.calls.filter((c) => c[0].join(' ') === 'rm -f c0ffee000001').length;
        const beforeRelease = removals();
        await runner.releaseServices(job);
        expect(removals()).toBeGreaterThan(beforeRelease);
    });

    // A spawn failure makes Node deliver 'error' and then 'close' with a null code. The close
    // must not settle the promise once the error has been seen: verdict(null) would read as a
    // started run with no exit code — a terminal failed job — when the truth is infrastructure
    // the loop should leave to its lease.
    it('rejects with the spawn error even when close follows it', async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psListing(args, 'c0ffee000001') };
            return { stdout: '' };
        });
        // Node's failed-spawn order: 'error' first, then 'close' with code null.
        const errorThenClose = (() => {
            const c = new EventEmitter() as ChildProcess;
            process.nextTick(() => {
                c.emit('error', new Error('spawn docker ENOENT'));
                c.emit('close', null);
            });
            return c;
        }) as unknown as typeof spawn;
        const pending = servicesRunner(exec, errorThenClose).run(job, { id: SESSION, resume: false });
        // Handled from the start: the run rejects on the error itself, before the close's turn.
        const rejected = expect(pending).rejects.toThrow(/ENOENT/);
        // A macrotask, so the close and the close handler's verdict get their turn too.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await rejected;
    });

    /** The group-removal calls the daemon saw from the spawn on: the supervisor's and the exporter's. */
    const groupRemovals = (exec: ReturnType<typeof daemon>, from: number) =>
        exec.mock.calls
            .slice(from)
            .map((call) => call[0])
            .filter((args) => args[0] === 'rm' && [supervisorName(job), exporterName(job)].includes(args[2] ?? ''));

    // The run is no teardown owner beside the loop's `end()` (#828): a spawn that errored rejects
    // with the group untouched, and the loop's `finish` or its retention decides.
    it('removes nothing of the group when a spawn errors before rejecting', async () => {
        const exec = daemon();
        let spawnedAt = -1;
        const errored = (() => {
            spawnedAt = exec.mock.calls.length;
            const c = new EventEmitter() as ChildProcess;
            process.nextTick(() => c.emit('error', new Error('spawn docker ENOENT')));
            return c;
        }) as unknown as typeof spawn;
        await expect(servicesRunner(exec, errored).run(job, { id: SESSION, resume: false })).rejects.toThrow(/ENOENT/);
        expect(spawnedAt).toBeGreaterThan(0);
        expect(groupRemovals(exec, spawnedAt)).toEqual([]);
    });

    // A refused create is a returned fact too: no group removal from run(), the loop's `end()` finishes.
    it('removes nothing of the group when the runner container is refused', async () => {
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'create' && args.includes(containerName(job))) {
                throw Object.assign(new Error('Command failed'), { stderr: 'Error response from daemon: Conflict\n' });
            }
            return { stdout: '' };
        });
        const never = (() => {
            throw new Error('the refused create must not reach the spawn');
        }) as unknown as typeof spawn;
        const asDaemon = exec as unknown as ReturnType<typeof daemon>;
        const outcome = await servicesRunner(asDaemon, never).run(job, { id: SESSION, resume: false });
        expect(outcome).toMatchObject({ exitCode: 125, started: false });
        const calls = exec.mock.calls.map((call) => call[0]);
        const refusedAt = calls.findIndex((args) => args[0] === 'create' && args.includes(containerName(job)));
        expect(refusedAt).toBeGreaterThan(0);
        expect(groupRemovals(asDaemon, refusedAt)).toEqual([]);
    });

    // A run whose outcome rejects once its group exists leaves that group alone: the loop leaves such a
    // run to its lease so the next claim can adopt it (`thrownRunDecision`, `loop-fence.ts`).
    it('a run that rejects leaves its group for the loop to decide', async () => {
        const exec = daemon();
        let spawnedAt = -1;
        const throwing = (() => {
            spawnedAt = exec.mock.calls.length;
            throw new Error('the attach could not be spawned');
        }) as unknown as typeof spawn;
        await expect(servicesRunner(exec, throwing).run(job, { id: SESSION, resume: false })).rejects.toThrow(
            /could not be spawned/
        );
        expect(spawnedAt).toBeGreaterThan(0);
        expect(groupRemovals(exec, spawnedAt)).toEqual([]);
    });

    // The spawn-error twin: A's runner spawn fails, but the failure is delivered only after B
    // claimed the same job id and stood its fleet up. The loop's release of the attempt's
    // services is unconditional, and safe so: the teardown's filters carry A's lease, so the
    // only fleet it can find and remove is A's own.
    it("scopes a superseded spawn error's teardown to the failing attempt's own lease", async () => {
        const { fn, fires, childAt } = gatedSpawns();
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A is as far as its spawn, whose failure stays undelivered for now
        // B re-claims the same job id and stands a fresh fleet up while A's spawn failure is
        // still in flight.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its group and service are live
        const afterBCreation = exec.mock.calls.length;

        fires[0]!('error', new Error('spawn docker ENOENT'));
        runA.catch(() => undefined);
        await expect(runA).rejects.toThrow(/ENOENT/);
        // The loop's release for A addresses only A's own resources.
        await runner.releaseServices(attemptA);

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late.some((a) => a[0] === 'network')).toBe(false);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // B is untouched and still finishes under its own verdict.
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The mid-flight twin: A's release starts after its spawn error, and B claims the job id only while that teardown sits mid-flight, between its ps and its
    // removals. In the gated world this interleaving needed a live ownership predicate
    // re-armed at every step; in the scoped world it needs nothing: the removals were chosen by
    // a ps that filtered on A's lease, and releasing them late removes exactly what that ps
    // found — A's own resources — whatever B stood up in between.
    it('keeps a teardown scoped to its own lease even when the replacement stands its fleet up while it is mid-flight', async () => {
        const { fn, fires, childAt } = gatedSpawns();
        let releaseTeardownPs: (() => void) | null = null;
        const teardownPsGate = new Promise<void>((resolve) => {
            releaseTeardownPs = resolve;
        });
        let markTeardownPs: (() => void) | null = null;
        const teardownPsParked = new Promise<void>((resolve) => {
            markTeardownPs = resolve;
        });
        let psCount = 0;
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') {
                psCount++;
                // ps #1 is A's entry fence; ps #2 is A's fence-half teardown; ps #3 is A's
                // error-path teardown, parked so B can stand its fleet up while it sits
                // between its ps and its removals; ps #4 and #5 are B's fence and fence-half.
                if (psCount === 3) {
                    markTeardownPs!();
                    await teardownPsGate;
                }
                return { stdout: psAnswer(args) };
            }
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its CLI client is alive
        fires[0]!('error', new Error('spawn docker ENOENT')); // A is still current
        runA.catch(() => undefined);
        await expect(runA).rejects.toThrow(/ENOENT/); // the run only throws; it tears nothing down
        const releaseA = runner.releaseServices(attemptA); // the loop's release for A starts
        await teardownPsParked; // the teardown is parked between its ps and its removals

        // B re-claims the same job id and stands a fresh fleet up while A's teardown is in flight.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its group and service are live
        const afterBCreation = exec.mock.calls.length;

        releaseTeardownPs!(); // the teardown resumes — and names only what its own ps found
        await releaseA;

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(late.some((a) => a[0] === 'network')).toBe(false);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // B is untouched and still finishes under its own verdict.
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    // The kill() twin: kill()'s `docker kill` daemon call is arbitrarily slow, and a
    // replacement claim lands inside that window and stands its fleet up — under its own
    // names. When the kill resumes, its teardown addresses only what A's lease filters resolve
    // to; B's fleet was never nameable by any of it, so there is nothing to re-check.
    it('keeps a kill scoped to its own lease even when the replacement stands its fleet up while the docker kill is mid-flight', async () => {
        const { fn, fires, childAt } = gatedSpawns();
        let releaseKill: (() => void) | null = null;
        const killGate = new Promise<void>((resolve) => {
            releaseKill = resolve;
        });
        let markKillParked: (() => void) | null = null;
        const killParked = new Promise<void>((resolve) => {
            markKillParked = resolve;
        });
        const exec = vitest.fn(async (args: string[]) => {
            if (args[0] === 'kill') {
                // kill()'s `docker kill` is held mid-flight — the arbitrarily slow daemon
                // call inside which B claims.
                markKillParked!();
                await killGate;
                return { stdout: '' };
            }
            if (isServiceRun(args)) return { stdout: '' };
            if (args[0] === 'ps') return { stdout: psAnswer(args) };
            return { stdout: '' };
        });
        const runner = servicesRunner(exec, fn);

        const runA = runner.run(attemptA, { id: SESSION, resume: false });
        await childAt(0); // A spawned; its runner and fleet stand
        const pending = runner.kill(attemptA); // resolves its target, then parks in `docker kill`
        await killParked;

        // The kill by id was issued before B existed, and it was A's id — resolved through
        // A's lease label — not a name.
        const killCall = exec.mock.calls.map((call) => call[0]).find((a) => a[0] === 'kill');
        expect(killCall).toEqual(['kill', idFor(ATTEMPT_A)]);

        // B re-claims the same job id with a fresh token and stands a fresh fleet up while
        // A's kill is still awaiting the daemon.
        const runB = runner.run(attemptB, { id: SESSION, resume: false });
        await childAt(1); // B spawned; its group and service are live
        const afterBCreation = exec.mock.calls.length;

        releaseKill!(); // the kill resumes into its teardown
        await pending;

        const late = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(late.some((a) => a[0] === 'ps')).toBe(false); // the kill's own lookup came before B stood up
        // The safety kill leaves the services to end(); its release is scoped to A's lease the same way.
        expect(late).not.toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        await runner.releaseServices(attemptA);
        const released = exec.mock.calls.slice(afterBCreation).map((call) => call[0]);
        expect(released).toContainEqual(['rm', '-f', idFor(ATTEMPT_A)]);
        expect(released.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(released.every((a) => !touchesB(a))).toBe(true);
        expect(late.some((a) => a[0] === 'network')).toBe(false);
        expect(late.every((a) => !touchesB(a))).toBe(true);

        // A still winds down by its own killed marker, and B is untouched, finishing under
        // its own verdict.
        fires[0]!('close', 137);
        await runA;
        fires[1]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
    });

    /*
     * The three pins of the attempt-scoping redesign itself. The race tests above replay
     * interleavings; these three state the structural invariant they all follow from: names
     * are attempt-scoped and never repeat, the fence is the only job-scoped sweep, and a stale
     * attempt's every daemon call resolves to its own lease or nothing.
     */

    // The flagship: two RUNNER INSTANCES share one daemon, the way two driver processes hold
    // two attempts of the same job with no in-process state between them. B's fence is
    // job-scoped and removes A's live fleet — that is its role, and it runs before B creates
    // anything; A's runner dying to it is the accepted re-claim semantics. The pin is the LATE
    // kill: fired from A's own runner after B stands its fleet up, every call it issues
    // carries A's lease, B's names appear in no argv, and B finishes its run untouched.
    it("keeps a replacement attempt unaddressable to a stale attempt's late kill across two runner instances", async () => {
        const d = labelDaemon({});
        const spawnA = gatedSpawns();
        const spawnB = gatedSpawns();
        const runner1 = asLoop(
            dockerRunner(readyWhileStarting(d.exec), {
                env: { RUNNER_SERVICES: '1' },
                spawn: spawnA.fn,
            })
        );
        const runner2 = asLoop(
            dockerRunner(readyWhileStarting(d.exec), {
                env: { RUNNER_SERVICES: '1' },
                spawn: spawnB.fn,
            })
        );

        const runA = runner1.run(attemptA, { id: SESSION, resume: false });
        await spawnA.childAt(0); // A's fleet and runner stand on the daemon
        expect(d.containers.has(containerName(attemptA))).toBe(true);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(true);

        // B claims the same job id with a different token. Its fence is job-scoped and removes
        // A's live fleet before creating anything of its own.
        const runB = runner2.run(attemptB, { id: SESSION, resume: false });
        // Indexes are per instance: B is spawnB's FIRST spawn, not the second of a shared one.
        await spawnB.childAt(0);
        expect(d.containers.has(containerName(attemptA))).toBe(false);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(false);
        expect(d.containers.has(containerName(attemptB))).toBe(true);
        expect(d.containers.has(serviceContainerName(attemptB, 'stub'))).toBe(true);
        const afterBCreation = d.calls.length;

        // A's late kill fires from its own runner, over a daemon where B's fleet is live.
        await runner1.kill(attemptA);

        const late = d.calls.slice(afterBCreation);
        // Every call kill() issues is scoped to A: the ps filters carry A's lease, and nothing
        // in any argv names B — not B's token, names, or ids.
        expect(late.some((a) => a[0] === 'ps' && a.includes(`label=factory.lease=${ATTEMPT_A}`))).toBe(true);
        expect(late.every((a) => !touchesB(a))).toBe(true);
        // B's fleet survives on the daemon: its containers all still there.
        expect(d.containers.has(containerName(attemptB))).toBe(true);
        expect(d.containers.has(serviceContainerName(attemptB, 'stub'))).toBe(true);

        // B finishes its run under its own verdict — and A's runner child winds down too:
        // its run never settles otherwise, and the job-timeout timer armed at its spawn would
        // hold the worker's event loop open for the full timeout.
        spawnB.fires[0]!('close', 0);
        await expect(runB).resolves.toMatchObject({ exitCode: 0, started: true });
        spawnA.fires[0]!('close', 137);
        await expect(runA).resolves.toMatchObject({ exitCode: 137, started: true });
    });

    // Same job id, different attempts: every name either attempt computes carries its own
    // token, so no name conflicts and no attempt can compute another's names. The fence is
    // what removes a previous attempt's leftovers when it runs — here seeded as A's leftover
    // runner and service container, still existing when B starts.
    it("computes disjoint names per attempt for the same job id, and fences the previous attempt's leftovers by label", async () => {
        // The pure argv half: the names differ for the same job id.
        expect(containerName(attemptB)).not.toBe(containerName(attemptA));
        expect(serviceContainerName(attemptB, 'stub')).not.toBe(serviceContainerName(attemptA, 'stub'));

        // A's leftovers still exist on the daemon when B's run starts.
        const d = labelDaemon({});
        d.containers.set(containerName(attemptA), { 'factory.job': job.id, 'factory.lease': ATTEMPT_A });
        d.containers.set(serviceContainerName(attemptA, 'stub'), {
            'factory.job': job.id,
            'factory.lease': ATTEMPT_A,
            'factory.service': 'stub',
        });

        const { fn, seen } = spawnRecording('ran\n', 0);
        const runner = asLoop(
            dockerRunner(readyWhileStarting(d.exec), {
                env: { RUNNER_SERVICES: '1' },
                spawn: fn,
            })
        );
        await runner.run(attemptB, { id: SESSION, resume: false });

        // The fence removed both of A's leftovers by label.
        expect(d.containers.has(containerName(attemptA))).toBe(false);
        expect(d.containers.has(serviceContainerName(attemptA, 'stub'))).toBe(false);
        // And B's own create and start are B-scoped: no name A could have been holding.
        const created = d.calls.find((a) => a[0] === 'create' && a.includes(containerName(attemptB)))!;
        expect(created[created.indexOf('--name') + 1]).toBe(containerName(attemptB));
        // The supervisor beside it carries B's names too.
        expect(d.calls.some((a) => a[0] === 'create' && a.includes(supervisorName(attemptB)))).toBe(true);
        expect(seen[0]).toEqual(['start', '-a', containerName(attemptB)]);
    });

    // The fence is the only job-scoped sweep, and this is its full inventory: every labeled
    // container of the job regardless of which attempt made it. Anything not this job's is left alone.
    it('fences every leftover container of the job by label, and nothing else', async () => {
        const oldA = { ...job, leaseToken: 'aaaaaaaa-1111-4111-8111-111111111111' };
        const oldB = { ...job, leaseToken: 'bbbbbbbb-2222-4222-8222-222222222222' };
        const d = labelDaemon({});
        d.containers.set(containerName(oldA), { 'factory.job': job.id, 'factory.lease': oldA.leaseToken });
        d.containers.set(serviceContainerName(oldB, 'stub'), {
            'factory.job': job.id,
            'factory.lease': oldB.leaseToken,
            'factory.service': 'stub',
        });
        d.containers.set('someone-elses-runner', { 'factory.job': '99999999-9999-4999-8999-999999999999' });

        // The loop started B's services first; run()'s fence then sweeps, and the runner's create is
        // the first call after it, so snapshotting there is snapshotting the fence's outcome.
        let afterFence: { containers: string[] } | null = null;
        const exec = async (args: string[]) => {
            if (!afterFence && args[0] === 'create' && args.includes(containerName(attemptB))) {
                afterFence = { containers: [...d.containers.keys()] };
            }
            return d.exec(args);
        };
        const { fn } = spawnRecording('ran\n', 0);
        const runner = asLoop(
            dockerRunner(readyWhileStarting(exec as unknown as (args: string[]) => Promise<{ stdout: string }>), {
                env: { RUNNER_SERVICES: '1' },
                spawn: fn,
            })
        );
        await runner.run(attemptB, { id: SESSION, resume: false });

        // Both leftovers are gone; the other job's container is not this fence's business, and
        // this attempt's own group and fleet — started before run() — are spared.
        expect(afterFence!.containers.sort()).toEqual(
            [serviceContainerName(attemptB, 'stub'), supervisorName(attemptB), 'someone-elses-runner'].sort()
        );
    });

    it('leaves the daemon alone when the switch is off', async () => {
        // RUNNER_SERVICES=0 explicitly: the default is on (services.test.ts pins that), and this
        // test is about the opt-out posture.
        const cfg = loadDriverConfig({ RUNNER_SERVICES: '0' });
        const exec = daemon();
        const { fn, seen } = spawnRecording('ran\n', 0);
        const outcome = await createDockerRunner(
            cfg,
            fn,
            exec as unknown as (args: string[]) => Promise<{ stdout: string }>,
            { steps: fakeSteps().sink }
        ).run(job, { id: SESSION, resume: false });

        expect(outcome).toMatchObject({ exitCode: 0, started: true });
        const calls = exec.mock.calls.map((call) => call[0]);
        // The fence is the runner's, not the services feature's, so its label and network
        // sweeps still run — but nothing services-specific happens: no readout, no network
        // create, no service containers, byte-identical runner argv. The one `--entrypoint`
        // run allowed is the close-time claude-code turn read, which is the runner's own.
        expect(calls.every((a) => !(a[0] === 'network' && a[1] === 'create'))).toBe(true);
        expect(calls.every((a) => !isServiceRun(a))).toBe(true);
        expect(
            calls.every(
                (a) =>
                    !(a[0] === 'run' && a.includes('--entrypoint')) ||
                    a.some((x) => typeof x === 'string' && x.startsWith('CLAUDE_TRANSCRIPT_DIR='))
            )
        ).toBe(true);
        expect(seen[0]).toEqual(['start', '-a', containerName(job)]);
        expect(calls.find((a) => a[0] === 'create' && a.includes(containerName(job)))).toEqual(
            dockerArgs(cfg, job, { id: SESSION, resume: false }, { envFile: envFilePath(job) })
        );
    });

    it('reports a declared service that vanished from docker ps as dead (issue #471)', async () => {
        const base = daemon();
        let removedByHand = false;
        const exec = vitest.fn(async (args: string[]) =>
            removedByHand && args[0] === 'ps' ? { stdout: '' } : base(args)
        ) as unknown as ReturnType<typeof daemon>;
        const { fn } = spawnRecording('', 0);
        const runner = servicesRunner(exec, fn);
        const outcome = await runner.run(job, { id: SESSION, resume: false });
        expect(outcome.exitCode).toBe(0);

        removedByHand = true; // `docker rm -f` of the stub service, between the run and the gates
        const dead = await runner.deadServices(job);
        expect(dead).toMatchObject([
            { name: 'stub', state: 'missing', exitCode: null, reason: 'container removed', logTail: '' },
        ]);

        // The attempt's teardown ends the declaration: nothing is expected of a released fleet.
        await runner.releaseServices(job);
        expect(await runner.deadServices(job)).toEqual([]);
    });

    const runningStub = JSON.stringify({ Labels: 'factory.service=stub', Image: 'stub-svc:1', State: 'running' });

    // Issues #560, #773 (R1-4): the restart is the fleet's — the healthy sibling re-runs too — into
    // the same namespace, whose hosts file still names every service on loopback.
    it('restartServices re-runs every service, a healthy sibling too, in the group’s namespace', async () => {
        const DB: ServiceSpec = { name: 'db', image: 'postgres:17', environment: [] };
        const fleet: BoardJob = { ...job, services: [STUB, DB] };
        const base = daemon();
        let removedByHand = false;
        const both = [
            runningStub,
            JSON.stringify({ Labels: 'factory.service=db', Image: 'postgres:17', State: 'running' }),
        ].join('\n');
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args)) removedByHand = false;
            if (args[0] === 'ps' && args.includes('{{json .}}')) return { stdout: removedByHand ? '' : both };
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(fleet, { id: SESSION, resume: false });
        removedByHand = true;
        const before = exec.mock.calls.length;

        await runner.restartServices(fleet, live);

        const calls = exec.mock.calls.slice(before).map((call) => call[0]);
        expect(calls.slice(0, 4)).toEqual([
            ['rm', '-f', serviceContainerName(fleet, 'stub')],
            serviceRunArgs(fleet, STUB, supervisorName(fleet)),
            ['rm', '-f', serviceContainerName(fleet, 'db')],
            serviceRunArgs(fleet, DB, supervisorName(fleet)),
        ]);
        expect(calls.some((a) => a[0] === 'network')).toBe(false);
        expect(await runner.deadServices(fleet)).toEqual([]);

        await runner.releaseServices(fleet);
        forgetDeclaredServices(fleet);
    });

    it('restartServices stops on a stand-down and removes the service it started again (issue #560)', async () => {
        const base = daemon();
        const stand = new AbortController();
        const exec = vitest.fn(async (args: string[]) => {
            if (isServiceRun(args) && stand.signal.aborted === false) {
                // The Stop lands while the replacement is being started.
                const answer = await base(args);
                stand.abort();
                return answer;
            }
            if (args[0] === 'ps' && args.includes('{{json .}}')) return { stdout: '' };
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        const before = exec.mock.calls.length;

        await expect(runner.restartServices(job, stand.signal)).rejects.toThrow(
            'the restart was abandoned: the attempt stood down'
        );
        const calls = exec.mock.calls.slice(before).map((call) => call[0]);
        expect(calls.at(-1)).toEqual(['rm', '-f', serviceContainerName(job, 'stub')]);
        expect(calls.some((a) => a[0] === 'ps')).toBe(false);
    });

    it('restartServices ends a pending readiness listing on the stand-down (#869)', async () => {
        const base = daemon();
        const exec = vitest.fn(async (args: string[], options?: { signal?: AbortSignal }) =>
            args[0] === 'ps' && args.includes('{{json .}}') ? hangsUntilAborted(options) : base(args)
        ) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        const stand = new AbortController();
        const before = exec.mock.calls.length;

        const pending = runner.restartServices(job, stand.signal);
        await vitest.waitFor(() =>
            expect(exec.mock.calls.slice(before).some((call) => call[0]![0] === 'ps')).toBe(true)
        );
        stand.abort();
        expect(await endsSoon(pending)).toBe(true);
        await runner.releaseServices(job);
    });

    it.each(['rm', 'run'])('restartServices ends a stalled %s by the restart’s deadline (#869)', async (stalled) => {
        const base = daemon();
        let stall = false;
        const exec = vitest.fn(async (args: string[], options?: { timeout?: number }) =>
            stall && args[0] === stalled && (stalled === 'rm' || isServiceRun(args))
                ? hangsUntilTimeout(options)
                : base(args)
        ) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        stall = true;
        vitest.useFakeTimers();
        try {
            let ended = false;
            const restarting = runner.restartServices(job, new AbortController().signal);
            restarting.then(
                () => (ended = true),
                () => (ended = true)
            );

            await vitest.advanceTimersByTimeAsync(SERVICE_RESTART_TIMEOUT_MS + 1_000);

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
        stall = false;
        await runner.releaseServices(job);
    });

    // #869: the first call of each kind an attempt makes stalls; none holds the attempt past its command deadline.
    it.each([
        ['the re-claim fence listing', (args: string[]) => args[0] === 'ps' && args.includes('--format')],
        ['the group create', (args: string[]) => args[0] === 'create'],
        ['the group start', (args: string[]) => args[0] === 'start'],
        ['the service creation', (args: string[]) => isServiceRun(args)],
    ])('ends a stalled %s by the attempt’s command deadline (#869)', async (_name, hang) => {
        const base = daemon();
        let stalled = false;
        const exec = vitest.fn(async (args: string[], options?: { timeout?: number }) => {
            if (!stalled && hang(args)) {
                stalled = true;
                return hangsUntilTimeout(options);
            }
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        vitest.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        try {
            let ended = false;
            const running = runner.run(job, { id: SESSION, resume: false });
            running.then(
                () => (ended = true),
                () => (ended = true)
            );
            // The calls before the stalled one touch the disk: let the run reach it.
            while (!stalled) await new Promise((resolve) => setImmediate(resolve));

            await vitest.advanceTimersByTimeAsync(ATTEMPT_COMMAND_TIMEOUT_MS + 1_000);
            // What follows the refusal touches the disk.
            for (let polls = 0; polls < 200 && !ended; polls += 1)
                await new Promise((resolve) => setImmediate(resolve));

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
    });

    it('ends a stalled vitals sample by the attempt’s command deadline (#869)', async () => {
        const exec = vitest.fn((_args: string[], options?: { timeout?: number }) =>
            hangsUntilTimeout(options)
        ) as unknown as ReturnType<typeof daemon>;
        vitest.useFakeTimers();
        try {
            let ended = false;
            const sampling = servicesRunner(exec, spawnRecording('', 0).fn).sampleRuntime(job);
            sampling.then(
                () => (ended = true),
                () => (ended = true)
            );

            // The stats read, then the fleet read: each ends by its own deadline.
            await vitest.advanceTimersByTimeAsync(2 * ATTEMPT_COMMAND_TIMEOUT_MS + 1_000);

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
    });

    it('ends a stalled group create when the attempt is killed (#869)', async () => {
        const base = daemon();
        let stalled = false;
        const exec = vitest.fn(async (args: string[], options?: { signal?: AbortSignal }) => {
            if (!stalled && args[0] === 'create') {
                stalled = true;
                return hangsUntilAborted(options);
            }
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);

        const running = runner.run(job, { id: SESSION, resume: false });
        await vitest.waitFor(() => expect(stalled).toBe(true));
        await runner.kill(job);

        expect(await endsSoon(running)).toBe(true);
    });

    it('restartServices throws when the daemon refuses the service again (issue #560)', async () => {
        const base = daemon();
        let refuse = false;
        const exec = vitest.fn(async (args: string[]) => {
            if (refuse && isServiceRun(args)) throw new Error('no such network');
            return base(args);
        }) as unknown as ReturnType<typeof daemon>;
        const runner = servicesRunner(exec, spawnRecording('', 0).fn);
        await runner.run(job, { id: SESSION, resume: false });
        refuse = true;

        await expect(runner.restartServices(job, live)).rejects.toThrow(
            'could not start service "stub": no such network'
        );

        await runner.releaseServices(job);
    });
});

describe('publishing the produced work', () => {
    const ISSUE_JOB: BoardJob = {
        ...job,
        command: '/fix https://github.com/Bellows-AI/factory/issues/10',
        repo: 'Bellows-AI/factory',
        env: { GITHUB_TOKEN: 't0k-3n' },
    };
    const NOW = new Date('2026-09-09T12:00:00Z');

    it('plans the branch, title and issue from the command', () => {
        expect(publishPlan(ISSUE_JOB, NOW)).toEqual({
            branch: 'fix/10',
            title: '/fix https://github.com/Bellows-AI/factory/issues/10 (#10)',
            issueNumber: 10,
        });
        // No issue named: a dated task branch, no closed issue.
        const plain = publishPlan({ ...job, command: 'tidy the docs' }, NOW);
        expect(plain.branch).toBe('task/20260909');
        expect(plain.issueNumber).toBeNull();
        expect(plain.title).toBe('tidy the docs');
    });

    it('caps the fallback title at 144 characters', () => {
        const capped = publishPlan({ ...job, command: 'y'.repeat(200) }, NOW);
        expect(capped.title).toBe('y'.repeat(144));
        expect(capped.issueNumber).toBeNull();
    });

    it('plans the same branch and closure from the bare /fix <number> form', () => {
        expect(publishPlan({ ...job, command: '/fix 100' }, NOW)).toEqual({
            branch: 'fix/100',
            title: '/fix 100 (#100)',
            issueNumber: 100,
        });
        const hashed = publishPlan({ ...job, command: '/fix #44' }, NOW);
        expect(hashed.branch).toBe('fix/44');
        expect(hashed.issueNumber).toBe(44);
        expect(publishPlan({ ...job, command: '/fix https://github.com/o/r/issues/44' }, NOW).issueNumber).toBe(44);
    });

    it('does not name an issue from a command that merely looks like /fix', () => {
        expect(publishPlan({ ...job, command: '/fix-a 100' }, NOW)).toEqual({
            branch: 'task/20260909',
            title: '/fix-a 100',
            issueNumber: null,
        });
    });

    it("closes the thread root's issue when a follow-up publishes", () => {
        // `/fix 122` failed its gates; the follow-up `both OK` is the run that publishes.
        const followUp = { ...job, command: 'both OK', rootCommand: '/fix 122' };
        expect(publishPlan(followUp, NOW).issueNumber).toBe(122);
        // A root that names no issue leaves the follow-up's own command to name one.
        expect(publishPlan({ ...job, command: 'now /fix 9', rootCommand: 'tidy' }, NOW).issueNumber).toBe(9);
        expect(publishPlan({ ...job, command: 'both OK', rootCommand: 'tidy' }, NOW).issueNumber).toBeNull();
    });

    it('prefers the /fix target over an incidental #mention', () => {
        expect(publishPlan({ ...job, command: '/fix 44 but really #9' }, NOW)).toEqual({
            branch: 'fix/44',
            title: '/fix 44 but really #9 (#44)',
            issueNumber: 44,
        });
    });

    it('rejects lookalike and impossible issue numbers', () => {
        // A trailing word character means the digits were the prefix of a longer token.
        expect(publishPlan({ ...job, command: '/fix 44oops' }, NOW).issueNumber).toBeNull();
        expect(publishPlan({ ...job, command: 'see #44oops' }, NOW).issueNumber).toBeNull();
        // Zero is no issue, and past the safe-integer range the number is not honest.
        expect(publishPlan({ ...job, command: '/fix 0' }, NOW).issueNumber).toBeNull();
        expect(publishPlan({ ...job, command: '/fix 99999999999999999999' }, NOW).issueNumber).toBeNull();
        // A sentence period after the reference is punctuation, not a longer number.
        expect(publishPlan({ ...job, command: 'fix #44.' }, NOW).issueNumber).toBe(44);
    });

    it('builds the checkout path from the workspace and repo label, asserting both', () => {
        expect(repoPath(loadDriverConfig({}), ISSUE_JOB)).toBe(`/workspaces/bellows/${USER}/factory`);
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, workspacePath: null })).toBeNull();
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, workspacePath: '../etc' })).toBeNull();
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, repo: 'just-a-name' })).toBeNull();
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, repo: 'o/..' })).toBeNull();
        expect(repoPath(loadDriverConfig({}), { ...ISSUE_JOB, repo: 'o/.' })).toBeNull();
    });

    /*
     * The per-task workspace (issue #35): one `git worktree` of the job's repo, branched off the
     * remote default, per task THREAD. Keyed by the thread's ROOT job id — stable across attempts
     * of the same job, and shared by follow-ups, because a follow-up resumes the parent session
     * and a session is only coherent in the tree it ran in. The clone itself stays pristine.
     */
    const ROOT = '55555555-5555-4555-8555-555555555555';
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };

    it('computes the worktree path and branch from the thread root', () => {
        expect(worktreeRelDir(repoJob)).toBe(`bellows/${USER}/.worktrees/${job.id}`);
        // A follow-up is a NEW job row resuming the parent conversation: its worktree is the
        // thread's, so it lands in the tree the session (and the parent's work) lives in.
        expect(worktreeRelDir({ ...repoJob, rootJobId: ROOT })).toBe(`bellows/${USER}/.worktrees/${ROOT}`);
        expect(worktreeDir(loadDriverConfig({}), { ...repoJob, rootJobId: ROOT })).toBe(
            `/workspaces/bellows/${USER}/.worktrees/${ROOT}`
        );
        expect(worktreeBranch({ ...repoJob, rootJobId: ROOT })).toBe(`factory/${ROOT}`);
    });

    it('refuses a worktree path it could not assert', () => {
        // The same posture repoPath pins above: every board-supplied half is asserted before it
        // joins a path, and here the value becomes the agent's working directory.
        const broken: BoardJob[] = [
            { ...repoJob, workspacePath: null },
            { ...repoJob, workspacePath: '../etc' },
            { ...repoJob, workspacePath: `bellows/not-a-uuid` },
            { ...repoJob, repo: 'just-a-name' },
            { ...repoJob, repo: 'o/..' },
            { ...repoJob, repo: 'o/.' },
            { ...repoJob, rootJobId: 'not-a-uuid' },
            { ...repoJob, rootJobId: '../../etc' },
        ];
        for (const job of broken) expect(worktreeRelDir(job), job.repo ?? undefined).toBeNull();
    });

    it('runs a repo job inside its worktree, and a repo-less job at the member root', () => {
        const withRepo = dockerArgs(
            loadDriverConfig({}),
            repoJob,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(withRepo).toContain(`WORKDIR=/workspaces/bellows/${USER}/.worktrees/${job.id}`);
        // A command-only job names no repo: no worktree exists, and the member root is where it
        // always started — the argv stays byte-identical to what it was.
        expect(
            dockerArgs(loadDriverConfig({}), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })
        ).toContain(`WORKDIR=/workspaces/bellows/${USER}`);
    });

    it('refuses to run a repo job whose worktree path cannot be asserted', () => {
        expect(() =>
            dockerArgs(loadDriverConfig({}), { ...repoJob, rootJobId: 'not-a-uuid' }, { id: SESSION, resume: false })
        ).toThrow(/worktree/);
    });

    // What the sync does is executed for real in worktree*.test.ts and scripts-worktree-lock.test.ts;
    // these pins have no behavioural twin.
    it('runs every git call of the sync without a shell, and anchors the transient marker', () => {
        expect(gitWorktreeScript).toContain('execFileSync');
        expect(gitWorktreeScript).not.toContain('execSync(');
        // A rebase that fails without a conflict aborts itself — the worktree never sits
        // mid-rebase — and the refusal names what happened.
        expect(gitWorktreeScript).toContain("inw('rebase', '--abort')");
        expect(gitWorktreeScript).toContain('rebased onto');
        expect(TRANSIENT_SYNC_REASON.test('transient worktree sync: still held')).toBe(true);
        // Anchored at the head: ordinary refusal reasons splice member-controlled git stderr,
        // and a conflicted file named after the marker must never read as transient.
        expect(TRANSIENT_SYNC_REASON.test('conflict in transient worktree sync.md')).toBe(false);
    });

    it('hands the sync the clone, the worktree and the branch, by env', async () => {
        const supervised = syncSteps();
        const d = labelDaemon();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });
        const result = await runner.syncCheckout(repoJob);

        expect(result).toEqual({ ok: true, reason: null });
        const [sync] = supervised.ofKind('sync');
        expect(sync?.argv).toEqual(['node', '-e', gitWorktreeScript]);
        // The clone — where origin lives and the worktree is created FROM. Paths, not credentials:
        // the claim env rides the step's own env, exactly as it rode the env file.
        expect(sync?.env).toMatchObject({
            REPO: `/workspaces/bellows/${USER}/factory`,
            WORKTREE: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
            BRANCH: `factory/${job.id}`,
        });
        // The step goes to the attempt's supervisor, under the control token only it holds.
        expect(supervised.submitted.map((entry) => entry.token)).toEqual([CONTROL_TOKEN]);
        // The supervisor mounts the job's own subtree — the same scoping every other container
        // this runner starts gets, nothing broader — and the sync starts no container of its own.
        const create = d.calls.find((a) => a[0] === 'create' && a.includes(supervisorName(repoJob)))!;
        expect(create).toEqual(
            expect.arrayContaining([
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            ])
        );
        expect(d.calls.some((a) => a[0] === 'run')).toBe(false);
    });

    // git reads no token from the environment, so a private-repo fetch needs the same token-backed
    // helper the push uses. It rides CONDITIONALLY: only beside the token the board minted for this
    // sync (docs/connections.md), because a public repo must keep its plain unauthenticated fetch
    // (a helper answering an empty password would break it). The VALUE passed is helper CODE,
    // never the credential — the token itself travels only in the step env, where the helper reads it.
    it("hands the sync the credential-helper code only beside the board's minted token", async () => {
        const supervised = syncSteps();
        const d = labelDaemon();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });

        await runner.syncCheckout(repoJob, undefined, null, 't0k-3n');
        const [withToken] = supervised.ofKind('sync');
        expect(withToken?.env).toMatchObject({ CRED_HELPER: CREDENTIAL_HELPER, GITHUB_TOKEN: 't0k-3n' });
        // The token itself rides the step, never argv — the step's or the daemon's.
        expect(withToken?.argv.some((arg) => arg.includes('t0k-3n'))).toBe(false);
        expect(d.calls.flat().some((arg) => arg.includes('t0k-3n'))).toBe(false);

        // No minted token keeps the plain fetch — and a claim value under the reserved name is no
        // token: it is dropped, never forwarded.
        await runner.syncCheckout({ ...repoJob, env: { GITHUB_TOKEN: 'claim-pat', CORE_TOKEN: 'shh' } });
        const plain = supervised.ofKind('sync')[1];
        expect(plain?.env).not.toHaveProperty('CRED_HELPER');
        expect(plain?.env).not.toHaveProperty('GITHUB_TOKEN');
        expect(plain?.env).toMatchObject({ CORE_TOKEN: 'shh' });

        // An EMPTY token is no token: the helper would answer an empty password and break the
        // public-repo plain fetch it exists to preserve.
        await runner.syncCheckout(repoJob, undefined, null, '');
        expect(supervised.ofKind('sync')[2]?.env).not.toHaveProperty('CRED_HELPER');
    });

    // A claim that CONTINUES a session — a follow-up — is mid-task, and git operations that touch
    // the remote belong to the task's beginning and end (issue #58). Its sync is a RESTORE: the
    // step runs with RESTORE=1 and carries NO claim env at all (restore talks only to the local
    // clone — nothing to credential), and the fetch's helper code is absent even beside a token.
    it('restores a claim that continues a session instead of syncing it', async () => {
        const supervised = syncSteps();
        const runner = dockerRunner(emptyDaemon, { steps: supervised.sink });

        await runner.syncCheckout({ ...repoJob, followUp: true }, undefined, null, 't0k-3n');
        const [follow] = supervised.ofKind('sync');
        expect(follow?.env).toMatchObject({ RESTORE: '1' });
        expect(follow?.env).not.toHaveProperty('GITHUB_TOKEN');
        expect(follow?.env).not.toHaveProperty('CRED_HELPER');

        // A claim carrying a resume session (resumeSessionId without the followUp flag) is the
        // same mid-task hazard: the session's tree must not move under it either.
        await runner.syncCheckout({ ...repoJob, resumeSessionId: SESSION }, undefined, null, 't0k-3n');
        const parked = supervised.ofKind('sync')[1];
        expect(parked?.env).toMatchObject({ RESTORE: '1' });
        expect(parked?.env).not.toHaveProperty('GITHUB_TOKEN');

        // A starting claim beside a token keeps the sync shape: no RESTORE, the token on.
        await runner.syncCheckout(repoJob, undefined, null, 't0k-3n');
        const fresh = supervised.ofKind('sync')[2];
        expect(fresh?.env).not.toHaveProperty('RESTORE');
        expect(fresh?.env).toMatchObject({ GITHUB_TOKEN: 't0k-3n' });
    });

    /* The terminal reclaim (issue #47): the one step that undoes the sync, naming only the clone
     * and the tree — no BRANCH, no credential helper, no claim env. The thread has no attempt, so
     * it runs in a supervisor-only group of its own, under a token of its own, and ends it. */
    it('reclaims the worktree through a supervisor-only group of its own, naming only paths', async () => {
        const d = labelDaemon();
        const { endpoint, closed } = reclaimEndpoint();
        const supervised = fakeSteps((step) =>
            ok(step.kind === 'reclaim' ? '{"ok":true,"removed":true,"reason":null}' : '')
        );
        const runner = dockerRunner(d.exec, { steps: supervised.sink, endpoint });
        // The checkout declares a service: a reclaim's group brings none of it (#773 D11).
        const result = await runner.reclaimWorktree({
            ...repoJob,
            env: { GITHUB_TOKEN: 't0k-3n' },
            services: [{ name: 'db', image: 'postgres:17', environment: [] }],
        });

        expect(result).toEqual({ ok: true, removed: true, reason: null });
        const [reclaim] = supervised.ofKind('reclaim');
        expect(reclaim?.argv).toEqual(['node', '-e', gitWorktreeRemoveScript]);
        // Reclaim touches no credential and no branch: the thread is terminal, so there is no
        // fetch to authenticate and no follow-up branch to preserve.
        expect(reclaim?.env).toEqual({
            REPO: `/workspaces/bellows/${USER}/factory`,
            WORKTREE: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
            // The thread's review roots go with it (issue #774).
            REVIEW_ROOTS: `/workspaces/bellows/${USER}/.worktrees/${job.id}.reviews`,
        });
        // Under the token its own endpoint opened — not the attempt's — and ended with the group.
        expect(supervised.submitted.every((entry) => entry.token === RECLAIM_TOKEN)).toBe(true);
        expect(supervised.ofKind('finish')).toHaveLength(1);
        expect(closed).toEqual([RECLAIM_TOKEN]);
        // A supervisor and nothing else, under a lease of its own, with the control pair off argv;
        // it mounts the job's own subtree like the sync it undoes, and it is gone afterwards.
        const creates = d.calls.filter((a) => a[0] === 'create');
        expect(creates).toHaveLength(1);
        const create = creates[0]!;
        expect(create).toContain('--entrypoint');
        expect(create).not.toContain('db:127.0.0.1');
        expect(create.some((arg) => arg.includes(repoJob.leaseToken))).toBe(false);
        expect(create.join(' ')).not.toContain(RECLAIM_TOKEN);
        expect(create).toEqual(
            expect.arrayContaining([
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            ])
        );
        // Issue #814: the one throwaway container, before the group — the tool uid's release of
        // what it closed, which the uid-1000 reclaim could not empty.
        expect(d.calls.filter((a) => a[0] === 'run')).toEqual([toolTreeReleaseArgs(loadDriverConfig({}), repoJob)]);
        expect(d.calls.findIndex((a) => a[0] === 'run')).toBeLessThan(d.calls.findIndex((a) => a[0] === 'create'));
        expect(d.containers.size).toBe(0);
        // Issue #821 D16: the group's supervisor and every mailbox carry the reclaim mark, so the
        // orphan reaper never reads its lease of its own as a dead attempt's.
        const volumes = d.calls.filter((a) => a[0] === 'volume' && a[1] === 'create');
        expect(volumes).toHaveLength(Object.keys(MAILBOXES).length - 1); // no review mailbox without a reviewer
        for (const made of [create, ...volumes]) expect(made).toEqual(expect.arrayContaining(['factory.reclaim=true']));
    });

    it("marks no attempt's own group as a reclaim group (#821 D16)", async () => {
        const d = labelDaemon();
        await dockerRunner(d.exec, { steps: syncSteps().sink }).syncCheckout(repoJob);
        const made = d.calls.filter((a) => a[0] === 'create' || (a[0] === 'volume' && a[1] === 'create'));
        expect(made.length).toBeGreaterThan(0);
        expect(made.some((args) => args.includes('factory.reclaim=true'))).toBe(false);
    });

    it('releases the tree as the tool uid, hardened, naming only the tree', () => {
        const args = toolTreeReleaseArgs(loadDriverConfig({}), repoJob) ?? [];
        expect(args.slice(0, 1)).toEqual(['run']);
        expect(args).toEqual(expect.arrayContaining(['--cap-drop', 'ALL', '--rm']));
        expect(args.join(' ')).toContain('--security-opt no-new-privileges');
        expect(args.join(' ')).toContain('--user 1001:1000');
        expect(args).toContain(`WORKTREE=/workspaces/bellows/${USER}/.worktrees/${job.id}`);
        expect(args.slice(-4)).toEqual([
            'node',
            executorImage(loadDriverConfig({}), repoJob.executorType),
            '-e',
            toolTreeReleaseScript,
        ]);
        expect(args.some((arg) => arg.includes('--cap-add'))).toBe(false);
    });

    it('reclaims even when the release container fails: the reclaim’s own verdict decides', async () => {
        const d = labelDaemon();
        const failing = async (args: string[]) => {
            if (args[0] === 'run') throw new Error('no such image');
            return d.exec(args);
        };
        const { endpoint } = reclaimEndpoint();
        const supervised = fakeSteps((step) =>
            ok(step.kind === 'reclaim' ? '{"ok":true,"removed":true,"reason":null}' : '')
        );
        const runner = dockerRunner(failing, { steps: supervised.sink, endpoint });
        expect(await runner.reclaimWorktree(repoJob)).toEqual({ ok: true, removed: true, reason: null });
    });

    it('refuses a reclaim by saying this driver has no supervisor endpoint to run it through', async () => {
        const supervised = fakeSteps();
        const runner = dockerRunner(emptyDaemon, { steps: supervised.sink });

        const result = await runner.reclaimWorktree(repoJob);

        expect(result).toMatchObject({ ok: false, removed: false });
        expect(result.reason).toContain('no supervisor endpoint');
        expect(supervised.steps()).toEqual([]);
    });

    it('reclaims nothing, run untouched, for a job that never had a worktree', async () => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec);
        expect(await runner.reclaimWorktree(job)).toEqual({ ok: true, removed: false, reason: null });
        expect(calls).toHaveLength(0);
    });

    /*
     * An unreadable sync/reclaim verdict names why — what the step printed — and a step that
     * exited non-zero says it in the tool's own words. (A RESOLVED unreadable verdict is by
     * construction an exit-0 step.)
     */
    it('names what the sync step printed when its answer is not a verdict', async () => {
        const supervised = syncSteps('fetching origin\nfatal: could not read from remote repository\n');
        const result = await dockerRunner(emptyDaemon, { steps: supervised.sink }).syncCheckout(repoJob);

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('the worktree sync answered nothing readable');
        expect(result.reason).toContain('fatal: could not read from remote repository');
    });

    it('names a sync step that printed nothing readable', async () => {
        const result = await dockerRunner(emptyDaemon, { steps: syncSteps('').sink }).syncCheckout(repoJob);

        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/^the worktree sync answered nothing readable/);
    });

    it('says why a sync step that exited non-zero failed, in the tool’s own words', async () => {
        const supervised = fakeSteps(() => ({
            exitCode: 128,
            stdout: '',
            stderr: 'fatal: unable to access the remote',
            timedOut: false,
        }));
        const result = await dockerRunner(emptyDaemon, { steps: supervised.sink }).syncCheckout(repoJob);

        expect(result).toEqual({ ok: false, reason: 'the worktree sync failed: fatal: unable to access the remote' });
    });

    /*
     * Issue #559: a sync that never lands (a fetch stalled on the network) would hold its clone's
     * queue, and every sibling behind it, forever. The step carries the sync deadline, which the
     * supervisor enforces — it kills the step's process and answers `timedOut` — and the run fails
     * like a sync the kubelet ended. Nothing of the step outlives the answer, so there is nothing
     * further to wait out.
     */
    it('bounds the sync step by the sync deadline, and fails the run when the supervisor ends it there', async () => {
        const supervised = fakeSteps(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        const result = await dockerRunner(emptyDaemon, { steps: supervised.sink }).syncCheckout(repoJob);

        const [sync] = supervised.ofKind('sync');
        expect(sync?.timeoutMs).toBe(SYNC_DEADLINE_MS);
        expect(result).toMatchObject({
            ok: false,
            reason: `the worktree sync failed: the step exceeded its ${SYNC_DEADLINE_MS}ms deadline`,
        });
        expect(TRANSIENT_SYNC_REASON.test(result.reason ?? '')).toBe(false);
        expect(result.settled).toBeUndefined();
    });

    // The sync is never abandoned mid-write: a stand-down — or an attempt whose channel closed —
    // kills the whole group instead, which rejects the step. The loop leaves the job to its lease,
    // and the group is gone from the daemon.
    it('removes the group and throws when the channel closes under the sync', async () => {
        const d = labelDaemon();
        const sink: StepSink = {
            submit: () => Promise.reject(new Error('the task supervisor channel closed before its step was answered')),
            awaitReport: () => Promise.resolve(FINALIZED),
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };
        const runner = dockerRunner(d.exec, { steps: sink });

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow('channel closed');

        expect(d.calls).toContainEqual(['rm', '-f', supervisorName(repoJob)]);
        expect(d.containers.size).toBe(0);
        // Nothing is remembered of the group: the next sync creates one afresh.
        const created = d.calls.filter((a) => a[0] === 'create').length;
        await expect(runner.syncCheckout(repoJob)).rejects.toThrow('channel closed');
        expect(d.calls.filter((a) => a[0] === 'create').length).toBe(created * 2);
    });

    // Issue #559: the contention verdict reaches the loop unchanged — the anchored marker is what
    // hands the claim back to the board — and the sync never shortens the script's lock wait.
    it('passes checkout contention through as the transient reason, with the shipped lock wait', async () => {
        const reason =
            'transient worktree sync: the checkout lock /w/.git/factory-sync.lock is still held after 20000ms';
        const supervised = syncSteps(`${JSON.stringify({ ok: false, reason })}\n`);
        const runner = dockerRunner(emptyDaemon, { steps: supervised.sink });

        const result = await runner.syncCheckout(repoJob);

        expect(result).toMatchObject({ ok: false, reason });
        expect(TRANSIENT_SYNC_REASON.test(result.reason ?? '')).toBe(true);
        expect(
            Object.keys(supervised.ofKind('sync')[0]!.env).some((name) => name.startsWith('SYNC_LOCK_WAIT_MS'))
        ).toBe(false);
    });

    it('carries the script’s failure kind through the sync step’s stdout (issue #666)', async () => {
        const verdict = { ok: false, reason: 'the repository clone /w/r does not exist', kind: 'missing_clone' };
        const runner = dockerRunner(emptyDaemon, { steps: syncSteps(`${JSON.stringify(verdict)}\n`).sink });

        expect(await runner.syncCheckout(repoJob)).toMatchObject(verdict);
    });

    it('names why the reclaim verdict was unreadable', async () => {
        const { runner } = reclaimRunner('rm: permission denied\n');
        const result = await runner.reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.removed).toBe(false);
        expect(result.reason).toContain('the worktree reclaim answered nothing readable');
        expect(result.reason).toContain('rm: permission denied');
    });

    it('answers the refusal verbatim when the reclaim script refuses', async () => {
        const { runner } = reclaimRunner(
            '{"ok":false,"removed":false,"reason":"refusing to remove /x: a git tree that is not a registered worktree"}'
        );
        const result = await runner.reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('registered worktree');
    });

    // The fence before the sync (PR #46 review): the loop calls syncCheckout before the
    // runner's own fence, so the sweep has to come here — the sync is the first writer on the
    // task worktree, and starting it over a previous attempt's live runner would mix edits.
    it('sweeps the job label before the sync step is asked of a group', async () => {
        const d = labelDaemon();
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });
        const result = await runner.syncCheckout(repoJob);

        expect(result).toEqual({ ok: true, reason: null });
        const shapes = d.calls.map((a) => a[0]);
        expect(shapes).toContain('ps');
        expect(shapes.indexOf('ps')).toBeLessThan(shapes.indexOf('create'));
        expect(shapes.indexOf('create')).toBeLessThan(shapes.indexOf('start'));
        expect(supervised.ofKind('sync')).toHaveLength(1);
    });

    // The replacement-with-an-active-previous-runner shape of the review comment: the old
    // attempt's runner is still on the daemon when the replacement's sync starts, and the
    // fence's removal must land BEFORE the sync's group is created — not after it.
    it('removes a previous attempt’s still-running runner before the sync runs', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const NEW_TOKEN = 'bbbbbbbb-2222-4222-8222-222222222222';
        const d = labelDaemon();
        d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const runner = dockerRunner(d.exec, { steps: syncSteps().sink });
        const next = { ...repoJob, leaseToken: NEW_TOKEN };
        const result = await runner.syncCheckout(next);

        expect(result).toEqual({ ok: true, reason: null });
        // The previous runner is off the daemon; what is there is the new attempt's own group.
        expect([...d.containers.keys()]).toEqual([supervisorName(next)]);
        const rmIndex = d.calls.findIndex((a) => a[0] === 'rm');
        const createIndex = d.calls.findIndex((a) => a[0] === 'create');
        expect(rmIndex).toBeGreaterThanOrEqual(0);
        expect(rmIndex).toBeLessThan(createIndex);
    });

    // A fence that converts a failed `docker ps` into an empty answer reads "nothing left" —
    // and the sync would start while a previous attempt's runner is still writing the worktree.
    // The fence is infrastructure, not the command's verdict: it must throw, and the loop's
    // try/catch around syncCheckout leaves the job to its lease. The same holds for every verb
    // of the fence, with the leftover the refused verb would have touched seeded.
    it.each<[string, (args: string[]) => string | null, 'container' | null]>([
        [
            'cannot list the job’s leftover containers',
            (args) => (args[0] === 'ps' ? 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' : null),
            null,
        ],
        [
            'a leftover container refuses to be removed',
            (args) => (args[0] === 'rm' ? 'Error: cannot remove container: device is busy' : null),
            'container',
        ],
    ])('fails the sync when the fence %s', async (_label, fail, leftover) => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const d = labelDaemon({ fail });
        const labels = { 'factory.job': job.id, 'factory.lease': OLD_TOKEN };
        if (leftover === 'container') d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), labels);
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });

        await expect(runner.syncCheckout(repoJob)).rejects.toThrow(/re-claim fence/);
        // No group, and no sync step, over an unfenced checkout: the throw precedes both.
        expect(d.calls.some((a) => a[0] === 'create')).toBe(false);
        expect(supervised.steps()).toEqual([]);
    });

    // The one tolerated shape: a container exiting between the fence's ps and its rm answers
    // "No such container" — the fence SUCCEEDED, the runner is gone. Failing there would burn
    // attempts on the daemon confirming a removal already finished.
    it('proceeds when the fence’s rm answers that the container is already gone', async () => {
        const OLD_TOKEN = 'aaaaaaaa-1111-4111-8111-111111111111';
        const d = labelDaemon({
            fail: (args) =>
                args[0] === 'rm'
                    ? `Error response from daemon: No such container: ${containerName({ ...job, leaseToken: OLD_TOKEN })}`
                    : null,
        });
        d.containers.set(containerName({ ...job, leaseToken: OLD_TOKEN }), {
            'factory.job': job.id,
            'factory.lease': OLD_TOKEN,
        });
        const supervised = syncSteps();
        const runner = dockerRunner(d.exec, { steps: supervised.sink });

        expect(await runner.syncCheckout(repoJob)).toEqual({ ok: true, reason: null });
        expect(d.calls.some((a) => a[0] === 'create' && a.includes(supervisorName(repoJob)))).toBe(true);
        expect(supervised.ofKind('sync')).toHaveLength(1);
    });

    it('runs every publish step inside the task worktree', async () => {
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        await runner.publishGit(ISSUE_JOB);

        const wt = `/workspaces/bellows/${USER}/.worktrees/${job.id}`;
        expect(steps.steps().length).toBeGreaterThan(0);
        for (const step of steps.steps()) {
            if (step.argv.some((x) => x.includes('shortstat'))) {
                // The summarizer (issue #82) is anchored like every git step — the task
                // worktree as its working directory, never the image default, where git would find
                // no repo and the summary would silently degrade to the command title. Pinned
                // explicitly, because its failure mode is the quiet one.
                expect(step.cwd).toBe(wt);
            } else if ('LEDGER' in step.env) {
                // The publication ledger is a file under the worktree, named by path.
                expect(step.env.LEDGER?.startsWith(`${wt}/`)).toBe(true);
            } else if (step.argv.some((x) => x.includes('execFileSync'))) {
                // The probe runs at the mount root and reads the repo by REPO.
                expect(step.env).toMatchObject({ REPO: wt });
            } else {
                expect(step.cwd).toBe(wt);
            }
        }
        // The steps run in the supervisor, which mounts the job's own subtree — the publish never
        // sees another member's tree.
        const create = docker.find((a) => a[0] === 'create' && a.includes(supervisorName(ISSUE_JOB)))!;
        expect(create).toEqual(
            expect.arrayContaining([
                '--mount',
                `type=volume,src=factory-ai_workspaces,volume-subpath=bellows/${USER},target=/workspaces/bellows/${USER}`,
            ])
        );
    });

    // The loop asks the board for a token right before the push (docs/connections.md); the env the
    // steps ride must carry THAT credential, and a claim value under the reserved name never.
    it("publishes with the board's minted token, never a claim value", async () => {
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN);
        const result = await runner.publishGit(ISSUE_JOB, 'ghs_fresh');

        expect(result.ok).toBe(true);
        const credentialed = steps.steps().filter((step) => 'GITHUB_TOKEN' in step.env);
        expect(credentialed.length).toBeGreaterThan(0);
        for (const step of credentialed) expect(step.env.GITHUB_TOKEN).toBe('ghs_fresh');
        expect(JSON.stringify(steps.steps())).not.toContain('t0k-3n');
        // Credentials ride the step and nothing else: never the daemon's argv.
        expect(docker.flat().join(' ')).not.toContain('ghs_fresh');
    });

    // Executor parity for the publish flag (docs/workflows.md): the flag is read in exactly ONE
    // place — the loop, shared by both executors — so this transport must have no opinion of its
    // own. The loop tests pin that a publish:false claim never reaches publishGit; this pins the
    // other half, that the docker transport grew no gate of its own to drift against.
    // Issue #825, executor parity: a bound publish's tree check rides the supervisor's steps here
    // exactly as under kubernetes — staged hook-free, the commit held to that tree.
    it.each([
        ['pushes when the commit holds the staged tree', {}, true],
        ['refuses stale, pushing nothing, when a commit hook moved it', { committed: 'b'.repeat(40) }, false],
    ])('a bound publish %s', async (_case, trees, published) => {
        const bound = { ...DIRTY_ON_MAIN, fingerprint: 'h:1' };
        const { steps, runner } = publishRunner(bound, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
            trees,
        });

        const result = await runner.publishGit(ISSUE_JOB, undefined, { revision: 'h:1' });

        expect(result).toMatchObject(published ? { ok: true, published } : { ok: false, stale: true });
        const argvs = steps.steps().map((step) => step.argv);
        expect(argvs.some((a) => a.includes('write-tree') && a.includes('core.hooksPath=/dev/null'))).toBe(true);
        expect(argvs.some((a) => a.includes('push'))).toBe(published);
    });

    it('leaves the publish decision to the loop: publishGit ignores a publish:false claim', async () => {
        const { steps, runner } = publishRunner(DIRTY_ON_MAIN);
        const result = await runner.publishGit({ ...ISSUE_JOB, publish: false });

        expect(result.ok).toBe(true);
        expect(steps.steps().length).toBeGreaterThan(0);
    });

    it('refuses branch names that could read as something else', () => {
        expect(isBranchName('fix/10')).toBe(true);
        expect(isBranchName('task/20260909')).toBe(true);
        expect(isBranchName('')).toBe(false);
        expect(isBranchName('../etc')).toBe(false);
        expect(isBranchName('-oProxyCommand')).toBe(false);
        expect(isBranchName('a b')).toBe(false);
    });

    it('probes without a shell and reads the credential from the environment, never argv', () => {
        // Every git call in the probe is execFileSync — no value can become a command.
        expect(gitProbeScript).toContain('execFileSync');
        expect(gitProbeScript).not.toContain('execSync(');
        // "Unpushed" is counted against the remote default branch, never `@{u}`: a branch that
        // was never pushed has no upstream, and the fatal rev-list would read its local-only
        // commits as fully landed — which once reported a two-commit task branch as "nothing to
        // publish".
        expect(gitProbeScript).toContain("'origin/' + out.defaultBranch + '..HEAD'");
        expect(gitProbeScript).not.toContain('@{u}');
        // The helper reads the token from the container's environment — the env file's job —
        // and the literal appears in no argv the publisher builds.
        expect(CREDENTIAL_HELPER).toContain('$GITHUB_TOKEN');
    });

    it('parses the probe’s answer, defaulting anything missing', () => {
        expect(
            parseGitState(
                '{"cloned":true,"branch":"fix/10","defaultBranch":"main","dirty":true,"unpushed":2,"hasIdentity":false}'
            )
        ).toEqual({
            cloned: true,
            branch: 'fix/10',
            defaultBranch: 'main',
            dirty: true,
            unpushed: 2,
            hasIdentity: false,
            fingerprint: null,
            conflicts: [],
            rebasing: false,
        });
        expect(parseGitState('{"cloned":true,"fingerprint":"abc:def"}').fingerprint).toBe('abc:def');
        expect(parseGitState('')).toEqual({
            cloned: false,
            branch: '',
            defaultBranch: 'main',
            dirty: false,
            unpushed: 0,
            hasIdentity: false,
            fingerprint: null,
            conflicts: [],
            rebasing: false,
        });
    });

    it('parses the PR summary’s answer, defaulting anything missing', () => {
        expect(parsePrSummary('{"title":"Fix the fence","body":"## Commits"}')).toEqual({
            title: 'Fix the fence',
            body: '## Commits',
        });
        expect(parsePrSummary('{"title":"","body":null}')).toEqual({ title: null, body: null });
        expect(parsePrSummary('')).toEqual({ title: null, body: null });
        expect(parsePrSummary('git: fatal: not a git repository')).toEqual({ title: null, body: null });
    });

    it('defaults the probe’s and the PR summary’s answers for a null last line or a non-JSON last line', () => {
        const unread = {
            cloned: false,
            branch: '',
            defaultBranch: 'main',
            dirty: false,
            unpushed: 0,
            hasIdentity: false,
            fingerprint: null,
            conflicts: [],
            rebasing: false,
        };
        expect(parseGitState('null')).toEqual(unread);
        expect(parseGitState('{"cloned":true}\nnoise')).toEqual(unread);
        expect(parsePrSummary('null')).toEqual({ title: null, body: null });
        expect(parsePrSummary('{"title":"t","body":"b"}\nnoise')).toEqual({ title: null, body: null });
    });

    /**
     * The supervisor stood in: the probe answers from `state`, git steps mutate nothing, and every
     * step the runner submits is recorded, so the flow — what ran, in which order, and what was
     * skipped — is the assertion. A step is a request over the control channel, never a container:
     * the daemon only ever sees the group (the supervisor), recorded in `docker`.
     */
    const publishRunner = (
        state: Record<string, unknown>,
        opts: {
            prExists?: boolean;
            fail?: ((argv: string[]) => boolean) | undefined;
            /** The step's stderr, as the supervisor answers it beside a non-zero exit. */
            failStderr?: string;
            summary?: Record<string, unknown>;
            exec?: (args: string[]) => Promise<{ stdout: string }>;
            /** What a bound publish's staged and committed trees read (issue #825); default both one tree. */
            trees?: { staged?: string; committed?: string };
        } = {}
    ) => {
        const docker: string[][] = [];
        const steps = fakeSteps((step) => {
            const argv = step.argv;
            if (opts.fail?.(argv)) {
                return { exitCode: 1, stdout: '', stderr: opts.failStderr ?? 'step refused', timedOut: false };
            }
            // The publication ledger answers "never recorded", and HEAD is a commit.
            if ('LEDGER' in step.env) return ok('{}');
            if (argv.includes('write-tree')) return ok(`${opts.trees?.staged ?? 't'.repeat(40)}\n`);
            if (argv.includes('HEAD^{tree}')) return ok(`${opts.trees?.committed ?? 't'.repeat(40)}\n`);
            if (argv.includes('rev-parse')) return ok(`${'a'.repeat(40)}\n`);
            // The probe's marker rides INSIDE the -e script string; the git steps carry their
            // subcommand as a standalone argv element. The PR summarizer (issue #82) is the
            // second node step — told apart by the git argv its script embeds.
            if (argv.some((a) => a.includes('execFileSync'))) {
                if (argv.some((a) => a.includes('shortstat'))) return ok(JSON.stringify(opts.summary ?? SUMMARY));
                return ok(JSON.stringify(state));
            }
            if (argv.includes('pr') && argv.includes('view')) {
                if (opts.prExists) return ok(`${PR_URL}\n`);
                return { exitCode: 1, stdout: '', stderr: 'no pull requests', timedOut: false };
            }
            if (argv.includes('pr') && argv.includes('create')) return ok(`${PR_URL}\n`);
            return ok();
        });
        const exec =
            opts.exec ??
            (vitest.fn(async (args: string[]) => {
                docker.push(args);
                return { stdout: args[0] === 'wait' ? '0\n' : '' };
            }) as unknown as (args: string[]) => Promise<{ stdout: string }>);
        const runner = dockerRunner(exec, { spawn: spawnChild(''), steps: steps.sink });
        return { steps, docker, runner };
    };

    const DIRTY_ON_MAIN = {
        cloned: true,
        branch: 'main',
        defaultBranch: 'main',
        dirty: true,
        unpushed: 0,
        hasIdentity: false,
    };

    /** What the PR summarizer answers (issue #82): what the branch did, not what was asked. */
    const SUMMARY = { title: 'Fix the sync re-claim fence', body: '## Commits\n\n- Fix the sync re-claim fence' };

    const argvsOf = (steps: ReturnType<typeof fakeSteps>): string[][] => steps.steps().map((step) => step.argv);

    const shapesOf = (steps: ReturnType<typeof fakeSteps>): string[] =>
        steps.steps().map(({ argv: a, env }) => {
            // The publication ledger (publish-reconcile.ts) is a node step keyed by its LEDGER path.
            if ('LEDGER' in env) return 'ledger';
            if (a.includes('rev-parse')) return 'rev-parse';
            if (a.some((x) => x.includes('execFileSync'))) {
                return a.some((x) => x.includes('shortstat')) ? 'summary' : 'probe';
            }
            if (a.includes('switch')) return 'switch';
            if (a.includes('add')) return 'add';
            if (a.includes('reset')) return 'reset';
            if (a.includes('commit')) return 'commit';
            if (a.includes('push')) return 'push';
            if (a.includes('view')) return 'pr-view';
            if (a.includes('create')) return 'pr-create';
            return 'other';
        });

    // The post-gate tree read: one probe step over the worktree, with no claim env.
    it('probes the tree fingerprint with one env-less step', async () => {
        const { steps, runner } = publishRunner({ ...DIRTY_ON_MAIN, fingerprint: 'h:1' });

        expect(await runner.probeTree(ISSUE_JOB)).toBe('h:1');

        expect(shapesOf(steps)).toEqual(['probe']);
        const [probe] = steps.ofKind('probe');
        expect(probe?.env).toEqual({ REPO: worktreeDir(loadDriverConfig({}), ISSUE_JOB) });
        expect(JSON.stringify(steps.steps())).not.toContain('t0k-3n');
    });

    // A Stop while the probe step is in flight ends the wait for its answer, never the supervisor.
    it('hands the stand-down signal to the probe step and answers null once it aborts', async () => {
        const cancel = new AbortController();
        const seen: (AbortSignal | undefined)[] = [];
        const sink: StepSink = {
            submit: async (_token, _step, signal) => {
                seen.push(signal);
                cancel.abort();
                throw new Error('step was cancelled');
            },
            awaitReport: () => Promise.resolve(FINALIZED),
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };
        const exec = (async () => ({ stdout: '' })) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild(''), steps: sink });

        expect(await runner.probeTree(ISSUE_JOB, cancel.signal)).toBeNull();

        expect(seen).toEqual([cancel.signal]);
    });

    it.each([
        ['answers no fingerprint', {}, undefined],
        ['fails', {}, () => true],
    ])('answers null when the probe %s', async (_label, extra, fail) => {
        const { runner } = publishRunner({ ...DIRTY_ON_MAIN, ...extra }, { fail });
        expect(await runner.probeTree(ISSUE_JOB)).toBeNull();
    });

    // The review snapshot of an attempt with no group yet (an adopted run): a supervisor-only group
    // is made for it, and its one `snapshot` step carries the stand-down signal.
    it('snapshots the tree as one snapshot step with the signal, making the supervisor-only group', async () => {
        const cancel = new AbortController();
        const seen: { step: StepRequest; signal: AbortSignal | undefined }[] = [];
        const sink: StepSink = {
            submit: async (_token, step, signal) => {
                seen.push({ step, signal });
                return ok('{"ok":true}');
            },
            awaitReport: () => Promise.resolve(FINALIZED),
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };
        const docker: string[][] = [];
        const exec = (async (args: string[]) => {
            docker.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { spawn: spawnChild(''), steps: sink });

        expect(await runner.snapshotTree(ISSUE_JOB, 'review-1', cancel.signal)).toMatchObject({ ok: true });

        expect(seen.map(({ step }) => step.kind)).toEqual(['snapshot']);
        expect(seen[0]?.signal).toBe(cancel.signal);
        const created = docker.filter((a) => a[0] === 'create').map((a) => a[a.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(ISSUE_JOB)]);
    });

    it('branches, commits, pushes and opens the PR — in that order', async () => {
        // The checkout sits on main with no fix branch yet: the plain switch refuses (no such
        // branch), and `-c` creates it — both calls are part of the expected shape.
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        const result = await runner.publishGit(ISSUE_JOB, 'ghs_minted');

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
        const calls = argvsOf(steps);
        expect(shapesOf(steps)).toEqual([
            'probe',
            'switch',
            'switch',
            'add',
            'reset',
            'commit',
            // The operation (`branch@sha`) is named and recorded in the publication ledger around
            // each effect, so a retry after a lost answer reads what happened instead of redoing it.
            'rev-parse',
            'ledger',
            'push',
            'ledger',
            'pr-view',
            'summary',
            'pr-create',
            'ledger',
        ]);
        // The decisions are publishCheckout's (publish-checkout.test.ts); this is their supervised
        // rendering. A step that needs the claim env gets it as its own env, never on argv — and
        // nowhere in what the daemon was asked.
        const pushStep = steps.steps().find((step) => step.argv.includes('push'))!;
        expect(pushStep.argv).toContain('--force-with-lease');
        expect(pushStep.env).toMatchObject({ GITHUB_TOKEN: 'ghs_minted' });
        expect(JSON.stringify(steps.steps())).not.toContain('t0k-3n');
        expect(calls.flat().join(' ')).not.toContain('ghs_minted');
        expect(docker.flat().join(' ')).not.toContain('ghs_minted');
        // A step's literal envs ride as env, and a step that needs no credential carries none.
        const summary = steps.steps().find((step) => step.argv.some((x) => x.includes('shortstat')))!;
        expect(summary.env).toEqual({
            BASE: 'origin/main',
            BACKSTOP_TITLE: '/fix https://github.com/Bellows-AI/factory/issues/10 (#10)',
        });
        // The summarizer's stdout reaches the PR through this transport.
        const create = calls.find((a) => a.includes('pr') && a.includes('create'));
        expect(create?.[create.indexOf('--title') + 1]).toBe('Fix the sync re-claim fence (#10)');
    });

    // The acceptance of #771: a sync or a publish step is a request to the task supervisor, never a
    // `docker run`. The daemon is asked for the group's own containers and nothing else.
    it('starts no container of its own for a sync or a publish step', async () => {
        const { steps, docker, runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('switch') && !a.includes('-c'),
        });
        await runner.syncCheckout(ISSUE_JOB);
        await runner.publishGit(ISSUE_JOB);

        expect(steps.steps().length).toBeGreaterThan(0);
        expect(docker.some((a) => a[0] === 'run')).toBe(false);
        const created = docker.filter((a) => a[0] === 'create').map((a) => a[a.indexOf('--name') + 1]);
        expect(created).toEqual([supervisorName(ISSUE_JOB)]);
    });

    // Issue #581: the board recovers a failed publish by its cause, read from the step's own words.
    it('names a rejected non-fast-forward push a conflict', async () => {
        const { runner } = publishRunner(DIRTY_ON_MAIN, {
            fail: (a) => a.includes('push'),
            failStderr: ' ! [rejected]        HEAD -> fix/10 (non-fast-forward)\nerror: failed to push some refs',
        });
        const result = await runner.publishGit(ISSUE_JOB);

        expect(result).toMatchObject({ ok: false, published: false, cause: 'conflict' });
    });

    // The group the publish needs is infrastructure: a daemon that refuses it is thrown to the
    // loop — never a publish verdict, and no step is asked of a supervisor that does not exist.
    it('throws, submitting nothing, when the daemon refuses the group a publish needs', async () => {
        const { steps, runner } = publishRunner(DIRTY_ON_MAIN, {
            exec: async (args) => {
                if (args[0] === 'create') throw new Error('Error response from daemon: no space left on device');
                return { stdout: '' };
            },
        });

        await expect(runner.publishGit(ISSUE_JOB)).rejects.toThrow('no space left on device');
        expect(steps.steps()).toEqual([]);
    });
});

describe('the block-helper transport (issue #207)', () => {
    const NOOP_SCRIPT = lookupHelper('noop')!.scriptBody;
    const NOOP_VERDICT = JSON.stringify({ schema: 'helper-noop/v1', version: 1, ok: true, output: { echoed: true } });
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory', env: { GITHUB_TOKEN: 'claim-token' } };
    const plan = (over: Partial<HelperPlan> = {}): HelperPlan => ({
        helperId: 'noop',
        phase: 'pre',
        input: { a: 1 },
        githubWriting: false,
        ...over,
    });

    /** A runner whose supervisor answers each helper step with `answer`; the daemon's every argv is kept. */
    const helperRunner = (
        answer: (step: StepRequest) => StepResult | Promise<StepResult> = () => ok(NOOP_VERDICT),
        env: Record<string, string> = {}
    ) => {
        const docker: string[][] = [];
        const supervised = fakeSteps(answer);
        const exec = vitest.fn(async (args: string[]) => {
            docker.push(args);
            return { stdout: args[0] === 'wait' ? '0\n' : '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        return { docker, supervised, runner: dockerRunner(exec, { env, steps: supervised.sink }) };
    };

    // Issue #826: the same receipt bracket and the same loss rule as the kubernetes runner.
    it('brackets a receipted helper with its receipt in the task worktree, and throws a lost supervisor', async () => {
        // The receipt's MAC key: a driver without a board token keeps no receipt.
        const { supervised, runner } = helperRunner(receiptedAnswer, { JOB_BOARD_TOKEN: 'board-key' });
        await runner.runHelper(repoJob, plan({ helperId: REVIEW_REPLY_PROBE_ID, githubWriting: true }), {
            token: 'fresh-install-token',
            effectId: 'effect-1',
        });
        expect(receiptOrder(supervised.steps())).toEqual(['read', 'started', 'helper', 'done']);
        expect(supervised.steps()[0]!.env.LEDGER).toMatch(/\/\.worktrees\/[^/]+\/\.factory\/helpers\.json$/);

        const lost = helperRunner(async () => {
            throw new StepChannelClosed('the helper');
        });
        await expect(lost.runner.runHelper(repoJob, plan())).rejects.toBeInstanceOf(StepChannelClosed);
    });

    it('fails an unknown helper id before any step is submitted', async () => {
        const { supervised, runner } = helperRunner();
        const result = await runner.runHelper(job, plan({ helperId: 'not-a-real-helper' }));
        expect(result).toEqual({
            ok: false,
            reason: 'unknown_helper',
            message: expect.stringContaining('not-a-real-helper'),
        });
        expect(supervised.steps()).toEqual([]);
    });

    // A group the daemon refuses is a failed helper in the daemon's own words, bounded — never a throw.
    it('fails a helper whose group the daemon refuses with the first 300 chars of its stderr', async () => {
        const stderr = `  Error response from daemon: ${'x'.repeat(400)}  \n`;
        const supervised = fakeSteps(() => ok(NOOP_VERDICT));
        const exec = (async (args: string[]) => {
            if (args[0] === 'create') throw Object.assign(new Error('Command failed: docker create'), { stderr });
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, { steps: supervised.sink });

        const result = await runner.runHelper(repoJob, plan());

        expect(result).toEqual({ ok: false, reason: 'runner_error', message: stderr.trim().slice(0, 300) });
        expect(supervised.steps()).toEqual([]);
    });

    it('runs the noop helper end to end, as one supervised step with node and the script by content', async () => {
        const { docker, supervised, runner } = helperRunner();
        const result = await runner.runHelper(repoJob, plan());

        expect(result).toEqual({ ok: true, output: { echoed: true } });
        const [step] = supervised.ofKind('helper');
        // Submitted to the attempt's supervisor, under the token only it holds.
        expect(supervised.submitted.map((entry) => entry.token)).toEqual([CONTROL_TOKEN]);
        expect(step?.argv).toEqual(['node', '-e', NOOP_SCRIPT]);
        expect(step?.timeoutMs).toBe(HELPER_TIMEOUT_MS);
        // Each call is its own operation: a helper is never replayed from an earlier answer.
        expect(step?.id).toMatch(/^helper-[0-9a-f]{16}-/);
        // The task worktree, when the job names a repo — the same tree the agent run edits.
        expect(step?.cwd).toBe(`/workspaces/bellows/${USER}/.worktrees/${job.id}`);
        // A read-only helper (githubWriting: false) gets its bounded input and nothing of the claim env.
        expect(step?.env).toEqual({ HELPER_INPUT: JSON.stringify({ a: 1 }) });
        // No container of its own: the daemon never saw the helper.
        expect(docker.some((a) => a[0] === 'run')).toBe(false);
    });

    it('maps a step the supervisor timed out to a named timeout failure', async () => {
        const { runner } = helperRunner(() => ({ exitCode: null, stdout: '', stderr: '', timedOut: true }));
        const result = await runner.runHelper(job, plan());
        expect(result).toEqual({ ok: false, reason: 'timeout', message: expect.stringContaining('ms bound') });
    });

    it('hands the stand-down signal to the step, and a cancelled helper is no timeout (issue #488)', async () => {
        const controller = new AbortController();
        const seen: (AbortSignal | undefined)[] = [];
        const sink: StepSink = {
            submit: async (_token, _step, signal) => {
                seen.push(signal);
                controller.abort();
                throw new Error('step was cancelled');
            },
            awaitReport: () => Promise.resolve(FINALIZED),
            contacted: () => true,
            release: () => undefined,
            attach: () => undefined,
            cancel: () => undefined,
        };
        const runner = dockerRunner(emptyDaemon, { steps: sink });

        const result = await runner.runHelper(job, plan(), { signal: controller.signal });

        expect(seen).toEqual([controller.signal]);
        expect(result).toMatchObject({ ok: false, reason: 'runner_error' });
    });

    it('carries a fresh token in the step env, only for a github-writing helper', async () => {
        const { supervised, runner } = helperRunner();
        const result = await runner.runHelper(repoJob, plan({ githubWriting: true }), {
            token: 'fresh-install-token',
        });

        expect(result).toEqual({ ok: true, output: { echoed: true } });
        const [step] = supervised.ofKind('helper');
        // The minted token is the step's GitHub credential; a claim value under the name never is.
        expect(step?.env).toMatchObject({ GITHUB_TOKEN: 'fresh-install-token' });
        expect(JSON.stringify(step)).not.toContain('claim-token');
    });

    it('never puts the token in the daemon’s argv or the step’s — only in the step env', async () => {
        const { docker, supervised, runner } = helperRunner();
        await runner.runHelper(repoJob, plan({ githubWriting: true }), { token: 'super-secret-token' });
        expect(docker.flat().some((a) => a.includes('super-secret-token'))).toBe(false);
        const [step] = supervised.ofKind('helper');
        expect(step?.argv.some((a) => a.includes('super-secret-token'))).toBe(false);
        expect(step?.env.GITHUB_TOKEN).toBe('super-secret-token');
    });

    it('maps any other failure to runner_error, using the tool own output', async () => {
        const { runner } = helperRunner(() => ({
            exitCode: 1,
            stdout: '',
            stderr: 'permission denied while running the helper',
            timedOut: false,
        }));
        const result = await runner.runHelper(job, plan());
        expect(result).toEqual({
            ok: false,
            reason: 'runner_error',
            message: expect.stringContaining('permission denied'),
        });
    });

    it('runs a command-only job (no repo) at the member root, with no working directory', async () => {
        const { supervised, runner } = helperRunner();
        await runner.runHelper(job, plan());
        expect(supervised.ofKind('helper')[0]).not.toHaveProperty('cwd');
    });
});

/*
 * Issue #382, the docker half. Kubernetes is the primary executor, but a hardening that exists on
 * only one of them is a hardening an operator cannot reason about — and docker is the executor a
 * developer actually runs agent-written code under, on their own machine, against a daemon that
 * is root on it. Same two controls, spelled the way docker spells them:
 *
 *   --cap-drop ALL                      the kubernetes `capabilities.drop: [ALL]`
 *   --security-opt no-new-privileges    the kubernetes `allowPrivilegeEscalation: false`
 *
 * There is no seccomp twin to assert: the daemon applies its own default profile to every
 * container unless told otherwise, which is what `seccompProfile: RuntimeDefault` asks the kubelet
 * for. Adding a flag to restate it would be a flag that can only ever be wrong.
 *
 * Asserted as an ADJACENT ARGV PAIR, never as "contains the flag": `--cap-drop` separated from
 * `ALL` by an inserted argument is the exact bug a substring check reports as passing, and the
 * argv is built by concatenation in thirteen places.
 */
describe('every container the driver runs is hardened (#382)', () => {
    /** The flag and its value, as the pair docker reads them — index-adjacent or it is not set. */
    const hasPair = (argv: string[], flag: string, value: string): boolean =>
        argv.some((arg, i) => arg === flag && argv[i + 1] === value);

    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    const config = () => loadDriverConfig({});
    const builders: [string, () => string[]][] = [
        ['the runner', () => dockerArgs(config(), job, { id: SESSION, resume: false }, { envFile: '/tmp/env-file' })],
        ['the gate container', () => gateCreateArgs(config(), job, 'node:24')],
        ['the opencode session readout', () => opencodeSessionReadoutArgs(config(), opencodeJob, START)],
        ['the opencode cache probe', () => opencodeCacheProbeArgs(config(), opencodeJob)],
        ['the claude turns readout', () => claudeTurnsArgs(config(), job, SESSION, START)],
        [
            'the task supervisor',
            () => supervisorCreateArgs(config(), job, { exporting: true, agentless: false }, '/tmp/supervisor.env'),
        ],
        [
            'the task supervisor of an agentless or reclaim group',
            () => supervisorCreateArgs(config(), repoJob, { exporting: false, agentless: true }, '/tmp/supervisor.env'),
        ],
        ['the claude transcript exporter', () => exporterCreateArgs(config(), job, START, '/tmp/export.env')],
        [
            'a declared service',
            () => serviceRunArgs(job, { name: 'cache', image: 'redis', environment: [] }, supervisorName(job)),
        ],
        ['the tool tree release', () => toolTreeReleaseArgs(config(), repoJob) ?? []],
    ];

    it.each(builders)('drops every capability on %s', (_name, build) => {
        expect(hasPair(build(), '--cap-drop', 'ALL')).toBe(true);
    });

    // Issue #814: the runner starts as root to launch its tool broker, with exactly the two
    // capabilities a uid switch needs; factory-launch drops both before the CLI starts.
    it('starts the runner as root with SETUID and SETGID added, and nothing else', () => {
        const argv = builders[0]![1]();
        expect(hasPair(argv, '--user', '0:0')).toBe(true);
        expect(argv.flatMap((arg, i) => (arg === '--cap-add' ? [argv[i + 1]] : []))).toEqual(['SETUID', 'SETGID']);
    });

    it.each(builders.slice(1))('adds no capability to %s and never starts it as root', (_name, build) => {
        const argv = build();
        expect(argv).not.toContain('--cap-add');
        expect(hasPair(argv, '--user', '0:0')).toBe(false);
    });

    it.each(builders)('refuses privilege escalation on %s', (_name, build) => {
        expect(hasPair(build(), '--security-opt', 'no-new-privileges')).toBe(true);
    });

    /*
     * The paths that used to build a `docker run` argv INLINE — the worktree reclaim, the publish
     * steps, the tree probe and the block helpers — now ask the task supervisor for a step instead
     * (#771). What they leave on the daemon is the group they ran in, so what is asserted is every
     * container THEY create (the supervisor of a group they open) and that none of them runs one
     * of its own: a new `docker run` site would land here unnoticed otherwise.
     *
     * Asserted through each path's own `execDocker` fake, so the argv checked is the argv the
     * daemon would have been handed.
     */
    const containersFrom = async (drive: (runner: ReturnType<typeof createDockerRunner>) => Promise<unknown>) => {
        const calls: string[][] = [];
        const exec = vitest.fn(async (args: string[]) => {
            calls.push(args);
            return { stdout: args[0] === 'wait' ? '0\n' : '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(
            exec,
            // A fake `files`: the group's control env file is a real file in os.tmpdir() under the
            // default, and an offline unit test has no business touching the filesystem.
            {
                files: { writeFile: async () => undefined, rm: async () => undefined } as unknown as RunnerFiles,
                endpoint: reclaimEndpoint().endpoint,
            }
        );
        await drive(runner).catch(() => undefined);
        return {
            created: calls.filter((a) => a[0] === 'create'),
            runs: calls.filter((a) => a[0] === 'run'),
        };
    };

    it.each([
        [
            'the worktree reclaim',
            (r: ReturnType<typeof createDockerRunner>) => r.reclaimWorktree({ ...job, repo: 'Bellows-AI/factory' }),
        ],
        [
            'a block helper',
            (r: ReturnType<typeof createDockerRunner>) =>
                r.runHelper(job, { helperId: 'noop', phase: 'pre', input: { a: 1 }, githubWriting: false }),
        ],
        [
            'the publish path',
            (r: ReturnType<typeof createDockerRunner>) => r.publishGit({ ...job, repo: 'Bellows-AI/factory' }),
        ],
        [
            'the tree probe',
            (r: ReturnType<typeof createDockerRunner>) => r.probeTree({ ...job, repo: 'Bellows-AI/factory' }),
        ],
        [
            'the startup sync',
            (r: ReturnType<typeof createDockerRunner>) => r.syncCheckout({ ...job, repo: 'Bellows-AI/factory' }),
        ],
    ])('hardens every container %s creates or runs', async (name, drive) => {
        const { created, runs } = await containersFrom(
            drive as (r: ReturnType<typeof createDockerRunner>) => Promise<unknown>
        );
        // The load-bearing guard: a path that created nothing would pass the loop below vacuously.
        expect(created.length).toBeGreaterThan(0);
        // A step runs in the supervisor, never in a container of its own. The one throwaway is the
        // tool uid's release of the tree before the reclaim (issue #814), hardened like the rest.
        expect(runs).toHaveLength(name === 'the worktree reclaim' ? 1 : 0);
        for (const argv of [...created, ...runs]) {
            expect(hasPair(argv, '--cap-drop', 'ALL')).toBe(true);
            expect(hasPair(argv, '--security-opt', 'no-new-privileges')).toBe(true);
        }
    });

    // A service has no opt-out: a stock image that needs root at boot declares its own uid:gid,
    // and every capability stays dropped.
    it('runs a declared service as its declared uid:gid, still hardened', () => {
        const argv = serviceRunArgs(
            job,
            {
                name: 'db',
                image: 'postgres:17',
                environment: [],
                user: { uid: 999, gid: 999 },
            },
            supervisorName(job)
        );
        expect(hasPair(argv, '--user', '999:999')).toBe(true);
        expect(hasPair(argv, '--cap-drop', 'ALL')).toBe(true);
        expect(hasPair(argv, '--security-opt', 'no-new-privileges')).toBe(true);
        expect(argv.indexOf('--user')).toBeLessThan(argv.indexOf('postgres:17'));
    });

    it('passes no --user to a service that declared none', () => {
        expect(
            serviceRunArgs(job, { name: 'db', image: 'postgres:17', environment: [] }, supervisorName(job))
        ).not.toContain('--user');
    });
});

/*
 * Issue #823: a group whose supervisor is gone — it exited without a report the driver took, or a
 * kill took the group away — leaves nothing to answer a step. Its channel is released, so the
 * probe and `finish` the loop still sends fail at once instead of waiting out each step's timeout
 * and the answer grace, three times over.
 */
describe('a group whose supervisor is gone releases its step channel', () => {
    const exited = (args: string[]) => {
        if (args[0] === 'inspect') return Promise.reject(new Error('Error: No such object'));
        return Promise.resolve({ stdout: args[0] === 'wait' ? '0\n' : '' });
    };
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };

    it('releases the channel when the run sees the supervisor exit with no report taken', async () => {
        const supervised = fakeSteps(() => ok(), new Promise<SupervisorReport>(() => undefined));
        await dockerRunner(exited, { steps: supervised.sink }).run(job, { id: SESSION, resume: false });
        expect(supervised.released).toEqual([CONTROL_TOKEN]);
    });

    it('keeps the channel of a supervisor that reported and serves on', async () => {
        const supervised = fakeSteps();
        await dockerRunner(exited, { steps: supervised.sink }).run(job, { id: SESSION, resume: false });
        expect(supervised.released).toEqual([]);
    });

    it('releases the channel when a stop finds the supervisor already exited', async () => {
        const supervised = fakeSteps();
        await dockerRunner(exited, { steps: supervised.sink }).stopAgent(job);
        expect(supervised.released).toEqual([CONTROL_TOKEN]);
    });

    it('fails a step in flight at once when a kill takes the group away', async () => {
        const broker = createStepBroker();
        broker.open(CONTROL_TOKEN);
        // The supervisor is stood in by this test's own pulls, repeated as a real one's are: a pull
        // before the group is made again is lost with the old slot, and the group's wait has to see one.
        const pull = async () => {
            for (;;) {
                const next = await broker.next(CONTROL_TOKEN, 20, new AbortController().signal);
                if (next) return next;
            }
        };
        const runner = dockerRunner(emptyDaemon, {
            steps: broker,
            sleep: () => new Promise((resolve) => setTimeout(resolve, 5)),
        });
        const probing = runner.probeTree(repoJob);
        expect(await pull()).toMatchObject({ kind: 'probe' });
        await runner.kill(repoJob);
        expect(await probing).toBeNull();
    });

    it('ends the first-contact wait at once when a kill lands while the group is being made', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        let gated = false;
        const exec = async (args: string[]) => {
            // The first call that makes or starts the group is held; the kill lands behind it.
            if (!gated && (args[0] === 'create' || args[0] === 'run' || args[0] === 'start')) {
                gated = true;
                await gate;
            }
            return { stdout: '' };
        };
        let sleeps = 0;
        const runner = dockerRunner(exec as never, {
            steps: createStepBroker(),
            sleep: async () => {
                sleeps += 1;
            },
        });
        const probing = runner.probeTree(repoJob);
        while (!gated) await new Promise((resolve) => setTimeout(resolve, 1));
        await runner.kill(repoJob);
        const sleptBeforeRelease = sleeps;
        release();
        await expect(probing).rejects.toThrow(/killed while (setting up services|its task group came up)/);
        expect(sleeps - sleptBeforeRelease).toBeLessThanOrEqual(2);
    });

    it('creates no group for a lease its driver killed, for the sync or any later step', async () => {
        const calls: string[][] = [];
        const exec = async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        };
        const runner = dockerRunner(exec as never, { steps: createStepBroker() });
        await runner.kill(repoJob);
        const killedAt = calls.length;
        await expect(runner.probeTree(repoJob)).rejects.toThrow(/killed while setting up services/);
        await expect(runner.syncCheckout(repoJob)).rejects.toThrow(/killed while setting up services/);
        expect(calls.slice(killedAt).filter((args) => ['create', 'run', 'start'].includes(args[0] ?? ''))).toEqual([]);
    });
});

/*
 * Issue #821 D16: a kill takes the group out of the runner's memory, and the `finish` that follows
 * must still remove what the kill only stopped — the supervisor, the exporter and the four
 * mailboxes — by this attempt's own names, without waiting on a supervisor the kill already ended.
 */
describe('a kill followed by finish removes the group (#821 D16)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };

    it('removes the supervisor, the exporter and every mailbox volume, by the killed attempt names', async () => {
        const { exec, calls } = entrypointAnswers('');
        const runner = dockerRunner(exec, { steps: syncSteps().sink });
        expect((await runner.syncCheckout(repoJob)).ok).toBe(true);
        await runner.kill(repoJob);
        const killedAt = calls.length;

        await runner.finish(repoJob);

        const after = calls.slice(killedAt);
        expect(after).toContainEqual(['rm', '-f', supervisorName(repoJob)]);
        expect(after).toContainEqual(['rm', '-f', exporterName(repoJob)]);
        for (const box of Object.values(MAILBOXES)) {
            expect(after).toContainEqual(['volume', 'rm', '-f', ctlVolumeName(repoJob, box)]);
        }
        // The kill already ended the group: nothing waits on its supervisor again.
        expect(after.filter((args) => args[0] === 'wait')).toEqual([]);
        // Attempt-scoped: every removal names this attempt, never a newer lease of the same job.
        const newer = '55555555-5555-4555-8555-555555555555';
        expect(after.flat().some((arg) => arg.includes(newer))).toBe(false);
        for (const args of after.filter((a) => a[0] === 'rm' || (a[0] === 'volume' && a[1] === 'rm'))) {
            expect(args[args.length - 1]).toContain(repoJob.leaseToken);
        }
    });
});

/*
 * Issue #805: a supervisor that already exited answers `docker wait` at once. Its exit is no sign
 * the agent ended — nobody is left to deliver the kill order — so the stop hard-kills the agent
 * still running, and only the agent: the supervisor's loss stays the close path's to record.
 */
describe('stopping an agent whose supervisor already exited (#805)', () => {
    const daemon = (supervisorExit: string, agentPs: string, refuses: (args: string[]) => boolean = () => false) => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            if (refuses(args)) return Promise.reject(new Error('the daemon answered 503'));
            if (args[0] === 'wait') return Promise.resolve({ stdout: `${supervisorExit}\n` });
            if (args[0] === 'ps' && args.includes('label=factory.role=agent'))
                return Promise.resolve({ stdout: agentPs });
            // The whole group's listing; the service teardown's own listing finds no services.
            if (args[0] === 'ps' && !args.includes('label=factory.service'))
                return Promise.resolve({ stdout: 'a1a1a1a1a1a1\na2a2a2a2a2a2\na3a3a3a3a3a3\n' });
            return Promise.resolve({ stdout: '' });
        };
        return { exec, calls };
    };
    const kills = (calls: string[][]) => calls.filter((args) => args[0] === 'kill');

    it('hard-kills the still-running agent, and only it, when the supervisor exited non-zero', async () => {
        const { exec, calls } = daemon('70', 'a1a1a1a1a1a1\n');

        await dockerRunner(exec).stopAgent(job);

        expect(kills(calls)).toEqual([['kill', 'a1a1a1a1a1a1']]);
        const listed = calls.find((args) => args[0] === 'ps' && args.includes('label=factory.role=agent'));
        expect(listed).toEqual(
            expect.arrayContaining([`label=factory.job=${job.id}`, `label=factory.lease=${job.leaseToken}`])
        );
    });

    it('kills nothing when the supervisor finalized and the agent is gone', async () => {
        const { exec, calls } = daemon('0', '');

        await dockerRunner(exec).stopAgent(job);

        expect(kills(calls)).toEqual([]);
    });

    // Never throws, like the kubernetes twin: a lookup the daemon refused falls back to the hard kill.
    it('falls back to the hard kill of the whole group when the agent lookup fails', async () => {
        const { exec, calls } = daemon('70', 'a1a1a1a1a1a1\n', (args) => args.includes('label=factory.role=agent'));

        await dockerRunner(exec).stopAgent(job);

        expect(kills(calls)).toEqual([
            ['kill', 'a1a1a1a1a1a1'],
            ['kill', 'a2a2a2a2a2a2'],
            ['kill', 'a3a3a3a3a3a3'],
        ]);
    });

    // #828: a kill that fails (the agent exited between the listing and the kill, or the daemon
    // refused once) is tried again, never answered with a removal: the exited container is the run
    // the next claim adopts, and only end() removes it.
    it('tries a failed kill again and never removes the agent', async () => {
        const { exec, calls } = daemon('70', 'a1a1a1a1a1a1\n', (args) => args[0] === 'kill');

        await dockerRunner(exec).stopAgent(job);

        expect(kills(calls)).toEqual([
            ['kill', 'a1a1a1a1a1a1'],
            ['kill', 'a1a1a1a1a1a1'],
        ]);
        expect(calls.filter((args) => args[0] === 'rm')).toEqual([]);
    });
});

/*
 * Issue #792, the docker twin: a driver restarted while its runner container ran on. The claim
 * that superseded it reads the EXITED runner container of the earlier claim — exit code, log,
 * session — and only then removes it; the run is never redone.
 */
describe('adopting a finished runner container of an earlier claim (#792)', () => {
    const adopter: BoardJob = { ...job, leaseToken: '99999999-9999-4999-8999-999999999999', claimSeq: 2 };
    const listing = (
        seq = '1',
        lease = job.leaseToken,
        name = containerName({ ...job, leaseToken: lease }),
        command = commandMark(job.command)
    ) => `${name}\t${lease}\t${seq}\t${SESSION}\t${command}\n`;

    /** An attempt older than the one adopted, whose leftovers no adoption reads. */
    const OLDER = '77777777-7777-4777-8777-777777777777';
    /**
     * The fence's own listing: every container of the job by id and lease — the read run's runner
     * and exporter, and an older attempt's leftover.
     */
    const FENCE_PS = `a4a4a4a4a4a4\t${job.leaseToken}\na3a3a3a3a3a3\t${job.leaseToken}\na5a5a5a5a5a5\t${OLDER}\n`;
    /** The fence's volume listing: the read run's mailbox, and the older attempt's. */
    const FENCE_VOLUMES = `read-mailbox\t${job.leaseToken}\nolder-mailbox\t${OLDER}\n`;

    /**
     * The daemon, and the `docker logs` read the adoption streams through spawn — its argv recorded
     * among the daemon calls, in order, its child printing `log` and exiting `logExit`.
     */
    const daemon = (
        ps: string,
        supervisorExit = '0',
        log: string | Buffer[] = 'did the work\n',
        logExit = 0,
        running: string | Error = ''
    ) => {
        const calls: string[][] = [];
        const exec = (args: string[]) => {
            calls.push(args);
            // The still-running runners: none unless a test lists one (#829).
            if (args[0] === 'ps' && args.includes('status=running')) {
                return running instanceof Error ? Promise.reject(running) : Promise.resolve({ stdout: running });
            }
            // The earlier attempt's supervisor: finalized (0) unless a test says how it ended.
            if (args[0] === 'wait') return Promise.resolve({ stdout: `${supervisorExit}\n` });
            if (args[0] === 'ps') return Promise.resolve({ stdout: args.includes('status=exited') ? ps : FENCE_PS });
            if (args[0] === 'volume' && args[1] === 'ls') return Promise.resolve({ stdout: FENCE_VOLUMES });
            // No kill marker recorded: the daemon's own refusal for a volume that does not exist.
            if (args[0] === 'volume' && args[1] === 'inspect') {
                return Promise.reject(
                    Object.assign(new Error('docker volume inspect exited 1'), {
                        stderr: 'Error response from daemon: get factory-kill: no such volume',
                    })
                );
            }
            if (args[0] === 'inspect') {
                return Promise.resolve({
                    stdout: '{"Status":"exited","ExitCode":0,"StartedAt":"2026-10-01T00:00:00Z"}\n',
                });
            }
            return Promise.resolve({ stdout: '' });
        };
        const logs = ((_command: string, args: string[]) => {
            calls.push(args);
            return typeof log === 'string' ? fakeChild(log, '', logExit) : chunkedChild(log, logExit);
        }) as unknown as typeof spawn;
        return { exec, calls, logs };
    };

    /** The removals the daemon was asked for, by the name or id each named last. */
    const removals = (calls: string[][]) =>
        calls
            .filter((args) => args[0] === 'rm' || (args[0] === 'volume' && args[1] === 'rm'))
            .map((args) => args.at(-1));
    /** Whether the runner's own log was read, or anything removed — the supervisor's report is read first. */
    const readOrRemoved = (calls: string[][]) =>
        calls.some((args) => (args[0] === 'logs' && !args.includes(supervisorName(job))) || args[0] === 'rm');
    /** The daemon of `daemon`, whose earlier supervisor logged `report` as its last line. */
    const withReport =
        (base: (args: string[]) => Promise<{ stdout: string }>, report: Record<string, unknown>) => (args: string[]) =>
            args[0] === 'logs' && args.includes(supervisorName(job))
                ? Promise.resolve({
                      stdout: `serving steps\n${SUPERVISOR_REPORT_PREFIX}${JSON.stringify({
                          outcome: 'completed',
                          cause: null,
                          agentExit: 0,
                          agentEnd: 'exit',
                          drained: true,
                          ...report,
                      })}\n`,
                  })
                : base(args);

    // Issue #821 (D1): the read run is the evidence a later claim adopts again if this one is lost
    // before its verdict lands — kept, like the kubernetes Job the adoption spares, until the
    // reaper takes it once the job is terminal. Every older attempt's leftover goes, read first.
    it('reads the exit code, log and session, keeps the read run and sweeps the older leftovers', async () => {
        const { exec, calls, logs } = daemon(listing());

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, timedOut: false, sessionId: SESSION },
        });
        expect(adopted!.outcome.output).toContain('did the work');
        expect(calls[0]).toEqual(expect.arrayContaining(['ps', '-a', `label=factory.job=${job.id}`, 'status=exited']));
        const read = calls.findIndex((args) => args[0] === 'logs');
        const swept = calls.findIndex((args) => args[0] === 'rm' && args.includes('a5a5a5a5a5a5'));
        expect(read).toBeGreaterThanOrEqual(0);
        expect(swept).toBeGreaterThan(read);
        expect(removals(calls)).toEqual(['a5a5a5a5a5a5', 'older-mailbox']);
    });

    it('keeps the read run through every later fence of the adopting attempt', async () => {
        const { exec, calls, logs } = daemon(listing());
        const runner = dockerRunner(exec, { spawn: logs });

        await runner.adopt(adopter);
        calls.length = 0;
        await runner.probeTree(adopter, new AbortController().signal).catch(() => null);

        expect(calls.some((args) => args[0] === 'ps' && !args.includes('status=exited'))).toBe(true);
        expect(removals(calls)).not.toContain('a4a4a4a4a4a4');
        expect(removals(calls)).not.toContain('a3a3a3a3a3a3');
        expect(removals(calls)).not.toContain('read-mailbox');
    });

    it('still sweeps every earlier attempt for a claim that adopted nothing', async () => {
        const { exec, calls, logs } = daemon(listing());

        await dockerRunner(exec, { spawn: logs })
            .probeTree(adopter, new AbortController().signal)
            .catch(() => null);

        expect(removals(calls)).toEqual(
            expect.arrayContaining(['a4a4a4a4a4a4', 'a3a3a3a3a3a3', 'a5a5a5a5a5a5', 'read-mailbox', 'older-mailbox'])
        );
    });

    // A run whose driver could not land its verdict closed its control endpoint and left the group:
    // with nothing left to serve, its supervisor exited finalized — the run the next claim adopts.
    it('adopts a group whose supervisor exited finalized after its endpoint closed', async () => {
        const { exec, logs } = daemon(listing(), String(SUPERVISOR_EXIT.finalized));

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true, timedOut: false } });
        expect(adopted?.outcome).not.toHaveProperty('infraLoss');
    });

    // Issue #796: a run read but never swept is no adoption — and, like the kubernetes twin, the
    // attempt stands down to its lease rather than run afresh over that run's tree (#824).
    it('rejects when an older leftover cannot be swept', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const exec = (args: string[]) => {
            if (args[0] !== 'rm') return base(args);
            calls.push(args);
            return Promise.reject(new Error('the daemon answered 503'));
        };

        const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter);
        await expect(adopting).rejects.toBeInstanceOf(AdoptionBlocked);
        await expect(adopting).rejects.toThrow('the daemon answered 503');

        const read = calls.findIndex((args) => args[0] === 'logs');
        expect(read).toBeGreaterThanOrEqual(0);
        expect(calls.findIndex((args) => args[0] === 'rm')).toBeGreaterThan(read);
    });

    // #869: the supplied stand-down ends every read of the adoption — the evidence, the log stream and the
    // close-time readout — never a daemon call or a child that outlives the abandoned attempt.
    it.each([
        ['the kill-record read', (args: string[]) => args[0] === 'volume' && args[1] === 'inspect'],
        ['the supervisor report read', (args: string[]) => args[0] === 'logs' && args.includes(supervisorName(job))],
        ['the exited runner inspect', (args: string[]) => args[0] === 'inspect'],
        ['the close-time session readout', (args: string[]) => args[0] === 'run'],
    ])('ends %s on the supplied signal', async (_name, hang) => {
        const { exec: base, logs } = daemon(listing());
        let hung = false;
        const exec = (args: string[], options?: { signal?: AbortSignal }) => {
            if (!hang(args)) return base(args);
            hung = true;
            return hangsUntilAborted(options);
        };
        const stop = new AbortController();

        const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter, stop.signal);
        await vitest.waitFor(() => expect(hung).toBe(true));
        stop.abort();
        expect(await endsSoon(adopting)).toBe(true);
    });

    // #869: every read of the adoption ends by ONE absolute deadline; a stalled daemon holds none of them.
    it.each([
        ['the kill-record read', (args: string[]) => args[0] === 'volume' && args[1] === 'inspect'],
        ['the supervisor report read', (args: string[]) => args[0] === 'logs' && args.includes(supervisorName(job))],
        ['the exited runner inspect', (args: string[]) => args[0] === 'inspect'],
    ])('ends %s by the adoption’s deadline', async (_name, hang) => {
        vitest.useFakeTimers();
        try {
            const { exec: base, logs } = daemon(listing());
            const exec = (args: string[], options?: { timeout?: number }) =>
                hang(args) ? hangsUntilTimeout(options) : base(args);
            let ended = false;
            const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter);
            adopting.then(
                () => (ended = true),
                () => (ended = true)
            );

            await vitest.advanceTimersByTimeAsync(CLOSE_READ_DEADLINE_MS + 1_000);

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
    });

    it('kills the runner log stream at the adoption’s deadline', async () => {
        vitest.useFakeTimers();
        try {
            const { exec } = daemon(listing());
            const logs = ((_command: string, _args: string[], options?: { signal?: AbortSignal }) => {
                const child = new EventEmitter() as ChildProcess;
                child.stdout = new EventEmitter() as Readable;
                child.stderr = new EventEmitter() as Readable;
                options?.signal?.addEventListener('abort', () => child.emit('error', new Error('aborted')));
                return child;
            }) as unknown as typeof spawn;
            let ended = false;
            const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter);
            adopting.then(
                () => (ended = true),
                () => (ended = true)
            );

            await vitest.advanceTimersByTimeAsync(CLOSE_READ_DEADLINE_MS + 1_000);

            expect(ended).toBe(true);
        } finally {
            vitest.useRealTimers();
        }
    });

    it('ends the runner log stream on the supplied signal', async () => {
        const { exec, calls } = daemon(listing());
        let streamed: AbortSignal | undefined;
        const logs = ((_command: string, args: string[], options?: { signal?: AbortSignal }) => {
            calls.push(args);
            streamed = options?.signal;
            const child = new EventEmitter() as ChildProcess;
            child.stdout = new EventEmitter() as Readable;
            child.stderr = new EventEmitter() as Readable;
            options?.signal?.addEventListener('abort', () => child.emit('error', new Error('aborted')));
            return child;
        }) as unknown as typeof spawn;
        const stop = new AbortController();

        const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter, stop.signal);
        await vitest.waitFor(() => expect(streamed).toBeDefined());
        stop.abort();
        expect(await endsSoon(adopting)).toBe(true);
    });

    // The supervisor outlives the agent to finalize: the next claim waits for it rather than
    // reading a half-finished group, and a supervisor lost mid-finalize adopts nothing — and
    // sweeps nothing: the group stays for the fence the sync runs.
    it('waits for the earlier attempt’s supervisor before it reads, and reads its deadline exit as a timeout', async () => {
        const { exec, calls, logs } = daemon(listing(), '124');

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted?.outcome.timedOut).toBe(true);
        const waited = calls.findIndex((args) => args[0] === 'wait');
        expect(waited).toBeGreaterThanOrEqual(0);
        expect(calls.findIndex((args) => args[0] === 'logs')).toBeGreaterThan(waited);
    });

    // #829 S3: a released group's supervisor may wait the takeover grace for a holder before it finalizes.
    it('waits for the earlier attempt’s supervisor the wind-down and the takeover grace', async () => {
        const { exec: base, logs } = daemon(listing());
        const timeouts: (number | undefined)[] = [];
        const exec = (args: string[], options?: { timeout?: number }) => {
            if (args[0] === 'wait') timeouts.push(options?.timeout);
            return base(args);
        };

        await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(timeouts).toEqual([finalizeWaitMs(loadDriverConfig({}))]);
    });

    // The wait scales with the lease it must outlast: a fixed one ends before a long lease's takeover bound.
    it('waits for the earlier supervisor longer at a long lease', async () => {
        const { exec: base, logs } = daemon(listing());
        const timeouts: (number | undefined)[] = [];
        const exec = (args: string[], options?: { timeout?: number }) => {
            if (args[0] === 'wait') timeouts.push(options?.timeout);
            return base(args);
        };
        const env = { DRIVER_LEASE_SECONDS: '3600' };

        await dockerRunner(exec, { spawn: logs, env }).adopt(adopter);

        expect(timeouts).toEqual([finalizeWaitMs(loadDriverConfig(env))]);
        expect(timeouts[0]).toBeGreaterThan(takeoverBoundMs(loadDriverConfig(env)));
    });

    // A killed supervisor with no recorded reason is a supervisor lost — also where a record the
    // daemon refused leaves a run its driver killed: the job runs again, its checkout and session kept.
    it('adopts nothing and removes nothing when the earlier supervisor was lost before it finalized', async () => {
        const { exec, calls, logs } = daemon(listing(), '137');

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    it('adopts nothing when the earlier supervisor lost its driver before it released the agent', async () => {
        const { exec, calls, logs } = daemon(listing(), String(SUPERVISOR_EXIT.lost));

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    // A group whose driver was lost before it released the agent reports too, and exits 75: no run.
    it('adopts nothing when the lost supervisor logged that its agent was never launched', async () => {
        const { exec: base, calls, logs } = daemon(listing(), String(SUPERVISOR_EXIT.lost));
        const exec = withReport(base, {
            outcome: 'lost',
            cause: 'driver_lost',
            agentExit: null,
            agentEnd: 'unlaunched',
        });

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    // Issue #824: the report is the supervisor's finalization — a crash after it does not unsay it.
    it('adopts a run whose supervisor crashed after logging its final report', async () => {
        const { exec: base, logs } = daemon(listing(), String(SUPERVISOR_EXIT.failed));

        const adopted = await dockerRunner(withReport(base, {}), { spawn: logs }).adopt(adopter);

        expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true } });
        expect(adopted?.outcome).not.toHaveProperty('infraLoss');
    });

    /** The daemon of `daemon`, refusing the earlier supervisor's `docker logs` with `stderr`. */
    const refusingSupervisorLog =
        (base: (args: string[]) => Promise<{ stdout: string }>, stderr: string) => (args: string[]) =>
            args[0] === 'logs' && args.includes(supervisorName(job))
                ? Promise.reject(Object.assign(new Error('docker logs exited 1'), { stderr }))
                : base(args);

    // Failure injection: a supervisor log the daemon would not serve is no answer — not "no report".
    it('stands down, removing nothing, when the earlier supervisor log cannot be read', async () => {
        const { exec: base, calls, logs } = daemon(listing(), String(SUPERVISOR_EXIT.failed));
        const exec = refusingSupervisorLog(base, 'Error response from daemon: i/o timeout');

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
        expect(readOrRemoved(calls)).toBe(false);
    });

    it('reads a supervisor container already gone as one that logged no report', async () => {
        const { exec: base, calls, logs } = daemon(listing(), String(SUPERVISOR_EXIT.failed));
        const exec = refusingSupervisorLog(base, 'Error response from daemon: No such container: factory-supervisor');

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    // A Stop while the re-claim fence lists what to remove: the abandoned adoption removes nothing.
    it('removes nothing once the attempt stands down during the fence of an adopted run', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const standDown = new AbortController();
        const exec = (args: string[]) => {
            if (args[0] === 'ps' && !args.includes('status=exited')) standDown.abort();
            return base(args);
        };

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);
        expect(removals(calls)).toEqual([]);
    });

    // Once an exited earlier runner is found, nothing unexpected may fall through to a fresh run,
    // whose fence would remove that run unread: any throw stands the attempt down.
    it('stands down, removing nothing, on any unexpected throw once an exited runner is found', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const exec = (args: string[]) =>
            args[0] === 'inspect' ? Promise.reject(new TypeError('something unforeseen')) : base(args);

        const adopting = dockerRunner(exec, { spawn: logs }).adopt(adopter);

        await expect(adopting).rejects.toBeInstanceOf(AdoptionBlocked);
        await expect(adopting).rejects.toThrow('something unforeseen');
        expect(removals(calls)).toEqual([]);
    });

    /** The daemon of `daemon`, refusing the adoption's exited-runner listing `refusals` times. */
    const refusingDiscovery = (base: (args: string[]) => Promise<{ stdout: string }>, refusals: number) => {
        let left = refusals;
        return (args: string[]) =>
            args[0] === 'ps' && args.includes('status=exited') && left-- > 0
                ? Promise.reject(new Error('Cannot connect to the Docker daemon'))
                : base(args);
    };

    // Failure injection: a listing the daemon refused is no "nothing to adopt" — a fresh run's fence
    // would remove a finalizing group unread once the daemon answers again.
    it('stands down, removing nothing, when the exited runners cannot be listed', async () => {
        const { exec: base, calls, logs } = daemon(listing());

        await expect(dockerRunner(refusingDiscovery(base, 99), { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(
            AdoptionBlocked
        );
        expect(removals(calls)).toEqual([]);
    });

    // #869: an earlier runner whose discovery labels are corrupt is no "nothing to adopt" either.
    it.each([
        ['a corrupt claim sequence', listing('corrupt')],
        ['a lease label that is no lease', listing('1', 'corrupt', 'factory-runner-x')],
    ])('stands down, removing nothing, when an exited runner is listed with %s', async (_name, ps) => {
        const { exec, calls, logs } = daemon(ps);

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
        expect(removals(calls)).toEqual([]);
    });

    it('lists the exited runners again after a refusal, and adopts the one it finds', async () => {
        const { exec: base, logs } = daemon(listing());

        expect(await dockerRunner(refusingDiscovery(base, 1), { spawn: logs }).adopt(adopter)).toMatchObject({
            claimSeq: 1,
        });
    });

    /*
     * Class (a), #824: a docker answer that is not confirmed is never taken for "gone", "no record"
     * or an exit. Each row answers one read of the adoption with something that proves nothing.
     */
    const answering =
        (base: (args: string[]) => Promise<{ stdout: string }>, match: (args: string[]) => boolean, stdout: string) =>
        (args: string[]) =>
            match(args) ? Promise.resolve({ stdout }) : base(args);
    const isWait = (args: string[]) => args[0] === 'wait';
    it.each<
        [
            string,
            (base: (args: string[]) => Promise<{ stdout: string }>) => (args: string[]) => Promise<{ stdout: string }>,
        ]
    >([
        ['an empty `docker wait` answer', (base) => answering(base, isWait, '')],
        ['a non-numeric `docker wait` answer', (base) => answering(base, isWait, 'exited\n')],
        ['a `docker wait` answer with trailing garbage', (base) => answering(base, isWait, '0 garbage\n')],
        ['an inspect state with no exit code', (base) => answering(base, (args) => args[0] === 'inspect', '{}\n')],
        [
            'kill marker labels that are not JSON',
            (base) => answering(base, (args) => args[0] === 'volume' && args[1] === 'inspect', '{not json\n'),
        ],
        [
            'kill marker labels that are not a label map',
            (base) => withMarks(base, { [killMarkName(job, 'timeout')]: 'x' as never }),
        ],
        [
            'a supervisor log refused with a generic "not found"',
            (base) => refusingSupervisorLog(base, 'Error response from daemon: page not found'),
        ],
    ])('stands down, removing nothing, on %s', async (_what, wrap) => {
        const { exec: base, calls, logs } = daemon(listing());

        await expect(dockerRunner(wrap(base), { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
        expect(readOrRemoved(calls)).toBe(false);
    });

    // Paced like the kubernetes listing (its verdict reads sleep between retries), and a stand-down
    // during the pause ends it: no further listing, the adoption abandoned.
    it('pauses between listings of the exited runners after a refusal', async () => {
        const { exec: base, logs } = daemon(listing());
        const events: string[] = [];
        const listed = refusingDiscovery(base, 1);
        const exec = (args: string[]) => {
            if (args[0] === 'ps' && args.includes('status=exited')) events.push('ps');
            return listed(args);
        };
        const sleep = async (ms: number) => {
            events.push(`sleep ${ms > 0}`);
        };

        expect(await dockerRunner(exec, { spawn: logs, sleep }).adopt(adopter)).toMatchObject({ claimSeq: 1 });
        expect(events).toEqual(['ps', 'sleep true', 'ps']);
    });

    it('abandons the adoption when the attempt stands down during the pause between listings', async () => {
        const { exec: base, logs } = daemon(listing());
        const standDown = new AbortController();
        let listings = 0;
        const listed = refusingDiscovery(base, 1);
        const exec = (args: string[]) => {
            if (args[0] === 'ps' && args.includes('status=exited')) listings += 1;
            return listed(args);
        };
        const sleep = (_ms: number, signal?: AbortSignal) => {
            standDown.abort();
            return signal?.aborted ? Promise.reject(new Error('The operation was aborted')) : Promise.resolve();
        };

        await expect(dockerRunner(exec, { spawn: logs, sleep }).adopt(adopter, standDown.signal)).rejects.toThrow(
            /abandoned/
        );
        expect(listings).toBe(1);
    });

    /** The daemon of `daemon`, whose `docker wait` on the earlier supervisor rejects with `error`. */
    const failingWait = (base: (args: string[]) => Promise<{ stdout: string }>, error: Error) => (args: string[]) =>
        args[0] === 'wait' ? Promise.reject(error) : base(args);

    // Failure injection: a `docker wait` the daemon failed is no answer — not the wind-down elapsed,
    // which would leave a supervisor still finalizing to the sweep.
    it('stands down, removing nothing, when the wait on the earlier supervisor fails', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const failure = Object.assign(new Error('docker wait exited 1'), {
            stderr: 'Error response from daemon: connection reset',
        });

        await expect(dockerRunner(failingWait(base, failure), { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(
            AdoptionBlocked
        );
        expect(readOrRemoved(calls)).toBe(false);
    });

    it('takes a supervisor still running at the end of the wind-down as one that did not finalize', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const timedOut = Object.assign(new Error('docker wait timed out'), { killed: true, signal: 'SIGTERM' });

        expect(await dockerRunner(failingWait(base, timedOut), { spawn: logs }).adopt(adopter)).toBeNull();
        expect(readOrRemoved(calls)).toBe(false);
    });

    // A Stop or a lost lease while the supervisor finalizes: the abandoned adoption removes nothing.
    it('abandons the wait when the attempt stands down, removing nothing', async () => {
        const { exec: base, calls, logs } = daemon(listing());
        const standDown = new AbortController();
        // The supervisor ends at the very moment the attempt stands down.
        const exec = (args: string[]) => {
            if (args[0] === 'wait') standDown.abort();
            return base(args);
        };

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter, standDown.signal)).rejects.toThrow(/abandoned/);
        expect(readOrRemoved(calls)).toBe(false);
    });

    /** The daemon of `daemon`, holding the kill marker volumes `marks` (name → labels); any other is no such volume. */
    const withMarks =
        (base: (args: string[]) => Promise<{ stdout: string }>, marks: Record<string, Record<string, string>>) =>
        (args: string[]) => {
            if (args[0] !== 'volume' || args[1] !== 'inspect') return base(args);
            const labels = marks[args.at(-1) as string];
            if (labels) return Promise.resolve({ stdout: `${JSON.stringify(labels)}\n` });
            const refused = Object.assign(new Error('docker volume inspect exited 1'), {
                stderr: 'Error response from daemon: get factory-kill: no such volume',
            });
            return Promise.reject(refused);
        };
    const mark = (reason: string, detail: string, lease = job.leaseToken) => ({
        [killMarkName(job, reason)]: {
            'factory.job': job.id,
            'factory.lease': lease,
            [`factory.kill.${reason}`]: detail,
        },
    });

    // Why the lost driver ended the run was recorded on the attempt before its kill: the adoption
    // reads the verdict the attached run would have, never the supervisor the kill took down.
    it.each<[string, string, Record<string, unknown>]>([
        [
            'a cache loss',
            'cache_lost',
            { cacheLost: '3 consecutive turns with no prompt-cache reads', timedOut: false },
        ],
        ['a timeout', 'timeout', { timedOut: true }],
    ])('adopts a run its lost driver hard-killed for %s as that verdict', async (_what, reason, fields) => {
        const { exec: base, calls, logs } = daemon(listing(), '137');
        const detail = reason === 'cache_lost' ? '3 consecutive turns with no prompt-cache reads' : '';
        const exec = withMarks(base, mark(reason, detail));

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted?.outcome).toMatchObject({ started: true, ...fields });
        expect(adopted?.outcome).not.toHaveProperty('infraLoss');
        // The record is the earlier attempt's, kept with the read run for a later adoption (#821).
        expect(calls.some((args) => args[0] === 'rm' && args.includes('a4a4a4a4a4a4'))).toBe(false);
    });

    it('adopts a supervised stop its lost driver recorded for a full spool, with the spool fault', async () => {
        const { exec: base, logs } = daemon(listing(), '0');
        const exec = withMarks(base, mark('artifact_spool_full', '2000000000 bytes'));

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted?.outcome.artifactSpoolFull).toBe('2000000000 bytes');
    });

    // A full spool rides a supervised stop, so its record never explains how the supervisor ended:
    // one lost after it (#805), or taken down when the stop fell back to the hard kill — which on
    // kubernetes deletes the Job and its record — is run again, on both executors.
    it.each(['70', '137'])(
        'never takes a recorded full spool for the end of a supervisor that exited %s',
        async (exit) => {
            const { exec: base, calls, logs } = daemon(listing(), exit);
            const exec = withMarks(base, mark('artifact_spool_full', '2000000000 bytes'));

            expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
            expect(readOrRemoved(calls)).toBe(false);
        }
    );

    it('never reads a record of another attempt as this one’s', async () => {
        const { exec: base, logs } = daemon(listing(), '137');
        const exec = withMarks(base, mark('cache_lost', 'collapsed', '77777777-7777-4777-8777-777777777777'));

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
    });

    // Issue #824: a stop the supervisor raised itself (its own spool watch) is in the report it logged.
    it('adopts a full spool the earlier supervisor raised itself, from its final report', async () => {
        const { exec: base, logs } = daemon(listing(), '0');
        const exec = withReport(base, { outcome: 'failed', cause: 'artifact_spool_full', agentEnd: 'killed' });

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted?.outcome.artifactSpoolFull).toBe('the supervisor reported the spool full');
        expect(adopted?.outcome).not.toHaveProperty('infraLoss');
    });

    it('reads no stop from a supervisor that logged no report', async () => {
        const { exec, logs } = daemon(listing(), '0');

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted?.outcome.artifactSpoolFull).toBeUndefined();
    });

    // A queued task's command can be edited after a handover: a run of the old command is not its run.
    it('never adopts a run of a command since edited', async () => {
        const { exec, calls, logs } = daemon(
            listing('1', job.leaseToken, containerName(job), commandMark('another command'))
        );

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(calls.some((args) => args[0] === 'logs')).toBe(false);
    });

    // Failure injection (#825): a log past an exec's output buffer streams; it never fails the adoption.
    it('adopts a runner whose log outgrew an exec buffer: its tail kept, flagged truncated', async () => {
        const EXEC_MAX_BUFFER = 1024 * 1024;
        const line = 'body line\n';
        const { exec: base, calls, logs } = daemon(listing(), '0', line.repeat(EXEC_MAX_BUFFER / line.length + 1));
        const exec = (args: string[]) =>
            args[0] === 'logs' && !args.includes(supervisorName(job))
                ? Promise.reject(
                      Object.assign(new Error('stdout maxBuffer length exceeded'), {
                          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
                      })
                  )
                : base(args);

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted?.outcome.logTruncated).toBe(true);
        expect(adopted?.outcome.fullLog?.endsWith(line)).toBe(true);
        expect(Buffer.byteLength(adopted?.outcome.fullLog ?? '')).toBeLessThanOrEqual(ARTIFACT_LIMIT);
        expect(Buffer.byteLength(adopted?.outcome.output ?? '')).toBeLessThanOrEqual(16 * 1024);
        const read = calls.findIndex((args) => args[0] === 'logs');
        expect(read).toBeGreaterThanOrEqual(0);
        expect(calls.findIndex((args) => args[0] === 'rm')).toBeGreaterThan(read);
    });

    it('adopts a short log whole and complete', async () => {
        const { exec, logs } = daemon(listing());

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted?.outcome).toMatchObject({ fullLog: 'did the work\n', logTruncated: false });
    });

    it('decodes a multibyte character split across two log chunks once, whole — below and above the cap', async () => {
        for (const [body, truncated] of SPLIT_EURO_CASES) {
            const { exec, logs } = daemon(listing(), '0', splitEuro(body));

            const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

            expectWholeEuro(adopted?.outcome, truncated);
        }
    });

    it('keeps the bytes of an adopted log that ended inside a character, never drops them', async () => {
        const { exec, logs } = daemon(listing(), '0', CUT_SHORT);

        const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

        expect(adopted?.outcome).toMatchObject({ fullLog: 'ok\uFFFD', logTruncated: false });
    });

    it('rejects an adoption whose log read failed, and removes nothing', async () => {
        const { exec, calls, logs } = daemon(listing(), '0', 'Error: No such container\n', 1);

        await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toThrow(/docker logs/);
        expect(calls.some((args) => args[0] === 'rm')).toBe(false);
    });

    it('adopts nothing of its own claim, a newer one, or a container that is not the runner', async () => {
        const own = listing('2', adopter.leaseToken);
        const notRunner = listing('1', job.leaseToken, `factory-svc-${job.id}-db`);
        const { exec, calls, logs } = daemon(own + notRunner);

        expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
        expect(calls.some((args) => args[0] === 'rm')).toBe(false);
    });

    it('answers null when no earlier runner exited', async () => {
        const { exec } = daemon('');
        expect(await dockerRunner(exec).adopt(adopter)).toBeNull();
    });

    it('labels every runner container with its claim sequence and session', () => {
        const args = dockerArgs(
            loadDriverConfig({}),
            job,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        expect(args).toEqual(
            expect.arrayContaining([
                '--label',
                'factory.claim-seq=1',
                '--label',
                `factory.session=${SESSION}`,
                '--label',
                `factory.command=${commandMark(job.command)}`,
            ])
        );
    });

    // Issue #822: a claim continuing an interrupted attempt is framed in its prompt alone; the
    // container is labelled with the unframed command, as the interrupted attempt's runner was.
    it.each([
        ['claude-code', job, SESSION],
        ['opencode', opencodeJob, 'ses_abc123'],
    ])(
        'frames a %s continuation into its prompt alone, labelling the container with the unframed command',
        (_name, claimed, session) => {
            const line = dockerArgs(
                loadDriverConfig({}),
                { ...claimed, claimSeq: 2, resumeSessionId: session, ownSession: true, continuesInterrupted: true },
                { id: session, resume: true },
                { envFile: '/tmp/env-file' }
            );

            expect(line.at(-1)?.startsWith('Your previous run of this task was interrupted')).toBe(true);
            expect(line.at(-1)?.endsWith(`The task, for reference:\n\n${claimed.command}`)).toBe(true);
            expect(line).toContain(`factory.command=${commandMark(claimed.command)}`);
        }
    );

    // Issue #822: the runner of an interrupted attempt exited while its takeover or handover was
    // being claimed. The continuing claim carries the command the first claim ran, so the label
    // that runner was started with is its own, and the run is adopted, never redone.
    it('adopts, for a claim continuing an interrupted attempt, the runner its first claim started', async () => {
        const started = dockerArgs(
            loadDriverConfig({}),
            job,
            { id: SESSION, resume: false },
            { envFile: '/tmp/env-file' }
        );
        const mark = started.find((arg) => arg.startsWith('factory.command='))!.slice('factory.command='.length);
        const { exec, logs } = daemon(listing('1', job.leaseToken, containerName(job), mark));
        const continuing = { ...adopter, resumeSessionId: SESSION, ownSession: true, continuesInterrupted: true };

        expect(await dockerRunner(exec, { spawn: logs }).adopt(continuing)).toMatchObject({
            claimSeq: 1,
            outcome: { exitCode: 0, started: true, sessionId: SESSION },
        });
    });

    // #829: a released group's agent still runs (its runner container is up): taken over, not read.
    describe('a live run (#829)', () => {
        const supervisorUp = (up: boolean | 'garbled') => (args: string[]) => {
            if (args[0] !== 'inspect') return undefined;
            if (args.includes(supervisorName(job))) {
                return Promise.resolve({
                    stdout:
                        up === 'garbled' ? 'not json' : `{"Status":"${up ? 'running' : 'exited'}","Running":${up}}\n`,
                });
            }
            return Promise.resolve({
                stdout: '{"Status":"running","Running":true,"StartedAt":"2026-10-01T00:00:00Z"}\n',
            });
        };
        const liveDaemon = (up: boolean | 'garbled' = true, running: string | Error = listing()) => {
            const { exec: base, calls, logs } = daemon('', '0', 'did the work\n', 0, running);
            const inspect = supervisorUp(up);
            const exec = (args: string[]) => inspect(args) ?? base(args);
            return { exec, calls, logs };
        };

        it('answers a running runner whose supervisor runs as live, recording the group and sweeping only the older', async () => {
            const { exec, calls, logs } = liveDaemon();

            const adopted = await dockerRunner(exec, { spawn: logs }).adopt(adopter);

            expect(adopted).toMatchObject({
                live: true,
                claimSeq: 1,
                session: SESSION,
                startedAt: '2026-10-01T00:00:00Z',
                prior: { id: job.id, leaseToken: job.leaseToken },
            });
            // The live run's own objects stay; the older attempt's go.
            expect(removals(calls)).toEqual(['a5a5a5a5a5a5', 'older-mailbox']);
            expect(calls.some((args) => args[0] === 'logs')).toBe(false);
            expect(calls.some((args) => args[0] === 'wait')).toBe(false);
        });

        it('follows the live runner of the prior lease on a resumed run: no create, no env, no start, no go order', async () => {
            const { exec, calls, logs } = liveDaemon();
            const runner = dockerRunner(exec, { spawn: logs });
            const live = await runner.adopt(adopter);
            expect(live).toMatchObject({ live: true });
            calls.length = 0;
            const taken: BoardJob = {
                ...adopter,
                groupLease: job.leaseToken,
                supervisorEnv: { SUPERVISOR_CONTROL_TOKEN: 'tok-new', SUPERVISOR_CONTROL_URL: 'http://driver/' },
            };

            const outcome = await runner.run(taken, { id: SESSION, resume: true });

            // The followed log ended and the bounded `docker wait` said how the runner exited.
            expect(outcome).toMatchObject({ exitCode: 0 });
            expect(calls.some((args) => args[0] === 'wait')).toBe(true);

            const named = containerName({ ...job, leaseToken: job.leaseToken });
            // The very first daemon call is the follow: nothing was created, copied or started before it.
            expect(calls[0]).toEqual(['logs', '-f', named]);
            for (const args of calls) {
                expect(args[0]).not.toMatch(/^(create|start|cp)$/);
                expect(args.join(' ')).not.toContain(containerName(adopter));
            }
        });

        it('answers nothing for a group no runner container runs (created, never started)', async () => {
            const { exec, calls, logs } = liveDaemon(true, '');

            expect(await dockerRunner(exec, { spawn: logs }).adopt(adopter)).toBeNull();
            expect(removals(calls)).toEqual([]);
        });

        it.each([
            ['refused', new Error('the daemon answered 503')],
            ['garbled', 'a\tb\n'],
        ])('blocks the attempt when the running listing is %s', async (_label, running) => {
            const { exec, calls, logs } = liveDaemon(true, running);

            await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(AdoptionBlocked);
            expect(removals(calls)).toEqual([]);
        });

        it.each([
            ['stopped', false],
            ['unreadable', 'garbled' as const],
        ])(
            'blocks the attempt, removing nothing, when the supervisor of a running runner is %s',
            async (_label, up) => {
                const { exec, calls, logs } = liveDaemon(up);

                await expect(dockerRunner(exec, { spawn: logs }).adopt(adopter)).rejects.toBeInstanceOf(
                    AdoptionBlocked
                );
                expect(removals(calls)).toEqual([]);
            }
        );
    });
});

describe('how a started run ends, on docker (the conformance table)', () => {
    interface End {
        code: number;
        supervisorExit: string;
        report?: SupervisorReport;
        removed?: boolean;
        kill?: boolean;
    }
    /** One attached run ended as `end` says: the agent's close, the supervisor's exit, its report. */
    const endOnDocker = async (end: End): Promise<RunOutcome> => {
        const child = new EventEmitter() as ChildProcess;
        child.stdout = new EventEmitter() as Readable;
        child.stderr = new EventEmitter() as Readable;
        let spawned!: () => void;
        const started = new Promise<void>((resolve) => {
            spawned = resolve;
        });
        const exec = (async (args: string[]) => {
            // The supervisor's exit lands after its report, as it does for a supervisor that reports.
            if (args[0] === 'wait') {
                await new Promise((resolve) => setTimeout(resolve, 10));
                return { stdout: `${end.supervisorExit}\n` };
            }
            if (args[0] === 'inspect' && end.removed) {
                throw Object.assign(new Error('docker inspect exited 1'), { stderr: 'Error: No such container: x' });
            }
            if (args[0] === 'inspect') return { stdout: '{"Status":"exited"}' };
            if (args[0] === 'ps' && args.some((a) => a.startsWith('label=factory.lease')))
                return { stdout: 'a0a0a0a0a001\n' };
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const runner = dockerRunner(exec, {
            spawn: (() => {
                spawned();
                return child;
            }) as unknown as typeof spawn,
            steps: fakeSteps(undefined, end.report ?? new Promise<never>(() => undefined)).sink,
        });
        const pending = runner.run(job, { id: SESSION, resume: false });
        await started;
        if (end.kill) await runner.kill(job);
        process.nextTick(() => child.emit('close', end.code));
        return pending;
    };

    const LOST_AGENT = { ...FINALIZED, outcome: 'lost', cause: 'lost', agentExit: null, agentEnd: 'lost' };
    const ends: Record<TerminationRow, End> = {
        'an agent that exits 0 under a finalizing supervisor': { code: 0, supervisorExit: '0', report: FINALIZED },
        'an agent its run budget ended': {
            code: 137,
            supervisorExit: '124',
            report: { ...FINALIZED, outcome: 'timed_out', cause: 'timeout', agentExit: 137, agentEnd: 'killed' },
        },
        'a group the driver hard-killed mid-run': { code: 137, supervisorExit: '137', kill: true },
        'a runner the platform took away mid-run': { code: 137, supervisorExit: '137', removed: true },
        'a runner the platform took away after the budget ended its agent': {
            code: 137,
            supervisorExit: '137',
            removed: true,
            report: { ...FINALIZED, outcome: 'timed_out', cause: 'timeout', agentExit: 137, agentEnd: 'killed' },
        },
        'a supervisor that ended without finalizing, nothing initiating it': { code: 0, supervisorExit: '70' },
        'a supervisor that reported, then crashed before the verdict read': {
            code: 0,
            supervisorExit: '70',
            report: FINALIZED,
        },
        // A report that finalized nothing (the driver was lost before the agent was released) is no
        // finalization: the attached run takes it as `reportFinalized` does, an interruption.
        'a supervisor that reported an unlaunched group, then crashed': {
            code: 0,
            supervisorExit: '70',
            report: { ...FINALIZED, agentEnd: 'unlaunched' },
        },
        // A lost agent is no finalized run either: the runner went, the work did not end.
        'a supervisor that reported its agent lost, then crashed': {
            code: 0,
            supervisorExit: '70',
            report: LOST_AGENT,
        },
        'a runner the platform took away after the supervisor reported its agent lost': {
            code: 137,
            supervisorExit: '137',
            removed: true,
            report: LOST_AGENT,
        },
    };

    it.each(TERMINATION_ROWS)('%s: %s', async (row, expected) => {
        expect(decisionOf(await endOnDocker(ends[row]))).toBe(expected);
    });

    it.each(LOSS_ROWS)('%s: carries nothing past the loss', async (row) => {
        const outcome = await endOnDocker(ends[row]);
        expect(outcome.infraLoss).toBeDefined();
        expect(carriedPastLoss(outcome)).toEqual([]);
    });
});

describe('what a closed run leaves for the next claim, on docker (the retention conformance table, #828)', () => {
    const adopter: BoardJob = { ...job, leaseToken: '99999999-9999-4999-8999-999999999999', claimSeq: 2 };
    const listed = `${containerName(job)}\t${job.leaseToken}\t1\t${SESSION}\t${commandMark(job.command)}\n`;

    it.each(RETENTION_ROWS)('%s: %s', async (_row, expected) => {
        // One daemon for both claims: the runner container is listed as exited until something removes it.
        let removed = false;
        const exec = (async (args: string[]) => {
            if (args[0] === 'rm') removed = true;
            if (args[0] === 'wait') return { stdout: '0\n' };
            if (args[0] === 'ps' && args.includes('status=exited')) return { stdout: removed ? '' : listed };
            if (args[0] === 'ps' && args.some((a) => a.startsWith('label=factory.lease')))
                return { stdout: 'a0a0a0a0a001\n' };
            if (args[0] === 'volume' && args[1] === 'inspect') {
                throw Object.assign(new Error('docker volume inspect exited 1'), {
                    stderr: 'Error response from daemon: get factory-kill: no such volume',
                });
            }
            if (args[0] === 'inspect') {
                return { stdout: '{"Status":"exited","ExitCode":0,"StartedAt":"2026-10-01T00:00:00Z"}\n' };
            }
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        const attached = new EventEmitter() as ChildProcess;
        attached.stdout = new EventEmitter() as Readable;
        attached.stderr = new EventEmitter() as Readable;
        let spawned!: () => void;
        const started = new Promise<void>((resolve) => {
            spawned = resolve;
        });
        const spawnFor = ((_command: string, args: string[]) => {
            if (args[0] === 'logs') return fakeChild('did the work\n', '', 0);
            spawned();
            return attached;
        }) as unknown as typeof spawn;

        const first = dockerRunner(exec, { spawn: spawnFor, steps: fakeSteps(undefined, FINALIZED).sink });
        const pending = first.run(job, { id: SESSION, resume: false });
        await started;
        process.nextTick(() => attached.emit('close', 0));
        await pending;

        const adopted = await dockerRunner(exec, { spawn: spawnFor }).adopt(adopter);
        const found = adopted ? 'adoptable' : 'gone';
        expect(found).toBe(expected);
        if (adopted) expect(adopted).toMatchObject({ claimSeq: 1, outcome: { exitCode: 0, started: true } });
    });
});

describe('how a refused group start ends, on docker (the startup conformance table, #824 D11)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    /** The daemon's own words for each refusal, as the CLI prints them on its stderr. */
    const refusals: Record<Exclude<StartupRow, typeof MISMATCH_ROW | typeof SILENT_ROW>, string> = {
        'the platform never brought the group up':
            'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?',
        'a registry that timed out':
            'Error response from daemon: Get "https://registry.example/v2/": dial tcp 10.0.0.1:443: i/o timeout',
        'a registry rate limit': 'Error response from daemon: toomanyrequests: You have reached your pull rate limit.',
        'a TLS handshake that timed out':
            'Error response from daemon: Get "https://registry.example/v2/": net/http: TLS handshake timeout',
        'a missing image':
            'Error response from daemon: manifest for registry.example/claude-executor:latest not found: manifest unknown',
        'an invalid image reference': 'docker: invalid reference format.',
        'an unauthorized pull':
            'Error response from daemon: Head "https://registry.example/v2/claude-executor/manifests/latest": unauthorized: authentication required',
        'an untrusted registry certificate':
            'Error response from daemon: Get "https://registry.example/v2/": tls: failed to verify certificate: x509: certificate signed by unknown authority',
        'a container configuration the platform refuses':
            'Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /srv/missing',
        'a refusal whose words prove no cause':
            'Error response from daemon: Conflict. The container name "/x" is already in use by container "y"',
    };
    /** The sync, its group's supervisor create refused with `stderr`: what it threw, or null. */
    const refusedSync = async (stderr: string): Promise<unknown> => {
        const d = labelDaemon({
            fail: (args) => (args[0] === 'create' && args.includes(supervisorName(repoJob)) ? stderr : null),
        });
        return dockerRunner(d.exec, { steps: syncSteps().sink })
            .syncCheckout(repoJob)
            .then(
                () => null,
                (e: unknown) => e
            );
    };

    /** The sync under session `SESSION`, then a run specced as `run` says: what the run threw, and the daemon. */
    const mismatchedRun = async (run: { id: string; resume: boolean }) => {
        const d = labelDaemon();
        const runner = dockerRunner(d.exec, { steps: syncSteps().sink });
        await runner.syncCheckout(repoJob, undefined, { id: SESSION, resume: false });
        const thrown = await runner.run(repoJob, run).then(
            () => null,
            (e: unknown) => e
        );
        return { thrown, d };
    };
    const startups: Record<StartupRow, () => Promise<unknown>> = {
        ...(Object.fromEntries(
            Object.entries(refusals).map(([row, stderr]) => [row, () => refusedSync(stderr)])
        ) as Record<Exclude<StartupRow, typeof MISMATCH_ROW | typeof SILENT_ROW>, () => Promise<unknown>>),
        [MISMATCH_ROW]: async () => (await mismatchedRun({ id: OTHER_SESSION, resume: false })).thrown,
        // The supervisor started and never pulled: the bound is reached on elapsed time, and nothing proves why.
        [SILENT_ROW]: async () =>
            dockerRunner(labelDaemon().exec, { steps: { ...syncSteps().sink, contacted: () => false } })
                .syncCheckout(repoJob)
                .then(
                    () => null,
                    (e: unknown) => e
                ),
    };

    it.each(STARTUP_ROWS)('%s: %s', async (row, expected) => {
        const thrown = await startups[row]();
        expect(thrown).not.toBeNull();
        expect(startupDecisionOf(thrown)).toBe(expected);
    });

    it('refuses a run specced for another session than its group', async () => {
        const message = `the task group of job ${repoJob.id} was specced for another session than the run's`;
        for (const run of [
            { id: OTHER_SESSION, resume: false },
            { id: SESSION, resume: true },
        ]) {
            const { thrown, d } = await mismatchedRun(run);
            expect((thrown as Error).message).toBe(message);
            expect(d.calls.some((a) => a[0] === 'create' && a.includes(containerName(repoJob)))).toBe(false);
        }
    });

    // A local failure — the env file the create reads, refused by the host — is no platform refusal,
    // whatever its words: it carries no stderr, so no cause is read from it.
    it('reads no startup cause from a local file the host refused', async () => {
        const d = labelDaemon();
        const files: RunnerFiles = {
            writeFile: (async () => {
                throw Object.assign(new Error("EACCES: permission denied, open '/tmp/env'"), { code: 'EACCES' });
            }) as unknown as RunnerFiles['writeFile'],
            rm: (async () => undefined) as unknown as RunnerFiles['rm'],
        };
        const thrown = await dockerRunner(d.exec, { steps: syncSteps().sink, files })
            .syncCheckout(repoJob)
            .then(
                () => null,
                (e: unknown) => e
            );
        expect((thrown as Error).message).toContain('EACCES');
        expect(startupDecisionOf(thrown)).toBe('unclassified');
    });
});

describe('docker waits for the supervisor of a started group to make contact (#828)', () => {
    const repoJob: BoardJob = { ...job, repo: 'Bellows-AI/factory' };
    /** A sink whose `contacted` answers `answers` in turn, then the last one for ever. */
    const contactAfter = (supervised: ReturnType<typeof fakeSteps>, answers: boolean[]) => {
        let reads = 0;
        return { ...supervised.sink, contacted: () => answers[Math.min(reads++, answers.length - 1)]! };
    };
    const settled = (p: Promise<unknown>) =>
        p.then(
            () => null,
            (e: unknown) => e as Error
        );

    it('submits nothing to a group before its supervisor has pulled', async () => {
        const supervised = syncSteps();
        const submittedAtSleep: number[] = [];
        const runner = dockerRunner(labelDaemon().exec, {
            steps: contactAfter(supervised, [false, false, true]),
            sleep: async () => void submittedAtSleep.push(supervised.submitted.length),
        });
        await runner.syncCheckout(repoJob);
        expect(submittedAtSleep).toEqual([0, 0]);
        expect(supervised.ofKind('sync')).toHaveLength(1);
    });

    it('ends the wait on elapsed time with a plain error naming the supervisor, then removes the group', async () => {
        let now = 0;
        const spy = vitest.spyOn(Date, 'now').mockImplementation(() => (now += 120_000));
        const slept: number[] = [];
        const d = labelDaemon();
        const supervised = syncSteps();
        try {
            const thrown = await settled(
                dockerRunner(d.exec, {
                    steps: contactAfter(supervised, [false]),
                    sleep: async (ms) => void slept.push(ms),
                }).syncCheckout(repoJob)
            );
            expect(thrown).toBeInstanceOf(Error);
            expect(startupDecisionOf(thrown)).toBe('unclassified');
            expect(thrown!.message).toContain(supervisorName(repoJob));
            expect(thrown!.message).toContain('600000');
        } finally {
            spy.mockRestore();
        }
        expect(slept.length).toBeLessThan(20);
        expect(supervised.submitted).toEqual([]);
        expect(d.calls.some((a) => a[0] === 'rm' && a.includes(supervisorName(repoJob)))).toBe(true);
    });

    it('stops waiting for a group whose job was killed while it came up', async () => {
        const slept: number[] = [];
        const d = labelDaemon();
        let runner: ReturnType<typeof dockerRunner> | undefined;
        runner = dockerRunner(d.exec, {
            steps: contactAfter(syncSteps(), [false]),
            sleep: async (ms) => {
                slept.push(ms);
                await runner!.kill(repoJob);
            },
        });
        const thrown = await settled(runner.syncCheckout(repoJob));
        expect(thrown?.message).toMatch(/killed while its task group came up/);
        expect(slept.length).toBeLessThanOrEqual(2);
        expect(d.calls.some((a) => a[0] === 'rm' && a.includes(supervisorName(repoJob)))).toBe(true);
    });

    it('runs a reclaim only once its supervisor has pulled', async () => {
        const supervised = fakeSteps((step) =>
            ok(step.kind === 'reclaim' ? '{"ok":true,"removed":true,"reason":null}' : '')
        );
        const { endpoint } = reclaimEndpoint();
        const submittedAtSleep: number[] = [];
        const runner = dockerRunner(labelDaemon().exec, {
            steps: contactAfter(supervised, [false, false, true]),
            endpoint,
            sleep: async () => void submittedAtSleep.push(supervised.submitted.length),
        });
        expect(await runner.reclaimWorktree(repoJob)).toEqual({ ok: true, removed: true, reason: null });
        expect(submittedAtSleep).toEqual([0, 0]);
    });

    it('fails a reclaim whose supervisor never pulled, and removes its group', async () => {
        const supervised = fakeSteps();
        const { endpoint } = reclaimEndpoint();
        const d = labelDaemon();
        const result = await dockerRunner(d.exec, {
            steps: contactAfter(supervised, [false]),
            endpoint,
        }).reclaimWorktree(repoJob);
        expect(result.ok).toBe(false);
        expect(result.reason).toContain('never came up');
        expect(supervised.ofKind('reclaim')).toEqual([]);
        expect(d.containers.size).toBe(0);
    });
});

describe('readDocker and its listing parsers (#869)', () => {
    const answering = (stdout: string) => async (): Promise<{ stdout: string }> => ({ stdout });
    const refusing =
        (stderr: string, extra: object = {}) =>
        async (): Promise<{ stdout: string }> => {
            throw Object.assign(new Error('Command failed'), { stderr, ...extra });
        };
    const read = <T>(
        exec: () => Promise<{ stdout: string }>,
        parse: (stdout: string) => T | null,
        absentOn?: readonly string[]
    ) => readDocker(exec, ['volume', 'inspect', 'x'], 'reading x', { parse, ...(absentOn ? { absentOn } : {}) });

    it('reads a refused exec as inconclusive, never as an empty list', async () => {
        const got = await read(refusing('Error response from daemon: 503'), nameLines);
        expect(got).toEqual({ kind: 'inconclusive', reason: 'reading x: Command failed' });
    });

    it('reads a timed-out exec as inconclusive', async () => {
        const got = await read(refusing('', { killed: true, signal: 'SIGTERM' }), nameLines);
        expect(got.kind).toBe('inconclusive');
    });

    it('reads the daemon\'s own "no such volume" as absent only for a kind it was told to expect', async () => {
        const gone = refusing('Error: No such volume: x');
        expect(await read(gone, nameLines, ['volume'])).toEqual({ kind: 'absent' });
        expect((await read(gone, nameLines)).kind).toBe('inconclusive');
        expect((await read(refusing('Error: No such container: x'), nameLines, ['volume'])).kind).toBe('inconclusive');
    });

    it('reads an answer that is no listing as inconclusive', async () => {
        const html = '<html><body>502 Bad Gateway</body></html>';
        expect((await read(answering(html), nameLines)).kind).toBe('inconclusive');
        expect((await read(answering(html), idLines)).kind).toBe('inconclusive');
    });

    it('reads an empty answer as the empty list', async () => {
        expect(await read(answering(''), nameLines)).toEqual({ kind: 'value', value: [] });
        expect(await read(answering('\n'), idLines)).toEqual({ kind: 'value', value: [] });
    });

    it('reads names and ids line by line', async () => {
        expect(await read(answering('factory-a\nfactory_b.c\n'), nameLines)).toEqual({
            kind: 'value',
            value: ['factory-a', 'factory_b.c'],
        });
        expect(await read(answering('0123456789ab\n' + 'f'.repeat(64) + '\n'), idLines)).toEqual({
            kind: 'value',
            value: ['0123456789ab', 'f'.repeat(64)],
        });
    });

    it.each(['null', 'agent-id', '0123456789a', '0123456789AB', `${'f'.repeat(65)}`, '0123456789ab extra'])(
        'refuses %s as a container id, so it is never a kill or rm target',
        (line) => {
            expect(idLines(`0123456789ab\n${line}\n`)).toBeNull();
        }
    );

    it.each(['-leading', 'a b', '<html>', '{"x":1}', 'a,b'])('refuses %s as a name', (line) => {
        expect(nameLines(`ok\n${line}\n`)).toBeNull();
    });

    it('reads tab rows of exactly the asked fields, an empty label included', async () => {
        const two = tabRows(2);
        expect(await read(answering('alpha\tlease-1\nbeta\t\n'), two)).toEqual({
            kind: 'value',
            value: [
                ['alpha', 'lease-1'],
                ['beta', ''],
            ],
        });
        expect((await read(answering('alpha\n'), two)).kind).toBe('inconclusive');
        expect((await read(answering('alpha\tb\tc\n'), two)).kind).toBe('inconclusive');
        expect((await read(answering('<html>\t502\n'), two)).kind).toBe('inconclusive');
    });

    // #869: the lease is what decides a row is "another attempt's", and so a delete target.
    describe('the fence listings', () => {
        const OLD = 'aaaaaaaa-1111-4111-8111-111111111111';
        const KEPT = { leaseToken: 'bbbbbbbb-2222-4222-8222-222222222222', grammar: /^[0-9a-f]{12,64}$/ };
        const list = (stdout: string) => listOtherAttemptsOrThrow(async () => ({ stdout }), ['ps'], 'listing', KEPT);

        it('names the rows of other attempts by their lease', async () => {
            expect(await list(`abcdef123456\t${OLD}\nabcdef123457\t${KEPT.leaseToken}\n`)).toEqual(['abcdef123456']);
        });

        it.each([
            ['a lease that is no lease', 'abcdef123456\tcorrupt\n'],
            ['an empty lease', 'abcdef123456\t\n'],
            ['a good row beside a corrupt one', `abcdef123456\t${OLD}\nabcdef123457\tcorrupt\n`],
        ])('reads %s as no listing, never as an attempt to delete', async (_name, stdout) => {
            await expect(list(stdout)).rejects.toThrow(/listing/);
        });
    });

    it('reads a tab row whose first field is not of the asked grammar as inconclusive', () => {
        expect(tabRows(2, /^[0-9a-f]{12,64}$/)('null\tlease\n')).toBeNull();
    });
});

// Issue #773: a gate is a step of the attempt's group, whose gate container runs it. Until the
// docker group shares one network namespace, the gate container joins the attempt's services
// network before a gate runs, once per attempt, so a gate reaches the services by name.
describe('the docker runner and the gates', () => {
    const gated: BoardJob = {
        ...job,
        repo: 'Bellows-AI/factory',
        gates: { image: 'node:24', gates: [{ name: 'test', command: 'npm test' }] },
    };
    const gate = {
        command: 'npm test',
        cwd: `/workspaces/bellows/${USER}/.worktrees/${job.id}`,
        env: {},
        timeoutMs: 1000,
    };
    const recording = () => {
        const calls: string[][] = [];
        const exec = (async (args: string[]) => {
            calls.push(args);
            return { stdout: '' };
        }) as unknown as (args: string[]) => Promise<{ stdout: string }>;
        return { calls, exec };
    };

    // Issue #773: the gate container shares its supervisor's namespace from its create, so the
    // declared services are on its loopback with no network to join.
    it('runs a gate as a step of a group it makes on demand, in its supervisor’s namespace, joining no network', async () => {
        const daemon = recording();
        const supervised = fakeSteps(() => ok('passed'));
        const runner = dockerRunner(daemon.exec, { steps: supervised.sink });

        expect(await runner.runGate(gated, gate)).toEqual(ok('passed'));
        await runner.runGate(gated, gate);

        expect(supervised.ofKind('gate')).toHaveLength(2);
        expect(supervised.ofKind('gate')[0]).toMatchObject({ argv: ['npm test'], cwd: gate.cwd });
        const created = daemon.calls.filter((args) => args[0] === 'create');
        const gateCreate = created.find((args) => args[args.indexOf('--name') + 1] === gateName(gated));
        expect(gateCreate?.[gateCreate.indexOf('--network') + 1]).toBe(`container:${supervisorName(gated)}`);
        expect(daemon.calls.some((args) => args[0] === 'network')).toBe(false);
    });

    // Issue #774: a review is steps of the CALLER's group — the reviewer's home, its restored
    // worktree, the executor in the reviewer container — made on demand like a gate's.
    it('runs a review as steps of the caller’s group, made on demand, with the reviewer container in it', async () => {
        const daemon = recording();
        const supervised = fakeSteps((step) => (step.kind === 'review' ? ok() : ok('{"ok":true,"reason":null}')));
        const runner = dockerRunner(daemon.exec, { steps: supervised.sink });
        const caller: BoardJob = { ...job, repo: 'Bellows-AI/factory', reviewerProfiles: ['security'] };
        const review = {
            ...caller,
            id: '66666666-6666-4666-8666-666666666666',
            rootJobId: caller.id,
            reviewRun: { profile: 'security', ref: `refs/factory/review/${caller.id}/sec-1`, timeoutMinutes: 5 },
        } as unknown as ReviewClaim;

        expect(await runner.runReview(caller, review, { id: 'sess-1', resume: false })).toEqual(ok());

        expect(supervised.ofKind('review')).toHaveLength(1);
        expect(supervised.steps().map((step) => step.kind)).toEqual(['sync', 'sync', 'review']);
        const created = daemon.calls.filter((args) => args[0] === 'create');
        expect(created.map((args) => args[args.indexOf('--name') + 1])).toContain(reviewerName(caller));
        expect(supervised.submitted.every((entry) => entry.token === supervised.submitted[0]!.token)).toBe(true);
    });

    it('resizes nothing: the reviewer container keeps its RUNNER_* sizing, as the gate container its GATE_*', async () => {
        const daemon = recording();
        const runner = dockerRunner(daemon.exec, { env: { RUNNER_SERVICES: '0' }, steps: fakeSteps().sink });
        expect(await runner.resizeReviewer({ ...job, reviewerProfiles: ['security'] }, 'run')).toBe(false);
        expect(daemon.calls).toEqual([]);
    });

    it('resizes nothing: the gate container keeps its GATE_* sizing', async () => {
        const daemon = recording();
        const runner = dockerRunner(daemon.exec, { env: { RUNNER_SERVICES: '0' }, steps: fakeSteps().sink });
        expect(await runner.resizeGate(gated, 'verify')).toBe(false);
        expect(daemon.calls).toEqual([]);
    });
});

describe('untilStandDown', () => {
    it('hands its signal into the exec already in flight, so the stand-down kills it', async () => {
        const controller = new AbortController();
        let seen: AbortSignal | undefined;
        const exec = untilStandDown(async (_args, options) => {
            seen = options?.signal;
            return { stdout: '' };
        }, controller.signal);

        await exec(['ps']);
        expect(seen?.aborted).toBe(false);
        controller.abort();

        expect(seen?.aborted).toBe(true);
        await expect(exec(['ps'])).rejects.toThrow(/abandoned/);
    });

    it('keeps a signal the call brought as well', async () => {
        const own = new AbortController();
        let seen: AbortSignal | undefined;
        const exec = untilStandDown(async (_args, options) => {
            seen = options?.signal;
            return { stdout: '' };
        }, new AbortController().signal);

        await exec(['ps'], { signal: own.signal, timeout: 5 });
        own.abort();

        expect(seen?.aborted).toBe(true);
    });
});
