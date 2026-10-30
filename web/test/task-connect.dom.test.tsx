import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
    authoredBy,
    heldThread,
    LOCAL_AUTHOR,
    mockedActivityOf,
    requirement,
    type ThreadJob,
    type ThreadRequirement,
} from '../../e2e/fixtures/threads.js';
import { type FetchCall, OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';

const CONSENT_URL = 'https://auth.example.test/authorize?state=stub';
const CONN_A = '44444444-4444-4444-8444-444444444444';
const CONN_B = '55555555-5555-4555-8555-555555555555';
const conn = (id: string, provider: string, site: string) => ({
    id,
    provider,
    site,
    account: `${site}-account@example.test`,
    access: 'read',
    status: 'active',
    createdAt: '2026-08-01T00:00:00.000Z',
});

interface Board {
    jobs: ThreadJob[];
    connections?: unknown;
    reply?: (call: FetchCall) => unknown;
}

/** The task page's reads answered from `jobs`; `reply` answers the block's own requests first. */
function board({ jobs, connections = [], reply = () => undefined }: Board) {
    return stubFetch((call) => {
        const own = reply(call);
        if (own !== undefined) return own;
        if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (call.url === '/api/connections') return typeof connections === 'function' ? connections() : { connections };
        if (/\/api\/jobs\/[^/]+\/thread/.test(call.url)) return { jobs };
        if (/\/api\/jobs\/[^/]+\/activity/.test(call.url)) return mockedActivityOf(jobs);
    });
}

const held = (...open: ThreadRequirement[]) => authoredBy(heldThread(...open), LOCAL_AUTHOR);
const open = (jobs: ThreadJob[]) => renderApp(`/tasks/${jobs[0]!.id}`);
const block = (name: RegExp) => screen.findByRole('region', { name });

/** jsdom cannot navigate; `window.location.assign` is replaced by a spy for the test. */
function spyNavigation() {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    return assign;
}

describe('the Connect block on the task page', () => {
    it('Connect starts the provider authorization with the job and returns to the task', async () => {
        const jobs = held(requirement());
        const assign = spyNavigation();
        const calls = board({
            jobs,
            reply: (c) =>
                c.method === 'POST' && c.url === '/api/integrations/jira/authorizations'
                    ? { status: 201, body: { authorizeUrl: CONSENT_URL } }
                    : undefined,
        });
        open(jobs);
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Connect Jira' }));
        await waitFor(() => expect(assign).toHaveBeenCalledWith(CONSENT_URL));
        const start = calls.find((c) => c.url === '/api/integrations/jira/authorizations');
        expect(start?.body).toEqual({ jobId: jobs[0]!.id, returnTo: `/tasks/${jobs[0]!.id}` });
    });

    it('Reconnect sends the connection id of the reconnect requirement', async () => {
        const jobs = held(requirement({ reason: 'reconnect', connectionId: CONN_A }));
        spyNavigation();
        const calls = board({
            jobs,
            reply: (c) =>
                c.method === 'POST' && c.url.endsWith('/authorizations')
                    ? { status: 201, body: { authorizeUrl: CONSENT_URL } }
                    : undefined,
        });
        open(jobs);
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Reconnect Jira' }));
        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/authorizations'))).toBe(true));
        expect(calls.find((c) => c.url.endsWith('/authorizations'))?.body).toMatchObject({ connectionId: CONN_A });
    });

    it("ambiguous: lists only this provider's connections and Use posts the binding revision", async () => {
        const jobs = held(requirement({ reason: 'ambiguous' })).map((j) => ({ ...j, bindingRevision: 3 }));
        const calls = board({
            jobs,
            connections: [
                conn(CONN_A, 'jira', 'one.example.test'),
                conn(CONN_B, 'jira', 'two.example.test'),
                conn('x', 'acme', 'other.example.test'),
            ],
            reply: (c) =>
                c.method === 'POST' && c.url === `/api/jobs/${jobs[0]!.id}/connections`
                    ? { bindingRevision: 4 }
                    : undefined,
        });
        open(jobs);
        const user = userEvent.setup();
        const group = await block(/Jira connection needed/);
        expect(within(group).queryByText(/other\.example\.test/)).toBeNull();
        await user.click(await within(group).findByRole('radio', { name: /two\.example\.test/ }));
        await user.click(within(group).getByRole('button', { name: 'Use selected connection' }));
        await waitFor(() =>
            expect(calls.find((c) => c.url.endsWith('/connections') && c.method === 'POST')?.body).toEqual({
                connectionId: CONN_B,
                bindingRevision: 3,
            })
        );
    });

    it('Continue without it posts the dismiss and re-reads the thread', async () => {
        const jobs = held(requirement());
        const calls = board({
            jobs,
            reply: (c) =>
                c.method === 'POST' && c.url === `/api/jobs/${jobs[0]!.id}/requirements/jira/dismiss` ? {} : undefined,
        });
        open(jobs);
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue without it' }));
        await waitFor(() => expect(calls.some((c) => c.url.endsWith('/requirements/jira/dismiss'))).toBe(true));
        const threadReads = () => calls.filter((c) => /\/thread/.test(c.url)).length;
        await waitFor(() => expect(threadReads()).toBeGreaterThan(1));
    });

    it('a refused dismiss renders the refusal and keeps the block', async () => {
        const jobs = held(requirement());
        board({
            jobs,
            reply: (c) =>
                c.url.endsWith('/dismiss')
                    ? {
                          status: 409,
                          body: { error: 'No open requirement for that provider', code: 'NO_OPEN_REQUIREMENT' },
                      }
                    : undefined,
        });
        open(jobs);
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Continue without it' }));
        expect(await screen.findByText(/No open requirement for that provider/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Connect Jira' })).toBeTruthy();
    });

    it('a failed connections read shows the error, not an empty list', async () => {
        const jobs = held(requirement({ reason: 'ambiguous' }));
        board({ jobs, connections: () => ({ status: 500, body: { error: 'database down' } }) });
        open(jobs);
        expect(await screen.findByText(/database down/)).toBeTruthy();
        expect(screen.queryByRole('radio')).toBeNull();
    });

    it('another member sees the block read-only, naming the execution user', async () => {
        const owner = { ...LOCAL_AUTHOR, id: 'cccccccc-0000-4000-8000-000000000009', name: 'Octo Owner' };
        const jobs = authoredBy(heldThread(requirement()), owner);
        board({ jobs });
        open(jobs);
        expect(await screen.findByText(/Waiting for Octo Owner/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /Connect Jira|Continue without it/ })).toBeNull();
    });

    it('a second provider renders one block of its own through the same component', async () => {
        const jobs = held(requirement(), requirement({ provider: 'acme', label: 'Acme', source: 'create' }));
        board({ jobs });
        open(jobs);
        expect(await screen.findByRole('button', { name: 'Connect Jira' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Connect Acme' })).toBeTruthy();
    });
});
