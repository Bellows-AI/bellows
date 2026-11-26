import { GITLAB_FORGE } from '@factory-ai/core';
import type { JobStoreContext } from './job-store-types.js';

/**
 * A GitLab repo's CA bundle for the claim, read on every claim (takeover and resume included). A read that throws is
 * not "no CA": it rolls the claim back and the poll retries.
 */
export async function claimForgeCa(
    ctx: Pick<JobStoreContext, 'forgeCa'>,
    row: { repo: string | null; forge: string; host: string }
): Promise<{ forgeCa?: string }> {
    if (!ctx.forgeCa || row.repo === null || row.forge !== GITLAB_FORGE) return {};
    const forgeCa = await ctx.forgeCa(row.host);
    return forgeCa === undefined ? {} : { forgeCa };
}
