import { SEND_PERMANENT_REASONS, SEND_RETRYABLE_REASONS } from '@factory-ai/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createSubscription,
    deleteSubscription,
    listSubscriptions,
    sendTestNotification,
    testResultMessage,
    updateSubscription,
    type SubscriptionInput,
} from '../src/api/notificationSubscriptions.js';
import { subscribeUnauthenticated } from '../src/api/useSession.js';

/**
 * The notification subscriptions' client half: each scope's base path, the strict list and result
 * validators (a malformed answer is an error, never an empty list or a sent notification), the 401
 * broadcast and the refusal sentence. The routes' own answers are server/test-db's.
 */

const VIEW = {
    id: '00000000-0000-4000-8000-000000000001',
    connectorKind: 'discord',
    connectorConfig: {},
    eventKinds: ['task.ready'],
    repos: [],
    workflows: [],
    enabled: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
};
const INPUT: SubscriptionInput = {
    connectorKind: 'discord',
    connectorConfig: {},
    credential: 'https://discord.com/api/webhooks/0/test',
    eventKinds: ['task.ready'],
    repos: [],
    workflows: [],
    enabled: true,
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stub = (reply: () => Response | Promise<Response>) => {
    const fetchStub = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(reply()));
    vi.stubGlobal('fetch', fetchStub);
    return fetchStub;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('listSubscriptions', () => {
    it('reads the scope its base path names, rows and connector kinds', async () => {
        const fetchStub = stub(() => json({ subscriptions: [VIEW], connectorKinds: ['discord'] }));
        expect(await listSubscriptions('org')).toEqual({
            ok: true,
            subscriptions: [VIEW],
            connectorKinds: ['discord'],
        });
        await listSubscriptions('workspace');
        expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([
            '/api/org/notification-subscriptions',
            '/api/workspace/notification-subscriptions',
        ]);
    });

    it.each([
        ['a row without its event kinds', { subscriptions: [{ ...VIEW, eventKinds: undefined }], connectorKinds: [] }],
        ['an unknown event kind', { subscriptions: [{ ...VIEW, eventKinds: ['task.nope'] }], connectorKinds: [] }],
        ['a non-boolean enabled', { subscriptions: [{ ...VIEW, enabled: 'yes' }], connectorKinds: [] }],
        ['a missing list', { connectorKinds: ['discord'] }],
        ['a missing connectorKinds', { subscriptions: [] }],
        ['connectorKinds that is not strings', { subscriptions: [], connectorKinds: [1] }],
    ])('is an error, never an empty list, for %s', async (_name, body) => {
        stub(() => json(body));
        const listed = await listSubscriptions('org');
        expect(listed.ok).toBe(false);
    });

    it('is an error for a refusal and for a network failure', async () => {
        stub(() => json({ error: 'No subscription store for this organization' }, 503));
        expect(await listSubscriptions('org')).toEqual({
            ok: false,
            error: 'No subscription store for this organization',
        });
        vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
        expect(await listSubscriptions('org')).toEqual({ ok: false, error: 'offline' });
    });

    it('reports a 401 to every subscriber', async () => {
        const heard = vi.fn();
        const off = subscribeUnauthenticated(heard);
        try {
            stub(() => json({ error: 'Sign in required' }, 401));
            expect((await listSubscriptions('workspace')).ok).toBe(false);
            expect(heard).toHaveBeenCalledTimes(1);
        } finally {
            off();
        }
    });
});

describe('the writes', () => {
    it('create posts the body to the scope and answers null', async () => {
        const fetchStub = stub(() => json(VIEW, 201));
        expect(await createSubscription('workspace', INPUT)).toBeNull();
        const [url, init] = fetchStub.mock.calls[0]!;
        expect(url).toBe('/api/workspace/notification-subscriptions');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(init?.body as string)).toEqual(INPUT);
    });

    it('update puts to the row and delete deletes it', async () => {
        const fetchStub = stub(() => json(VIEW));
        expect(await updateSubscription('org', VIEW.id, INPUT)).toBeNull();
        expect(await deleteSubscription('org', VIEW.id)).toBeNull();
        expect(fetchStub.mock.calls.map(([url, init]) => `${init?.method} ${url}`)).toEqual([
            `PUT /api/org/notification-subscriptions/${VIEW.id}`,
            `DELETE /api/org/notification-subscriptions/${VIEW.id}`,
        ]);
    });

    it('a 400 joins the connector problems into the message', async () => {
        stub(() =>
            json(
                { error: 'the connector refused the credential', code: 'X', problems: ['credential must use https'] },
                400
            )
        );
        expect(await createSubscription('org', INPUT)).toBe(
            'the connector refused the credential: credential must use https'
        );
    });

    it('a refusal without problems is its own sentence; a 401 is reported', async () => {
        stub(() => json({ error: 'Only an organization admin can manage notification subscriptions' }, 403));
        expect(await deleteSubscription('org', VIEW.id)).toBe(
            'Only an organization admin can manage notification subscriptions'
        );
        const heard = vi.fn();
        const off = subscribeUnauthenticated(heard);
        try {
            stub(() => json({ error: 'Sign in required' }, 401));
            expect(await updateSubscription('org', VIEW.id, INPUT)).not.toBeNull();
            expect(heard).toHaveBeenCalledTimes(1);
        } finally {
            off();
        }
    });
});

describe('sendTestNotification', () => {
    it("posts to the row's test path and answers the verdict", async () => {
        const fetchStub = stub(() => json({ result: { status: 'delivered' } }));
        expect(await sendTestNotification('workspace', VIEW.id)).toEqual({ ok: true, result: { status: 'delivered' } });
        const [url, init] = fetchStub.mock.calls[0]!;
        expect(url).toBe(`/api/workspace/notification-subscriptions/${VIEW.id}/test`);
        expect(init?.method).toBe('POST');
    });

    it.each([
        ['a missing result', {}],
        ['an unknown status', { result: { status: 'sent' } }],
        ['an unknown reason', { result: { status: 'permanent', reason: 'nope' } }],
        ['a non-object result', { result: 'delivered' }],
    ])('is an error, never "sent", for %s', async (_name, body) => {
        stub(() => json(body));
        expect((await sendTestNotification('org', VIEW.id)).ok).toBe(false);
    });

    it('is an error for a refusal (PUBLIC_URL unset) and reports a 401', async () => {
        stub(() => json({ error: 'Notifications are off', code: 'UNAVAILABLE' }, 503));
        expect(await sendTestNotification('org', VIEW.id)).toEqual({ ok: false, error: 'Notifications are off' });
        const heard = vi.fn();
        const off = subscribeUnauthenticated(heard);
        try {
            stub(() => json({}, 401));
            expect((await sendTestNotification('org', VIEW.id)).ok).toBe(false);
            expect(heard).toHaveBeenCalledTimes(1);
        } finally {
            off();
        }
    });
});

describe('testResultMessage', () => {
    it('says delivered in one sentence', () => {
        expect(testResultMessage({ status: 'delivered' })).toMatch(/delivered/i);
    });

    it.each([...SEND_RETRYABLE_REASONS])('names the retryable reason %s', (reason) => {
        const message = testResultMessage({ status: 'retryable', reason });
        expect(message.length).toBeGreaterThan(10);
        expect(message).not.toMatch(/delivered/i);
    });

    it.each([...SEND_PERMANENT_REASONS])('names the permanent reason %s', (reason) => {
        const message = testResultMessage({ status: 'permanent', reason });
        expect(message.length).toBeGreaterThan(10);
        expect(message).not.toMatch(/delivered/i);
    });

    it('reads an aborted verdict as no answer, never as not sent', () => {
        const message = testResultMessage({ status: 'retryable', reason: 'aborted' });
        expect(message).toMatch(/did not answer/i);
        expect(message).not.toMatch(/not sent/i);
    });

    it('turns a rate limit into its wait', () => {
        expect(testResultMessage({ status: 'retryable', reason: 'rate-limited', retryAfterMs: 4000 })).toMatch(/4 s/);
    });
});
