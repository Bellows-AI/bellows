import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeploymentMode } from '@factory-ai/core';
import type { ModelSetupView } from '../src/api/useModelSetup.js';
import type { WorkspacePayload } from '../src/api/useWorkspace.js';
import { useModelSetup } from '../src/api/useModelSetup.js';
import { NoModelBanner } from '../src/components/NoModelBanner.js';
import { type FetchCall, renderApp, renderAt, stubFetch } from './dom.js';
import { memberSession } from './fixtures.js';

/**
 * The shell's "No model yet" banner: shown only on a confirmed `effective: null` where a task could not
 * run (cloud; self-hosted with no profile or agent default either), gone after a save
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

const BARE: WorkspacePayload = { executors: [], orgExecutors: [], defaultExecutor: null, agentDefault: null };
const PROFILE: WorkspacePayload = { ...BARE, defaultExecutor: { scope: 'user', name: 'mine' } };

/** The banner's board: self-hosted with nothing to run on, unless told otherwise. */
function board(
    first: ModelSetupView | { status: number },
    { mode = 'self-hosted', workspace = BARE }: { mode?: DeploymentMode; workspace?: WorkspacePayload } = {}
) {
    const state: { view: ModelSetupView | { status: number } } = { view: first };
    const calls = stubFetch((call: FetchCall) => {
        if (call.url === '/api/auth/me') return memberSession({ deploymentMode: mode });
        if (call.url === '/api/workspace') return workspace;
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
                    agentType: 'claude-code',
                    model: 'claude-test-model',
                    connection: { intent: 'create', provider: 'anthropic', key: 'sk-ant-test', name: 'Anthropic' },
                    executor: { name: 'Anthropic' },
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

    it('self-hosted with an executor profile: no banner, the runners may hold the key', async () => {
        const { reads } = board(NONE, { workspace: PROFILE });
        renderAt(<NoModelBanner />);
        await waitFor(() => expect(reads()).toBe(1));
        // Every read has landed — the session, the setup and the workspace — and still nothing is said.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(banner()).toBeNull();
    });

    it('cloud with an executor profile and no key: the banner', async () => {
        board(NONE, { mode: 'cloud', workspace: PROFILE });
        renderAt(<NoModelBanner />);
        expect(await screen.findByText(new RegExp(TEXT))).toBeTruthy();
    });

    it('cloud with a connection-backed default executor: no banner, though no env key or agent default exists', async () => {
        const executor: ModelSetupView = {
            ...NONE,
            effective: 'executor',
            selected: {
                scope: 'org',
                executorId: 'executor-1',
                name: 'Claude',
                agentType: 'claude-code',
                model: 'claude-test-model',
                suspended: false,
                updatedAt: '2026-01-02T03:04:05.678Z',
                connection: { id: 'c-1', name: 'Anthropic', provider: 'anthropic', scope: 'org', baseUrl: null },
            },
        };
        const { reads } = board(executor, { mode: 'cloud', workspace: PROFILE });
        renderAt(<NoModelBanner />);
        await waitFor(() => expect(reads()).toBe(1));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(banner()).toBeNull();
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

/**
 * The shell's settled signal: `data-no-model` on `.shell` reads `pending` until the banner has decided,
 * then `shown` or `hidden` — what a whole-page e2e check waits on before it walks or measures.
 */
describe('the shell says when the No model yet decision is made', () => {
    const shellState = () => document.querySelector('.shell')?.getAttribute('data-no-model');

    it('pending while the reads load, then hidden once the workspace confirms a profile', async () => {
        let release: (payload: WorkspacePayload) => void = () => {};
        const workspace = new Promise<WorkspacePayload>((resolve) => {
            release = resolve;
        });
        stubFetch((call: FetchCall) => {
            if (call.url === '/api/auth/me') return memberSession({ deploymentMode: 'self-hosted' });
            if (call.url === '/api/workspace') return workspace;
            if (call.url === '/api/model-setup') return NONE;
        });
        renderApp('/settings');
        await waitFor(() => expect(shellState()).toBe('pending'));
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(shellState()).toBe('pending');
        await act(async () => {
            release(PROFILE);
        });
        await waitFor(() => expect(shellState()).toBe('hidden'));
        expect(banner()).toBeNull();
    });

    it('hidden after a confirmed key', async () => {
        board(SAVED);
        renderApp('/settings');
        await waitFor(() => expect(shellState()).toBe('hidden'));
        expect(banner()).toBeNull();
    });

    it('shown after a confirmed none', async () => {
        board(NONE);
        renderApp('/settings');
        await waitFor(() => expect(shellState()).toBe('shown'));
        expect(banner()).toBeTruthy();
    });

    it('hidden after a failed read', async () => {
        board({ status: 500 });
        renderApp('/settings');
        await waitFor(() => expect(shellState()).toBe('hidden'));
        expect(banner()).toBeNull();
    });
});
