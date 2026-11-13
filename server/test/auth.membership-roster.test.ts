import { describe, expect, it } from 'vitest';
import { createMembershipReader, type MembershipTarget } from '../src/auth/membership.js';
import { FAKE_GITHUB_API, fakeGitHubMembers } from './helpers-github-members.js';

/**
 * GitHub's member list of an installation's organization (`GET /orgs/:org/members`, the App's `members:read`): what
 * the invitation read offers an admin. Only a 200 on every page is a list; anything else is `unknown`.
 */

const org = (overrides: Partial<MembershipTarget['org']> = {}): MembershipTarget['org'] => ({
    id: '99001',
    login: 'acme',
    accountType: 'Organization',
    accountId: 4242,
    ...overrides,
});

const rig = (budgetMs = 1_000) => {
    const github = fakeGitHubMembers();
    github.orgs.set('acme', 4242);
    const tokens: string[] = [];
    const reader = createMembershipReader({
        apiUrl: FAKE_GITHUB_API,
        tokenFor: async (installationId) => {
            tokens.push(installationId);
            return 'ghs_installation';
        },
        fetchFn: github.fetchFn,
        timeoutMs: budgetMs,
    });
    /** `count` members of acme, ids from 1. */
    const people = (count: number) => {
        for (let id = 1; id <= count; id += 1) {
            github.users.set(id, `cat-${id}`);
            github.answer('acme', `cat-${id}`, id === 1 ? 'admin' : 'member');
        }
    };
    return { github, reader, tokens, people };
};

describe('the GitHub member list', () => {
    it('lists every active member across pages, with the org installation token', async () => {
        const { github, reader, tokens, people } = rig();
        people(150);
        github.answer('acme', 'cat-151', 'pending');
        github.users.set(151, 'cat-151');

        const answer = await reader.roster(org());
        expect(answer.kind).toBe('listed');
        if (answer.kind !== 'listed') return;
        expect(answer.members).toHaveLength(150);
        expect(answer.members[0]).toEqual({ githubUserId: 1, login: 'cat-1' });
        expect(answer.members.map((m) => m.login)).not.toContain('cat-151');
        expect(github.calls.filter((path) => path === '/orgs/acme/members')).toHaveLength(2);
        expect(tokens).toEqual(['99001']);
    });

    it.each([
        ['a 403 (members:read not granted)', { status: 403, body: '{}' }],
        ['a malformed body', { status: 200, body: '{"members":[]}' }],
        ['a transport failure', 'throw' as const],
        ['a request past the budget', 'hang' as const],
    ])('reads %s as unknown', async (_, fault) => {
        const { github, reader, people } = rig(50);
        people(3);
        github.rosterFault = fault;
        expect((await reader.roster(org())).kind).toBe('unknown');
    });

    it('lists a user-account installation as its one account, asking GitHub nothing', async () => {
        const { github, reader } = rig();
        expect(await reader.roster(org({ accountType: 'User', accountId: 77, login: 'solo' }))).toEqual({
            kind: 'listed',
            members: [{ githubUserId: 77, login: 'solo' }],
        });
        expect((await reader.roster(org({ accountType: null, accountId: null }))).kind).toBe('unknown');
        expect(github.calls).toEqual([]);
    });
});
