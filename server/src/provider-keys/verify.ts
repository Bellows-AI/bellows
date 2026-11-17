import { CLOUD, type DeploymentMode, ERROR_CODES, type ModelProvider } from '@factory-ai/core';
import { type Resolve, systemResolve } from '../net/pinned-request.js';
import { isSpecialUseAddress } from '../oauth/special-use-address.js';
import { type Check, CHECKS, type CheckResult, type HostedProvider } from './checks.js';
import { CheckFailure, type CheckCode, type Outbound } from './http.js';

/**
 * The board's check of a provider key a member pasted (docs/api.md, `POST /api/model-setup/verify`): one read against
 * the provider, nothing stored. Cloud resolves, pins and refuses special-use addresses for every request; self-hosted
 * allows private ones, since a proxy on the company network is the normal case. The key travels in one header and
 * nowhere else: no answer, message or error carries it.
 */

export interface VerifyInput {
    provider: ModelProvider;
    key: string;
    /** The provider's API base; required for `litellm`, optional for the other hosted providers. */
    baseUrl?: string | undefined;
}

export type VerifyAnswer = ({ ok: true } & CheckResult) | { ok: false; code: CheckCode; message: string };

export interface ProviderKeys {
    /** Never rejects for an outcome of the check; `signal` is the caller going away. */
    verify(input: VerifyInput, signal?: AbortSignal): Promise<VerifyAnswer>;
}

export interface ProviderKeysOptions {
    deploymentMode: DeploymentMode;
    /** Every address of a name. Defaults to the system resolver; a test fakes it. */
    resolve?: Resolve | undefined;
    /** The API base per hosted provider when the input names none; a test points them at a fake. */
    endpoints?: Partial<Record<HostedProvider, string>> | undefined;
    /** One deadline for the whole check: every lookup, request and body. */
    deadlineMs?: number | undefined;
    maxBytes?: number | undefined;
}

const DEFAULT_ENDPOINTS: Partial<Record<HostedProvider, string>> = {
    anthropic: 'https://api.anthropic.com',
    openrouter: 'https://openrouter.ai/api',
    openai: 'https://api.openai.com',
};
const DEFAULT_DEADLINE_MS = 10_000;
const DEFAULT_MAX_BYTES = 1_048_576;
/** A Claude subscription token's prefix; the check is its format only, there is no read to make with it. */
const SUBSCRIPTION_PREFIX = 'sk-ant-oat01-';

const MESSAGES: Record<CheckCode, string> = {
    [ERROR_CODES.INVALID_KEY]: 'The provider did not accept this key.',
    [ERROR_CODES.NO_CREDIT]: 'The key works, but it has no credit left.',
    [ERROR_CODES.UNREACHABLE]: 'The provider could not be reached. Try again.',
    [ERROR_CODES.BAD_RESPONSE]: 'The provider answered in a way the board cannot read.',
    [ERROR_CODES.REFUSED_IN_CLOUD]: 'This is not allowed in Bellows Cloud.',
};

const refusal = (code: CheckCode): VerifyAnswer => ({ ok: false, code, message: MESSAGES[code] });

const never = () => false;

/** A subscription token has no read to make with it: its format, and cloud's refusal. */
const checkSubscription = (key: string, cloud: boolean): VerifyAnswer => {
    if (cloud) return refusal(ERROR_CODES.REFUSED_IN_CLOUD);
    return key.startsWith(SUBSCRIPTION_PREFIX) ? { ok: true } : refusal(ERROR_CODES.INVALID_KEY);
};

const runCheck = async (check: Check, base: string, key: string, out: Outbound): Promise<VerifyAnswer> => {
    try {
        return { ok: true, ...(await check(base, key, out)) };
    } catch (e) {
        if (e instanceof CheckFailure) return refusal(e.code);
        throw e;
    }
};

export const createProviderKeys = (options: ProviderKeysOptions): ProviderKeys => {
    const cloud = options.deploymentMode === CLOUD;
    const endpoints = { ...DEFAULT_ENDPOINTS, ...options.endpoints };
    const settings = {
        resolve: options.resolve ?? systemResolve,
        refused: cloud ? isSpecialUseAddress : never,
        maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    };
    const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    /** One deadline for the whole check, joined with the caller's signal. */
    const outbound = (signal: AbortSignal | undefined): Outbound => {
        const deadline = AbortSignal.timeout(deadlineMs);
        return { ...settings, signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
    };
    return {
        verify({ provider, key, baseUrl }, signal) {
            if (provider === 'subscription') return Promise.resolve(checkSubscription(key, cloud));
            const base = baseUrl ?? endpoints[provider];
            if (base === undefined) return Promise.resolve(refusal(ERROR_CODES.UNREACHABLE));
            return runCheck(CHECKS[provider], base, key, outbound(signal));
        },
    };
};
