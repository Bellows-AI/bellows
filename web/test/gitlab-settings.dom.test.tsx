import { ADMIN_ROLE, MEMBER_ROLE, type Role } from '@factory-ai/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { GitlabConnectionView, GitlabProjectView } from '../src/api/gitlab.js';
import { type FetchCall, type FetchReply, renderApp, stubFetch } from './dom.js';
import { boardHandler, settingsBoard } from './settings-board.js';

/** Settings → Integrations → GitLab, mounted on its real route over a stubbed board (docs/gitlab.md). */

const PATH = '/settings/integrations/gitlab';
const ID = '11111111-1111-4111-8111-111111111111';
const AUTHORIZE = 'https://gitlab.example.test/oauth/authorize?state=stub';

const connection = (overrides: Partial<GitlabConnectionView> = {}): GitlabConnectionView => ({
    id: ID,
    host: 'gitlab.example.test',
    clientId: 'app-1',
    allowedGroups: ['acme'],
    hasCaBundle: false,
    active: false,
    version: null,
    activationRefusal: null,
    probe: { status: 'reachable', reason: null, at: '2026-09-01T00:00:00.000Z' },
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
});

const project = (path: string, overrides: Partial<GitlabProjectView> = {}): GitlabProjectView => ({
    path,
    defaultBranch: 'main',
    tracked: false,
    listed: true,
    ...overrides,
});

interface Gitlab {
    role?: Role;
    connections?: GitlabConnectionView[];
    standings?: { id: string; host: string; standing: 'live' | 'broken' | 'missing' }[];
    reply?: (call: FetchCall) => FetchReply | undefined;
}

/** The board's routes plus the GitLab ones; `reply` answers a test's own request first. */
function board({ role = ADMIN_ROLE, connections = [], standings = [], reply = () => undefined }: Gitlab = {}) {
    return stubFetch(
        boardHandler(settingsBoard({ role }), (call) => {
            const own = reply(call);
            if (own !== undefined) return own;
            if (call.method === 'GET' && call.url === '/api/org/gitlab-connections') return { connections };
            if (call.method === 'GET' && call.url === '/api/forge-grants/gitlab') return { connections: standings };
        })
    );
}

/** jsdom cannot navigate; `window.location.assign` is replaced by a spy for the test. */
function spyNavigation() {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    return assign;
}

const fill = async (label: string, text: string) => userEvent.setup().type(await screen.findByLabelText(label), text);

describe('the admin connect form', () => {
    it('posts the typed application and shows the stored pending connection', async () => {
        const created = connection();
        let stored: GitlabConnectionView[] = [];
        const calls = board({
            reply: (call) => {
                if (call.method === 'GET' && call.url === '/api/org/gitlab-connections') return { connections: stored };
                if (call.method === 'POST' && call.url === '/api/org/gitlab-connections') {
                    stored = [created];
                    return { status: 201, body: created };
                }
            },
        });
        renderApp(PATH);
        await fill('GitLab host', 'GitLab.Example.test');
        await fill('OAuth application ID', 'app-1');
        await fill('OAuth application secret', 's3cret');
        await fill('Allowed root groups', 'acme, platform');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Connect GitLab' }));

        const row = await screen.findByRole('region', { name: 'gitlab.example.test' });
        expect(within(row).getByText('Pending')).toBeTruthy();
        const post = calls.find((c) => c.method === 'POST');
        expect(post?.body).toEqual({
            host: 'GitLab.Example.test',
            clientId: 'app-1',
            clientSecret: 's3cret',
            allowedGroups: ['acme', 'platform'],
        });
    });

    it('shows the refusal sentence and keeps what was typed', async () => {
        board({
            reply: (call) =>
                call.method === 'POST'
                    ? {
                          status: 409,
                          body: {
                              error: 'This organization already connects that GitLab host',
                              code: 'GITLAB_CONNECTION_EXISTS',
                          },
                      }
                    : undefined,
        });
        renderApp(PATH);
        await fill('GitLab host', 'gitlab.example.test');
        await fill('OAuth application ID', 'app-1');
        await fill('OAuth application secret', 's');
        await fill('Allowed root groups', 'acme');
        await userEvent.setup().click(screen.getByRole('button', { name: 'Connect GitLab' }));

        expect((await screen.findByRole('alert')).textContent).toContain('already connects that GitLab host');
        expect((screen.getByLabelText('GitLab host') as HTMLInputElement).value).toBe('gitlab.example.test');
    });

    it('is not shown to a member', async () => {
        board({ role: MEMBER_ROLE });
        renderApp(PATH);
        await screen.findByRole('heading', { level: 1, name: 'GitLab' });
        expect(screen.queryByLabelText('GitLab host')).toBeNull();
    });
});

describe('a connection the admin sees', () => {
    it('says why activation refused an old version', async () => {
        board({ connections: [connection({ version: '16.11.2', activationRefusal: 'version-too-old' })] });
        renderApp(PATH);
        const row = await screen.findByRole('region', { name: 'gitlab.example.test' });
        expect(row.textContent).toMatch(/16\.11\.2.*older than 17\.0/);
    });

    it('says an unreachable probe is not a refusal', async () => {
        board({
            connections: [
                connection({ probe: { status: 'unreachable', reason: 'timeout', at: '2026-09-01T00:00:00.000Z' } }),
            ],
        });
        renderApp(PATH);
        const row = await screen.findByRole('region', { name: 'gitlab.example.test' });
        expect(row.textContent).toMatch(/could not reach.*timeout/i);
    });

    it('Activate starts the admin consent and leaves for GitLab', async () => {
        const assign = spyNavigation();
        const calls = board({
            connections: [connection()],
            reply: (call) =>
                call.method === 'POST' && call.url === `/api/org/gitlab-connections/${ID}/activation`
                    ? { status: 201, body: { authorizeUrl: AUTHORIZE, expiresAt: 't' } }
                    : undefined,
        });
        renderApp(PATH);
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Activate' }));
        await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE));
        expect(calls.find((c) => c.url.endsWith('/activation'))?.body).toEqual({ returnTo: PATH });
    });

    it('Remove confirms, deletes and drops the row', async () => {
        let stored = [connection()];
        const calls = board({
            reply: (call) => {
                if (call.method === 'GET' && call.url === '/api/org/gitlab-connections') return { connections: stored };
                if (call.method === 'DELETE') {
                    stored = [];
                    return { ok: true };
                }
            },
        });
        renderApp(PATH);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Remove' }));
        await user.click(await screen.findByRole('button', { name: 'Remove connection' }));
        await waitFor(() => expect(screen.queryByRole('region', { name: 'gitlab.example.test' })).toBeNull());
        expect(calls.some((c) => c.method === 'DELETE' && c.url === `/api/org/gitlab-connections/${ID}`)).toBe(true);
    });
});

describe('tracking projects', () => {
    const active = connection({ active: true, version: '17.2.0' });

    it('a 503 says the list could not be read, offers a retry, and never reads as an empty list', async () => {
        let attempt = 0;
        board({
            connections: [active],
            reply: (call) => {
                if (!call.url.endsWith('/projects')) return;
                attempt += 1;
                return attempt === 1
                    ? { status: 503, body: { error: 'raw', code: 'UNAVAILABLE' } }
                    : { projects: [project('acme/api')] };
            },
        });
        renderApp(PATH);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Load projects' }));
        expect((await screen.findByRole('alert')).textContent).toMatch(/could not list/i);
        expect(screen.queryByText(/no projects/i)).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByRole('checkbox', { name: 'acme/api' })).toBeTruthy();
    });

    it('shows a tracked path the listing lacks, saves the selection and words a path collision', async () => {
        const calls = board({
            connections: [active],
            reply: (call) => {
                if (call.url.endsWith('/projects')) {
                    return {
                        projects: [
                            project('acme/api', { tracked: true }),
                            project('acme/web'),
                            project('acme/old', { tracked: true, listed: false, defaultBranch: null }),
                        ],
                    };
                }
                if (call.method === 'PUT') {
                    return {
                        status: 409,
                        body: {
                            error: '"acme/web" is already tracked under another forge',
                            code: 'TRACKED_PATH_CONFLICT',
                        },
                    };
                }
            },
        });
        renderApp(PATH);
        const user = userEvent.setup();
        await user.click(await screen.findByRole('button', { name: 'Load projects' }));
        const old = await screen.findByRole('checkbox', { name: 'acme/old' });
        expect((old as HTMLInputElement).checked).toBe(true);
        expect(screen.getByText(/no longer listed/i)).toBeTruthy();
        await user.click(screen.getByRole('checkbox', { name: 'acme/web' }));
        await user.click(screen.getByRole('button', { name: 'Save tracked projects' }));

        expect((await screen.findByRole('alert')).textContent).toContain('already tracked under another forge');
        const put = calls.find((c) => c.method === 'PUT');
        expect(put?.url).toBe(`/api/org/gitlab-connections/${ID}/tracked-repos`);
        expect(put?.body).toEqual({ paths: ['acme/api', 'acme/old', 'acme/web'] });
    });
});

describe('the member link', () => {
    const standing = (value: 'live' | 'broken' | 'missing') => ({
        id: ID,
        host: 'gitlab.example.test',
        standing: value,
    });

    it('Link starts the member consent and leaves for GitLab', async () => {
        const assign = spyNavigation();
        const calls = board({
            role: MEMBER_ROLE,
            standings: [standing('missing')],
            reply: (call) =>
                call.method === 'POST' && call.url === `/api/forge-grants/gitlab/${ID}/link`
                    ? { status: 201, body: { authorizeUrl: AUTHORIZE, expiresAt: 't' } }
                    : undefined,
        });
        renderApp(PATH);
        const row = await screen.findByRole('region', { name: 'Your account on gitlab.example.test' });
        expect(within(row).getByText('Not linked')).toBeTruthy();
        await userEvent.setup().click(within(row).getByRole('button', { name: 'Link GitLab account' }));
        await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTHORIZE));
        expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ returnTo: PATH });
    });

    it('a broken grant says Needs reconnect and offers Reconnect', async () => {
        board({ role: MEMBER_ROLE, standings: [standing('broken')] });
        renderApp(PATH);
        const row = await screen.findByRole('region', { name: 'Your account on gitlab.example.test' });
        expect(within(row).getByText('Needs reconnect')).toBeTruthy();
        expect(within(row).getByRole('button', { name: 'Reconnect GitLab account' })).toBeTruthy();
    });

    it('a live grant says Linked and offers no link', async () => {
        board({ role: MEMBER_ROLE, standings: [standing('live')] });
        renderApp(PATH);
        const row = await screen.findByRole('region', { name: 'Your account on gitlab.example.test' });
        expect(within(row).getByText('Linked')).toBeTruthy();
        expect(within(row).queryByRole('button')).toBeNull();
    });

    it('a failed read is an alert, never "no connections"', async () => {
        board({
            role: MEMBER_ROLE,
            reply: (call) =>
                call.url === '/api/forge-grants/gitlab'
                    ? { status: 503, body: { error: 'database is down' } }
                    : undefined,
        });
        renderApp(PATH);
        expect((await screen.findByRole('alert')).textContent).toContain('database is down');
        expect(screen.queryByText(/no gitlab/i)).toBeNull();
    });

    it('words the callback result', async () => {
        board({ role: MEMBER_ROLE, standings: [standing('live')] });
        renderApp(`${PATH}?integration=gitlab&result=linked`);
        expect(await screen.findByText('GitLab account linked.')).toBeTruthy();
    });
});
