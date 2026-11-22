import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { claimOf } from '../src/board/board-claim.js';
import { loadDriverConfig } from '../src/config.js';
import { dockerArgs } from '../src/docker/docker.js';
import { runnerJobSpec } from '../src/k8s/k8s-podspec.js';
import { runnerPlan } from '../src/runner-plan.js';
import { AGENT_CONTAINER } from '../src/supervisor-contract.js';
import { SESSION, SUPERVISED, job as k8sJob, opencodeJob as k8sOpencodeJob } from './fixtures/k8s-suite.js';

/**
 * BEL-531: the claim's `author` (the member who started the task) reaches git as GIT_AUTHOR_* in the agent's env on
 * both executors and both agents; GIT_COMMITTER_* is never set, so the committer stays the bot the images' gitconfig
 * names. A takeover or resume reads the same claim, so it gets the same author.
 */
const AUTHOR = { name: 'Octo Member', email: '1234+octo-member@users.noreply.github.com' };
const AUTHOR_PAIRS = [
    ['GIT_AUTHOR_NAME', AUTHOR.name],
    ['GIT_AUTHOR_EMAIL', AUTHOR.email],
];
const SESSION_NEW = { id: SESSION, resume: false };
const withAuthor = (j: BoardJob): BoardJob => ({ ...j, author: AUTHOR });

describe('the claim author', () => {
    it('is parsed from the wire and dropped when malformed', () => {
        expect(claimOf({ ...k8sJob, author: AUTHOR } as Partial<BoardJob>).author).toEqual(AUTHOR);
        for (const bad of [
            { name: '', email: AUTHOR.email },
            { name: 'x\ny', email: AUTHOR.email },
            { name: 'x' },
            'x',
            null,
        ]) {
            expect(claimOf({ ...k8sJob, author: bad } as unknown as Partial<BoardJob>).author).toBeUndefined();
        }
    });

    it.each([
        ['claude-code', k8sJob, SESSION_NEW],
        ['opencode', k8sOpencodeJob, null],
    ])('rides the %s runner plan as author env only', (_agent, j, session) => {
        const { envPairs } = runnerPlan(loadDriverConfig({}), withAuthor(j), session);
        expect(envPairs).toEqual(expect.arrayContaining(AUTHOR_PAIRS));
        expect(envPairs.map(([name]) => name).filter((name) => name.startsWith('GIT_COMMITTER'))).toEqual([]);
    });

    it('is absent from the plan when the claim names no author (AUTH_MODE=none)', () => {
        const { envPairs } = runnerPlan(loadDriverConfig({}), k8sJob, SESSION_NEW);
        expect(envPairs.map(([name]) => name).filter((name) => name.startsWith('GIT_'))).toEqual([]);
    });

    it('is on the docker runner argv, with no committer', () => {
        const args = dockerArgs(loadDriverConfig({}), withAuthor(k8sJob), SESSION_NEW, { envFile: '/tmp/env-file' });
        for (const [name, value] of AUTHOR_PAIRS) expect(args).toContain(`${name}=${value}`);
        expect(args.join(' ')).not.toContain('GIT_COMMITTER');
    });

    it('is a literal value in the kubernetes agent container env, with no committer', () => {
        const config = loadDriverConfig({ EXECUTOR: 'kubernetes', K8S_NAMESPACE: 'bellows' });
        const env =
            runnerJobSpec(
                config,
                { ...withAuthor(k8sJob), ...SUPERVISED },
                SESSION_NEW
            ).spec.template.spec.containers.find((container) => container.name === AGENT_CONTAINER)?.env ?? [];
        for (const [name, value] of AUTHOR_PAIRS) expect(env).toContainEqual({ name, value });
        expect(env.map((entry) => entry.name).filter((name) => name.startsWith('GIT_COMMITTER'))).toEqual([]);
    });

    it('rides a resumed or taken-over claim the same way', () => {
        const resumed = withAuthor({ ...k8sJob, followUp: true, resumeSessionId: SESSION, ownSession: true });
        const { envPairs } = runnerPlan(loadDriverConfig({}), resumed, { id: SESSION, resume: true });
        expect(envPairs).toEqual(expect.arrayContaining(AUTHOR_PAIRS));
    });
});
