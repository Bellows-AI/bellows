import { describe, expect, it } from 'vitest';
import { createMembershipReader, type MembershipTarget } from '../src/auth/membership.js';
import { FAKE_GITHUB_API, fakeGitHubMembers, type MembershipAnswer } from './helpers-github-members.js';

const ORG_ID = 4242;
const USER_ID = 7001;

const target = (overrides: Partial<MembershipTarget['org']> = {}, login = 'octocat'): MembershipTarget => ({
    org: { id: '99001', login: 'acme', accountType: 'Organization', accountId: ORG_ID, ...overrides },
    user: { githubUserId: USER_ID, login },
});

const rig = (budgetMs = 1_000) => {
    const github = fakeGitHubMembers();
    github.orgs.set('acme', ORG_ID);
    github.users.set(USER_ID, 'octocat');
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
    return { github, reader, tokens };
};

describe('the GitHub membership read', () => {
    it('reads an active admin as an owner and an active member as a member, with the org installation token', async () => {
        const { github, reader, tokens } = rig();
        github.answer('acme', 'octocat', 'admin');
        expect(await reader.read(target())).toEqual({ kind: 'active', owner: true });
        github.answer('acme', 'octocat', 'member');
        expect(await reader.read(target())).toEqual({ kind: 'active', owner: false });
        expect(tokens).toEqual(['99001', '99001']);
    });

    it('reads a 404 as not a member only once the org and the user are confirmed to be who was asked about', async () => {
        const { github, reader } = rig();
        expect(await reader.read(target())).toEqual({ kind: 'not-member' });
        expect(github.calls).toEqual(['/orgs/acme/memberships/octocat', '/orgs/acme', `/user/${USER_ID}`]);
    });

    it('reads a pending invitation as not a member', async () => {
        const { github, reader } = rig();
        github.answer('acme', 'octocat', 'pending');
        expect(await reader.read(target())).toEqual({ kind: 'not-member' });
    });

    it('re-asks under the current login when the user was renamed, and trusts only that answer', async () => {
        const { github, reader } = rig();
        github.users.set(USER_ID, 'octo-renamed');
        github.answer('acme', 'octo-renamed', 'member');
        expect(await reader.read(target())).toEqual({ kind: 'active', owner: false });
    });

    it('never applies an answer about another account holding the old login: it re-asks under the current one', async () => {
        const { github, reader } = rig();
        // The account was renamed; a stranger now holds `octocat` and owns the org.
        github.users.set(USER_ID, 'octo-renamed');
        github.answer('acme', 'octocat', 'admin');
        expect(await reader.read(target())).toEqual({ kind: 'not-member' });
        github.answer('acme', 'octo-renamed', 'member');
        expect(await reader.read(target())).toEqual({ kind: 'active', owner: false });
    });

    it('never applies an answer about another organization holding the org login', async () => {
        const { github, reader } = rig();
        github.orgs.set('acme', ORG_ID + 1);
        github.answer('acme', 'octocat', 'admin');
        expect((await reader.read(target())).kind).toBe('unknown');
    });

    it.each<[string, string]>([
        ['no user id', '{"state":"active","role":"admin","organization":{"id":4242}}'],
        ['no organization id', '{"state":"active","role":"admin","user":{"id":7001}}'],
    ])('reads a 200 with %s as unknown', async (_, body) => {
        const { github, reader } = rig();
        github.answer('acme', 'octocat', { status: 200, body });
        expect((await reader.read(target())).kind).toBe('unknown');
    });

    it.each<[string, (github: ReturnType<typeof rig>['github']) => void]>([
        ['the org login now names another organization', (github) => github.orgs.set('acme', ORG_ID + 1)],
        ['the org login is gone (a rename)', (github) => github.orgs.delete('acme')],
        ['the user id no longer resolves', (github) => github.users.delete(USER_ID)],
    ])('never reads a 404 as not a member when %s', async (_, mutate) => {
        const { github, reader } = rig();
        mutate(github);
        expect((await reader.read(target())).kind).toBe('unknown');
    });

    it.each<[string, MembershipAnswer]>([
        ['a missing members:read permission (403)', { status: 403, body: '{"message":"Resource not accessible"}' }],
        ['a server error', { status: 502, body: 'bad gateway' }],
        ['a rate limit', { status: 429, body: '{}' }],
        ['a malformed body', { status: 200, body: 'not json' }],
        ['an unexpected shape', { status: 200, body: '{"state":"active"}' }],
        ['an unknown state', { status: 200, body: '{"state":"gone","role":"member"}' }],
        ['a transport failure', 'throw'],
        ['a request past the budget', 'hang'],
    ])('reads %s as unknown, never as a verdict', async (_, answer) => {
        const { github, reader } = rig(50);
        github.answer('acme', 'octocat', answer);
        expect((await reader.read(target())).kind).toBe('unknown');
    });

    it('reads unknown when no installation token can be minted', async () => {
        const github = fakeGitHubMembers();
        const reader = createMembershipReader({
            apiUrl: FAKE_GITHUB_API,
            tokenFor: () => Promise.reject(new Error('mint failed')),
            fetchFn: github.fetchFn,
        });
        expect((await reader.read(target())).kind).toBe('unknown');
        expect(github.calls).toEqual([]);
    });

    it('takes a user-account installation’s account as its owner, and asks GitHub nothing', async () => {
        const { github, reader } = rig();
        const account = target({ accountType: 'User', accountId: USER_ID });
        expect(await reader.read(account)).toEqual({ kind: 'active', owner: true });
        const other = target({ accountType: 'User', accountId: USER_ID + 1 });
        expect((await reader.read(other)).kind).toBe('unknown');
        expect(github.calls).toEqual([]);
    });

    it('reads an installation whose account kind is not recorded as unknown', async () => {
        const { github, reader } = rig();
        expect((await reader.read(target({ accountType: null, accountId: null }))).kind).toBe('unknown');
        expect(github.calls).toEqual([]);
    });
});
