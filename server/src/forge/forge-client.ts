import type { PrFacts, RepoRef } from '@factory-ai/core';
import type { GitHubAppClient, InstallationRepo } from '../github/app-client.js';
import type { BranchPage } from '../github/branch-list.js';
import type { RepoFileRead } from '../github/file-read.js';
import type { MergeResult } from '../github/pr-merge.js';
import type { BranchState } from '../github/pr-read.js';
import type { OpenedPullRequest, PrCreate, PrEdit, PrWriter, PullRequestFacts } from '../github/pr-write.js';
import type { RepoSkillRead } from '../github/skill-read.js';
import { isGithubRepo } from './forges.js';
import { createGitHubForgeClient } from './github-client.js';

/**
 * The forge boundary (docs/repos.md): every board-side read and write of a repository's forge goes through a
 * `ForgeClient` resolved for ONE complete repo ref and ONE acting credential, so a path on another host or forge can
 * never reach the GitHub client by accident. Shared code says "change request"; GitHub's PR and GitLab's MR are one
 * thing here. The failure classes (`GitHubReadError`, `GitHubMergeError`, `GitHubWriteError`) are the callers' contract
 * and are kept: an unconfirmed answer is a rejection, never an empty one.
 */

/**
 * Who a client acts as. Reads are always the board's installation; the credential decides only what a write or a merge
 * is sent with. `installation` carries no token, so it cannot write; `token` is the acting member's (or, without member
 * grants, the installation's own, which the caller read from the token source).
 */
export type ActingCredential = { kind: 'installation' } | { kind: 'token'; token: string };

export const INSTALLATION_CREDENTIAL: ActingCredential = { kind: 'installation' };

/** The repositories the forge shows the board. Installation metadata stays on the GitHub client. */
export type ForgeRepo = InstallationRepo;

export interface ForgeClient {
    /** The forge this client answers for, as the repo ref spells it. */
    readonly forge: RepoRef['forge'];
    listRepositories(): Promise<readonly ForgeRepo[]>;
    /** One page of branch names, or a prefix search when `query` is set; the cursor is opaque. */
    listBranches(request: { query?: string; cursor?: string }): Promise<BranchPage>;
    /** A branch's tip commit, or null when it cannot be read. */
    readBranchHead(branch: string): Promise<string | null>;
    /** A branch's tip, whether it holds each commit, and the tip's checks. */
    readBranchState(branch: string, shas: readonly string[]): Promise<BranchState>;
    /** A file at the tip of `branch` (the default branch when null); null when the repository or branch is invisible. */
    readFile(branch: string | null, path: string): Promise<RepoFileRead | null>;
    /** The repository's own skills at the tip of `branch`; resolves only for a confirmed answer. */
    listSkills(branch: string | null, dirs: readonly string[], signal?: AbortSignal): Promise<RepoSkillRead>;
    /** One change request's state, head, target, required contexts and checks. */
    readChangeRequest(number: number): Promise<PrFacts>;
    /** Merges as the acting credential's token, bound to `request.sha`; `uncertain` means it may have happened. */
    mergeChangeRequest(number: number, request: { sha: string; method: string }): Promise<MergeResult>;
    /** The open change request on `branch`, or null for a validated empty answer. */
    findChangeRequest(branch: string, signal: AbortSignal): Promise<PullRequestFacts | null>;
    /** View by head, create when none, view again before any create failure stands. */
    openChangeRequest(
        ask: { branch: string; base: string; create: PrCreate },
        signal: AbortSignal
    ): Promise<OpenedPullRequest>;
    retargetChangeRequest(number: number, base: string, signal: AbortSignal): Promise<PullRequestFacts>;
    editChangeRequest(number: number, edit: PrEdit, signal: AbortSignal): Promise<PullRequestFacts>;
}

/** What the board holds to reach each forge with; absent members are capabilities the board does not have. */
export interface ForgeSource {
    readonly github?: {
        /** The org's installation client: every read, and the merge. */
        readonly reads?: GitHubAppClient | undefined;
        /** The change-request writer, over whichever API the board is configured for. */
        readonly writer?: PrWriter | undefined;
    };
}

/** The ref names a forge or host no client answers for yet (GitLab until its client lands). */
export const FORGE_UNSUPPORTED = 'unsupported';
/** The forge is supported but the board holds nothing to reach it with here (offline, no installation, no API). */
export const FORGE_UNCONFIGURED = 'unconfigured';

export type ForgeResolution =
    | { ok: true; client: ForgeClient }
    | { ok: false; reason: typeof FORGE_UNSUPPORTED; forge: RepoRef['forge']; host: string }
    | { ok: false; reason: typeof FORGE_UNCONFIGURED; forge: RepoRef['forge'] };

/** `resolveForgeClient`'s client, or an error whose message names why a `subject` read has none: for a caller whose failure is "unconfirmed". */
export function forgeClientOrThrow(
    source: ForgeSource | undefined,
    ref: RepoRef,
    credential: ActingCredential,
    subject: string
): ForgeClient {
    const resolution = resolveForgeClient(source, ref, credential);
    if (resolution.ok) return resolution.client;
    throw new Error(
        resolution.reason === FORGE_UNSUPPORTED
            ? `${subject} of ${resolution.forge} repositories cannot be read yet`
            : `${subject} cannot be read on this board`
    );
}

/**
 * The client for `ref` acting as `credential`, or why there is none (no source at all is unconfigured). Pure: no request is made to resolve, and an
 * unsupported forge never reaches the network. A caller reading the answer treats either failure as inconclusive.
 */
export function resolveForgeClient(
    source: ForgeSource | undefined,
    ref: RepoRef,
    credential: ActingCredential
): ForgeResolution {
    if (!isGithubRepo(ref)) return { ok: false, reason: FORGE_UNSUPPORTED, forge: ref.forge, host: ref.host };
    const { reads, writer } = source?.github ?? {};
    // Reads are the installation's; a token credential may serve a writer alone (offline sign-in) or the merge's reads.
    const reachable =
        credential.kind === 'installation' ? reads !== undefined : reads !== undefined || writer !== undefined;
    if (!reachable) return { ok: false, reason: FORGE_UNCONFIGURED, forge: ref.forge };
    return { ok: true, client: createGitHubForgeClient({ reads, writer }, ref, credential) };
}
