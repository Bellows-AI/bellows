import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import type { RunSession } from '../src/runner.js';
import { runnerPlan } from '../src/runner-plan.js';

/**
 * What a runner is asked to do, decided once for both platforms (runner-plan.ts). docker renders
 * `envPairs` as `-e` before the image and `cliArgs` after it; kubernetes as container env values
 * and `args`. Those renderings are pinned once each in docker.test.ts and k8s.test.ts; every
 * decision about the plan itself is pinned here.
 */
const USER = '44444444-4444-4444-8444-444444444444';
const SESSION = '33333333-3333-4333-8333-333333333333';
const MASTER_PROMPT = 'Factory execution contract (factory-master-prompt/v1)\n\n- Mode: standalone';
const TRANSCRIPTS = `/workspaces/bellows/${USER}/.factory/transcripts/11111111-1111-4111-8111-111111111111`;

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
    userId: USER,
    workspacePath: `bellows/${USER}`,
} as BoardJob;
const opencodeJob: BoardJob = { ...job, executorType: 'opencode' };
const SYSTEM_PROMPT = ['--append-system-prompt', MASTER_PROMPT, '--system-prompt-snapshot', 'off'];

const plan = (j: BoardJob, session: RunSession | null, env: NodeJS.ProcessEnv = {}) =>
    runnerPlan(loadDriverConfig(env), j, session);

describe('the claude-code runner plan', () => {
    // The prompt is delivered on EVERY run, resume and follow-up included: a restored
    // conversation that receives nothing idles to the deadline. `--resume` keeps the id.
    it.each([
        ['a fresh run', job, { id: SESSION, resume: false }, '--session-id'],
        ['a resume', job, { id: SESSION, resume: true }, '--resume'],
        ['a follow-up', { ...job, followUp: true }, { id: SESSION, resume: true }, '--resume'],
    ])('runs the command as the prompt, last, on %s', (_name, j, session, flag) => {
        expect(plan(j, session)).toEqual({
            envPairs: [
                ['FACTORY_TRANSCRIPT_DIR', TRANSCRIPTS],
                ['BELLOWS_SESSION_ID', SESSION],
                ['NPM_CONFIG_UPDATE_NOTIFIER', 'false'],
            ],
            cliArgs: [flag, SESSION, ...SYSTEM_PROMPT, '-p', 'fix the failing build'],
        });
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

    it('skips permissions only when told to', () => {
        const session = { id: SESSION, resume: false };
        expect(plan(job, session).cliArgs).not.toContain('--dangerously-skip-permissions');
        expect(plan(job, session, { RUNNER_SKIP_PERMISSIONS: '1' }).cliArgs).toContain(
            '--dangerously-skip-permissions'
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
                ['XDG_DATA_HOME', `/workspaces/bellows/${USER}/.opencode`],
                ['NPM_CONFIG_UPDATE_NOTIFIER', 'false'],
            ],
            cliArgs: ['run', '--agent', 'factory', 'fix the failing build'],
        });
    });

    // A follow-up continues the session opencode ITSELF created, and the reporter names it.
    it('continues its own session with the new command on a follow-up', () => {
        const session = { id: 'ses_f86188c3dffeZGYO4yZq4atba9', resume: true };
        expect(plan({ ...opencodeJob, followUp: true }, session)).toEqual({
            envPairs: [
                ['XDG_DATA_HOME', `/workspaces/bellows/${USER}/.opencode`],
                ['NPM_CONFIG_UPDATE_NOTIFIER', 'false'],
                ['BELLOWS_SESSION_ID', session.id],
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

    it.each([
        ['adopt a minted session', { id: 'ses_abc123', resume: false }, /cannot adopt a minted session/],
        ['take a session id that is not a safe token', { id: 'bad id; rm -rf', resume: true }, /not a safe token/],
    ])('refuses to %s', (_name, session, error) => {
        expect(() => plan({ ...opencodeJob, followUp: true }, session)).toThrow(error);
    });
});
