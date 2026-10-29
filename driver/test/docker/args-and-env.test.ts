import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../../src/board/board.js';
import { loadDriverConfig } from '../../src/config.js';
import { containerName, dockerArgs, opencodeSessionReadoutArgs } from '../../src/docker/docker.js';
import { claimEnv, envFileBody, transcriptDir } from '../../src/claim.js';
import { TASK_MOUNT, taskMountArgs, taskVolumeName } from '../../src/task-volume.js';
import { claudeTurnsArgs } from '../../src/docker/docker-close-read.js';
import { CLAUDE_READ_NONE, parseClaudeCloseRead, readsAgentTurns } from '../../src/close-read.js';
import { OPENCODE_EXPORT_LIMIT } from '../../src/runner.js';
import { claudeTurnsScript, opencodeReadoutScript } from '../../src/container-scripts.js';
import {
    USER,
    MASTER_PROMPT,
    job,
    SESSION,
    opencodeJob,
    args,
    START,
    spawnChild,
    entrypointAnswers,
    dockerRunner,
} from '../fixtures/docker-suite.js';

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
        expect(claude.slice(-11)).toEqual([
            'claude-executor',
            '--session-id',
            SESSION,
            '--permission-mode',
            'auto',
            '--append-system-prompt',
            MASTER_PROMPT,
            '--system-prompt-snapshot',
            'off',
            '-p',
            'fix the failing build',
        ]);
        envBeforeImage(claude, 'claude-executor', [
            `FACTORY_TRANSCRIPT_DIR=/task/.factory/transcripts/${job.id}`,
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
            `XDG_DATA_HOME=/task/.factory/opencode/${opencodeJob.id}`,
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

    it("mounts the thread's own task volume whole at /task and starts at its root", () => {
        // The mount is the thread's volume by name, with no subPath: one task = one volume, so the
        // container can reach nothing of any other task, whatever the WORKDIR points at.
        expect(args()).toEqual(expect.arrayContaining([...taskMountArgs(job), `WORKDIR=${TASK_MOUNT}`]));
        expect(args().join(' ')).toContain(`type=volume,src=${taskVolumeName(job)},target=/task`);
        expect(args().join(' ')).not.toContain('volume-subpath');
    });

    it('refuses a thread root that is not a uuid before it becomes a volume name', () => {
        for (const root of ['../../etc', 'bellows/../../etc', 'not-a-uuid', `/absolute/${USER}`]) {
            expect(
                () => dockerArgs(loadDriverConfig({}), { ...job, rootJobId: root }, { id: SESSION, resume: false }),
                root
            ).toThrow(/not a uuid/);
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
            expect(transcriptDir(job)).toBe(`/task/.factory/transcripts/${job.id}`);
            // A follow-up is a NEW job row resuming the parent conversation: its store is the
            // thread's, keyed by the same root the worktree is keyed by.
            expect(transcriptDir({ ...job, rootJobId: ROOT })).toBe(`/task/.factory/transcripts/${ROOT}`);
        });

        it('refuses a non-uuid thread root', () => {
            expect(() => transcriptDir({ ...job, rootJobId: '../../etc' })).toThrow(/not a uuid/);
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

    // The run-control pair is never minted into the env file (the supervisor's relays carry it), and a
    // member cannot set it for themselves.
    it('drops a member-set run-control name from the env file', () => {
        const forged = { ...envJob, env: { MY_TOKEN: 'board-secret', BELLOWS_CONTROL_TOKEN: 'member-forged' } };
        expect(envFileBody(forged)).toBe('MY_TOKEN=board-secret\n');
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
        expect(line).toEqual(expect.arrayContaining([`WORKDIR=${TASK_MOUNT}`]));
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
            ...taskMountArgs(job),
            '-e',
            `CLAUDE_TRANSCRIPT_DIR=/task/.factory/transcripts/${job.id}`,
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
                ...taskMountArgs(job),
                `WORKDIR=${TASK_MOUNT}`,
                '-e',
                'ANTHROPIC_API_KEY',
            ])
        );
        expect(line.some((arg) => arg.includes('ANTHROPIC_API_KEY='))).toBe(false);
    });
});
