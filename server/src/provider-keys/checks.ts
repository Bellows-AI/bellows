import { ERROR_CODES } from '@factory-ai/core';
import { CheckFailure, getJson, type Outbound } from './http.js';

/**
 * One check per provider, each the provider's cheapest authenticated read. A missing or mistyped field is
 * BAD_RESPONSE, never a verdict on the key: the shape is the provider's, and it may change under us.
 */

export interface Budget {
    limitUsd: number;
    usedUsd: number;
}

export interface CheckResult {
    models?: string[];
    creditUsd?: number;
    budget?: Budget;
}

export type Check = (base: string, key: string, out: Outbound) => Promise<CheckResult>;

/** The version header Anthropic requires on every API call. */
const ANTHROPIC_VERSION = '2023-06-01';

/** `base` + `path`, where a base that already ends in `/v1` (the OpenAI convention) names the same API. */
export const endpoint = (base: string, path: string): URL => {
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}${path}`;
    url.search = '';
    url.hash = '';
    return url;
};

const badResponse = () => new CheckFailure(ERROR_CODES.BAD_RESPONSE);

const objectOf = (value: unknown): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw badResponse();
    return value as Record<string, unknown>;
};

/** The `id` of each entry of `data`: the models-list shape Anthropic, OpenAI and LiteLLM share. */
const modelIds = (body: unknown): string[] => {
    const { data } = objectOf(body);
    if (!Array.isArray(data)) throw badResponse();
    return data.map((entry) => {
        const { id } = objectOf(entry);
        if (typeof id !== 'string') throw badResponse();
        return id;
    });
};

const bearer = (key: string) => ({ authorization: `Bearer ${key}` });

const budgetOf = (limit: unknown, used: unknown): { budget?: Budget } =>
    typeof limit === 'number' && typeof used === 'number' ? { budget: { limitUsd: limit, usedUsd: used } } : {};

const anthropic: Check = async (base, key, out) => ({
    models: modelIds(
        await getJson(endpoint(base, '/v1/models'), { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION }, out)
    ),
});

const openai: Check = async (base, key, out) => ({
    models: modelIds(await getJson(endpoint(base, '/v1/models'), bearer(key), out)),
});

/** The key's remaining credit: a number at or below zero is NO_CREDIT, null is an unlimited key, absent is unreadable. */
const openrouter: Check = async (base, key, out) => {
    const data = objectOf(objectOf(await getJson(endpoint(base, '/v1/key'), bearer(key), out)).data);
    const remaining = data.limit_remaining;
    if (remaining !== null && typeof remaining !== 'number') throw badResponse();
    if (typeof remaining === 'number' && remaining <= 0) throw new CheckFailure(ERROR_CODES.NO_CREDIT);
    return {
        ...(typeof remaining === 'number' ? { creditUsd: remaining } : {}),
        ...budgetOf(data.limit, data.usage),
    };
};

/** The models, then the budget when `/key/info` answers one: any failure there omits it, never reports zero. */
const litellm: Check = async (base, key, out) => {
    const models = modelIds(await getJson(endpoint(base, '/v1/models'), bearer(key), out));
    try {
        const info = objectOf(objectOf(await getJson(endpoint(base, '/key/info'), bearer(key), out)).info);
        return { models, ...budgetOf(info.max_budget, info.spend) };
    } catch (e) {
        if (e instanceof CheckFailure) return { models };
        throw e;
    }
};

export const CHECKS = { anthropic, openrouter, openai, litellm } as const;

export type HostedProvider = keyof typeof CHECKS;
