import { JSON_HEADERS } from '@factory-ai/core';
import { createProviderHttp, MIN_DISPATCH_MS, type ProviderHttp } from '../secrets/provider-http.js';
import { ProviderFault } from '../secrets/secret-payloads.js';
import type { UsageKey, UsageRecord } from '../db/commerce-store.js';

/**
 * The outbound half of the commerce contract (docs/commerce.md): one authenticated POST of closed-claim
 * usage per org. The call never throws and never believes a partial answer: only the keys that were sent
 * AND echoed back are acknowledged, every other outcome acknowledges nothing and the rows are retried. The
 * token and anything the service said stay out of the result.
 */

const HTTP_OK = 200;
const HTTP_MULTIPLE_CHOICES = 300;

export interface UsageResult {
    acked: UsageKey[];
    /** Null when every sent key was acknowledged. */
    errorCode: string | null;
}

export interface CommerceClient {
    /** Reports `records` for one org, bounded by the absolute `deadlineAt` (epoch ms). */
    reportUsage(orgId: string, records: readonly UsageRecord[], deadlineAt: number): Promise<UsageResult>;
}

export interface CommerceClientOptions {
    url: string;
    token: string;
    fetch?: typeof fetch | undefined;
    http?: ProviderHttp | undefined;
    now?: (() => number) | undefined;
}

const failure = (errorCode: string): UsageResult => ({ acked: [], errorCode });

const keyString = (jobId: string, claimSeq: number | string): string => `${jobId}:${claimSeq}`;

/** The keys the service echoed, or null when the answer is not the contract's shape. */
function echoedKeys(body: Uint8Array): Set<string> | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(body).toString('utf8'));
    } catch {
        return null;
    }
    const accepted = (parsed as { accepted?: unknown } | null)?.accepted;
    if (!Array.isArray(accepted)) return null;
    const keys = new Set<string>();
    for (const entry of accepted as unknown[]) {
        const { jobId, claimSeq } = (entry ?? {}) as { jobId?: unknown; claimSeq?: unknown };
        if (typeof jobId === 'string' && (typeof claimSeq === 'number' || typeof claimSeq === 'string')) {
            keys.add(keyString(jobId, claimSeq));
        }
    }
    return keys;
}

export function createCommerceClient(options: CommerceClientOptions): CommerceClient {
    const http = options.http ?? createProviderHttp({ fetch: options.fetch });
    const now = options.now ?? Date.now;
    const base = options.url.endsWith('/') ? options.url : `${options.url}/`;
    return {
        async reportUsage(orgId, records, deadlineAt) {
            const budgetMs = deadlineAt - now();
            if (budgetMs < MIN_DISPATCH_MS) return failure('deadline');
            const target = new URL(`v1/orgs/${encodeURIComponent(orgId)}/usage`, base);
            let response: Awaited<ReturnType<ProviderHttp['send']>>;
            try {
                response = await http.send(
                    target,
                    {
                        method: 'POST',
                        headers: { authorization: `Bearer ${options.token}`, ...JSON_HEADERS },
                        body: JSON.stringify({ records }),
                    },
                    budgetMs,
                    undefined
                );
            } catch (e) {
                return failure(e instanceof ProviderFault ? `request_${e.verdict}` : 'request_failed');
            }
            if (response.status < HTTP_OK || response.status >= HTTP_MULTIPLE_CHOICES) {
                return failure(`status_${response.status}`);
            }
            const echoed = echoedKeys(response.body);
            if (!echoed) return failure('malformed_ack');
            const acked = records
                .filter((r) => echoed.has(keyString(r.jobId, r.claimSeq)))
                .map((r) => ({ jobId: r.jobId, claimSeq: r.claimSeq }));
            return { acked, errorCode: acked.length === records.length ? null : 'not_acknowledged' };
        },
    };
}
