import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board.js';
import { loadDriverConfig } from '../src/config.js';
import { type PublishOptions, type PublishStep, publishCheckout } from '../src/publish.js';

/**
 * The publish workflow both executors run (`publishCheckout`), over a fake transport: every
 * decision — step order, branch, commit, push, PR reuse, draft, the no-ops, the stale refusal and
 * the failure causes — is pinned here once. docker.test.ts and k8s.test.ts keep one end-to-end
 * publish each plus what only their transport decides (`docker run` argv and env file; step Jobs
 * and the publish Secret).
 */
const USER = '44444444-4444-4444-8444-444444444444';
const ISSUE_JOB = {
    id: '11111111-1111-4111-8111-111111111111',
    command: '/fix https://github.com/Bellows-AI/factory/issues/10',
    attempts: 1,
    claimSeq: 1,
    leaseToken: '22222222-2222-4222-8222-222222222222',
    leaseExpiresAt: '2026-08-29T12:05:00.000Z',
    executorType: 'claude-code',
    resumeSessionId: null,
    followUp: false,
    userId: USER,
    workspacePath: `bellows/${USER}`,
    repo: 'Bellows-AI/factory',
    env: { GITHUB_TOKEN: 't0k-3n' } as Record<string, string>,
} as BoardJob;
const WT = `/workspaces/bellows/${USER}/.worktrees/${ISSUE_JOB.id}`;
const PR_URL = 'https://github.com/Bellows-AI/factory/pull/42';
const PLAN_TITLE = '/fix https://github.com/Bellows-AI/factory/issues/10 (#10)';
const GATES_LINE = 'Published by the factory board after the declared gates passed.';

const DIRTY_ON_MAIN = {
    cloned: true,
    branch: 'main',
    defaultBranch: 'main',
    dirty: true,
    unpushed: 0,
    hasIdentity: false,
};
const ON_TASK_BRANCH = { ...DIRTY_ON_MAIN, branch: 'fix/10', hasIdentity: true, dirty: false };
/** What the PR summarizer answers (issue #82): what the branch did, not what was asked. */
const SUMMARY = { title: 'Fix the sync re-claim fence', body: '## Commits\n\n- Fix the sync re-claim fence' };

const LANDED = {
    ok: true,
    published: true,
    branch: 'fix/10',
    prUrl: PR_URL,
    reason: null,
    repository: 'Bellows-AI/factory',
    baseBranch: 'main',
    prNumber: 42,
    cause: null,
};
const nothing = (reason: string) => ({
    ok: true,
    published: false,
    branch: null,
    prUrl: null,
    reason,
    repository: null,
    baseBranch: null,
    prNumber: null,
    cause: null,
});

/**
 * A fake transport: the probe answers `state`, `git switch` without `-c` finds no branch, `gh pr
 * view` finds a PR only when `prExists`, and `fail` rejects a step the way a transport does — with
 * the tool's own words. Every step is recorded, so the flow is the assertion.
 */
const transport = (
    state: Record<string, unknown>,
    opts: {
        prExists?: boolean;
        /** What `gh pr base` answers: the reused PR's state and base. */
        prBase?: string;
        summary?: unknown;
        fail?: (step: PublishStep) => string | null;
    } = {}
) => {
    const steps: PublishStep[] = [];
    const run = async (step: PublishStep): Promise<{ stdout: string }> => {
        steps.push(step);
        const refused = opts.fail?.(step);
        if (refused) throw new Error(refused);
        if (step.label === 'probe') return { stdout: `${JSON.stringify(state)}\n` };
        if (step.label === 'git switch' && !step.args.includes('-c')) throw new Error('invalid reference: fix/10');
        if (step.label === 'gh pr view') {
            if (opts.prExists) return { stdout: `${PR_URL}\n` };
            throw new Error('no pull requests found');
        }
        if (step.label === 'gh pr base') return { stdout: `${opts.prBase ?? ''}\n` };
        if (step.label === 'pr summary') return { stdout: JSON.stringify(opts.summary ?? SUMMARY) };
        if (step.label === 'gh pr create') return { stdout: `${PR_URL}\n` };
        return { stdout: '' };
    };
    const labels = () => steps.map((s) => s.label);
    const find = (label: string) => steps.find((s) => s.label === label)!;
    return { run, steps, labels, find };
};

const publish = (t: ReturnType<typeof transport>, options?: PublishOptions, job: BoardJob = ISSUE_JOB) =>
    publishCheckout(loadDriverConfig({}), job, options, t.run);

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe('the publish workflow', () => {
    it('branches, commits, pushes and opens the PR — in that order', async () => {
        const t = transport(DIRTY_ON_MAIN);

        expect(await publish(t)).toEqual(LANDED);

        expect(t.labels()).toEqual([
            'probe',
            'git switch',
            'git switch',
            'git add',
            'git reset',
            'git commit',
            'git push',
            'gh pr view',
            'pr summary',
            'gh pr create',
        ]);
        // The probe reads the worktree by its REPO literal; every other step runs inside it.
        expect(t.find('probe')).toMatchObject({ inRepo: false, env: false, envLiterals: { REPO: WT } });
        expect(t.steps.slice(1).every((s) => s.inRepo)).toBe(true);
        // Only the push and the two PR calls are handed the claim env — the token they read.
        expect(t.steps.filter((s) => s.env).map((s) => s.label)).toEqual(['git push', 'gh pr view', 'gh pr create']);
        // The plain switch finds no branch; `-c` creates it.
        expect(t.steps[2]?.args).toEqual(['switch', '-c', 'fix/10']);
        // The commit carries the plan title, and the fallback identity only when the probe found none.
        expect(t.find('git commit').args).toEqual([
            '-c',
            'user.name=factory-ai',
            '-c',
            'user.email=factory-ai@users.noreply.github.com',
            'commit',
            '-m',
            PLAN_TITLE,
        ]);
        // force-with-lease: the startup sync may have rewritten the task branch's base, and the
        // lease refuses to clobber a remote that moved under us. The helper reads the token from
        // the env; no step's argv carries it.
        const push = t.find('git push').args;
        expect(push).toContain('--force-with-lease');
        expect(push.join(' ')).toContain('credential.helper=');
        expect(JSON.stringify(t.steps)).not.toContain('t0k-3n');
        // The PR speaks for the work (issue #82): the summarizer reads the branch with literal
        // envs only — the BASE and the backstop commit's subject, which must never win the title
        // (issue #389) — and its title, issue ref appended, heads the PR over its body.
        expect(t.find('pr summary')).toMatchObject({
            entrypoint: 'node',
            env: false,
            envLiterals: { BASE: 'origin/main', BACKSTOP_TITLE: PLAN_TITLE },
        });
        const create = t.find('gh pr create').args;
        expect(flag(create, '--head')).toBe('fix/10');
        // No base on the claim: gh picks the repository default, as it always has.
        expect(create).not.toContain('--base');
        expect(flag(create, '--title')).toBe('Fix the sync re-claim fence (#10)');
        expect(flag(create, '--body')).toBe(`${SUMMARY.body}\n\nCloses #10.\n\n${GATES_LINE}`);
        expect(create).not.toContain('--draft');
    });

    it('bases the probe and the PR on a claim’s base branch, and reports it', async () => {
        // The probe answers the base it was handed as the branch to compare against.
        const t = transport({ ...DIRTY_ON_MAIN, branch: 'batch-sandbox', defaultBranch: 'batch-sandbox' });

        expect(await publish(t, undefined, { ...ISSUE_JOB, baseBranch: 'batch-sandbox' })).toEqual({
            ...LANDED,
            baseBranch: 'batch-sandbox',
        });
        expect(t.find('probe').envLiterals).toEqual({ REPO: WT, BASE_BRANCH: 'batch-sandbox' });
        expect(t.find('pr summary').envLiterals).toMatchObject({ BASE: 'origin/batch-sandbox' });
        expect(flag(t.find('gh pr create').args, '--base')).toBe('batch-sandbox');
    });

    // The agent may have opened the PR itself with gh's default base: a reused PR is retargeted
    // to the claim's base before the board records it, so automerge never lands on the default.
    it.each([
        [
            'reused after a push',
            { ...ON_TASK_BRANCH, unpushed: 1 },
            ['probe', 'git push', 'gh pr view', 'gh pr base', 'gh pr edit'],
        ],
        [
            'reconciled on a clean tree',
            { ...ON_TASK_BRANCH, unpushed: 0 },
            ['probe', 'gh pr view', 'gh pr base', 'gh pr edit'],
        ],
    ])('retargets an open PR %s to the claim’s base branch', async (_case, state, labels) => {
        const t = transport({ ...state, defaultBranch: 'batch-sandbox' }, { prExists: true, prBase: 'OPEN main' });

        expect(await publish(t, undefined, { ...ISSUE_JOB, baseBranch: 'batch-sandbox' })).toEqual({
            ...LANDED,
            baseBranch: 'batch-sandbox',
        });
        expect(t.labels()).toEqual(labels);
        expect(t.find('gh pr edit')).toMatchObject({
            args: ['pr', 'edit', 'fix/10', '--base', 'batch-sandbox'],
            env: true,
            inRepo: true,
        });
    });

    it.each([
        ['already on the base', 'OPEN batch-sandbox'],
        ['merged', 'MERGED main'],
        ['closed', 'CLOSED main'],
    ])('leaves a reused PR %s as it is', async (_case, prBase) => {
        const t = transport(
            { ...ON_TASK_BRANCH, unpushed: 1, defaultBranch: 'batch-sandbox' },
            { prExists: true, prBase }
        );

        expect(await publish(t, undefined, { ...ISSUE_JOB, baseBranch: 'batch-sandbox' })).toMatchObject({ ok: true });
        expect(t.labels()).toEqual(['probe', 'git push', 'gh pr view', 'gh pr base']);
    });

    it.each(['gh pr base', 'gh pr edit'])('fails the publish when the retarget’s %s step fails', async (label) => {
        const t = transport(
            { ...ON_TASK_BRANCH, unpushed: 0, defaultBranch: 'batch-sandbox' },
            { prExists: true, prBase: 'OPEN main', fail: (step) => (step.label === label ? 'HTTP 422' : null) }
        );

        expect(await publish(t, undefined, { ...ISSUE_JOB, baseBranch: 'batch-sandbox' })).toMatchObject({
            ok: false,
            reason: expect.stringContaining(`${label}: HTTP 422`),
        });
    });

    it('keeps a member-configured committer identity', async () => {
        const t = transport({ ...DIRTY_ON_MAIN, hasIdentity: true });
        await publish(t);
        expect(t.find('git commit').args).toEqual(['commit', '-m', PLAN_TITLE]);
    });

    it('reuses an existing task branch and an existing PR, with no summarizer', async () => {
        const t = transport({ ...ON_TASK_BRANCH, unpushed: 1 }, { prExists: true });

        expect(await publish(t)).toEqual(LANDED);
        expect(t.labels()).toEqual(['probe', 'git push', 'gh pr view']);
    });

    it('opens the agent’s PR as a draft, and reuses one that exists without a second create', async () => {
        const fresh = transport(DIRTY_ON_MAIN);
        await publish(fresh, { draft: true });
        const create = fresh.find('gh pr create').args;
        expect(create).toContain('--draft');
        expect(flag(create, '--body')).toContain('Draft published by the agent');
        expect(flag(create, '--body')).not.toContain('declared gates passed');

        const again = transport({ ...ON_TASK_BRANCH, unpushed: 1 }, { prExists: true });
        expect(await publish(again, { draft: true })).toMatchObject({ ok: true, published: true, prNumber: 42 });
        expect(again.labels()).toEqual(['probe', 'git push', 'gh pr view']);
    });

    // Issue #573: the agent opened the PR itself and pushed everything, so the checkout is clean —
    // the publish still names that PR, so the board records the one link.
    it('reconciles a pull request the agent opened itself on a clean, pushed task branch', async () => {
        const reconciled = transport({ ...ON_TASK_BRANCH, unpushed: 0 }, { prExists: true });
        expect(await publish(reconciled)).toEqual(LANDED);
        expect(reconciled.labels()).toEqual(['probe', 'gh pr view']);

        const none = transport({ ...ON_TASK_BRANCH, unpushed: 0 });
        expect(await publish(none)).toEqual(nothing('no uncommitted changes and nothing unpushed'));
    });

    it.each([
        [
            'a clean, fully pushed tree',
            { ...DIRTY_ON_MAIN, dirty: false },
            'no uncommitted changes and nothing unpushed',
        ],
        ['an uncloned checkout', { cloned: false }, 'the checkout has not been cloned yet'],
        ['a probe that cannot run', null, 'the checkout has not been cloned yet'],
    ])('answers %s as a no-op after the probe alone', async (_name, state, reason) => {
        const t = transport(state ?? {}, { fail: (s) => (state === null && s.label === 'probe' ? 'boom' : null) });

        expect(await publish(t)).toEqual(nothing(reason));
        expect(t.labels()).toEqual(['probe']);
    });

    it('publishes nothing for a command-only job, without a probe', async () => {
        const t = transport(DIRTY_ON_MAIN);
        const { repo: _repo, ...commandOnly } = ISSUE_JOB;
        expect(await publish(t, undefined, commandOnly)).toEqual(
            nothing('the job names no checkout — nothing to publish')
        );
        expect(t.steps).toEqual([]);
    });

    // Revision-bound evidence (issue #548): a publish bound to a revision pushes only that tree.
    it('refuses a publish bound to a revision the checkout no longer holds, after the probe alone', async () => {
        const t = transport({ ...DIRTY_ON_MAIN, fingerprint: 'h:2' });

        expect(await publish(t, { revision: 'h:1' })).toMatchObject({ ok: false, published: false, stale: true });
        expect(t.labels()).toEqual(['probe']);
    });

    it('publishes a bound revision the checkout still holds, and an unbound publish ignores the fingerprint', async () => {
        const bound = transport({ ...DIRTY_ON_MAIN, fingerprint: 'h:1' });
        expect(await publish(bound, { revision: 'h:1' })).toMatchObject({ ok: true, published: true });
        const unbound = transport({ ...DIRTY_ON_MAIN, fingerprint: 'h:2' });
        expect(await publish(unbound)).toMatchObject({ ok: true, published: true });
    });
});

describe('a failed publish step', () => {
    // Issue #581: the board recovers a failed publish by its cause, read from the step's own words.
    it.each([
        ['a refused step', 'step refused', 'unknown'],
        [
            'a rejected non-fast-forward push',
            ' ! [rejected]        HEAD -> fix/10 (non-fast-forward)\nerror: failed to push some refs',
            'conflict',
        ],
        [
            'a denied push',
            'remote: Permission to Bellows-AI/factory.git denied to bellows-ai[bot]\nfatal: Authentication failed',
            'denied',
        ],
    ])('fails %s naming the step and the tool’s own words', async (_name, words, cause) => {
        const t = transport(DIRTY_ON_MAIN, { fail: (s) => (s.label === 'git push' ? words : null) });

        const result = await publish(t);

        expect(result).toMatchObject({ ok: false, published: false, cause });
        expect(result.reason).toBe(`git push: ${words}`);
        expect(t.labels().at(-1)).toBe('git push');
    });
});

// The summary is decoration, never worth the publish (issue #82): the command-derived plan
// title and the plain body are the fallback.
describe('the PR summary', () => {
    const created = async (opts: Parameters<typeof transport>[1]) => {
        const t = transport(DIRTY_ON_MAIN, opts);
        const result = await publish(t);
        const create = t.find('gh pr create').args;
        return { result, title: flag(create, '--title'), body: flag(create, '--body') };
    };

    it('falls back to the command-derived title and body when the summarizer fails', async () => {
        const { result, title, body } = await created({ fail: (s) => (s.label === 'pr summary' ? 'boom' : null) });

        expect(result).toEqual(LANDED);
        expect(title).toBe(PLAN_TITLE);
        expect(body).toBe(`Closes #10.\n\n${GATES_LINE}`);
    });

    it('does not append the issue ref to a title that already ends with it', async () => {
        const { title } = await created({
            summary: { title: 'Fix the sync re-claim fence (#10)', body: '## Commits' },
        });
        expect(title).toBe('Fix the sync re-claim fence (#10)');
    });

    it('falls back per half when the summary answers nulls on one side', async () => {
        const { title, body } = await created({ summary: { title: null, body: SUMMARY.body } });

        expect(title).toBe(PLAN_TITLE);
        expect(body).toBe(`${SUMMARY.body}\n\nCloses #10.\n\n${GATES_LINE}`);
    });
});
