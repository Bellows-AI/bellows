import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { taskUsageStats, telemetryStats } from '@factory-ai/core';
import type { TelemetryInput } from '@factory-ai/core';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StatsPayload, TelemetryMeta } from '../src/api/useStats.js';
import { ByUserPanel } from '../src/panels/ByUserPanel.js';
import { TokenUsagePanel } from '../src/panels/TokenUsagePanel.js';
import { OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';

/**
 * The dashboard's single-page interactions, driven in jsdom over a stubbed board: the custom
 * range dialog's draft/commit contract, a supporting table's keyboard sort, the user menu's panel
 * (client-only, so the SSR suites cannot open it), and the main chart's legend and bucket roving.
 */

const REPO = 'Bellows-AI/bellows.ai';
const NOW = new Date('2026-08-21T12:00:00.000Z');
const input = JSON.parse(
    // A path, not a URL object: under jsdom the global URL is jsdom's, which node:fs refuses.
    readFileSync(fileURLToPath(`${import.meta.url}/../../../core/test/fixtures/telemetry-sessions.json`), 'utf8')
) as TelemetryInput;
const telemetry = telemetryStats(input, { repos: [REPO], now: NOW });

const telemetryMeta: TelemetryMeta = {
    status: 'ok',
    reason: null,
    source: 'fixture',
    fetchedAt: NOW.toISOString(),
    ageSeconds: 0,
    stale: false,
    repoFilter: [REPO],
    otherRepoSessions: 0,
    sessionsWithoutHook: 0,
    unattributedSessions: 0,
};

const stats: StatsPayload = {
    telemetry,
    tasks: taskUsageStats([], []),
    meta: {
        fetchedAt: NOW.toISOString(),
        ageSeconds: 0,
        stale: false,
        organization: { mode: 'config', current: { id: 'bellows', name: 'Bellows AI' }, available: [] },
        repos: [{ owner: 'Bellows-AI', name: 'bellows.ai' }],
        range: { preset: 'all', from: null, to: null },
        scope: 'org',
        scopeLogin: null,
        telemetry: telemetryMeta,
    },
} as StatsPayload;

function openDashboard() {
    const calls = stubFetch(({ url }) => {
        if (url.startsWith('/api/stats?')) return stats;
        if (url === '/api/auth/me') return OPEN_BOARD_SESSION;
    });
    const view = renderApp('/');
    const statsRequests = () => calls.filter((c) => c.url.startsWith('/api/stats?')).map((c) => c.url);
    return { ...view, statsRequests };
}

describe('the custom range picker', () => {
    it('commits once through Apply, and a draft never requests', async () => {
        const user = userEvent.setup();
        const { statsRequests } = openDashboard();
        const trigger = await screen.findByRole('button', { name: /All time/ });
        await waitFor(() => expect(statsRequests()).toEqual(['/api/stats?range=all']));
        const customRequests = () => statsRequests().filter((u) => u.includes('range=custom'));

        const openCustom = async () => {
            await user.click(trigger);
            // Anchored, not exact: once committed, the option's name carries the checkmark.
            await user.click(await screen.findByRole('option', { name: /^Custom( ✓)?$/ }));
            return screen.findByRole('dialog', { name: 'Custom range' });
        };

        // Custom opens the dialog; typing is a draft and Cancel discards it, requesting nothing.
        let dialog = await openCustom();
        const from = () => within(dialog).getByLabelText('Start date') as HTMLInputElement;
        const to = () => within(dialog).getByLabelText('End date') as HTMLInputElement;
        expect(from().value).toBe('');
        fireEvent.change(from(), { target: { value: '2026-07-01' } });
        expect(customRequests()).toEqual([]);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(customRequests()).toEqual([]);
        expect(trigger.textContent).toContain('All time');

        // Reopening starts from the committed values, not the abandoned draft; Escape discards too.
        dialog = await openCustom();
        expect(from().value).toBe('');
        fireEvent.change(from(), { target: { value: '2026-07-15' } });
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(customRequests()).toEqual([]);

        // Apply commits both bounds exactly once.
        dialog = await openCustom();
        fireEvent.change(from(), { target: { value: '2026-07-01' } });
        fireEvent.change(to(), { target: { value: '2026-08-01' } });
        expect(customRequests()).toEqual([]);
        await user.click(within(dialog).getByRole('button', { name: 'Apply range' }));
        await waitFor(() =>
            expect(customRequests()).toEqual(['/api/stats?range=custom&from=2026-07-01&to=2026-08-01'])
        );
        await waitFor(() => expect(trigger.textContent).toContain('Jul 1 – Aug 1'));

        // Clear returns to All time from the same dialog.
        const before = statsRequests().length;
        dialog = await openCustom();
        await user.click(within(dialog).getByRole('button', { name: 'Clear' }));
        await waitFor(() => expect(statsRequests().slice(before)).toEqual(['/api/stats?range=all']));
        expect(trigger.textContent).toContain('All time');
        expect(customRequests()).toHaveLength(1);
    });
});

describe('a supporting table', () => {
    it('sorts from the keyboard and announces the active column', async () => {
        const user = userEvent.setup();
        render(<ByUserPanel telemetry={telemetry} meta={telemetryMeta} />);
        const header = screen.getByRole('button', { name: 'New tokens' });
        const th = header.closest('th');
        // The by-user table opens sorted by New tokens, largest first.
        expect(th?.getAttribute('aria-sort')).toBe('descending');
        header.focus();
        await user.keyboard('{Enter}');
        expect(th?.getAttribute('aria-sort')).toBe('ascending');
    });
});

describe('the user menu', () => {
    it('offers the way to the account page but no sign out where there is no session to end', async () => {
        const user = userEvent.setup();
        const { container } = openDashboard();
        await waitFor(() => expect(container.querySelector('.user-menu-button')).not.toBeNull());
        await user.click(container.querySelector('.user-menu-button') as HTMLElement);
        // The mode ignores every credential, so a sign-out item could never work — absent, not disabled.
        expect(await screen.findByRole('menuitem', { name: 'Account' })).toBeTruthy();
        expect(screen.queryByRole('menuitem', { name: 'Sign out' })).toBeNull();
    });
});

describe('the main chart', () => {
    it('toggles a series from the legend and inspects the buckets from the keyboard', async () => {
        const user = userEvent.setup();
        const { container } = render(<TokenUsagePanel telemetry={telemetry} meta={telemetryMeta} />);
        const panel = container.querySelector('section.panel') as HTMLElement;
        expect(within(panel).getByText('AI token usage')).toBeTruthy();
        const output = within(panel).getByRole('button', { name: 'Output' });
        expect(panel.querySelectorAll('rect[data-series="output"]').length).toBeGreaterThan(0);
        await user.click(output);
        expect(output.getAttribute('aria-pressed')).toBe('false');
        expect(panel.querySelectorAll('rect[data-series="output"]')).toHaveLength(0);
        await user.click(output);
        expect(output.getAttribute('aria-pressed')).toBe('true');

        const buckets = panel.querySelectorAll<SVGElement>('.bucket-hit');
        expect(buckets.length).toBeGreaterThan(1);
        buckets[0]?.focus();
        await user.keyboard('{ArrowRight}');
        expect(document.activeElement).toBe(buckets[1]);
        expect(panel.querySelector('.chart-tooltip')).not.toBeNull();
    });
});
