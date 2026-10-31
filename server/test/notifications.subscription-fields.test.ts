import { describe, expect, it } from 'vitest';
import {
    type ConnectorRegistry,
    createConnectorRegistry,
    type NotificationConnector,
} from '../src/notifications/connector.js';
import { parseSubscriptionFields } from '../src/notifications/subscription-fields.js';
import { fakeConnector } from './notifications-fake-connector.js';

const registry = createConnectorRegistry([fakeConnector('fake')]);

const parse = (raw: unknown, reg: ConnectorRegistry = registry, credentialRequired = false) =>
    parseSubscriptionFields(raw, reg, { credentialRequired });

/** A connector whose config is fine and whose validateCredential answers `answer`, or throws when it is an Error. */
const oddCredential = (answer: unknown): ConnectorRegistry =>
    createConnectorRegistry([
        {
            kind: 'odd',
            validateConfig: () => ({ ok: true, config: {} }),
            validateCredential: () => {
                if (answer instanceof Error) throw answer;
                return answer as never;
            },
            send: async () => ({ status: 'delivered' }),
        } satisfies NotificationConnector,
    ]);

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
            validateCredential: () => ({ ok: true, config: 'c' }),
            send: async () => ({ status: 'delivered' }),
        } satisfies NotificationConnector,
    ]);

describe('parseSubscriptionFields', () => {
    it('accepts a full body and stores the connector’s normalized config', () => {
        const config = { target: 'room-1' };
        const parsed = parse({ ...valid, connectorConfig: config, repos: ['acme/api'] }, registry);

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
            credential: null,
        });
        if (parsed.ok) expect(parsed.fields.connectorConfig).not.toBe(config);
    });

    it('defaults repos and workflows to empty and dedupes every list', () => {
        const defaults = parse(valid, registry);
        expect(defaults.ok && defaults.fields.repos).toEqual([]);
        expect(defaults.ok && defaults.fields.workflows).toEqual([]);

        const deduped = parse(
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
            expect(parse({ ...valid, connectorKind: 'nope' }, reg)).toMatchObject({
                ok: false,
                code: 'UNKNOWN_CONNECTOR',
            });
        }
        expect(parse(valid, createConnectorRegistry([]))).toMatchObject({
            ok: false,
            code: 'UNKNOWN_CONNECTOR',
        });
    });

    it('refuses a config the connector rejects with BAD_CONNECTOR_CONFIG and its problems', () => {
        expect(parse({ ...valid, connectorConfig: {} }, registry)).toEqual({
            ok: false,
            code: 'BAD_CONNECTOR_CONFIG',
            message: expect.any(String),
            problems: ['target must be a non-empty string'],
        });
    });

    it('refuses with BAD_CONNECTOR_CONFIG when validateConfig throws or answers malformed', () => {
        const cases = [new Error('boom'), undefined, { ok: 'yes' }, { ok: 'yes', config: {} }, null];
        for (const answer of cases) {
            const parsed = parse({ ...valid, connectorKind: 'odd' }, answering(answer));
            expect(parsed, String(answer)).toMatchObject({ ok: false, code: 'BAD_CONNECTOR_CONFIG' });
            expect(parsed).not.toHaveProperty('problems');
        }
    });

    it('credential required on create', () => {
        for (const credential of [undefined, null]) {
            expect(parse({ ...valid, credential }, registry, true)).toMatchObject({ ok: false, code: 'BAD_BODY' });
        }
        expect(parse(valid, registry, true)).toMatchObject({ ok: false, code: 'BAD_BODY' });
        expect(parse({ ...valid, credential: 'hook-secret' }, registry, true)).toMatchObject({
            ok: true,
            credential: 'hook-secret',
        });
    });

    it('credential optional on replace', () => {
        expect(parse(valid, registry, false)).toMatchObject({ ok: true, credential: null });
        expect(parse({ ...valid, credential: 'hook-secret' }, registry, false)).toMatchObject({
            ok: true,
            credential: 'hook-secret',
        });
    });

    it('credential refused by the connector → BAD_CONNECTOR_CONFIG without the value', () => {
        const refused = parse({ ...valid, credential: 7 }, registry, false);
        expect(refused).toMatchObject({ ok: false, code: 'BAD_CONNECTOR_CONFIG' });
        const rejecting = createConnectorRegistry([
            {
                ...fakeConnector('fake'),
                validateCredential: () => ({ ok: false, problems: ['not a webhook'] }),
            },
        ]);
        const secret = 'hook-secret';
        const parsed = parse({ ...valid, credential: secret }, rejecting, true);
        expect(parsed).toMatchObject({ ok: false, code: 'BAD_CONNECTOR_CONFIG', problems: ['not a webhook'] });
        expect(JSON.stringify(parsed)).not.toContain(secret);
        for (const answer of [new Error(`boom ${secret}`), undefined, { ok: 'yes' }, null]) {
            const odd = oddCredential(answer);
            const out = parse({ ...valid, connectorKind: 'odd', credential: secret }, odd, true);
            expect(out, String(answer)).toMatchObject({ ok: false, code: 'BAD_CONNECTOR_CONFIG' });
            expect(JSON.stringify(out)).not.toContain(secret);
        }
    });

    it('credential is not part of fields', () => {
        const parsed = parse({ ...valid, credential: 'hook-secret' }, registry, true);
        expect(parsed.ok).toBe(true);
        expect(parsed.ok && JSON.stringify(parsed.fields)).not.toContain('hook-secret');
        expect(parsed.ok && 'credential' in parsed.fields).toBe(false);
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
            expect(parse(raw, registry), label).toMatchObject({ ok: false, code: 'BAD_BODY' });
        }
    });
});
