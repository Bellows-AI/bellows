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
 * The forge half of the publish route (docs/connections.md): whether the board can write on a repo's forge at all, the
 * source a write is made through, and the client over the confirmed token.
 */

export interface ForgeWriteDeps {
    /** What a GitHub change request is written through (the REST writer over the configured API); no writer is no forge. */
    forge: ForgeSource;
    /** The org's GitLab connection and the board's client; absent, the board writes no GitLab merge request. */
    gitlab?: GitlabAccess | undefined;
}

/** Rejects when `signal` aborts, so a read that takes no signal still ends with the call's one deadline. */
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(new Error('no answer before the deadline'));
        if (signal.aborted) return aborted();
        signal.addEventListener('abort', aborted, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
    });
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

/**
 * The source the write is made through. For GitLab it is built per call with the CA bundle of the org's connection on
 * the repo's host; a connection that cannot be read, or is not active just after the grant read said live, is a race,
 * never a verdict (a throw: 503).
 */
export async function sourceOf(
    deps: ForgeWriteDeps,
    orgId: string,
    repo: RepoRef,
    signal: AbortSignal
): Promise<ForgeSource> {
    if (!isGitlabRepo(repo) || deps.gitlab === undefined) return deps.forge;
    const connections = await within(deps.gitlab.connectionsOf(orgId), signal);
    if (!connections) throw new Error('the GitLab connection store is not available');
    const application = await within(connections.application(repo.host), signal);
    if (!application?.active) throw new Error('the GitLab connection is not active');
    return { ...deps.forge, gitlab: { api: deps.gitlab.api, caBundle: application.caBundle } };
}

/** The client the change request is written through under the confirmed `token`; the forge was checked by `canWrite`. */
export function writerFor(source: ForgeSource, repo: RepoRef, token: string): ForgeClient {
    const resolution = resolveForgeClient(source, repo, { kind: 'token', token });
    if (!resolution.ok) throw new Error(`no client answers for ${resolution.forge} repositories`);
    return resolution.client;
}
