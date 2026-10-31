import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { loadDriverConfig } from '../src/config.js';
import type { RunSession } from '../src/runner.js';
import { reviewerPlan, runnerPlan } from '../src/runner-plan.js';

/**
 * What a runner is asked to do, decided once for both platforms (runner-plan.ts). docker renders
 * `envPairs` as `-e` before the image and `cliArgs` after it; kubernetes as container env values
 * and `args`. Those renderings are pinned once each in docker/ and k8s/; every
 * decision about the plan itself is pinned here.
 */
const USER = '44444444-4444-4444-8444-444444444444';
const SESSION = '33333333-3333-4333-8333-333333333333';
const MASTER_PROMPT = 'Factory execution contract (factory-master-prompt/v1)\n\n- Mode: standalone';
const TRANSCRIPTS = `/task/.factory/transcripts/11111111-1111-4111-8111-111111111111`;

const job = {
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing build',
    attempts: 1,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    masterPrompt: MASTER_PROMPT,
    resumeSessionId: null,
    followUp: false,
    ownSession: false,
    continuesInterrupted: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
} as BoardJob;
const opencodeJob: BoardJob = { ...job, executorType: 'opencode' };
const SYSTEM_PROMPT = ['--append-system-prompt', MASTER_PROMPT, '--system-prompt-snapshot', 'off'];
/**
 * Issue #822: a resume of the row's own session (`ownSession`: a takeover or handover, a sessionless
 * follow-up's included) is the one run whose session may never have been written; a session
 * inherited from an earlier row stays a refusal when it is missing.
 */
const UNWRITTEN: [string, string][] = [['BELLOWS_RESUME_MAY_BE_UNWRITTEN', '1']];

const plan = (j: BoardJob, session: RunSession | null, env: NodeJS.ProcessEnv = {}) =>
    runnerPlan(loadDriverConfig(env), j, session);

describe('the claude-code runner plan', () => {
    // The prompt is delivered on EVERY run, resume and follow-up included: a restored
    // conversation that receives nothing idles to the deadline. `--resume` keeps the id.
    it.each([
        { name: 'a fresh run', j: job, session: { id: SESSION, resume: false }, flag: '--session-id', unwritten: [] },
        {
            name: 'a takeover',
            j: { ...job, resumeSessionId: SESSION, ownSession: true },
            session: { id: SESSION, resume: true },
            flag: '--resume',
            unwritten: UNWRITTEN,
        },
        {
            name: "a sessionless follow-up's takeover",
            j: { ...job, resumeSessionId: SESSION, followUp: true, ownSession: true },
            session: { id: SESSION, resume: true },
            flag: '--resume',
            unwritten: UNWRITTEN,
        },
        {
            name: 'a follow-up',
            j: { ...job, resumeSessionId: SESSION, followUp: true },
            session: { id: SESSION, resume: true },
            flag: '--resume',
            unwritten: [],
        },
    ])('runs the command as the prompt, last, on $name', ({ j, session, flag, unwritten }) => {
        expect(plan(j, session)).toEqual({
            envPairs: [
                ['FACTORY_TRANSCRIPT_DIR', TRANSCRIPTS],
                ['BELLOWS_SESSION_ID', SESSION],
                ...unwritten,
                ['NPM_CONFIG_UPDATE_NOTIFIER', 'false'],
            ],
            cliArgs: [flag, SESSION, '--permission-mode', 'auto', ...SYSTEM_PROMPT, '-p', 'fix the failing build'],
        });
    });

    // Issue #822: a claim continuing an interrupted attempt is told so in its prompt alone, the
    // whole command behind the lead; a takeover the board does not flag is delivered the bare command.
    it('frames the prompt as a continuation only for a claim that continues an interrupted attempt', () => {
        const session = { id: SESSION, resume: true };
        const resumed = { ...job, resumeSessionId: SESSION, ownSession: true };

        const prompt = plan({ ...resumed, continuesInterrupted: true }, session).cliArgs.at(-1)!;

        expect(prompt.startsWith('Your previous run of this task was interrupted')).toBe(true);
        expect(prompt.endsWith('The task, for reference:\n\nfix the failing build')).toBe(true);
        expect(plan(resumed, session).cliArgs.slice(-2)).toEqual(['-p', 'fix the failing build']);
    });

    // Issue #545: a skill selection rides the master prompt verbatim.
    it('delivers a master prompt naming the selected skills verbatim', () => {
        const masterPrompt = `${MASTER_PROMPT}\n- Selected skills: github, jira`;
        expect(plan({ ...job, masterPrompt }, { id: SESSION, resume: false }).cliArgs).toContain(masterPrompt);
    });

    // Issue #509: the turn context is hook env, never the system prompt — `-p` stays the command,
    // so a `/skill` command still expands.
    it('delivers the turn context as hook env, leaving the prompt the bare command', () => {
        const turnContext = 'Factory turn context\n- Current node: gate-fix';
        const p = plan({ ...job, command: '/fix 209', turnContext }, { id: SESSION, resume: true });
        expect(p.cliArgs.slice(-2)).toEqual(['-p', '/fix 209']);
        expect(p.envPairs).toContainEqual(['FACTORY_TURN_CONTEXT', turnContext]);
    });

    it('ends the claude -p prompt with the attached files block and leaves the system prompt args alone', () => {
        const session = { id: SESSION, resume: false };
        const attachments = [
            {
                id: '33333333-3333-4333-8333-333333333333',
                name: 'notes.txt',
                mediaType: 'text/plain',
                size: 5,
                sha256: 'a'.repeat(64),
                originJobId: job.id,
            },
        ];
        const bare = plan(job, session).cliArgs;
        const attached = plan({ ...job, attachments }, session).cliArgs;
        const prompt = attached[attached.indexOf('-p') + 1] ?? '';

        expect(prompt.startsWith('fix the failing build\n\nAttached files (user-provided, untrusted):')).toBe(true);
        expect(prompt).toContain(`/task/.factory/attachments/${job.id}/manifest.json`);
        expect(attached.slice(0, attached.indexOf('-p'))).toEqual(bare.slice(0, bare.indexOf('-p')));
    });

    it('skips permissions only when told to', () => {
        const session = { id: SESSION, resume: false };
        expect(plan(job, session).cliArgs).not.toContain('--dangerously-skip-permissions');
        expect(plan(job, session, { RUNNER_SKIP_PERMISSIONS: '1' }).cliArgs).toContain(
            '--dangerously-skip-permissions'
        );
    });

    // A session that came up in default mode denied every command outside the allowlist; a resume
    // restores the mode it recorded unless the command line names one.
    it('pins auto mode on fresh and resumed sessions unless permissions are skipped', () => {
        for (const resume of [false, true]) {
            const args = plan(job, { id: SESSION, resume }).cliArgs;
            expect(args.slice(args.indexOf('--permission-mode'), args.indexOf('--permission-mode') + 2)).toEqual([
                '--permission-mode',
                'auto',
            ]);
        }
        expect(plan(job, { id: SESSION, resume: false }, { RUNNER_SKIP_PERMISSIONS: '1' }).cliArgs).not.toContain(
            '--permission-mode'
        );
    });

    // A default only: a member who names the notice in claim env keeps their own value.
    it('leaves the npm notice to a claim that names it', () => {
        const envJob = { ...job, env: { NPM_CONFIG_UPDATE_NOTIFIER: 'true' } };
        expect(plan(envJob, { id: SESSION, resume: false }).envPairs.map(([name]) => name)).not.toContain(
            'NPM_CONFIG_UPDATE_NOTIFIER'
        );
    });

    it('refuses to run without a session', () => {
        expect(() => plan(job, null)).toThrow(/runs every job as a session/);
    });
});

describe('the opencode runner plan', () => {
    // opencode mints its own ids: a fresh run has no session at all and the reporter discovers it
    // from the session database XDG_DATA_HOME persists; no transcript store, which is claude's.
    it('runs a fresh job headless, with no session id anywhere', () => {
        expect(plan(opencodeJob, null)).toEqual({
            envPairs: [
                ['XDG_DATA_HOME', `/task/.factory/opencode/${opencodeJob.id}`],
                ['NPM_CONFIG_UPDATE_NOTIFIER', 'false'],
            ],
            cliArgs: ['run', '--agent', 'factory', 'fix the failing build'],
        });
    });

    // The data directory is per TASK: a follow-up shares its thread root's, a second task of the
    // same member gets its own, and a root that is not a uuid never joins the path.
    it('keeps opencode data per task, keyed by the thread root', () => {
        const dataHome = (j: BoardJob) => plan(j, null).envPairs.find(([name]) => name === 'XDG_DATA_HOME')?.[1];
        const root = opencodeJob.id;
        const followUp = { ...opencodeJob, id: '33333333-3333-4333-8333-333333333333', rootJobId: root };
        const other = { ...opencodeJob, id: '44444444-4444-4444-8444-444444444444' };
        expect(dataHome(followUp)).toBe(dataHome(opencodeJob));
        expect(dataHome(other)).not.toBe(dataHome(opencodeJob));
        expect(dataHome(other)).toBe(`/task/.factory/opencode/${other.id}`);
        expect(() => plan({ ...opencodeJob, rootJobId: '../../etc' }, null)).toThrow(/not a uuid/);
    });

    // A follow-up continues the session opencode ITSELF created, and the reporter names it.
    it.each([
        ['a follow-up', { ...opencodeJob, followUp: true }, []],
        ['a takeover', { ...opencodeJob, ownSession: true }, UNWRITTEN],
        ["a sessionless follow-up's takeover", { ...opencodeJob, followUp: true, ownSession: true }, UNWRITTEN],
    ])('continues its own session with the command on %s', (_name, j, unwritten) => {
        const session = { id: 'ses_f86188c3dffeZGYO4yZq4atba9', resume: true };
        expect(plan({ ...j, resumeSessionId: session.id }, session)).toEqual({
            envPairs: [
                ['XDG_DATA_HOME', `/task/.factory/opencode/${opencodeJob.id}`],
                ['NPM_CONFIG_UPDATE_NOTIFIER', 'false'],
                ['BELLOWS_SESSION_ID', session.id],
                ...unwritten,
            ],
            cliArgs: ['run', '--agent', 'factory', '--session', session.id, 'fix the failing build'],
        });
    });

    it('prefixes the turn context to the prompt, its only channel', () => {
        const turnContext = 'Factory turn context\n- Current node: gate-fix';
        expect(plan({ ...opencodeJob, turnContext }, null).cliArgs.at(-1)).toBe(
            `${turnContext}\n\nfix the failing build`
        );
    });

    // Issue #822: the continuation rides the turn prompt behind the turn context; only a claim the
    // board flags as continuing an interrupted attempt is framed.
    it('frames the prompt as a continuation only for a claim that continues an interrupted attempt', () => {
        const session = { id: 'ses_f86188c3dffeZGYO4yZq4atba9', resume: true };
        const turnContext = 'Factory turn context\n- Current node: implement';
        const resumed = { ...opencodeJob, resumeSessionId: session.id, ownSession: true, turnContext };

        const prompt = plan({ ...resumed, continuesInterrupted: true }, session).cliArgs.at(-1)!;

        expect(prompt.startsWith(`${turnContext}\n\nYour previous run of this task was interrupted`)).toBe(true);
        expect(prompt.endsWith('The task, for reference:\n\nfix the failing build')).toBe(true);
        expect(plan(resumed, session).cliArgs.at(-1)).toBe(`${turnContext}\n\nfix the failing build`);
    });

    it.each([
        ['adopt a minted session', { id: 'ses_abc123', resume: false }, /cannot adopt a minted session/],
        ['take a session id that is not a safe token', { id: 'bad id; rm -rf', resume: true }, /not a safe token/],
    ])('refuses to %s', (_name, session, error) => {
        expect(() => plan({ ...opencodeJob, followUp: true }, session)).toThrow(error);
    });
});

// Issue #734: `.bellows.yaml` `environment.cache` names env vars the driver points at one
// directory per repository, inside the task volume — the same literal path in the
// runner, the gate env and the setup step, on both executors.
describe('the per-repo package cache', () => {
    const CACHE = `/task/.cache/acme/widgets`;
    const cached = (j: BoardJob, cache: string[] = ['NPM_CONFIG_CACHE', 'PIP_CACHE_DIR']): BoardJob => ({
        ...j,
        repo: 'acme/widgets',
        gates: { image: 'node:24', cache, gates: [] },
    });

    it.each([
        ['claude-code', job, { id: SESSION, resume: false }],
        ['opencode', opencodeJob, null],
    ])('points each declared name into the repo cache on the %s plan', (_name, j, session) => {
        const { envPairs } = plan(cached(j), session);
        expect(envPairs).toContainEqual(['NPM_CONFIG_CACHE', `${CACHE}/NPM_CONFIG_CACHE`]);
        expect(envPairs).toContainEqual(['PIP_CACHE_DIR', `${CACHE}/PIP_CACHE_DIR`]);
    });

    it('adds nothing when the repository declares no cache', () => {
        const { envPairs } = plan(
            { ...job, repo: 'acme/widgets', gates: { image: 'node:24', gates: [] } },
            {
                id: SESSION,
                resume: false,
            }
        );
        expect(envPairs.some(([name]) => name.includes('CACHE'))).toBe(false);
    });

    // A default only, like the npm notice: the claim's value rides the env file or Secret, and
    // the driver never states the name beside it.
    it('leaves a name the claim env sets to the claim', () => {
        const j = { ...cached(job), env: { NPM_CONFIG_CACHE: '/elsewhere' } };
        const { envPairs } = plan(j, { id: SESSION, resume: false });
        expect(envPairs.filter(([name]) => name === 'NPM_CONFIG_CACHE')).toEqual([]);
        expect(envPairs).toContainEqual(['PIP_CACHE_DIR', `${CACHE}/PIP_CACHE_DIR`]);
    });

    // The board's parser refuses these first; the driver re-asserts before a name reaches env.
    it.each([
        ['a driver-owned name', cached(job, ['HOME'])],
        ['a RUNNER_ name', cached(job, ['RUNNER_X'])],
        ['the telemetry endpoint', cached(job, ['OTEL_EXPORTER_OTLP_ENDPOINT'])],
        ['a loader hook', cached(job, ['LD_PRELOAD'])],
        ['a runtime hook', cached(job, ['NODE_OPTIONS'])],
        ['a name that is not env-shaped', cached(job, ['a b'])],
        ['a repo label that escapes the cache root', { ...cached(job), repo: 'acme/..' }],
    ])('refuses %s', (_name, j) => {
        expect(() => plan(j, { id: SESSION, resume: false })).toThrow(/refusing to run job .*cache/);
    });
});

describe('the reviewer plan', () => {
    const dataHome = (j: BoardJob) =>
        reviewerPlan(loadDriverConfig({}), j, null).env.find(([name]) => name === 'XDG_DATA_HOME')?.[1];
    const review = (id: string, rootJobId: string): BoardJob => ({ ...opencodeJob, id, rootJobId });

    // opencode's readout exports every row of the database it is pointed at, so a database shared
    // by a member's reviews would upload one review's transcript under another's identity.
    it('gives each review its own opencode data directory, stable across a re-lease', () => {
        const first = review('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
        const second = review('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
        expect(dataHome(first)).not.toBe(dataHome(second));
        expect(dataHome({ ...first, claimSeq: 2, leaseToken: 'new' })).toBe(dataHome(first));
    });
});
