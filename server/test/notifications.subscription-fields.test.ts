import { describe, expect, it } from 'vitest';
import { createConnectorRegistry, type NotificationConnector } from '../src/notifications/connector.js';
import { parseSubscriptionFields } from '../src/notifications/subscription-fields.js';
import { fakeConnector } from './notifications-fake-connector.js';

const registry = createConnectorRegistry([fakeConnector('fake')]);

const valid = {
    connectorKind: 'fake',
    connectorConfig: { target: 'room-1' },
    eventKinds: ['task.ready'],
    enabled: true,
};

/** A connector whose validateConfig answers `answer`, or throws when `answer` is an Error. */
const answering = (answer: unknown): ReturnType<typeof createConnectorRegistry> =>
    createConnectorRegistry([
        {
            kind: 'odd',
            validateConfig: () => {
                if (answer instanceof Error) throw answer;
                return answer as never;
            },
            send: async () => ({ status: 'delivered' }),
        } satisfies NotificationConnector,
    ]);

describe('parseSubscriptionFields', () => {
    it('accepts a full body and stores the connector’s normalized config', () => {
        const config = { target: 'room-1' };
        const parsed = parseSubscriptionFields({ ...valid, connectorConfig: config, repos: ['acme/api'] }, registry);

        expect(parsed).toEqual({
            ok: true,
            fields: {
                connectorKind: 'fake',
                connectorConfig: { target: 'room-1' },
                eventKinds: ['task.ready'],
                repos: ['acme/api'],
                workflows: [],
                enabled: true,
            },
        });
        if (parsed.ok) expect(parsed.fields.connectorConfig).not.toBe(config);
    });

    it('defaults repos and workflows to empty and dedupes every list', () => {
        const defaults = parseSubscriptionFields(valid, registry);
        expect(defaults.ok && defaults.fields.repos).toEqual([]);
        expect(defaults.ok && defaults.fields.workflows).toEqual([]);

        const deduped = parseSubscriptionFields(
            {
                ...valid,
                eventKinds: ['task.ready', 'task.blocked', 'task.ready'],
                repos: ['acme/api', 'acme/api'],
                workflows: ['w', 'w'],
            },
            registry
        );
        expect(deduped.ok && deduped.fields).toMatchObject({
            eventKinds: ['task.ready', 'task.blocked'],
            repos: ['acme/api'],
            workflows: ['w'],
        });
    });

    it('refuses an unknown kind with UNKNOWN_CONNECTOR, also against an empty registry', () => {
        for (const reg of [registry, createConnectorRegistry([])]) {
            expect(parseSubscriptionFields({ ...valid, connectorKind: 'nope' }, reg)).toMatchObject({
                ok: false,
                code: 'UNKNOWN_CONNECTOR',
            });
        }
        expect(parseSubscriptionFields(valid, createConnectorRegistry([]))).toMatchObject({
            ok: false,
            code: 'UNKNOWN_CONNECTOR',
        });
    });

    it('refuses a config the connector rejects with BAD_CONNECTOR_CONFIG and its problems', () => {
        expect(parseSubscriptionFields({ ...valid, connectorConfig: {} }, registry)).toEqual({
            ok: false,
            code: 'BAD_CONNECTOR_CONFIG',
            message: expect.any(String),
            problems: ['target must be a non-empty string'],
        });
    });

    it('refuses with BAD_CONNECTOR_CONFIG when validateConfig throws or answers malformed', () => {
        const cases = [new Error('boom'), undefined, { ok: 'yes' }, { ok: 'yes', config: {} }, null];
        for (const answer of cases) {
            const parsed = parseSubscriptionFields({ ...valid, connectorKind: 'odd' }, answering(answer));
            expect(parsed, String(answer)).toMatchObject({ ok: false, code: 'BAD_CONNECTOR_CONFIG' });
            expect(parsed).not.toHaveProperty('problems');
        }
    });

    it('refuses malformed fields with BAD_BODY', () => {
        const bad: Array<[string, unknown]> = [
            ['an empty event kind list', { ...valid, eventKinds: [] }],
            ['an unknown event kind', { ...valid, eventKinds: ['task.exploded'] }],
            ['a missing event kind list', { ...valid, eventKinds: undefined }],
            ['a repo that is not owner/name', { ...valid, repos: ['acme'] }],
            ['a non-string repo', { ...valid, repos: [1] }],
            ['an empty workflow name', { ...valid, workflows: [''] }],
            ['a missing enabled', { ...valid, enabled: undefined }],
            ['a non-boolean enabled', { ...valid, enabled: 'true' }],
            ['an unknown body key', { ...valid, extra: 1 }],
            ['an empty connector kind', { ...valid, connectorKind: '' }],
            ['a non-object body', 'text'],
            ['an array body', []],
            ['a null body', null],
        ];
        for (const [label, raw] of bad) {
            expect(parseSubscriptionFields(raw, registry), label).toMatchObject({ ok: false, code: 'BAD_BODY' });
        }
    });
});
