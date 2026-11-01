import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderApp, stubFetch, type FetchHandler } from './dom.js';
import { boardHandler, connection, settingsBoard, type SettingsBoard } from './settings-board.js';

/**
 * The Browse integrations cards across every state a provider can be in. The claims a card makes
 * (Connected, Manage, Connect) each rest on one read; a state whose read is missing, failed or
 * unanswered must make none of the claims that read licenses.
 */

const PATH = '/settings/integrations/available';
const never = new Promise<unknown>(() => undefined);

afterEach(() => vi.unstubAllGlobals());

interface Reads {
    board?: Partial<SettingsBoard>;
    config?: unknown;
    connections?: unknown;
}

const handler = ({ board, config, connections }: Reads): FetchHandler =>
    boardHandler(settingsBoard(board), ({ method, url }) => {
        if (method !== 'GET') return;
        if (url === '/api/integrations' && config !== undefined) return config;
        if (url === '/api/connections' && connections !== undefined) return connections as never;
    });

const card = async (name: string) => within(await screen.findByRole('listitem', { name }));

interface Claims {
    connected: boolean;
    manage: boolean;
    connect: boolean;
}

const claimsOf = (jira: ReturnType<typeof within>): Claims => ({
    connected: jira.queryByText('Connected') !== null,
    manage: jira.queryByRole('link', { name: /Manage/ }) !== null,
    connect: jira.queryByRole('button', { name: /^Connect/ }) !== null,
});

const NO_CLAIMS: Claims = { connected: false, manage: false, connect: false };

const states: Array<[string, Reads, Claims]> = [
    ['supported and unconnected', {}, { ...NO_CLAIMS, connect: true }],
    [
        'connected',
        { board: { connections: [connection('acme-example.atlassian.net')] } },
        { connected: true, manage: true, connect: true },
    ],
    [
        'needing reconnect',
        { board: { connections: [connection('acme-example.atlassian.net', { needsReconnect: true })] } },
        { connected: false, manage: true, connect: true },
    ],
    ['not configured', { board: { jiraConfigured: false } }, NO_CLAIMS],
    ['config read failed', { config: { status: 500, body: { error: 'db down' } } }, NO_CLAIMS],
    ['config read pending', { config: never }, NO_CLAIMS],
    ['list pending', { connections: never }, { ...NO_CLAIMS, connect: true }],
    ['list failed', { connections: { status: 500, body: { error: 'db down' } } }, { ...NO_CLAIMS, connect: true }],
];

describe('the catalog card for Jira, by state', () => {
    it.each(states)('%s', async (_name, reads, expected) => {
        stubFetch(handler(reads));
        renderApp(PATH);

        const jira = await card('Jira');
        // Let both reads settle (or stay pending) before judging the card.
        await waitFor(() => {
            const text = jira.getByText((_, el) => el?.className === 'catalog-card-state' && el.textContent !== '');
            expect(text).toBeTruthy();
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(claimsOf(jira)).toEqual(expected);
    });
});

describe('the catalog cards that are not connectable', () => {
    it.each([['Slack'], ['GitHub']])('%s claims neither Connected nor Connect', async (name) => {
        stubFetch(handler({ board: { connections: [connection('acme-example.atlassian.net')] } }));
        renderApp(PATH);

        const other = await card(name);
        expect(other.queryByText('Connected')).toBeNull();
        expect(other.queryByRole('button', { name: /Connect/ })).toBeNull();
    });
});
