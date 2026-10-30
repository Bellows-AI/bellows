import { type NotificationEvent, notificationEventOf } from '@factory-ai/core';
import { describe, expect, it } from 'vitest';
import { createConnectorRegistry, deliver } from '../src/notifications/connector.js';
import { fakeConnector } from './notifications-fake-connector.js';

const event: NotificationEvent = notificationEventOf(
    {
        id: '11111111-1111-4111-8111-111111111111',
        kind: 'task.blocked',
        orgId: '42',
        jobId: '22222222-2222-4222-8222-222222222222',
        rootJobId: '33333333-3333-4333-8333-333333333333',
        repo: 'acme/widgets',
        workflow: 'walk',
        command: 'fix it',
        reason: 'policy',
        prUrl: null,
        questionId: null,
        questions: null,
        occurredAt: '2026-10-30T10:00:00.000Z',
    },
    'https://factory.example.com'
);
const ok = { target: 'room-1' };
const live = () => new AbortController().signal;

describe('createConnectorRegistry', () => {
    it('refuses a duplicate kind', () => {
        expect(() => createConnectorRegistry([fakeConnector('a'), fakeConnector('a')])).toThrow();
    });

    it('refuses an empty kind', () => {
        expect(() => createConnectorRegistry([fakeConnector('')])).toThrow();
    });
});

describe('deliver', () => {
    it('delivers through the fake and passes event and config separately', async () => {
        const fake = fakeConnector('fake');
        const result = await deliver(createConnectorRegistry([fake]), { kind: 'fake', config: ok }, event, live());
        expect(result).toEqual({ status: 'delivered', externalId: `fake-${event.id}` });
        expect(fake.sent[0]!.event).toBe(event);
        expect(fake.sent[0]!.config).toEqual(ok);
        expect('config' in event).toBe(false);
    });

    it('second kind needs no edit', async () => {
        const a = fakeConnector('a');
        const b = fakeConnector('b');
        const registry = createConnectorRegistry([a, b]);
        const other = { ...event, id: '99999999-9999-4999-8999-999999999999' };
        await deliver(registry, { kind: 'a', config: ok }, event, live());
        await deliver(registry, { kind: 'b', config: ok }, other, live());
        expect(a.sent.map((s) => s.event)).toEqual([event]);
        expect(b.sent.map((s) => s.event)).toEqual([other]);
    });

    it('unknown kind is retryable', async () => {
        const fake = fakeConnector('fake');
        const result = await deliver(createConnectorRegistry([fake]), { kind: 'nope', config: ok }, event, live());
        expect(result).toEqual({ status: 'retryable', reason: 'unknown-kind' });
        expect(fake.sent).toEqual([]);
    });

    it('invalid config is permanent and does not echo the config', async () => {
        const fake = fakeConnector('fake');
        const result = await deliver(
            createConnectorRegistry([fake]),
            { kind: 'fake', config: { target: '', secret: 'S3CRET' } },
            event,
            live()
        );
        expect(result).toEqual({ status: 'permanent', reason: 'config-invalid' });
        expect(JSON.stringify(result)).not.toContain('S3CRET');
        expect(fake.sent).toEqual([]);
    });

    it('validateConfig throwing is retryable', async () => {
        const fake = fakeConnector('fake');
        fake.validateConfig = () => {
            throw new Error('boom');
        };
        const result = await deliver(createConnectorRegistry([fake]), { kind: 'fake', config: ok }, event, live());
        expect(result).toEqual({ status: 'retryable', reason: 'connector-threw' });
        expect(fake.sent).toEqual([]);
    });

    it('connector results pass through', async () => {
        for (const scripted of [
            { status: 'retryable', reason: 'rate-limited', retryAfterMs: 5000 },
            { status: 'permanent', reason: 'destination-refused' },
        ]) {
            const fake = fakeConnector('fake', async () => scripted);
            const result = await deliver(createConnectorRegistry([fake]), { kind: 'fake', config: ok }, event, live());
            expect(result).toEqual(scripted);
        }
    });

    it('send throwing is retryable, never permanent', async () => {
        const fake = fakeConnector('fake', async () => {
            throw new Error('boom');
        });
        const result = await deliver(createConnectorRegistry([fake]), { kind: 'fake', config: ok }, event, live());
        expect(result).toEqual({ status: 'retryable', reason: 'connector-threw' });
    });

    it('malformed result is retryable', async () => {
        for (const scripted of [
            { status: 'delivered', body: 'x' },
            undefined,
            { status: 'permanent', reason: 'nope' },
        ]) {
            const fake = fakeConnector('fake', async () => scripted);
            const result = await deliver(createConnectorRegistry([fake]), { kind: 'fake', config: ok }, event, live());
            expect(result).toEqual({ status: 'retryable', reason: 'malformed-result' });
        }
    });

    it('pre-aborted signal skips send', async () => {
        const fake = fakeConnector('fake');
        const result = await deliver(
            createConnectorRegistry([fake]),
            { kind: 'fake', config: ok },
            event,
            AbortSignal.abort()
        );
        expect(result).toEqual({ status: 'retryable', reason: 'aborted' });
        expect(fake.sent).toEqual([]);
    });

    it('abort mid-send settles without waiting for the connector', async () => {
        const fake = fakeConnector('fake', () => new Promise(() => {}));
        const ac = new AbortController();
        const pending = deliver(createConnectorRegistry([fake]), { kind: 'fake', config: ok }, event, ac.signal);
        await Promise.resolve();
        ac.abort();
        expect(await pending).toEqual({ status: 'retryable', reason: 'aborted' });
        expect(fake.sent).toHaveLength(1);
    });

    it('a rejection after abort is labelled aborted', async () => {
        const ac = new AbortController();
        const fake = fakeConnector('fake', async () => {
            ac.abort();
            throw new Error('cancelled');
        });
        const result = await deliver(createConnectorRegistry([fake]), { kind: 'fake', config: ok }, event, ac.signal);
        expect(result).toEqual({ status: 'retryable', reason: 'aborted' });
    });

    it('the connector receives the caller signal', async () => {
        const signal = live();
        let seen: AbortSignal | undefined;
        const fake = fakeConnector('fake', async (_e, _c, s) => {
            seen = s;
            return { status: 'delivered' };
        });
        await deliver(createConnectorRegistry([fake]), { kind: 'fake', config: ok }, event, signal);
        expect(seen).toBe(signal);
    });

    it('abort listener removed on every settle path', async () => {
        const paths: Array<(ac: AbortController) => Promise<unknown>> = [
            async () => ({ status: 'delivered' }),
            async () => {
                throw new Error('boom');
            },
            async () => ({ nope: true }),
            (ac) => {
                queueMicrotask(() => ac.abort());
                return new Promise(() => {});
            },
        ];
        for (const script of paths) {
            const ac = new AbortController();
            let added = 0;
            let removed = 0;
            const add = ac.signal.addEventListener.bind(ac.signal);
            const remove = ac.signal.removeEventListener.bind(ac.signal);
            ac.signal.addEventListener = ((...a: Parameters<typeof add>) => {
                added++;
                return add(...a);
            }) as typeof add;
            ac.signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
                removed++;
                return remove(...a);
            }) as typeof remove;
            const fake = fakeConnector('fake', () => script(ac));
            await deliver(createConnectorRegistry([fake]), { kind: 'fake', config: ok }, event, ac.signal);
            expect(added).toBeGreaterThan(0);
            expect(removed).toBe(added);
        }
    });
});
