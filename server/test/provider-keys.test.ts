import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProviderKeys, type ProviderKeysOptions } from '../src/provider-keys/verify.js';
import {
    type FakeProvider,
    forbidden,
    liteLlmKeyInfo,
    modelList,
    notFound,
    notJson,
    openRouterKey,
    redirect,
    serverError,
    stall,
    startFakeProvider,
    tooBig,
    trickle,
    unauthorized,
    json,
} from './fake-provider.js';

/**
 * Offline: the board's provider key check against a fake provider on loopback. Only 401/403 is a verdict on
 * the key; everything else that goes wrong is the provider's or the network's, never INVALID_KEY.
 */

const KEY = 'sk-test-0123456789abcdef-secret';
const DEADLINE_MS = 200;
const ANSWER_WITHIN_MS = 2000;

let fake: FakeProvider;
beforeEach(async () => {
    fake = await startFakeProvider();
});
afterEach(async () => {
    await fake.close();
});

const keys = (options: Partial<ProviderKeysOptions> = {}) =>
    createProviderKeys({
        deploymentMode: 'self-hosted',
        endpoints: { anthropic: fake.origin, openai: fake.origin, openrouter: `${fake.origin}/api` },
        ...options,
    });

describe('each provider, when the key is good', () => {
    it('anthropic: lists the models, sending x-api-key and anthropic-version', async () => {
        fake.reply('/v1/models', modelList('claude-sonnet-4-5', 'claude-opus-4-1'));
        const answer = await keys().verify({ subscriptionAllowed: true, provider: 'anthropic', key: KEY });
        expect(answer).toEqual({ ok: true, models: ['claude-sonnet-4-5', 'claude-opus-4-1'] });
        const [seen] = fake.requests;
        expect(seen?.method).toBe('GET');
        expect(seen?.headers['x-api-key']).toBe(KEY);
        expect(seen?.headers['anthropic-version']).toBeTruthy();
        expect(seen?.headers.authorization).toBeUndefined();
    });

    it('openai: lists the models with a bearer key', async () => {
        fake.reply('/v1/models', modelList('gpt-5', 'gpt-5-mini'));
        const answer = await keys().verify({ subscriptionAllowed: true, provider: 'openai', key: KEY });
        expect(answer).toEqual({ ok: true, models: ['gpt-5', 'gpt-5-mini'] });
        expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it('openrouter: answers the credit left and the limit', async () => {
        fake.reply('/api/v1/key', openRouterKey(7.5, 10, 2.5));
        const answer = await keys().verify({ subscriptionAllowed: true, provider: 'openrouter', key: KEY });
        expect(answer).toEqual({ ok: true, creditUsd: 7.5, budget: { limitUsd: 10, usedUsd: 2.5 } });
        expect(fake.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
    });

    it('openrouter: an unlimited key (null limit) is ok without a credit figure', async () => {
        fake.reply('/api/v1/key', openRouterKey(null, null, 1));
        expect(await keys().verify({ subscriptionAllowed: true, provider: 'openrouter', key: KEY })).toEqual({
            ok: true,
        });
    });

    it('litellm: lists the models and reads the budget from /key/info', async () => {
        fake.reply('/v1/models', modelList('gpt-4o', 'claude-sonnet'));
        fake.reply('/key/info', liteLlmKeyInfo(100, 12.25));
        const answer = await keys().verify({
            subscriptionAllowed: true,
            provider: 'litellm',
            key: KEY,
            baseUrl: fake.origin,
        });
        expect(answer).toEqual({
            ok: true,
            models: ['gpt-4o', 'claude-sonnet'],
            budget: { limitUsd: 100, usedUsd: 12.25 },
        });
        expect(fake.requests.map((r) => r.path)).toEqual(['/v1/models', '/key/info']);
        expect(fake.requests.every((r) => r.headers.authorization === `Bearer ${KEY}`)).toBe(true);
    });

    it('litellm: /key/info 404 is ok with the models only, never a zero budget', async () => {
        fake.reply('/v1/models', modelList('gpt-4o'));
        fake.reply('/key/info', notFound);
        expect(
            await keys().verify({ subscriptionAllowed: true, provider: 'litellm', key: KEY, baseUrl: fake.origin })
        ).toEqual({
            ok: true,
            models: ['gpt-4o'],
        });
    });

    it('litellm: /key/info without a numeric budget omits it', async () => {
        fake.reply('/v1/models', modelList('gpt-4o'));
        fake.reply('/key/info', liteLlmKeyInfo(null, 3));
        expect(
            await keys().verify({
                subscriptionAllowed: true,
                provider: 'litellm',
                key: KEY,
                baseUrl: `${fake.origin}/`,
            })
        ).toEqual({
            ok: true,
            models: ['gpt-4o'],
        });
    });

    it('subscription: a token with the subscription prefix passes a format check, with no request', async () => {
        const answer = await keys().verify({
            subscriptionAllowed: true,
            provider: 'subscription',
            key: 'sk-ant-oat01-abcdef',
        });
        expect(answer).toEqual({ ok: true });
        expect(fake.requests).toEqual([]);
    });
});

describe('codes', () => {
    it.each([
        ['401', unauthorized],
        ['403', forbidden],
    ])('%s is INVALID_KEY', async (_label, reply) => {
        fake.reply('/v1/models', reply);
        const answer = await keys().verify({ subscriptionAllowed: true, provider: 'anthropic', key: KEY });
        expect(answer).toMatchObject({ ok: false, code: 'INVALID_KEY' });
    });

    it('openrouter credit 0 is NO_CREDIT', async () => {
        fake.reply('/api/v1/key', openRouterKey(0, 10, 10));
        expect(await keys().verify({ subscriptionAllowed: true, provider: 'openrouter', key: KEY })).toMatchObject({
            ok: false,
            code: 'NO_CREDIT',
        });
    });

    it('openrouter without the remaining-credit field is BAD_RESPONSE, never NO_CREDIT', async () => {
        fake.reply('/api/v1/key', json({ data: { limit: 10, usage: 1 } }));
        expect(await keys().verify({ subscriptionAllowed: true, provider: 'openrouter', key: KEY })).toMatchObject({
            ok: false,
            code: 'BAD_RESPONSE',
        });
    });

    it('connection refused is UNREACHABLE', async () => {
        const port = fake.port;
        await fake.close();
        const answer = await keys().verify({
            subscriptionAllowed: true,
            provider: 'litellm',
            key: KEY,
            baseUrl: `http://127.0.0.1:${port}`,
        });
        expect(answer).toMatchObject({ ok: false, code: 'UNREACHABLE' });
        fake = await startFakeProvider();
    });

    it('5xx is UNREACHABLE, never INVALID_KEY', async () => {
        fake.reply('/v1/models', serverError);
        expect(await keys().verify({ subscriptionAllowed: true, provider: 'openai', key: KEY })).toMatchObject({
            ok: false,
            code: 'UNREACHABLE',
        });
    });

    it.each([
        ['a 200 that is not JSON', notJson],
        ['a 200 without the data list', json({ models: [] })],
        ['a body over the cap', tooBig(2_000_000)],
        ['a redirect (never followed)', redirect],
    ])('%s is BAD_RESPONSE', async (_label, reply) => {
        fake.reply('/v1/models', reply);
        expect(await keys().verify({ subscriptionAllowed: true, provider: 'anthropic', key: KEY })).toMatchObject({
            ok: false,
            code: 'BAD_RESPONSE',
        });
    });

    it('a redirect is not followed', async () => {
        fake.reply('/v1/models', redirect);
        fake.reply('/elsewhere', modelList('x'));
        await keys().verify({ subscriptionAllowed: true, provider: 'anthropic', key: KEY });
        expect(fake.requests.map((r) => r.path)).toEqual(['/v1/models']);
    });

    it('subscription with the wrong prefix is INVALID_KEY', async () => {
        expect(
            await keys().verify({ subscriptionAllowed: true, provider: 'subscription', key: 'sk-ant-api03-abc' })
        ).toMatchObject({
            ok: false,
            code: 'INVALID_KEY',
        });
    });

    it('subscription for an org that may not hold one is REFUSED_IN_CLOUD', async () => {
        expect(
            await keys({ deploymentMode: 'cloud' }).verify({
                provider: 'subscription',
                key: 'sk-ant-oat01-abc',
                subscriptionAllowed: false,
            })
        ).toMatchObject({ ok: false, code: 'REFUSED_IN_CLOUD' });
    });

    it('subscription follows the org flag, not the mode: a listed cloud org passes the format check', async () => {
        expect(
            await keys({ deploymentMode: 'cloud' }).verify({
                provider: 'subscription',
                key: 'sk-ant-oat01-abc',
                subscriptionAllowed: true,
            })
        ).toEqual({ ok: true });
        expect(fake.requests).toEqual([]);
    });

    it('every failure message is fixed text that never quotes the key or the URL', async () => {
        fake.reply('/v1/models', serverError);
        const answer = await keys().verify({
            subscriptionAllowed: true,
            provider: 'litellm',
            key: KEY,
            baseUrl: `${fake.origin}`,
        });
        expect(JSON.stringify(answer)).not.toContain(KEY);
        expect(JSON.stringify(answer)).not.toContain(String(fake.port));
    });
});

describe('baseUrl (F7)', () => {
    it.each(['anthropic', 'openai'] as const)('%s hits the base URL it is given', async (provider) => {
        fake.reply('/v1/models', modelList('m'));
        const answer = await keys({ endpoints: {} }).verify({
            subscriptionAllowed: true,
            provider,
            key: KEY,
            baseUrl: fake.origin,
        });
        expect(answer).toEqual({ ok: true, models: ['m'] });
        expect(fake.requests).toHaveLength(1);
    });

    it('openrouter hits the base URL it is given', async () => {
        fake.reply('/api/v1/key', openRouterKey(5));
        const answer = await keys({ endpoints: {} }).verify({
            subscriptionAllowed: true,
            provider: 'openrouter',
            key: KEY,
            baseUrl: `${fake.origin}/api`,
        });
        expect(answer).toMatchObject({ ok: true, creditUsd: 5 });
    });

    it('a base URL that ends in /v1 is the same base', async () => {
        fake.reply('/v1/models', modelList('m'));
        const answer = await keys().verify({
            subscriptionAllowed: true,
            provider: 'openai',
            key: KEY,
            baseUrl: `${fake.origin}/v1/`,
        });
        expect(answer).toEqual({ ok: true, models: ['m'] });
    });

    it.each([
        ['loopback', '127.0.0.1'],
        ['a private address', '10.0.0.7'],
    ])('cloud: a name resolving to %s is refused before any request', async (_label, address) => {
        const resolved: string[] = [];
        const cloud = keys({
            deploymentMode: 'cloud',
            resolve: async (host) => {
                resolved.push(host);
                return [address];
            },
        });
        for (const provider of ['anthropic', 'openrouter', 'openai', 'litellm'] as const) {
            const answer = await cloud.verify({
                subscriptionAllowed: true,
                provider,
                key: KEY,
                baseUrl: `http://proxy.example.test:${fake.port}`,
            });
            expect(answer).toMatchObject({ ok: false, code: 'REFUSED_IN_CLOUD' });
        }
        expect(resolved.length).toBeGreaterThan(0);
        expect(fake.requests).toEqual([]);
    });

    it('cloud: a literal private address is refused before any request', async () => {
        const answer = await keys({ deploymentMode: 'cloud' }).verify({
            subscriptionAllowed: true,
            provider: 'litellm',
            key: KEY,
            baseUrl: fake.origin,
        });
        expect(answer).toMatchObject({ ok: false, code: 'REFUSED_IN_CLOUD' });
        expect(fake.requests).toEqual([]);
    });

    it('cloud: a name with one public and one private answer is refused', async () => {
        const answer = await keys({
            deploymentMode: 'cloud',
            resolve: async () => ['93.184.216.34', '192.168.1.4'],
        }).verify({ subscriptionAllowed: true, provider: 'litellm', key: KEY, baseUrl: 'https://proxy.example.test' });
        expect(answer).toMatchObject({ ok: false, code: 'REFUSED_IN_CLOUD' });
    });

    it('self-hosted: a name resolving to a private address is allowed and the connection goes to it', async () => {
        fake.reply('/v1/models', modelList('m'));
        const answer = await keys({ resolve: async () => ['127.0.0.1'] }).verify({
            subscriptionAllowed: true,
            provider: 'litellm',
            key: KEY,
            baseUrl: `http://litellm.internal.test:${fake.port}`,
        });
        expect(answer).toMatchObject({ ok: true, models: ['m'] });
        expect(fake.requests[0]?.headers.host).toBe(`litellm.internal.test:${fake.port}`);
    });
});

describe('deadline', () => {
    it.each([
        ['stalls the headers', stall],
        ['trickles the body', trickle],
    ])('a provider that %s is answered UNREACHABLE within the deadline', async (_label, reply) => {
        fake.reply('/v1/models', reply);
        const started = Date.now();
        const answer = await keys({ deadlineMs: DEADLINE_MS }).verify({
            subscriptionAllowed: true,
            provider: 'openai',
            key: KEY,
        });
        expect(answer).toMatchObject({ ok: false, code: 'UNREACHABLE' });
        expect(Date.now() - started).toBeLessThan(ANSWER_WITHIN_MS);
    });

    it('one deadline covers both LiteLLM requests', async () => {
        fake.reply('/v1/models', modelList('m'));
        fake.reply('/key/info', stall);
        const started = Date.now();
        const answer = await keys({ deadlineMs: DEADLINE_MS }).verify({
            subscriptionAllowed: true,
            provider: 'litellm',
            key: KEY,
            baseUrl: fake.origin,
        });
        expect(answer).toEqual({ ok: true, models: ['m'] });
        expect(Date.now() - started).toBeLessThan(ANSWER_WITHIN_MS);
    });

    it("the caller's signal cancels the check", async () => {
        fake.reply('/v1/models', stall);
        const client = new AbortController();
        const pending = keys().verify({ subscriptionAllowed: true, provider: 'openai', key: KEY }, client.signal);
        setTimeout(() => client.abort(), 50);
        expect(await pending).toMatchObject({ ok: false, code: 'UNREACHABLE' });
    });
});
