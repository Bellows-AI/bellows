import { MEMBER_ROLE } from '@factory-ai/core';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
    channelLabel,
    EVENT_KIND_LABELS,
    testResultMessage,
    type SubscriptionView,
} from '../src/api/notificationSubscriptions.js';
import {
    ADD_SUBSCRIPTION_LABEL,
    EMPTY_WRITER_NOTE,
    MEMBER_NOTE,
    NO_SUBSCRIPTIONS_NOTE,
} from '../src/panels/NotificationSubscriptionsPanel.js';
import { renderApp, stubFetch, type FetchCall } from './dom.js';
import { boardHandler, settingsBoard, subscription } from './settings-board.js';

/**
 * The notification subscriptions section mounted on its two real settings pages over a stubbed
 * board: the organization's (admins write, members read) and the member's own. The routes'
 * answers are server/test-db's; the browser half against the real board is
 * e2e/notification-subscriptions.spec.ts.
 */

const WEBHOOK = 'https://discord.com/api/webhooks/0/test';
const ORG_PATH = '/api/org/notification-subscriptions';
const PERSONAL_PATH = '/api/workspace/notification-subscriptions';
const REFUSED = 'the connector refused the credential: credential must be a discord.com or discordapp.com URL';

type User = ReturnType<typeof userEvent.setup>;

const orgTable = () => screen.findByRole('table', { name: 'Organization notification subscriptions' });
const personalTable = () => screen.findByRole('table', { name: 'My notification subscriptions' });
const writes = (calls: FetchCall[]) => calls.filter(({ method }) => method !== 'GET');

async function pick(user: User, rowName: RegExp, item: string) {
    await user.click(await screen.findByRole('button', { name: rowName }));
    await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: item }));
}

describe('the organization notifications on the organization page', () => {
    it('an admin creates one: the dialog posts the exact body and the list is read again', async () => {
        const board = settingsBoard();
        const calls = stubFetch(boardHandler(board));
        const user = userEvent.setup();
        renderApp('/settings/organization');

        await user.click(await screen.findByRole('button', { name: ADD_SUBSCRIPTION_LABEL }));
        const dialog = await screen.findByRole('dialog', { name: 'Add notification' });
        await user.type(within(dialog).getByLabelText('Webhook URL'), WEBHOOK);
        await user.click(within(dialog).getByRole('checkbox', { name: 'Admin action on a task' }));
        await user.type(within(dialog).getByLabelText(/Repositories/), 'e2e-org/no-such-repo');
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        const post = writes(calls)[0]!;
        expect(post).toMatchObject({ method: 'POST', url: ORG_PATH });
        expect(post.body).toEqual({
            connectorKind: 'discord',
            connectorConfig: {},
            credential: WEBHOOK,
            eventKinds: ['task.ready', 'task.blocked', 'task.question', 'task.admin_action'],
            repos: ['e2e-org/no-such-repo'],
            enabled: true,
        });
        const row = within(await orgTable()).getByRole('row', { name: /e2e-org\/no-such-repo/ });
        expect(row.textContent).toContain('Task ready');
        expect(calls.filter(({ method, url }) => method === 'GET' && url === ORG_PATH)).toHaveLength(2);
    });

    it('create refuses an empty webhook and no event in the dialog, sending nothing', async () => {
        const calls = stubFetch(boardHandler(settingsBoard()));
        const user = userEvent.setup();
        renderApp('/settings/organization');

        await user.click(await screen.findByRole('button', { name: ADD_SUBSCRIPTION_LABEL }));
        const dialog = await screen.findByRole('dialog', { name: 'Add notification' });
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));
        expect((await within(dialog).findByRole('alert')).textContent).toMatch(/webhook url/i);

        await user.type(within(dialog).getByLabelText('Webhook URL'), WEBHOOK);
        for (const name of ['Task ready', 'Task blocked', 'Task has a question']) {
            await user.click(within(dialog).getByRole('checkbox', { name }));
        }
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));
        expect((await within(dialog).findByRole('alert')).textContent).toMatch(/at least one event/i);
        expect(writes(calls)).toEqual([]);
    });

    it('edit with a blank webhook omits the credential and never shows the stored one', async () => {
        const row = subscription({ eventKinds: ['task.ready'], repos: ['acme/api'] });
        const board = settingsBoard({ subscriptions: { org: [row], workspace: [] } });
        const calls = stubFetch(boardHandler(board));
        const user = userEvent.setup();
        renderApp('/settings/organization');

        await orgTable();
        await pick(user, /Actions for Discord/, 'Edit');
        const dialog = await screen.findByRole('dialog', { name: 'Edit notification' });
        const webhook = within(dialog).getByLabelText('Webhook URL') as HTMLInputElement;
        expect(webhook.type).toBe('password');
        expect(webhook.value).toBe('');
        expect((within(dialog).getByLabelText(/Repositories/) as HTMLTextAreaElement).value).toBe('acme/api');
        expect(within(dialog).queryByLabelText(/Workflows/)).toBeNull();
        await user.click(within(dialog).getByRole('checkbox', { name: 'Task blocked' }));
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        const put = writes(calls)[0]!;
        expect(put).toMatchObject({ method: 'PUT', url: `${ORG_PATH}/${row.id}` });
        expect(put.body).toEqual({
            connectorKind: 'discord',
            connectorConfig: {},
            eventKinds: ['task.ready', 'task.blocked'],
            repos: ['acme/api'],
            enabled: true,
        });
    });

    it('a channel change with a blank webhook is refused in the dialog', async () => {
        const board = settingsBoard({
            connectorKinds: ['discord', 'slack'],
            subscriptions: { org: [subscription()], workspace: [] },
        });
        const calls = stubFetch(boardHandler(board));
        const user = userEvent.setup();
        renderApp('/settings/organization');

        await orgTable();
        await pick(user, /Actions for Discord/, 'Edit');
        const dialog = await screen.findByRole('dialog', { name: 'Edit notification' });
        await user.selectOptions(within(dialog).getByLabelText('Channel'), 'slack');
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        expect((await within(dialog).findByRole('alert')).textContent).toMatch(/new channel/i);
        expect(writes(calls)).toEqual([]);
    });

    it('the Enabled toggle sends a full-body PUT with enabled flipped and no credential', async () => {
        const row = subscription({ repos: ['acme/api'] });
        const calls = stubFetch(boardHandler(settingsBoard({ subscriptions: { org: [row], workspace: [] } })));
        const user = userEvent.setup();
        renderApp('/settings/organization');

        const table = await orgTable();
        await user.click(within(table).getByRole('switch', { name: /enabled/i }));

        await waitFor(() => expect(writes(calls)).toHaveLength(1));
        expect(writes(calls)[0]).toMatchObject({
            method: 'PUT',
            url: `${ORG_PATH}/${row.id}`,
            body: {
                connectorKind: 'discord',
                connectorConfig: {},
                eventKinds: ['task.ready'],
                repos: ['acme/api'],
                enabled: false,
            },
        });
        expect(writes(calls)[0]!.body).not.toHaveProperty('credential');
        await waitFor(() =>
            expect(
                (within(screen.getByRole('table')).getByRole('switch', { name: /enabled/i }) as HTMLInputElement)
                    .checked
            ).toBe(false)
        );
    });

    it('delete confirms first: cancel sends nothing, confirm deletes and re-reads', async () => {
        const row = subscription();
        const calls = stubFetch(boardHandler(settingsBoard({ subscriptions: { org: [row], workspace: [] } })));
        const user = userEvent.setup();
        renderApp('/settings/organization');

        await orgTable();
        await pick(user, /Actions for Discord/, 'Delete');
        const dialog = await screen.findByRole('dialog', { name: 'Delete notification' });
        expect(writes(calls)).toEqual([]);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(writes(calls)).toEqual([]);

        await pick(user, /Actions for Discord/, 'Delete');
        await user.click(
            within(await screen.findByRole('dialog', { name: 'Delete notification' })).getByRole('button', {
                name: 'Delete',
            })
        );

        await waitFor(() => expect(writes(calls)).toHaveLength(1));
        expect(writes(calls)[0]).toMatchObject({ method: 'DELETE', url: `${ORG_PATH}/${row.id}` });
        await waitFor(() =>
            expect(screen.queryByRole('table', { name: 'Organization notification subscriptions' })).toBeNull()
        );
    });

    it('Send test notification reads the verdict as one sentence: delivered, then refused', async () => {
        const row = subscription();
        const verdicts = [
            { status: 'delivered' },
            { status: 'permanent', reason: 'destination-refused' },
            { status: 'retryable', reason: 'aborted' },
        ] as const;
        let sent = 0;
        const calls = stubFetch(
            boardHandler(settingsBoard({ subscriptions: { org: [row], workspace: [] } }), ({ method, url }) =>
                method === 'POST' && url === `${ORG_PATH}/${row.id}/test` ? { result: verdicts[sent++] } : undefined
            )
        );
        const user = userEvent.setup();
        renderApp('/settings/organization');

        const table = await orgTable();
        const send = () => user.click(within(table).getByRole('button', { name: 'Send test notification' }));
        await send();
        expect(await screen.findByText(testResultMessage(verdicts[0]))).toBeTruthy();
        await send();
        expect(await screen.findByText(testResultMessage(verdicts[1]))).toBeTruthy();
        await send();
        const aborted = await screen.findByText(testResultMessage(verdicts[2]));
        expect(aborted.textContent).toMatch(/did not answer/i);
        expect(aborted.textContent).not.toMatch(/not sent/i);
        expect(calls.filter(({ url }) => url.endsWith('/test'))).toHaveLength(3);
    });

    it('a malformed test answer is an error, never "delivered", and the controls come back', async () => {
        const row = subscription();
        stubFetch(
            boardHandler(settingsBoard({ subscriptions: { org: [row], workspace: [] } }), ({ method, url }) =>
                method === 'POST' && url.endsWith('/test') ? { result: { status: 'sent' } } : undefined
            )
        );
        const user = userEvent.setup();
        renderApp('/settings/organization');

        const table = await orgTable();
        await user.click(within(table).getByRole('button', { name: 'Send test notification' }));
        // The members read this board 404s is an alert too: the answer under test is one of several.
        expect((await screen.findAllByRole('alert')).map((alert) => alert.textContent).join(' ')).toMatch(
            /unexpected response/i
        );
        expect(screen.queryByText(/delivered/i)).toBeNull();
        expect(
            (within(table).getByRole('button', { name: 'Send test notification' }) as HTMLButtonElement).disabled
        ).toBe(false);
        expect((screen.getByRole('button', { name: ADD_SUBSCRIPTION_LABEL }) as HTMLButtonElement).disabled).toBe(
            false
        );
    });

    it('a 400 shows the connector problems in the dialog, which stays open', async () => {
        const calls = stubFetch(
            boardHandler(settingsBoard(), ({ method }) =>
                method === 'POST'
                    ? {
                          status: 400,
                          body: {
                              error: 'the connector refused the credential',
                              code: 'BAD_CONNECTOR_CONFIG',
                              problems: ['credential must be a discord.com or discordapp.com URL'],
                          },
                      }
                    : undefined
            )
        );
        const user = userEvent.setup();
        renderApp('/settings/organization');

        await user.click(await screen.findByRole('button', { name: ADD_SUBSCRIPTION_LABEL }));
        const dialog = await screen.findByRole('dialog', { name: 'Add notification' });
        await user.type(within(dialog).getByLabelText('Webhook URL'), 'https://example.test/hook');
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));

        expect((await within(dialog).findByRole('alert')).textContent).toBe(REFUSED);
        expect(screen.getByRole('dialog', { name: 'Add notification' })).toBeTruthy();
        expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false);
        expect(writes(calls)).toHaveLength(1);
    });

    it('a member sees the read-only table and the sentence, with no write controls', async () => {
        const board = settingsBoard({ role: MEMBER_ROLE, subscriptions: { org: [subscription()], workspace: [] } });
        stubFetch(boardHandler(board));
        renderApp('/settings/organization');

        const table = await orgTable();
        expect(within(table).getByRole('row', { name: /Discord/ })).toBeTruthy();
        expect(screen.getByText(MEMBER_NOTE)).toBeTruthy();
        expect(screen.queryByRole('button', { name: ADD_SUBSCRIPTION_LABEL })).toBeNull();
        expect(within(table).queryByRole('button')).toBeNull();
        expect((within(table).getByRole('switch', { name: /enabled/i }) as HTMLInputElement).disabled).toBe(true);
    });

    it('a failed list is an alert with no Add button, never an empty table', async () => {
        stubFetch(
            boardHandler(settingsBoard(), ({ method, url }) =>
                method === 'GET' && url === ORG_PATH ? { status: 503, body: { error: 'store down' } } : undefined
            )
        );
        renderApp('/settings/organization');

        const region = await screen.findByRole('region', { name: 'Organization notifications' }).catch(() => null);
        const alert = await screen.findAllByRole('alert');
        expect(alert.some((node) => node.textContent === 'store down')).toBe(true);
        expect(region === null || within(region).queryByRole('table') === null).toBe(true);
        expect(screen.queryByRole('button', { name: ADD_SUBSCRIPTION_LABEL })).toBeNull();
        expect(screen.queryByRole('table', { name: 'Organization notification subscriptions' })).toBeNull();
    });

    it('a malformed list is the same error state', async () => {
        stubFetch(
            boardHandler(settingsBoard(), ({ method, url }) =>
                method === 'GET' && url === ORG_PATH
                    ? { subscriptions: 'none', connectorKinds: ['discord'] }
                    : undefined
            )
        );
        renderApp('/settings/organization');

        expect(
            (await screen.findAllByRole('alert')).some((node) => /unexpected response/.test(node.textContent ?? ''))
        ).toBe(true);
        expect(screen.queryByRole('button', { name: ADD_SUBSCRIPTION_LABEL })).toBeNull();
    });
});

describe('my notifications on the workspace page', () => {
    it('a member has every control, and every call goes to the personal routes', async () => {
        const row = subscription({ eventKinds: ['task.blocked'] });
        const board = settingsBoard({ role: MEMBER_ROLE, subscriptions: { org: [], workspace: [row] } });
        const calls = stubFetch(boardHandler(board));
        const user = userEvent.setup();
        renderApp('/settings/workspace');

        const table = await personalTable();
        expect(screen.queryByText(MEMBER_NOTE)).toBeNull();
        expect(screen.getByText(/updates for tasks you start and actions you take/i)).toBeTruthy();
        expect(within(table).getByRole('row', { name: /Task blocked/ })).toBeTruthy();

        await user.click(screen.getByRole('button', { name: ADD_SUBSCRIPTION_LABEL }));
        const dialog = await screen.findByRole('dialog', { name: 'Add notification' });
        await user.type(within(dialog).getByLabelText('Webhook URL'), WEBHOOK);
        await user.click(within(dialog).getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

        await user.click(within(await personalTable()).getAllByRole('button', { name: 'Send test notification' })[0]!);
        await waitFor(() => expect(calls.some(({ url }) => url === `${PERSONAL_PATH}/${row.id}/test`)).toBe(true));

        const personal = calls.filter(({ url }) => url.includes('notification-subscriptions'));
        expect(personal.length).toBeGreaterThan(0);
        expect(personal.every(({ url }) => url.startsWith(PERSONAL_PATH))).toBe(true);
        expect(writes(personal)[0]).toMatchObject({ method: 'POST', url: PERSONAL_PATH });
    });

    it('a failed list is an alert and no table', async () => {
        stubFetch(
            boardHandler(settingsBoard({ role: MEMBER_ROLE }), ({ method, url }) =>
                method === 'GET' && url === PERSONAL_PATH ? { status: 500, body: { error: 'store down' } } : undefined
            )
        );
        renderApp('/settings/workspace');

        expect((await screen.findAllByRole('alert')).some((node) => node.textContent === 'store down')).toBe(true);
        expect(screen.queryByRole('button', { name: ADD_SUBSCRIPTION_LABEL })).toBeNull();
        expect(screen.queryByRole('table', { name: 'My notification subscriptions' })).toBeNull();
    });
});

describe('the compact notification rows', () => {
    const open = async (events: SubscriptionView['eventKinds'], repos: string[] = []) => {
        const row = subscription({ eventKinds: events, repos });
        stubFetch(boardHandler(settingsBoard({ subscriptions: { org: [], workspace: [row] } })));
        renderApp('/settings/workspace');
        return { row, table: await personalTable() };
    };
    const ALL_EVENTS: SubscriptionView['eventKinds'] = [
        'task.ready',
        'task.blocked',
        'task.question',
        'task.admin_action',
    ];

    it('renders each event as a tag with its label and an aria-hidden icon', async () => {
        const { table } = await open(ALL_EVENTS);
        const pills = Array.from(table.querySelectorAll<HTMLElement>('[data-label="Events"] .pill'));
        expect(pills.map((pill) => pill.textContent)).toEqual(ALL_EVENTS.map((kind) => EVENT_KIND_LABELS[kind]));
        for (const pill of pills) expect(pill.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    });

    it('tones the Question tag purple and only the Question tag', async () => {
        const { table } = await open(ALL_EVENTS);
        const toned = Array.from(table.querySelectorAll<HTMLElement>('[data-label="Events"] .pill-question'));
        expect(toned.map((pill) => pill.textContent)).toEqual([EVENT_KIND_LABELS['task.question']]);
    });

    it('renders an all-repositories scope as one neutral tag, and named repos as one tag each', async () => {
        const all = await open(['task.ready']);
        const allTags = Array.from(all.table.querySelectorAll('[data-label="Repos"] .pill'));
        expect(allTags.map((pill) => pill.textContent)).toEqual(['All repositories']);
        cleanup();

        const named = await open(['task.ready'], ['acme/api', 'acme/web']);
        const tags = Array.from(named.table.querySelectorAll<HTMLElement>('[data-label="Repos"] .pill'));
        expect(tags.map((pill) => pill.textContent)).toEqual(['acme/api', 'acme/web']);
        expect(tags.map((pill) => pill.title)).toEqual(['acme/api', 'acme/web']);
    });

    it('shows the subscription count beside the heading, and none while the read is pending or failed', async () => {
        const rows = [subscription(), subscription({ connectorKind: 'slack' })];
        stubFetch(boardHandler(settingsBoard({ subscriptions: { org: [], workspace: rows } })));
        renderApp('/settings/workspace');
        const heading = await screen.findByRole('heading', { name: /^My notifications/ });
        expect(heading.querySelector('.count')?.textContent).toBe('2');
        cleanup();

        stubFetch(
            boardHandler(settingsBoard(), ({ method, url }) =>
                method === 'GET' && url === PERSONAL_PATH ? { status: 503, body: { error: 'store down' } } : undefined
            )
        );
        renderApp('/settings/workspace');
        await screen.findAllByRole('alert');
        expect(document.querySelector('section[aria-label="My notifications"] .count')).toBeNull();
    });

    it('the channel cell shows the provider mark with the channel name', async () => {
        const { table } = await open(['task.ready']);
        const cell = table.querySelector<HTMLElement>('[data-label="Channel"]')!;
        const mark = cell.querySelector('svg.provider-mark');
        expect(mark?.getAttribute('aria-hidden')).toBe('true');
        expect(mark?.getAttribute('role')).toBeNull();
        expect(cell.textContent).toBe(channelLabel('discord'));
    });

    it('the Enabled control is a switch named for its row', async () => {
        const { table } = await open(['task.ready']);
        const toggle = within(table).getByRole('switch', { name: /^Enabled, Discord for/ });
        expect(toggle.classList.contains('switch')).toBe(true);
    });
});

describe('the notification states are StateNote lines', () => {
    /** The note inside one named region: other sections on the page raise their own. */
    const stateNote = (region: string) => screen.getByRole('region', { name: region }).querySelector('.state-note');

    it('an empty organization shows the empty note and one Add button to an admin', async () => {
        stubFetch(boardHandler(settingsBoard()));
        renderApp('/settings/organization');

        await screen.findByRole('region', { name: 'Organization notifications' });
        expect(stateNote('Organization notifications')?.textContent).toBe(
            `${NO_SUBSCRIPTIONS_NOTE} ${EMPTY_WRITER_NOTE}`
        );
        expect(screen.getAllByRole('button', { name: ADD_SUBSCRIPTION_LABEL })).toHaveLength(1);
        expect(screen.queryByRole('table')).toBeNull();
    });

    it('an empty organization shows a member the note alone and no Add button', async () => {
        stubFetch(boardHandler(settingsBoard({ role: MEMBER_ROLE })));
        renderApp('/settings/organization');

        await screen.findByRole('region', { name: 'Organization notifications' });
        expect(stateNote('Organization notifications')?.textContent).toBe(NO_SUBSCRIPTIONS_NOTE);
        expect(screen.queryByRole('button', { name: ADD_SUBSCRIPTION_LABEL })).toBeNull();
    });

    it('an empty personal list shows the empty note and one Add button', async () => {
        stubFetch(boardHandler(settingsBoard({ role: MEMBER_ROLE })));
        renderApp('/settings/workspace');

        await screen.findByRole('region', { name: 'My notifications' });
        expect(stateNote('My notifications')?.textContent).toBe(`${NO_SUBSCRIPTIONS_NOTE} ${EMPTY_WRITER_NOTE}`);
        expect(screen.getAllByRole('button', { name: ADD_SUBSCRIPTION_LABEL })).toHaveLength(1);
    });

    it('a failed read is a StateNote error, not the empty note', async () => {
        stubFetch(
            boardHandler(settingsBoard(), ({ method, url }) =>
                method === 'GET' && url === ORG_PATH ? { status: 503, body: { error: 'store down' } } : undefined
            )
        );
        renderApp('/settings/organization');

        await waitFor(() => expect(document.querySelector('.state-note.error')?.textContent).toBe('store down'));
        expect(screen.queryByText(NO_SUBSCRIPTIONS_NOTE)).toBeNull();
    });
});
