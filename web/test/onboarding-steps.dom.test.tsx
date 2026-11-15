import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { Session } from '../src/api/useSession.js';
import { renderApp, stubFetch, type FetchCall } from './dom.js';
import { memberSession } from './fixtures.js';

/**
 * The setup walk after sign-in: an unfinished member is sent from any app route to the
 * first open step, carrying where they were going; the placeholder steps record a skip, re-read
 * `/api/auth/me` and only then move on; Ready completes setup and returns to the path it carried.
 */

afterEach(() => {
    window.history.replaceState(null, '', '/');
});

type Setup = Session['setup'];
const open = (over: Partial<Setup> = {}): Setup => ({ completed: false, done: [], skipped: [], ...over });

/** Answers `/api/auth/me` with `setup()` read at call time; every other read 404s. */
function board(setup: () => Setup | undefined, extra: (call: FetchCall) => unknown = () => undefined) {
    return stubFetch((call) => {
        if (call.url === '/api/auth/me') return memberSession({ setup: setup() as Setup });
        return extra(call);
    });
}

const at = (router: ReturnType<typeof renderApp>['router']) =>
    `${router.state.location.pathname}${router.state.location.search}`;

/** Lets the session read land and any redirect it triggers run. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));

describe('the first-sign-in redirect', () => {
    it('sends an unfinished member from an app route to the model step, carrying the path', async () => {
        board(() => open());
        const { router } = renderApp('/tasks');
        await waitFor(() => expect(at(router)).toBe('/onboarding/model?returnTo=%2Ftasks'));
    });

    it('sends the single-installation callback landing on / to the model step too', async () => {
        board(() => open());
        const { router } = renderApp('/');
        await waitFor(() => expect(at(router)).toBe('/onboarding/model?returnTo=%2F'));
    });

    it('resumes at the first open step', async () => {
        board(() => open({ skipped: ['model'] }));
        const tools = renderApp('/tasks');
        await waitFor(() => expect(at(tools.router)).toBe('/onboarding/tools?returnTo=%2Ftasks'));
        tools.unmount();

        board(() => open({ done: ['model'], skipped: ['tools'] }));
        const ready = renderApp('/settings');
        await waitFor(() => expect(at(ready.router)).toBe('/onboarding/ready?returnTo=%2Fsettings'));
    });

    it('leaves a completed member where they are', async () => {
        board(() => open({ completed: true }));
        const { router, container } = renderApp('/tasks');
        await waitFor(() => expect(container.querySelector('.sidenav')).not.toBeNull());
        await settle();
        expect(at(router)).toBe('/tasks');
    });

    it('never redirects on the open board (AUTH_MODE=none)', async () => {
        stubFetch(({ url }) => (url === '/api/auth/me' ? memberSession({ mode: 'none', setup: open() }) : undefined));
        const { router, container } = renderApp('/tasks');
        await waitFor(() => expect(container.querySelector('.sidenav')).not.toBeNull());
        await settle();
        expect(at(router)).toBe('/tasks');
    });

    it('does not redirect on an unconfirmed read: no setup in /me, or no answer at all', async () => {
        board(() => undefined);
        const missing = renderApp('/tasks');
        await waitFor(() => expect(missing.container.querySelector('.sidenav')).not.toBeNull());
        await settle();
        expect(at(missing.router)).toBe('/tasks');
        missing.unmount();

        stubFetch(({ url }) => (url === '/api/auth/me' ? { status: 500 } : undefined));
        const failed = renderApp('/tasks');
        await waitFor(() => expect(failed.container.querySelector('.sidenav')).not.toBeNull());
        await settle();
        expect(at(failed.router)).toBe('/tasks');
    });

    for (const path of ['/oauth/consent', '/attachments/upload']) {
        it(`never redirects ${path}`, async () => {
            board(() => open());
            const { router } = renderApp(path);
            await settle();
            await settle();
            expect(router.state.location.pathname).toBe(path);
        });
    }
});

/** A held `/api/auth/me` answer: the test decides when the re-read lands. */
function held() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { gate, release: () => release() };
}

describe('the placeholder steps', () => {
    it('Skip for now records the skip, re-reads /me, and only then moves to the next step', async () => {
        let setup = open();
        const reread = held();
        let posted = false;
        const calls = stubFetch((call) => {
            if (call.url === '/api/onboarding/setup' && call.method === 'POST') {
                posted = true;
                setup = open({ skipped: ['model'] });
                return { status: 204 };
            }
            if (call.url === '/api/auth/me') {
                const answer = memberSession({ setup });
                return posted ? reread.gate.then(() => answer) : answer;
            }
        });
        const user = userEvent.setup();
        const { router } = renderApp('/onboarding/model?returnTo=%2Ftasks');

        expect(screen.getByRole('heading', { level: 1, name: 'Connect a model' })).toBeTruthy();
        await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
        await waitFor(() => expect(calls.filter((c) => c.url === '/api/auth/me').length).toBeGreaterThan(1));
        expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ step: 'model', action: 'skip' });
        // The re-read is still in flight: the stale `completed: false` must not move the page yet.
        await settle();
        expect(at(router)).toBe('/onboarding/model?returnTo=%2Ftasks');

        reread.release();
        await waitFor(() => expect(at(router)).toBe('/onboarding/tools?returnTo=%2Ftasks'));
        const post = calls.findIndex((c) => c.method === 'POST');
        expect(calls.slice(post).some((c) => c.url === '/api/auth/me')).toBe(true);
        expect(await screen.findByRole('heading', { level: 1, name: 'Connect your issue tracker' })).toBeTruthy();
    });

    it('a refused skip stays on the step and says so', async () => {
        board(
            () => open(),
            (call) => (call.method === 'POST' ? { status: 500 } : undefined)
        );
        const user = userEvent.setup();
        const { router } = renderApp('/onboarding/tools?returnTo=%2F');
        await user.click(await screen.findByRole('button', { name: 'Skip for now' }));
        expect((await screen.findByRole('alert')).textContent).toBeTruthy();
        expect(at(router)).toBe('/onboarding/tools?returnTo=%2F');
    });

    it('Back from Model is the reselect round trip back to this step', async () => {
        board(() => open());
        renderApp('/onboarding/model?returnTo=%2Ftasks');
        const back = await screen.findByRole('link', { name: 'Back' });
        expect(back.getAttribute('href')).toBe(
            '/api/auth/github?reselect=1&returnTo=%2Fonboarding%2Fmodel%3FreturnTo%3D%252Ftasks'
        );
    });

    it('Back from Tools goes to Model, keeping the return path', async () => {
        board(() => open({ skipped: ['model'] }));
        const user = userEvent.setup();
        const { router } = renderApp('/onboarding/tools?returnTo=%2Ftasks');
        await user.click(await screen.findByRole('link', { name: 'Back' }));
        await waitFor(() => expect(at(router)).toBe('/onboarding/model?returnTo=%2Ftasks'));
    });

    it('Ready completes setup, re-reads /me, then returns to the carried path', async () => {
        let setup = open({ skipped: ['model', 'tools'] });
        const reread = held();
        let completed = false;
        const calls = stubFetch((call) => {
            if (call.url === '/api/onboarding/setup/complete' && call.method === 'POST') {
                completed = true;
                setup = { ...setup, completed: true };
                return { status: 204 };
            }
            if (call.url === '/api/auth/me') {
                const answer = memberSession({ setup });
                return completed ? reread.gate.then(() => answer) : answer;
            }
        });
        const user = userEvent.setup();
        const { router } = renderApp('/onboarding/ready?returnTo=%2Ftasks');
        await user.click(await screen.findByRole('button', { name: 'Go to the dashboard' }));
        await waitFor(() => expect(calls.some((c) => c.url === '/api/onboarding/setup/complete')).toBe(true));
        await settle();
        expect(at(router)).toBe('/onboarding/ready?returnTo=%2Ftasks');

        reread.release();
        await waitFor(() => expect(router.state.location.pathname).toBe('/tasks'));
        await settle();
        expect(router.state.location.pathname).toBe('/tasks');
    });

    for (const unsafe of ['//evil.example', 'https://evil.example/']) {
        it(`Ready never follows an off-site return path (${unsafe})`, async () => {
            let completed = false;
            stubFetch((call) => {
                if (call.method === 'POST') {
                    completed = true;
                    return { status: 204 };
                }
                if (call.url === '/api/auth/me') return memberSession({ setup: open({ completed }) });
            });
            const user = userEvent.setup();
            const { router } = renderApp(`/onboarding/ready?returnTo=${encodeURIComponent(unsafe)}`);
            await user.click(await screen.findByRole('button', { name: 'Go to the dashboard' }));
            await waitFor(() => expect(at(router)).toBe('/'));
        });
    }
});
