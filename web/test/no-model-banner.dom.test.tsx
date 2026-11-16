import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelSetupView } from '../src/api/useModelSetup.js';
import { useModelSetup } from '../src/api/useModelSetup.js';
import { NoModelBanner } from '../src/components/NoModelBanner.js';
import { type FetchCall, renderApp, renderAt, stubFetch } from './dom.js';
import { memberSession } from './fixtures.js';

/**
 * The shell's "No model yet" banner: shown only on a confirmed `effective: null`, gone after a save
 * anywhere without a reload, never on a failed read, and re-read when the window regains focus —
 * never on a timer.
 */

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const NONE: ModelSetupView = { platform: false, org: null, personal: null, effective: null };
const SAVED: ModelSetupView = {
    platform: false,
    org: null,
    personal: { provider: 'anthropic', agentType: 'claude-code', model: 'claude-test-model', keyNames: ['K'] },
    effective: 'personal',
};
const TEXT = 'No model yet — tasks will wait until one is connected';

function board(first: ModelSetupView | { status: number }) {
    const state: { view: ModelSetupView | { status: number } } = { view: first };
    const calls = stubFetch((call: FetchCall) => {
        if (call.url === '/api/auth/me') return memberSession();
        if (call.url === '/api/model-setup' && call.method === 'GET') return state.view;
        if (call.url === '/api/model-setup' && call.method === 'PUT') {
            state.view = SAVED;
            return { status: 200, body: {} };
        }
    });
    const reads = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/model-setup').length;
    return { state, reads };
}

/** Another mount of the setup read that saves, as the model step and Settings → Model do. */
function Saver() {
    const setup = useModelSetup();
    return (
        <button
            type="button"
            onClick={() =>
                void setup.save({
                    scope: 'personal',
                    provider: 'anthropic',
                    key: 'sk-ant-test',
                    agentType: 'claude-code',
                    model: 'claude-test-model',
                })
            }
        >
            Save
        </button>
    );
}

const banner = () => document.querySelector('.banner-warn.no-model-banner');

describe('the No model yet banner', () => {
    it('shows on a confirmed effective null, with its icon and a link to Settings → Model', async () => {
        board(NONE);
        renderAt(<NoModelBanner />);
        expect(await screen.findByText(new RegExp(TEXT))).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Connect a model' }).getAttribute('href')).toBe('/settings/model');
        expect(banner()?.querySelector('.icon')).toBeTruthy();
    });

    it('disappears after a save elsewhere, without a reload', async () => {
        board(NONE);
        renderAt(
            <>
                <NoModelBanner />
                <Saver />
            </>
        );
        await screen.findByText(new RegExp(TEXT));
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(banner()).toBeNull());
    });

    it('never shows on a failed read, nor while the read is in flight', async () => {
        const { reads } = board({ status: 500 });
        renderAt(<NoModelBanner />);
        expect(banner()).toBeNull();
        await waitFor(() => expect(reads()).toBe(1));
        await act(async () => {});
        expect(banner()).toBeNull();
    });

    it('re-reads when the window regains focus, and sets no timer', async () => {
        // Timers the banner might set are fake from the start, and still tick for the harness's own waits.
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { state, reads } = board(NONE);
        renderAt(<NoModelBanner />);
        await screen.findByText(new RegExp(TEXT));
        expect(reads()).toBe(1);
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10 * 60_000);
        });
        expect(reads()).toBe(1);

        state.view = SAVED;
        await act(async () => {
            window.dispatchEvent(new Event('focus'));
        });
        await waitFor(() => expect(banner()).toBeNull());
        expect(reads()).toBe(2);
    });

    it('sits in the app shell above the page', async () => {
        board(NONE);
        renderApp('/settings');
        await screen.findByText(new RegExp(TEXT));
        expect(document.querySelector('main#main-content > .no-model-banner')).toBeTruthy();
    });
});
