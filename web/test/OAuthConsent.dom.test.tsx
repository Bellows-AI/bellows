import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { OAuthConsentPage } from '../src/pages/OAuthConsentPage.js';
import { ThemeProvider } from '../src/theme.js';
import { renderAt, stubFetch, type FetchCall } from './dom.js';

const Page = ({ navigate }: { navigate: (url: string) => void }) => (
    <ThemeProvider>
        <OAuthConsentPage navigate={navigate} />
    </ThemeProvider>
);
const TX = '#id=tx-1&csrf=csrf-1';
const request = (overrides: Record<string, unknown> = {}) => ({
    client: { id: 'dcr_abc', kind: 'dcr', name: 'Totally Official Bank', uri: null },
    scopes: ['factory:read'],
    resource: 'https://board.example.test/api/mcp',
    redirectUri: 'https://app.example.test/callback',
    organization: { id: 'o1', name: 'acme' },
    organizations: [
        { id: 'o1', name: 'acme' },
        { id: 'o2', name: 'beta' },
    ],
    user: { login: 'alice' },
    ...overrides,
});

function setup(consent: unknown, decision?: (call: FetchCall) => unknown) {
    const navigate = vi.fn();
    const calls = stubFetch((call) => {
        if (call.url.startsWith('/api/oauth/consent/tx-1')) return consent;
        if (call.url.startsWith('/api/oauth/consent/') && decision) return decision(call);
    });
    renderAt(<Page navigate={navigate} />, `/oauth/consent${TX}`);
    return { navigate, calls, user: userEvent.setup() };
}

describe('the consent screen', () => {
    it('names the app, what it asks for and where the browser returns, with Allow and Deny side by side', async () => {
        setup(request());
        expect(await screen.findByRole('heading', { level: 1, name: 'Connect an app to Bellows' })).toBeTruthy();
        expect(screen.getAllByText('Totally Official Bank').length).toBeGreaterThan(0);
        expect(screen.getByText(/unverified/i)).toBeTruthy();
        expect(screen.getByText(/Read tasks/)).toBeTruthy();
        expect(screen.getByText('app.example.test')).toBeTruthy();
        const allow = screen.getByRole('button', { name: 'Allow' });
        const deny = screen.getByRole('button', { name: 'Deny' });
        // Declining is as prominent as agreeing: the same class, neither the accent action.
        expect(deny.className).toBe(allow.className);
        expect(allow.className).not.toContain('primary');
    });

    it('identifies a metadata-document client by its URL host, not by the name it claims', async () => {
        setup(
            request({
                client: { id: 'https://agent.example.test/client.json', kind: 'cimd', name: 'Trusted Corp', uri: null },
            })
        );
        await screen.findByRole('button', { name: 'Allow' });
        expect(screen.getAllByText('agent.example.test').length).toBeGreaterThan(0);
        expect(screen.queryByText(/unverified/i)).toBeNull();
        expect(screen.getByText(/metadata document at https:\/\/agent\.example\.test\/client\.json/)).toBeTruthy();
    });

    it('approves with a fetch POST of id, csrf and the session org, then navigates to the returned redirect', async () => {
        const { navigate, calls, user } = setup(request(), () => ({
            redirect: 'https://app.example.test/callback?code=c1',
        }));
        await user.click(await screen.findByRole('button', { name: 'Allow' }));
        await waitFor(() => expect(navigate).toHaveBeenCalledWith('https://app.example.test/callback?code=c1'));
        const post = calls.find((call) => call.method === 'POST');
        expect(post?.url).toBe('/api/oauth/consent/approve');
        expect(post?.body).toEqual({ id: 'tx-1', csrf: 'csrf-1', orgId: 'o1' });
    });

    it('denies through the deny route and follows its redirect', async () => {
        const { navigate, calls, user } = setup(request(), () => ({
            redirect: 'https://app.example.test/callback?error=access_denied',
        }));
        await user.click(await screen.findByRole('button', { name: 'Deny' }));
        await waitFor(() =>
            expect(navigate).toHaveBeenCalledWith('https://app.example.test/callback?error=access_denied')
        );
        expect(calls.find((call) => call.method === 'POST')?.url).toBe('/api/oauth/consent/deny');
    });

    it('says the request is no longer valid when the server has none, and offers no Allow', async () => {
        setup({ status: 404, body: { error: 'No such authorization request' } });
        expect((await screen.findByRole('alert')).textContent).toMatch(/no longer valid/);
        expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    });

    it('treats a missing fragment as an invalid request without asking the server', async () => {
        const calls = stubFetch(() => undefined);
        renderAt(<Page navigate={vi.fn()} />, '/oauth/consent');
        expect((await screen.findByRole('alert')).textContent).toMatch(/no longer valid/);
        expect(calls).toEqual([]);
    });

    it('shows a failed read as an error, never as an empty request', async () => {
        setup({ status: 503, body: { error: 'Try again shortly.' } });
        expect((await screen.findByRole('alert')).textContent).toBe('Try again shortly.');
        expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
    });

    it('re-reads the transaction after a refused decision and shows that it is gone', async () => {
        let reads = 0;
        const calls = stubFetch((call) => {
            if (call.url === '/api/oauth/consent/tx-1') return ++reads === 1 ? request() : { status: 404 };
            return { status: 400, body: { error: 'This authorization request is no longer valid.' } };
        });
        const navigate = vi.fn();
        renderAt(<Page navigate={navigate} />, `/oauth/consent${TX}`);
        await userEvent.setup().click(await screen.findByRole('button', { name: 'Allow' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull());
        expect(screen.getAllByRole('alert')[0]?.textContent).toMatch(/no longer valid/);
        expect(calls.filter((call) => call.method === 'GET')).toHaveLength(2);
        expect(navigate).not.toHaveBeenCalled();
    });

    it('lets the member pick which of their orgs the grant is for, defaulting to the signed-in one', async () => {
        const { calls, user } = setup(request(), () => ({ redirect: 'https://app.example.test/callback?code=c1' }));
        const picker = (await screen.findByRole('combobox', { name: /organization/i })) as HTMLSelectElement;
        expect(picker.value).toBe('o1');
        await user.selectOptions(picker, 'o2');
        await user.click(screen.getByRole('button', { name: 'Allow' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
        expect(calls.find((call) => call.method === 'POST')?.body).toEqual({ id: 'tx-1', csrf: 'csrf-1', orgId: 'o2' });
    });

    it('drops the transaction from the address bar once it has been read', async () => {
        const replace = vi.spyOn(window.history, 'replaceState');
        setup(request());
        await screen.findByRole('button', { name: 'Allow' });
        const urls = replace.mock.calls.map((call) => String(call[2]));
        expect(urls.length).toBeGreaterThan(0);
        expect(urls.every((url) => !url.includes('#'))).toBe(true);
        replace.mockRestore();
    });

    it('shows the name a metadata client claims as a claim, beside the host that was verified', async () => {
        setup(
            request({
                client: { id: 'https://agent.example.test/client.json', kind: 'cimd', name: 'Trusted Corp', uri: null },
            })
        );
        await screen.findByRole('button', { name: 'Allow' });
        expect(screen.getByText(/calls itself .*Trusted Corp/i)).toBeTruthy();
    });

    it("shows an app's own redirect scheme with its full address, never as a web host", async () => {
        setup(request({ redirectUri: 'myapp://evil.example/cb' }));
        await screen.findByRole('button', { name: 'Allow' });
        expect(screen.getByText(/myapp:\/\/evil\.example\/cb/)).toBeTruthy();
        expect(screen.queryByText('evil.example')).toBeNull();
    });
});
