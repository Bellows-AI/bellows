import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ConnectedAppsSection } from '../src/panels/ConnectedAppsPanel.js';
import { stubFetch } from './dom.js';
import './dom.js';

const grant = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    client: { id: `dcr_${id}`, name: 'Planner', kind: 'dcr' },
    org: { id: 'o1', name: 'acme' },
    scopes: ['factory:read'],
    createdAt: '2026-01-15T09:30:00.000Z',
    lastIssuedAt: '2026-01-16T10:00:00.000Z',
    ...overrides,
});

describe('the connected apps panel', () => {
    it('lists each app with its identity, access and times', async () => {
        stubFetch(() => ({
            grants: [
                grant('g1'),
                grant('g2', {
                    client: { id: 'https://agent.example.test/c.json', name: 'X', kind: 'cimd' },
                    lastIssuedAt: null,
                }),
            ],
        }));
        render(<ConnectedAppsSection />);
        const table = await screen.findByRole('table', { name: 'Connected apps' });
        expect(within(table).getByText('Planner')).toBeTruthy();
        expect(within(table).getByText(/unverified name/)).toBeTruthy();
        expect(within(table).getByText('agent.example.test')).toBeTruthy();
        expect(within(table).getAllByText(/Read tasks/)).toHaveLength(2);
        expect(within(table).getAllByText('2026-01-15 09:30')).toHaveLength(2);
        expect(within(table).getByText('2026-01-16 10:00')).toBeTruthy();
        expect(within(table).getByRole('columnheader', { name: 'Org' })).toBeTruthy();
        expect(within(table).getAllByText('acme')).toHaveLength(2);
        expect(within(table).getByRole('columnheader', { name: 'Last token issued' })).toBeTruthy();
        expect(within(table).getByText('—')).toBeTruthy();
    });

    it('says there are no apps only after the read succeeded', async () => {
        stubFetch(() => ({ grants: [] }));
        render(<ConnectedAppsSection />);
        expect(await screen.findByText('No apps are connected.')).toBeTruthy();
    });

    it('shows a failed read as an error, not as an empty list', async () => {
        stubFetch(() => ({ status: 503, body: { error: 'Try again shortly.' } }));
        render(<ConnectedAppsSection />);
        expect((await screen.findByRole('alert')).textContent).toBe('Try again shortly.');
        expect(screen.queryByText('No apps are connected.')).toBeNull();
    });

    it('asks before disconnecting, then posts the revoke and refetches', async () => {
        let live = [grant('g1'), grant('g2', { client: { id: 'dcr_g2', name: 'Other', kind: 'dcr' } })];
        const calls = stubFetch((call) => {
            if (call.method === 'POST') {
                live = live.filter((g) => `/api/oauth/grants/${g.id}/revoke` !== call.url);
                return { id: 'g1', revoked: true };
            }
            return { grants: live };
        });
        const user = userEvent.setup();
        render(<ConnectedAppsSection />);
        await user.click(await screen.findByRole('button', { name: 'Disconnect Planner' }));
        const dialog = await screen.findByRole('dialog');
        expect(calls.some((call) => call.method === 'POST')).toBe(false);
        await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));
        await waitFor(() => expect(screen.queryByRole('button', { name: 'Disconnect Planner' })).toBeNull());
        expect(calls.find((call) => call.method === 'POST')?.url).toBe('/api/oauth/grants/g1/revoke');
        expect(screen.getByRole('button', { name: 'Disconnect Other' })).toBeTruthy();
    });

    it('keeps the row and says why when the revoke is refused', async () => {
        stubFetch((call) =>
            call.method === 'POST'
                ? { status: 404, body: { error: 'No such connected app' } }
                : { grants: [grant('g1')] }
        );
        const user = userEvent.setup();
        render(<ConnectedAppsSection />);
        await user.click(await screen.findByRole('button', { name: 'Disconnect Planner' }));
        await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
        expect((await screen.findByRole('alert')).textContent).toBe('No such connected app');
        expect(screen.getByRole('button', { name: 'Disconnect Planner' })).toBeTruthy();
    });
});
