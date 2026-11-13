import { MEMBER_ROLE } from '@factory-ai/core';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AuditEvent } from '../src/api/audit.js';
import { type FetchCall, renderApp, stubFetch, stubObjectUrls } from './dom.js';
import { boardHandler, type SettingsBoard, settingsBoard } from './settings-board.js';

/**
 * The audit log section on /settings/organization over a stubbed board: an admin reads the picked days newest first
 * and exports the answer's own bytes; a member never sees it nor reads it. The route's contract is
 * `server/test-db/audit-log.test.ts`'s.
 */

const event = (over: Partial<AuditEvent>): AuditEvent => ({
    id: crypto.randomUUID(),
    at: '2026-11-10T09:30:00.000Z',
    actorKind: 'user',
    actorId: 'u1',
    actorLogin: 'e2e-member',
    action: 'auth.sign_in',
    target: 'u1',
    detail: {},
    ...over,
});

/** The board with an empty roster; `/api/audit` answers `audit` as NDJSON text, or the status it names. */
function stubAudit(board: SettingsBoard, audit: AuditEvent[] | { status: number }): FetchCall[] {
    const calls = stubFetch(
        boardHandler(board, ({ method, url }) => {
            if (method === 'GET' && url === '/api/org/members') return { members: [] };
            if (method === 'GET' && url === '/api/org/members/removed') return { removed: [] };
            if (method === 'GET' && url === '/api/org/members/invitations') {
                return { signInUrl: null, github: { state: 'listed', people: [] } };
            }
        })
    );
    const board$ = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('/api/audit')) return board$(input, init);
        calls.push({ method: 'GET', url, body: undefined, headers: {} });
        if (!Array.isArray(audit)) {
            return new Response(JSON.stringify({ error: 'boom' }), {
                status: audit.status,
                headers: { 'content-type': 'application/json' },
            });
        }
        const text = audit.map((row) => `${JSON.stringify(row)}\n`).join('');
        return new Response(text, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
    });
    return calls;
}

const auditCalls = (calls: FetchCall[]) => calls.filter((call) => call.url.startsWith('/api/audit'));

describe('the audit log section', () => {
    it('shows an admin the picked days newest first, and exports the answer unchanged', async () => {
        const urls = stubObjectUrls();
        const clicked: string[] = [];
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
            this: HTMLAnchorElement
        ) {
            clicked.push(this.download);
        });
        const calls = stubAudit(settingsBoard(), [
            event({ at: '2026-11-10T09:30:00.000Z', action: 'auth.sign_in' }),
            event({ at: '2026-11-11T10:00:00.000Z', action: 'member.role', target: 'u2' }),
            event({ at: '2026-11-12T11:00:00.000Z', actorKind: 'system', actorLogin: null, action: 'something.new' }),
        ]);
        const user = userEvent.setup();
        renderApp('/settings/organization');

        const table = await screen.findByRole('region', { name: 'Audit events' });
        const rows = within(table).getAllByRole('row').slice(1);
        expect(rows.map((row) => within(row).getAllByRole('cell')[2]!.textContent)).toEqual([
            'something.new',
            'Changed a role',
            'Signed in',
        ]);
        expect(within(rows[0]!).getByText('Bellows')).toBeTruthy();
        expect(within(rows[2]!).getByText('e2e-member')).toBeTruthy();

        // The picked end day is inside the range: the request's `to` is the next midnight.
        const [first] = auditCalls(calls);
        const query = new URL(first!.url, 'http://board.test').searchParams;
        const from = screen.getByLabelText<HTMLInputElement>('From').value;
        const to = screen.getByLabelText<HTMLInputElement>('To').value;
        expect(query.get('from')).toBe(from);
        expect(Date.parse(query.get('to')!) - Date.parse(to)).toBe(86_400_000);

        await user.click(screen.getByRole('button', { name: 'Export' }));
        expect(clicked).toEqual([`audit-${from}-to-${to}.ndjson`]);
        expect(urls.created).toHaveLength(1);
        expect(urls.revoked).toEqual(urls.created);
        click.mockRestore();
    });

    it('reads the new days when the range changes, and says when nothing was recorded', async () => {
        const calls = stubAudit(settingsBoard(), []);
        const user = userEvent.setup();
        renderApp('/settings/organization');

        await screen.findByText('Nothing was recorded in these days.');
        const before = auditCalls(calls).length;
        const fromField = screen.getByLabelText<HTMLInputElement>('From');
        await user.clear(fromField);
        await user.type(fromField, '2026-01-01');
        await waitFor(() => expect(auditCalls(calls).length).toBeGreaterThan(before));
        expect(auditCalls(calls).at(-1)!.url).toContain('from=2026-01-01');
    });

    it('names a failed read, and offers no export', async () => {
        stubAudit(settingsBoard(), { status: 500 });
        renderApp('/settings/organization');

        const section = await screen.findByRole('region', { name: 'Audit log' });
        await within(section).findByText(/boom/);
        expect(within(section).getByRole<HTMLButtonElement>('button', { name: 'Export' }).disabled).toBe(true);
    });

    it('renders nothing for a member, who never reads the log', async () => {
        const calls = stubAudit(settingsBoard({ role: MEMBER_ROLE }), [event({})]);
        renderApp('/settings/organization');

        await screen.findByRole('heading', { name: 'Organization' });
        await waitFor(() => expect(calls.some((call) => call.url === '/api/env')).toBe(true));
        expect(screen.queryByRole('region', { name: 'Audit log' })).toBeNull();
        expect(auditCalls(calls)).toEqual([]);
    });
});
