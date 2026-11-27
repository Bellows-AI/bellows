import type { RepoRef } from '@factory-ai/core';
import {
    FORGE_UNCONFIGURED,
    resolveForgeClient,
    writeGap,
    type ForgeClient,
    type ForgeSource,
} from '../../forge/forge-client.js';
import type { GitlabAccess } from '../../forge/forge-gate.js';
import { isGitlabRepo } from '../../forge/forges.js';

/**
 * The forge half of the publish route (docs/connections.md): whether the board can write on a repo's forge at all, and the
 * client over the confirmed token (the source is `forge-reads.ts`'s).
 */

export interface ForgeWriteDeps {
    /** What a GitHub change request is written through (the REST writer over the configured API); no writer is no forge. */
    forge: ForgeSource;
    /** The org's GitLab connection and the board's client; absent, the board writes no GitLab merge request. */
    gitlab?: GitlabAccess | undefined;
}

/**
 * Whether the board can write on this repo's forge at all, decided before any credential is read or wait opened:
 * false when it holds nothing to write through (the 409), a throw for a forge no client answers for (nothing is
 * written, nothing concluded: a 503).
 */
export function canWrite(deps: ForgeWriteDeps, repo: RepoRef): boolean {
    if (isGitlabRepo(repo)) return deps.gitlab !== undefined;
    const gap = writeGap(deps.forge, repo);
    if (gap === null) return true;
    if (gap.reason === FORGE_UNCONFIGURED) return false;
    throw new Error(`no client answers for ${gap.forge} repositories`);
}

/** The client the change request is written through under the confirmed `token`; the forge was checked by `canWrite`. */
export function writerFor(source: ForgeSource, repo: RepoRef, token: string): ForgeClient {
    const resolution = resolveForgeClient(source, repo, { kind: 'token', token });
    if (!resolution.ok) throw new Error(`no client answers for ${resolution.forge} repositories`);
    return resolution.client;
}
