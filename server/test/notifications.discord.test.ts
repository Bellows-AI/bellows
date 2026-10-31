import { isSendResult, type NotificationEvent, type NotificationKind, notificationEventOf } from '@factory-ai/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createConnectorRegistry, deliver } from '../src/notifications/connector.js';
import { createDiscordConnector, embedOf } from '../src/notifications/discord.js';
import {
    type FakeDiscord,
    hang,
    invalidForm,
    invalidToken,
    messageOk,
    rateLimited,
    redirect,
    type Reply,
    serverError,
    startFakeDiscord,
    tooBig,
    unknownWebhook,
} from './fake-discord.js';

/** BEL-132: the Discord connector against a local fake of Discord's webhook route. No real Discord is ever called. */
const ID = '123456789012345678';
const TOKEN = 'abc_DEF-ghi0123';
const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
const ZWSP = '​';

const eventOf = (over: Partial<NotificationEvent> = {}): NotificationEvent => ({
    ...notificationEventOf(
        {
            id: '11111111-1111-4111-8111-111111111111',
            kind: 'task.blocked',
            orgId: '42',
            jobId: '22222222-2222-4222-8222-222222222222',
            rootJobId: '33333333-3333-4333-8333-333333333333',
            repo: 'acme/widgets',
            workflow: 'walk',
            command: 'fix the build\nwith details',
            reason: 'policy refused the change',
            prUrl: null,
            questionId: null,
            questions: null,
            action: null,
            actor: null,
            author: null,
            occurredAt: '2026-10-30T10:00:00.000Z',
        },
        'https://factory.example.com'
    ),
    ...over,
});

const connector = createDiscordConnector();
const config = {};

describe('discord connector: validation', () => {
    it('credential: accepts discord.com and discordapp.com webhook URLs and normalizes to discord.com', () => {
        for (const host of ['discord.com', 'discordapp.com', 'DISCORD.COM']) {
            expect(connector.validateCredential(`https://${host}/api/webhooks/${ID}/${TOKEN}`)).toEqual({
                ok: true,
                config: URL_OK,
            });
        }
        expect(connector.validateCredential(`https://discord.com:443/api/webhooks/${ID}/${TOKEN}`)).toEqual({
            ok: true,
            config: URL_OK,
        });
    });

    it('credential: refuses http, other hosts (ptb./canary. included), ports, userinfo, query, hash, wrong path, non-digit id; problems never contain the input', () => {
        const refused = [
            `http://discord.com/api/webhooks/${ID}/${TOKEN}`,
            `https://ptb.discord.com/api/webhooks/${ID}/${TOKEN}`,
            `https://canary.discord.com/api/webhooks/${ID}/${TOKEN}`,
            `https://discord.com.evil.example/api/webhooks/${ID}/${TOKEN}`,
            `https://evil.example/discord.com/api/webhooks/${ID}/${TOKEN}`,
            `https://discord.com@evil.example/api/webhooks/${ID}/${TOKEN}`,
            `https://127.0.0.1/api/webhooks/${ID}/${TOKEN}`,
            `https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`,
            `https://user:pw@discord.com/api/webhooks/${ID}/${TOKEN}`,
            `https://discord.com/api/webhooks/${ID}/${TOKEN}?thread_id=1`,
            `https://discord.com/api/webhooks/${ID}/${TOKEN}#frag`,
            `https://discord.com/api/webhooks/${ID}/${TOKEN}/github`,
            `https://discord.com/api/webhooks/${ID}`,
            `https://discord.com/api/v10/webhooks/${ID}/${TOKEN}`,
            `https://discord.com/api/webhooks/${ID}/%41%42`,
            `https://discord.com/api/webhooks/${ID}/../../x`,
            `https://discord.com/api/webhooks/12345/${TOKEN}`,
            `https://discord.com/api/webhooks/${'9'.repeat(21)}/${TOKEN}`,
            `https://discord.com/api/webhooks/12345678901234567x/${TOKEN}`,
            `https://discord.com/api/webhooks/${ID}/${'t'.repeat(101)}`,
            'not a url',
            '',
        ];
        for (const input of refused) {
            const verdict = connector.validateCredential(input);
            expect(verdict.ok, input).toBe(false);
            if (!verdict.ok) {
                expect(verdict.problems.length).toBeGreaterThan(0);
                for (const problem of verdict.problems) {
                    expect(problem).not.toContain(input === '' ? '\u0000' : input);
                    expect(problem).not.toContain(TOKEN);
                }
            }
        }
        for (const input of [undefined, null, 7, {}, [URL_OK]]) {
            expect(connector.validateCredential(input).ok, String(input)).toBe(false);
        }
    });

    it('config: accepts only {}', () => {
        expect(connector.validateConfig({})).toEqual({ ok: true, config: {} });
        for (const input of [{ a: 1 }, null, undefined, [], 'x', { webhook: URL_OK }]) {
            expect(connector.validateConfig(input).ok, JSON.stringify(input)).toBe(false);
        }
    });
});

describe('discord embed', () => {
    it('title, url=link, description=task title, timestamp, colour per kind', () => {
        const expected: Array<[NotificationKind, string, number]> = [
            ['task.ready', 'Task ready for review', 0x2ecc71],
            ['task.blocked', 'Task blocked', 0xe74c3c],
            ['task.question', 'Agent asked a question', 0xf1c40f],
            ['task.admin_action', 'An admin acted on a task', 0x3498db],
        ];
        for (const [kind, title, color] of expected) {
            const event = eventOf({ kind });
            expect(embedOf(event)).toMatchObject({
                title,
                url: event.link,
                description: 'fix the build',
                timestamp: event.occurredAt,
                color,
            });
        }
    });

    it('Repo/Reason/Question fields present only when set; empty values omitted', () => {
        const full = embedOf(eventOf({ kind: 'task.question', questions: ['Which db?', 'Which cache?'] }));
        expect(full.fields).toEqual([
            { name: 'Repo', value: 'acme/widgets', inline: true },
            { name: 'Reason', value: 'policy refused the change' },
            { name: 'Question', value: 'Which db?\n\nWhich cache?' },
        ]);
        const bare = embedOf(eventOf({ repo: null, reason: null, questions: null }));
        expect(bare.fields).toBeUndefined();
        const empties = embedOf(eventOf({ repo: '', reason: '', questions: [''], title: '' }));
        expect(empties.fields).toBeUndefined();
        expect('description' in empties).toBe(false);
    });

    it('an admin action names what was done, by whom and for whose task', () => {
        const embed = embedOf(
            eventOf({
                kind: 'task.admin_action',
                reason: null,
                action: 'follow-up',
                actor: { id: 'u-admin', login: 'admin-cat' },
                author: { id: 'u-author', login: '@author-dog' },
            })
        );
        expect(embed.fields).toEqual([
            { name: 'Repo', value: 'acme/widgets', inline: true },
            { name: 'Action', value: 'follow-up', inline: true },
            { name: 'By', value: 'admin-cat', inline: true },
            { name: 'On behalf of', value: `@${ZWSP}author-dog`, inline: true },
        ]);
        const unknown = embedOf(
            eventOf({
                kind: 'task.admin_action',
                reason: null,
                action: 'retry',
                actor: null,
                author: { id: 'u', login: null },
            })
        );
        expect(unknown.fields).toEqual([
            { name: 'Repo', value: 'acme/widgets', inline: true },
            { name: 'Action', value: 'retry', inline: true },
        ]);
    });

    it('truncates title 256, description 4096, field 1024, total ≤ 6000; never splits a surrogate pair', () => {
        const long = 'a'.repeat(10_000);
        const embed = embedOf(eventOf({ title: long, reason: long, questions: [long, long], repo: long }));
        const total = (embed.title?.length ?? 0) + (embed.description?.length ?? 0);
        expect((embed.title ?? '').length).toBeLessThanOrEqual(256);
        for (const field of embed.fields ?? []) {
            expect(field.name.length).toBeLessThanOrEqual(256);
            expect(field.value.length).toBeLessThanOrEqual(1024);
            expect(field.value.endsWith('…')).toBe(true);
        }
        const sum = total + (embed.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
        expect(sum).toBeLessThanOrEqual(6000);
        expect((embed.description ?? '').length).toBeLessThanOrEqual(4096);
        expect((embed.description ?? '').endsWith('…')).toBe(true);

        const lone = embedOf(eventOf({ title: '😀'.repeat(3000), reason: null, repo: null }));
        const desc = lone.description ?? '';
        expect(desc.length).toBeLessThanOrEqual(4096);
        const body = desc.slice(0, -1);
        expect(body.endsWith('😀')).toBe(true);
        expect(/[\ud800-\udbff]$/.test(body)).toBe(false);
        expect(/^(?:[\ud800-\udbff][\udc00-\udfff])*$/.test(body)).toBe(true);
    });

    it('neutralizes @everyone, @here, <@id>, <@&id> in every task-derived string; body carries allowed_mentions.parse = []', () => {
        const nasty = '@everyone @here <@123> <@!123> <@&456>';
        const embed = embedOf(
            eventOf({ title: nasty, repo: nasty, reason: nasty, questions: [nasty], kind: 'task.question' })
        );
        const strings = [embed.description, ...(embed.fields ?? []).map((f) => f.value)];
        expect(strings).toHaveLength(4);
        for (const text of strings) {
            expect(text).not.toMatch(/@(?!​)/);
            expect(text).toContain(`@${ZWSP}everyone`);
            expect(text).toContain(`<@${ZWSP}&456>`);
        }
    });
});

let fake: FakeDiscord | undefined;
afterEach(async () => {
    await fake?.close();
    fake = undefined;
});

/** A `fetch` that refuses everything but `https://discord.com` and rewrites that to the fake's origin. */
async function setup(reply: Reply = messageOk()) {
    fake = await startFakeDiscord();
    fake.reply(reply);
    const target = fake;
    const seen: string[] = [];
    const fetchFn: typeof fetch = (input, init) => {
        const url = new URL(String(input));
        seen.push(url.origin);
        if (url.origin !== 'https://discord.com') return Promise.reject(new Error('real network refused'));
        return fetch(`${target.origin}${url.pathname}${url.search}`, init);
    };
    return { fake: target, seen, discord: createDiscordConnector({ fetch: fetchFn }) };
}

const live = () => AbortSignal.timeout(5000);

describe('discord connector: send', () => {
    it('200 ?wait=true → delivered with externalId = message id; request is POST JSON to /api/webhooks/<id>/<token> with wait=true', async () => {
        const { fake, seen, discord } = await setup(messageOk('4000000000000000004'));

        const result = await discord.send(eventOf(), config, URL_OK, live());

        expect(result).toEqual({ status: 'delivered', externalId: '4000000000000000004' });
        expect(seen).toEqual(['https://discord.com']);
        expect(fake.requests).toHaveLength(1);
        const [request] = fake.requests;
        expect(request).toMatchObject({
            method: 'POST',
            path: `/api/webhooks/${ID}/${TOKEN}`,
            query: { wait: 'true' },
        });
        expect(request!.headers['content-type']).toBe('application/json');
        expect(request!.json).toEqual({
            embeds: [embedOf(eventOf())],
            allowed_mentions: { parse: [] },
        });
    });

    it('2xx with malformed or oversized body → delivered without externalId; body cancelled', async () => {
        for (const reply of [
            { status: 200, body: 'not json' },
            { status: 204 },
            { status: 200, body: '{"id":7}' },
            { status: 200, body: '{"id":"abc"}' },
            tooBig,
        ] satisfies Reply[]) {
            const { discord } = await setup(reply);
            expect(await discord.send(eventOf(), config, URL_OK, live()), JSON.stringify(reply).slice(0, 40)).toEqual({
                status: 'delivered',
            });
            await fake?.close();
        }
    });

    it('429 → rate-limited with retryAfterMs 529 from JSON; header fallback when JSON absent; none when both invalid', async () => {
        const cases: Array<[Reply, { retryAfterMs?: number }]> = [
            [rateLimited, { retryAfterMs: 529 }],
            [{ status: 429, headers: { 'retry-after': '2' }, body: 'oops' }, { retryAfterMs: 2000 }],
            [{ status: 429, headers: { 'retry-after': '2' }, body: '{"retry_after":-1}' }, { retryAfterMs: 2000 }],
            [{ status: 429, headers: { 'retry-after': 'soon' }, body: '{"retry_after":"x"}' }, {}],
            [{ status: 429 }, {}],
        ];
        for (const [reply, expected] of cases) {
            const { discord } = await setup(reply);
            const result = await discord.send(eventOf(), config, URL_OK, live());
            expect(result, JSON.stringify(reply)).toEqual({ status: 'retryable', reason: 'rate-limited', ...expected });
            await fake?.close();
        }
    });

    it('401/403/404 → permanent destination-refused', async () => {
        for (const reply of [invalidToken, { status: 403, body: '{}' }, unknownWebhook] satisfies Reply[]) {
            const { discord } = await setup(reply);
            expect(await discord.send(eventOf(), config, URL_OK, live()), String(reply.status)).toEqual({
                status: 'permanent',
                reason: 'destination-refused',
            });
            await fake?.close();
        }
    });

    it('400/413 → permanent payload-refused', async () => {
        for (const reply of [invalidForm, { status: 413 }] satisfies Reply[]) {
            const { discord } = await setup(reply);
            expect(await discord.send(eventOf(), config, URL_OK, live()), String(reply.status)).toEqual({
                status: 'permanent',
                reason: 'payload-refused',
            });
            await fake?.close();
        }
    });

    it('500/502/503 and an unlisted 4xx/3xx → retryable upstream-error', async () => {
        for (const reply of [
            { status: 500 },
            serverError,
            { status: 503 },
            { status: 405 },
            { status: 410 },
            { status: 304 },
        ] satisfies Reply[]) {
            const { discord } = await setup(reply);
            expect(await discord.send(eventOf(), config, URL_OK, live()), String(reply.status)).toEqual({
                status: 'retryable',
                reason: 'upstream-error',
            });
            await fake?.close();
        }
    });

    it('redirect is never followed: 302 → retryable, fake sees no second request', async () => {
        const { fake, discord } = await setup(redirect);

        const result = await discord.send(eventOf(), config, URL_OK, live());

        expect(result.status).toBe('retryable');
        expect(fake.requests).toHaveLength(1);
    });

    it('connection refused → retryable transport', async () => {
        const gone = await startFakeDiscord();
        const { origin } = gone;
        await gone.close();
        const discord = createDiscordConnector({
            fetch: (input, init) => fetch(`${origin}${new URL(String(input)).pathname}`, init),
        });

        expect(await discord.send(eventOf(), config, URL_OK, live())).toEqual({
            status: 'retryable',
            reason: 'transport',
        });
    });

    it('abort before and during the request (and during a hanging body) → retryable aborted, settles promptly, the socket closes', async () => {
        const { fake, discord } = await setup(hang);
        const before = await discord.send(eventOf(), config, URL_OK, AbortSignal.abort());
        expect(before).toEqual({ status: 'retryable', reason: 'aborted' });
        expect(fake.requests).toHaveLength(0);

        const started = Date.now();
        const during = await discord.send(eventOf(), config, URL_OK, AbortSignal.timeout(150));
        expect(during).toEqual({ status: 'retryable', reason: 'aborted' });
        expect(Date.now() - started).toBeLessThan(3000);
        const until = Date.now() + 3000;
        while (fake.openSockets() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
        expect(fake.openSockets()).toBe(0);

        const slowHeaders = createDiscordConnector({
            fetch: (_i, init) =>
                new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('x')))),
        });
        expect(await slowHeaders.send(eventOf(), config, URL_OK, AbortSignal.timeout(100))).toEqual({
            status: 'retryable',
            reason: 'aborted',
        });
    });

    it('isSendResult holds for every answer above', async () => {
        const replies: Reply[] = [
            messageOk(),
            tooBig,
            rateLimited,
            unknownWebhook,
            invalidToken,
            invalidForm,
            serverError,
            redirect,
            { status: 204 },
            { status: 429 },
        ];
        for (const reply of replies) {
            const { discord } = await setup(reply);
            const result = await discord.send(eventOf(), config, URL_OK, live());
            expect(isSendResult(result), `${reply.status} ${JSON.stringify(result)}`).toBe(true);
            await fake?.close();
        }
    });

    it('through deliver: the normalized credential is what send posts to, and a bad credential never reaches the network', async () => {
        const { fake, discord } = await setup();
        const registry = createConnectorRegistry([discord]);

        const ok = await deliver(
            registry,
            { kind: 'discord', config: {}, credential: `https://discordapp.com/api/webhooks/${ID}/${TOKEN}` },
            eventOf(),
            live()
        );
        const bad = await deliver(
            registry,
            { kind: 'discord', config: {}, credential: `https://evil.example/api/webhooks/${ID}/${TOKEN}` },
            eventOf(),
            live()
        );

        expect(ok.status).toBe('delivered');
        expect(bad).toEqual({ status: 'permanent', reason: 'config-invalid' });
        expect(fake.requests).toHaveLength(1);
    });
});
