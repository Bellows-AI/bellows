import {
    INTEGRATION_CATEGORIES,
    INTEGRATION_CATALOG,
    LISTED_PROVIDERS,
    canConnect,
    integrationProvider,
} from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import type { ConnectionView } from '../src/api/connections.js';
import { connectionState, integrationNotice } from '../src/settings/integration-providers.js';

const view = (over: Partial<ConnectionView> = {}): ConnectionView => ({
    id: 'c1',
    provider: 'jira',
    site: 'acme-example.atlassian.net',
    account: 'dev@acme-example.test',
    access: 'read',
    status: 'active',
    needsReconnect: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    ...over,
});

describe('connectionState', () => {
    it('is connected for an active connection whose grant is live', () => {
        expect(connectionState(view())).toBe('connected');
    });

    it('is needs-reconnect when the grant needs reconnecting', () => {
        expect(connectionState(view({ needsReconnect: true }))).toBe('needs-reconnect');
    });

    it('is disconnected for a disconnected row, whatever its grant says', () => {
        expect(connectionState(view({ status: 'disconnected' }))).toBe('disconnected');
        expect(connectionState(view({ status: 'disconnected', needsReconnect: true }))).toBe('disconnected');
    });
});

describe('the provider registry', () => {
    it('files every provider under a category from the closed list, with unique ids', () => {
        for (const provider of INTEGRATION_CATALOG) expect(INTEGRATION_CATEGORIES).toContain(provider.category);
        const ids = INTEGRATION_CATALOG.map((provider) => provider.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('files the catalog the way it is browsed', () => {
        const byCategory = (category: string) =>
            INTEGRATION_CATALOG.filter((provider) => provider.category === category).map((provider) => provider.id);
        expect(INTEGRATION_CATEGORIES).toEqual(['Issue tracking', 'Communication', 'Agent tools', 'CI / DevOps']);
        expect(byCategory('Issue tracking')).toEqual(['jira']);
        expect(byCategory('Communication')).toEqual(['slack', 'discord']);
        expect(byCategory('Agent tools')).toEqual(['mcp']);
        expect(byCategory('CI / DevOps')).toEqual(['github', 'gitlab']);
        expect(integrationProvider('mcp')?.label).toBe('MCP servers');
        expect(integrationProvider('github')?.availability).toBe('organization');
        expect(integrationProvider('gitlab')?.availability).toBe('planned');
    });

    it('lets only an oauth provider connect', () => {
        for (const provider of INTEGRATION_CATALOG) {
            expect(canConnect(provider)).toBe(provider.availability === 'oauth');
        }
        expect(canConnect(integrationProvider('jira')!)).toBe(true);
        expect(canConnect(integrationProvider('slack')!)).toBe(false);
        expect(canConnect(integrationProvider('github')!)).toBe(false);
    });

    it('lists every provider but the planned ones', () => {
        expect(LISTED_PROVIDERS.map((provider) => provider.id)).toEqual(['jira', 'github']);
    });

    it('looks a provider up by id, and answers undefined for a stranger', () => {
        expect(integrationProvider('jira')?.label).toBe('Jira');
        expect(integrationProvider('nope')).toBeUndefined();
    });
});

describe('integrationNotice', () => {
    it('keeps the Jira sentences', () => {
        expect(integrationNotice('jira', 'connected')).toEqual({ message: 'Jira connected.', tone: 'info' });
        expect(integrationNotice('jira', 'exchange-failed')?.message).toContain('exchange-failed');
    });

    it('is null for another provider, or with nothing to say', () => {
        expect(integrationNotice('slack', 'connected')).toBeNull();
        expect(integrationNotice(null, null)).toBeNull();
        expect(integrationNotice('jira', null)).toBeNull();
    });
});
