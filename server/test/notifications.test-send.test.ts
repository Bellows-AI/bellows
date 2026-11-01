import { describe, expect, it } from 'vitest';
import type { NotificationEvent } from '@factory-ai/core';
import { createConnectorRegistry } from '../src/notifications/connector.js';
import { sendTestNotification, TEST_SEND_TIMEOUT_MS } from '../src/notifications/test-send.js';
import { fakeConnector } from './notifications-fake-connector.js';

/** BEL-177: the test send builds a made-up event of the row's first kind and sends it once, writing nothing. */
const ORG = 'org-a';
const NIL = '00000000-0000-0000-0000-000000000000';
const PUBLIC_URL = 'https://factory.example';
const NOW = '2026-11-01T10:00:00.000Z';

const target = (over: Record<string, unknown> = {}) => ({
    kind: 'fake',
    config: { target: 'room-1' },
    eventKinds: ['task.blocked', 'task.ready'] as never,
    credential: 'hook-secret' as string | null,
    ...over,
});

const run = (
    connector: ReturnType<typeof fakeConnector>,
    readTarget: (signal: AbortSignal) => Promise<ReturnType<typeof target> | null>,
    over: { settingsPath?: string; signal?: AbortSignal } = {}
) =>
    sendTestNotification({
        connectors: createConnectorRegistry([connector]),
        readTarget,
        orgId: ORG,
        publicUrl: PUBLIC_URL,
        settingsPath: over.settingsPath ?? '/settings/organization',
        now: () => new Date(NOW),
        signal: over.signal ?? AbortSignal.timeout(TEST_SEND_TIMEOUT_MS),
    });

describe('sendTestNotification', () => {
    it('sends an event of the first kind linking to the scope settings page; no credential in the event', async () => {
        const connector = fakeConnector('fake');

        const result = await run(connector, async () => target(), { settingsPath: '/settings/workspace' });

        expect(result).toMatchObject({ status: 'delivered' });
        const event = connector.sent[0]!.event;
        expect(event).toMatchObject({
            kind: 'task.blocked',
            orgId: ORG,
            jobId: NIL,
            threadId: NIL,
            repo: null,
            workflow: null,
            reason: null,
            prUrl: null,
            questionId: null,
            questions: null,
            action: null,
            actor: null,
            author: null,
            title: 'Test notification from Factory: this channel is subscribed.',
            link: `${PUBLIC_URL}/settings/workspace`,
            occurredAt: NOW,
        });
        expect(JSON.stringify(event)).not.toContain('hook-secret');
    });

    it('delivers once with the stored credential and config', async () => {
        const connector = fakeConnector('fake');

        await run(connector, async () => target());

        expect(connector.sent).toHaveLength(1);
        expect(connector.sent[0]).toMatchObject({ config: { target: 'room-1' }, credential: 'hook-secret' });
    });

    it('no row → null, nothing sent', async () => {
        const connector = fakeConnector('fake');

        expect(await run(connector, async () => null)).toBeNull();
        expect(connector.sent).toEqual([]);
    });

    it('unconfirmed credential → credential-unavailable, connector never called', async () => {
        const connector = fakeConnector('fake');

        const result = await run(connector, async () => target({ credential: null }));

        expect(result).toEqual({ status: 'retryable', reason: 'credential-unavailable' });
        expect(connector.sent).toEqual([]);
    });

    it('permanent verdict returned as-is', async () => {
        const connector = fakeConnector('fake', async () => ({ status: 'permanent', reason: 'destination-refused' }));

        expect(await run(connector, async () => target())).toEqual({
            status: 'permanent',
            reason: 'destination-refused',
        });
    });

    it('throwing connector → retryable connector-threw', async () => {
        const connector = fakeConnector('fake', async () => {
            throw new Error('boom');
        });

        expect(await run(connector, async () => target())).toEqual({ status: 'retryable', reason: 'connector-threw' });
    });

    it('a throwing read propagates: an unconfirmed read is not a verdict', async () => {
        const connector = fakeConnector('fake');

        await expect(
            run(connector, async () => {
                throw new Error('db down');
            })
        ).rejects.toThrow('db down');
        expect(connector.sent).toEqual([]);
    });

    it('the one signal bounds a hanging read', async () => {
        const connector = fakeConnector('fake');
        const started = Date.now();

        const result = await run(connector, () => new Promise(() => {}), { signal: AbortSignal.timeout(50) });

        expect(result).toEqual({ status: 'retryable', reason: 'aborted' });
        expect(Date.now() - started).toBeLessThan(1000);
        expect(connector.sent).toEqual([]);
    });

    it('the one signal bounds a hanging send', async () => {
        const connector = fakeConnector('fake', () => new Promise(() => {}));
        const started = Date.now();

        const result = await run(connector, async () => target(), { signal: AbortSignal.timeout(50) });

        expect(result).toEqual({ status: 'retryable', reason: 'aborted' });
        expect(Date.now() - started).toBeLessThan(1000);
    });

    it('the same signal reaches readTarget and the connector', async () => {
        const seen: AbortSignal[] = [];
        const connector = fakeConnector('fake', async (_e: NotificationEvent, _c, signal) => {
            seen.push(signal);
            return { status: 'delivered', externalId: 'x' };
        });
        const signal = AbortSignal.timeout(TEST_SEND_TIMEOUT_MS);

        await run(
            connector,
            async (readSignal) => {
                seen.push(readSignal);
                return target();
            },
            { signal }
        );

        expect(seen).toEqual([signal, signal]);
    });
});
