import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { returnToOf } from '../src/return-to.js';
import { LoginGate } from '../src/components/LoginGate.js';
import { AttachmentUploadPage } from '../src/pages/AttachmentUploadPage.js';
import { ThemeProvider } from '../src/theme.js';
import { renderAt, stubFetch } from './dom.js';

const CAP = `fcu_${'a'.repeat(43)}`;

/** The one boundary this page owns: an XMLHttpRequest the test answers by hand. */
class FakeXhr {
    static all: FakeXhr[] = [];
    method = '';
    url = '';
    headers: Record<string, string> = {};
    withCredentials = false;
    body: unknown;
    status = 0;
    responseText = '';
    upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = {
        onprogress: null,
    };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    constructor() {
        FakeXhr.all.push(this);
    }
    open(method: string, url: string) {
        this.method = method;
        this.url = url;
    }
    setRequestHeader(name: string, value: string) {
        this.headers[name.toLowerCase()] = value;
    }
    send(body: unknown) {
        this.body = body;
    }
    reply(status: number, body: unknown) {
        this.status = status;
        this.responseText = JSON.stringify(body);
        this.onload?.();
    }
}

afterEach(() => {
    FakeXhr.all = [];
    window.history.replaceState(null, '', '/');
});

function setup(hash = `#${CAP}`) {
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    window.history.replaceState(null, '', `/attachments/upload${hash}`);
    const calls = stubFetch(() => undefined);
    renderAt(
        <ThemeProvider>
            <AttachmentUploadPage />
        </ThemeProvider>,
        `/attachments/upload${hash}`
    );
    return { calls, user: userEvent.setup() };
}

const file = (name = 'spec sheet.pdf', body = 'hello') => new File([body], name, { type: 'application/pdf' });

async function pick(user: ReturnType<typeof userEvent.setup>, f: File) {
    await user.upload(screen.getByTestId('upload-input'), f);
}

describe('the attachment upload page', () => {
    it('reads the link from the fragment, clears the address bar and sends nothing to the board on load', async () => {
        const { calls } = setup();
        expect(await screen.findByRole('heading', { level: 1, name: 'Upload a file to Bellows' })).toBeTruthy();
        expect(window.location.hash).toBe('');
        expect(window.location.href).not.toContain(CAP);
        expect(calls).toHaveLength(0);
        expect(FakeXhr.all).toHaveLength(0);
    });

    it('PUTs the raw file to the link with the name header and no credentials, shows progress, then the id', async () => {
        const { user } = setup();
        const f = file();
        await pick(user, f);
        const xhr = FakeXhr.all[0] as FakeXhr;
        expect(xhr.method).toBe('PUT');
        expect(xhr.url).toBe(`/api/attachments/uploads/${CAP}`);
        expect(xhr.withCredentials).toBe(false);
        expect(xhr.body).toBe(f);
        expect(xhr.headers['content-type']).toBe('application/octet-stream');
        expect(xhr.headers['x-attachment-name']).toBe(encodeURIComponent('spec sheet.pdf'));
        xhr.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 5 });
        const bar = (await screen.findByLabelText('Upload progress')) as HTMLProgressElement;
        await waitFor(() => expect(bar.value).toBe(3));
        xhr.reply(201, { id: 'att-123', name: 'spec sheet.pdf', size: 5, state: 'ready' });
        expect(await screen.findByText('att-123')).toBeTruthy();
        expect(screen.getByText(/return to your app/i)).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    it.each([
        [410, 'UPLOAD_CAPABILITY_EXPIRED', /expired/],
        [409, 'UPLOAD_CAPABILITY_SPENT', /already used/],
        [404, 'UPLOAD_CAPABILITY_INVALID', /not valid.*revoked/],
    ] as const)('says a %i link plainly and offers no further upload', async (status, code, text) => {
        const { user } = setup();
        await pick(user, file());
        (FakeXhr.all.at(-1) as FakeXhr).reply(status, { error: 'x', code });
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(text);
        expect(screen.queryByTestId('upload-input')).toBeNull();
        expect(screen.queryByText(/return to your app/i)).toBeNull();
    });

    it('lets the member choose another file after a too-large or unsupported refusal', async () => {
        const { user } = setup();
        await pick(user, file());
        (FakeXhr.all[0] as FakeXhr).reply(413, { error: 'x', code: 'ATTACHMENT_TOO_LARGE' });
        expect((await screen.findByRole('alert')).textContent).toMatch(/larger than this link allows/);
        await pick(user, file('b.png'));
        (FakeXhr.all[1] as FakeXhr).reply(415, { error: 'x', code: 'ATTACHMENT_UNSUPPORTED' });
        await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/type of file/));
        expect(screen.getByTestId('upload-input')).toBeTruthy();
    });

    it('a network failure is retryable with the same file and never claims success', async () => {
        const { user } = setup();
        const f = file();
        await pick(user, f);
        (FakeXhr.all[0] as FakeXhr).onerror?.();
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toMatch(/did not finish/);
        expect(screen.queryByText(/return to your app/i)).toBeNull();
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        const second = FakeXhr.all[1] as FakeXhr;
        expect(second.body).toBe(f);
        second.reply(201, { id: 'att-9', name: 'spec sheet.pdf', size: 5, state: 'ready' });
        expect(await screen.findByText('att-9')).toBeTruthy();
    });

    it('refuses a multi-file drop with a visible one-file notice and uploads nothing', async () => {
        setup();
        const zone = document.querySelector('.upload-zone') as HTMLElement;
        fireEvent.drop(zone, { dataTransfer: { types: ['Files'], files: [file('a.pdf'), file('b.pdf')] } });
        expect((await screen.findByRole('alert')).textContent).toMatch(/one file/i);
        expect(FakeXhr.all).toHaveLength(0);
        expect(screen.getByTestId('upload-input')).toBeTruthy();
    });

    it('keeps one live region mounted across phases, announces progress and the result, and moves focus', async () => {
        const { user } = setup();
        const region = document.querySelector('[aria-live="polite"]') as HTMLElement;
        expect(region).toBeTruthy();
        await pick(user, file());
        await waitFor(() => expect(region.textContent).toMatch(/Uploading spec sheet\.pdf/));
        expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
        (FakeXhr.all[0] as FakeXhr).reply(201, { id: 'att-5', name: 'spec sheet.pdf', size: 5, state: 'ready' });
        await screen.findByText('att-5');
        expect(document.querySelector('[aria-live="polite"]')).toBe(region);
        expect(region.textContent).toMatch(/uploaded.*att-5/);
        expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }));
    });

    it('does not grab focus on load under StrictMode, only on a phase change', async () => {
        vi.stubGlobal('XMLHttpRequest', FakeXhr);
        window.history.replaceState(null, '', `/attachments/upload#${CAP}`);
        stubFetch(() => undefined);
        const router = createMemoryRouter(
            [
                {
                    path: '*',
                    element: (
                        <ThemeProvider>
                            <AttachmentUploadPage />
                        </ThemeProvider>
                    ),
                },
            ],
            { initialEntries: [`/attachments/upload#${CAP}`] }
        );
        render(<RouterProvider router={router} />, { reactStrictMode: true });
        await screen.findByRole('heading', { level: 1 });
        await act(async () => undefined);
        expect(document.activeElement).toBe(document.body);
        await userEvent.setup().upload(screen.getByTestId('upload-input'), file());
        await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 })));
    });

    it('a link-less visit says the link is incomplete', async () => {
        setup('');
        expect((await screen.findByRole('alert')).textContent).toMatch(/incomplete/);
        expect(screen.queryByTestId('upload-input')).toBeNull();
    });
});

describe('the login gate', () => {
    it.each(['/attachments/upload', '/attachments/upload/'])(
        'lets %s through signed out, without a session call, and never puts the link in a URL',
        async (path) => {
            const calls = stubFetch(() => undefined);
            window.history.replaceState(null, '', `${path}#${CAP}`);
            renderAt(
                <ThemeProvider>
                    <LoginGate>
                        <p>the page</p>
                    </LoginGate>
                </ThemeProvider>,
                `${path}#${CAP}`
            );
            expect(screen.getByText('the page')).toBeTruthy();
            expect(calls.filter((c) => c.url === '/api/auth/me')).toHaveLength(0);
            for (const a of document.querySelectorAll('[href]')) expect(a.getAttribute('href')).not.toContain('fcu_');
        }
    );

    it('agrees with the router on a percent-encoded path: the page renders, no session call', async () => {
        const calls = stubFetch(() => undefined);
        renderAt(
            <ThemeProvider>
                <LoginGate>
                    <p>the page</p>
                </LoginGate>
            </ThemeProvider>,
            `/attachments/%75pload#${CAP}`
        );
        expect(screen.getByText('the page')).toBeTruthy();
        expect(calls.filter((c) => c.url === '/api/auth/me')).toHaveLength(0);
    });

    it('never forwards a link fragment into the sign-in returnTo of any other page', async () => {
        stubFetch(({ url }) => (url === '/api/auth/me' ? { authenticated: false } : undefined));
        window.history.replaceState(null, '', `/tasks#${CAP}`);
        renderAt(
            <ThemeProvider>
                <LoginGate>
                    <p>the page</p>
                </LoginGate>
            </ThemeProvider>,
            `/tasks#${CAP}`
        );
        const link = await screen.findByRole('link', { name: 'Sign in with GitHub' });
        expect(link.getAttribute('href')).not.toContain('fcu_');
        expect(link.getAttribute('href')).toBe('/api/auth/github?returnTo=%2Ftasks');
    });

    it('lets the upload page through with no session', async () => {
        stubFetch(({ url }) => (url === '/api/auth/me' ? { authenticated: false } : undefined));
        window.history.replaceState(null, '', `/attachments/upload#${CAP}`);
        renderAt(
            <ThemeProvider>
                <LoginGate>
                    <p>the page</p>
                </LoginGate>
            </ThemeProvider>,
            '/attachments/upload'
        );
        expect(await screen.findByText('the page')).toBeTruthy();
        expect(within(document.body).queryByRole('link', { name: 'Sign in with GitHub' })).toBeNull();
    });
});

describe('returnToOf', () => {
    it('keeps a path and an ordinary fragment, and drops any capability fragment', () => {
        expect(returnToOf('/tasks', '#x=1')).toBe('/tasks#x=1');
        expect(returnToOf('/attachments/upload/', `#${CAP}`)).toBe('/attachments/upload/');
        expect(returnToOf('/anything', `#${CAP}`)).toBe('/anything');
        expect(returnToOf('/anything', `#a=1&b=${CAP}`)).toBe('/anything');
    });
});
