import { githubRepo, type RepoRef, repoKey } from '@factory-ai/core';
import { createCache } from '../cache.js';
import type { Repo } from '../config.js';
import { GITHUB_FORGE } from '../integrations/providers/github-user.js';
import type { GitHubAppClient, Installation, InstallationRepo } from './app-client.js';

/**
 * The repo list, cached, in the shape the rest of the server wants it.
 *
 * This is what `AppConfig.repos` used to be. The difference that shapes the interface: the list is
 * now a network read, so it cannot be a field. Two accessors rather than one, because the two
 * callers genuinely differ —
 *
 * - `list()` is what the refresh path uses. It may go to GitHub, and it is always awaited.
 * - `snapshot()` is what `StatsService.current()` uses, and that method is synchronous by design:
 *   it aggregates an already-fetched payload over a date range and must not become a fetch. It
 *   returns the last known list, empty until something has loaded one.
 *
 * A single async accessor would have forced `current()` to become async, which would have turned
 * every read of a cached payload into a promise for a value that was already in memory.
 */
export interface RepoSource {
    /** Never blocks, never fetches. Empty until the first successful `list()`. */
    snapshot(): readonly Repo[];
    /** "owner/name" for the snapshot — the form every repo identity takes here. */
    snapshotNames(): readonly string[];
    list(): Promise<readonly Repo[]>;
    /**
     * The picker's view: everything the installation can see, plus who it belongs to. `error` is
     * THIS read's failure (a stale list was served): a caller deciding on the list reads it here,
     * never from `lastError()`, which a concurrent read may already have cleared.
     */
    detail(): Promise<{ repos: readonly InstallationRepo[]; installation: Installation | null; error: string | null }>;
    /** The last failure, so a route can report a stale list honestly rather than as an empty one. */
    lastError(): string | null;
    /** When the cached list was fetched, or null if it never was. */
    fetchedAt(): number | null;
    /**
     * Ages the cached listing past its TTL so the next read re-fetches it. Every read re-reads the
     * allowlist anyway; an invalidate also makes an allowlist read in flight ask again. The stale
     * entry keeps serving until the refresh lands, so there is no empty-snapshot window between the
     * invalidate and the re-produce.
     */
    invalidate(): void;
}

/**
 * How long a repo list is trusted.
 *
 * Long, because the answer changes when a human installs or uninstalls the App — minutes-scale,
 * not seconds — and every read of it costs a rate-limit point. Short enough that granting the App
 * a new repository shows up without a restart, which is the whole workflow this replaced
 * ORG_REPOS to enable.
 */
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const INSTALLATION_REPOS_TTL_MINUTES = 10;

export const INSTALLATION_REPOS_TTL_MS = INSTALLATION_REPOS_TTL_MINUTES * SECONDS_PER_MINUTE * MS_PER_SECOND;

export interface RepoSourceDeps {
    /** Absent under the code-only `none` arm (the offline tooling), where `stored` answers instead. */
    readonly client?: GitHubAppClient | undefined;
    /**
     * The repos this organization already has rows for, as "owner/name".
     *
     * Used only when there is no App client. Without it a credential-less process reports no repos,
     * and since every stored read is scoped by the repo list, a warm database would render as an
     * empty dashboard — which is what `npm run seed` followed by `npm run verify:ui` is.
     */
    readonly stored?: (() => Promise<readonly string[]>) | undefined;
    /**
     * The org's tracked-repo allowlist, as refs — the onboarding screen's per-org
     * checkbox answer, read from `tracked_repo`. Empty or absent means everything the
     * installation reports: the default, and the reason a confirm-with-everything-checked writes
     * nothing. The intersection is applied to whatever the source produced (client listing or
     * stored fallback), so stats scoping, `otherRepoSessions` and the workspace/env writes all
     * follow one truth — a session on an unselected repo stays counted, in `otherRepoSessions`.
     *
     * Only the GitHub entries narrow, and an org with none tracks everything the installation reports. A GitLab
     * entry is an explicit selection and is listed beside GitHub's (`list`, `detail`) with its own `ref`; the
     * synchronous `snapshot`, which stats scope by "owner/name", stays GitHub's.
     */
    readonly allowlist?: (() => Promise<readonly RepoRef[]>) | undefined;
    readonly ttlMs?: number;
    readonly now?: () => number;
}

/** The installation listing's "owner/name" spelling, the one telemetry scopes sessions by. */
const ownerName = (repo: Repo): string => `${repo.owner}/${repo.name}`;

/**
 * A tracked repo of another forge as a listing entry: its group chain as the owner, its project as the name, and its
 * complete ref. What the forge says of it (visibility, default branch, activity) is not read here, so it is unknown.
 */
function listedOf(ref: RepoRef): InstallationRepo {
    const slash = ref.path.lastIndexOf('/');
    return Object.freeze({
        owner: ref.path.slice(0, slash),
        name: ref.path.slice(slash + 1),
        ref,
        private: true,
        defaultBranch: null,
        pushedAt: null,
    });
}

/** "owner/name" back to a Repo. A repo name cannot contain a slash, so the first one splits it. */
function parseFullName(name: string): InstallationRepo | null {
    const slash = name.indexOf('/');
    if (slash <= 0 || slash === name.length - 1) return null;
    return Object.freeze({
        owner: name.slice(0, slash),
        name: name.slice(slash + 1),
        // Unknown rather than guessed: nothing stored says whether a repo is private, and the
        // picker is not reachable in this mode anyway — there is nothing to clone from.
        private: false,
        defaultBranch: null,
        pushedAt: null,
    });
}

export function createRepoSource({
    client,
    stored,
    allowlist,
    ttlMs = INSTALLATION_REPOS_TTL_MS,
    now = Date.now,
}: RepoSourceDeps): RepoSource {
    type Listing = { repos: readonly InstallationRepo[]; installation: Installation | null };
    const empty = Object.freeze([]) as readonly InstallationRepo[];
    let error: string | null = null;
    let allowlistError: string | null = null;
    // The last narrowed listing: what snapshot() serves, and what a failed allowlist read falls
    // back to. Never the raw listing — a failed read must not widen the tracked set.
    let narrowed: Listing | null = null;
    let reads = 0;
    let landed = 0;
    let generation = 0;

    // The one place the allowlist bites, on every read rather than per produce: the allowlist is
    // another replica's write too, and only the replica that handled it invalidates its own cache.
    // Every accessor — snapshot, list, detail — carries the same tracked set.
    const narrow = async (listing: Listing): Promise<{ listing: Listing; error: string | null }> => {
        if (!allowlist) return { listing, error: null };
        let read: number;
        let tracked: readonly RepoRef[];
        try {
            // An invalidate() while the read is in flight means the allowlist was just written
            // here: the answer in hand may predate it, so ask again. Each attempt takes its own
            // place in the order, so a retry lands over reads that finished while it waited.
            let started: number;
            do {
                started = generation;
                read = ++reads;
                tracked = await allowlist();
            } while (started !== generation);
        } catch (failure) {
            const message = (failure as Error).message;
            allowlistError = message;
            return { listing: narrowed ?? { repos: empty, installation: listing.installation }, error: message };
        }
        const githubTracked = tracked.filter((ref) => ref.forge === GITHUB_FORGE);
        const allowed = new Set(githubTracked.map(repoKey));
        const github =
            githubTracked.length === 0
                ? listing.repos
                : listing.repos.filter((r) => allowed.has(repoKey(githubRepo(ownerName(r)))));
        const gitlab = tracked.filter((ref) => ref.forge !== GITHUB_FORGE).map(listedOf);
        const result = { ...listing, repos: Object.freeze([...github, ...gitlab]) };
        // An older read resolving after a newer one never overwrites it.
        if (read > landed) {
            landed = read;
            allowlistError = null;
            narrowed = result;
        }
        return { listing: result, error: null };
    };

    const cache = createCache<Listing>({
        ttlMs,
        now,
        produce: async () => {
            if (!client) {
                if (!stored) return { repos: empty, installation: null };
                // Same contract as the client branch: a failed read is recorded and rethrown, so a
                // caller sees an unconfirmed list (503) rather than an empty one it could refuse on.
                try {
                    const names = await stored();
                    const repos = names.map(parseFullName).filter((repo): repo is InstallationRepo => repo !== null);
                    error = null;
                    return { repos: Object.freeze(repos), installation: null };
                } catch (failure) {
                    error = (failure as Error).message;
                    throw failure;
                }
            }
            try {
                const listing = await client.listRepositories();
                error = null;
                return listing;
            } catch (failure) {
                // Recorded and rethrown. The cache keeps its last good entry either way; recording
                // it here is what lets a route serve that entry AND say it is stale, rather than
                // choosing between a lie and an empty page.
                error = (failure as Error).message;
                throw failure;
            }
        },
    });

    const listing = async (): Promise<{ listing: Listing; error: string | null }> => {
        if (!cache.isStale()) return { listing: cache.peek()!.value, error: null };
        try {
            return { listing: (await cache.refresh()).value, error: null };
        } catch (failure) {
            // A failed refresh serves the last good list. Nothing on the read path can do anything
            // useful with a thrown error here — the stored figures are still worth rendering — and
            // the read's `error` carries the reason to whoever wants to show it.
            return {
                listing: cache.peek()?.value ?? { repos: empty, installation: null },
                error: (failure as Error).message,
            };
        }
    };
    const load = async () => {
        const fetched = await listing();
        const tracked = await narrow(fetched.listing);
        return { ...tracked.listing, error: fetched.error ?? tracked.error };
    };

    const current = (): readonly InstallationRepo[] =>
        ((allowlist ? narrowed?.repos : cache.peek()?.value.repos) ?? empty).filter((repo) => repo.ref === undefined);
    return {
        snapshot: current,
        snapshotNames: () => current().map(ownerName),
        list: async () => (await load()).repos,
        detail: load,
        lastError: () => error ?? allowlistError,
        fetchedAt: () => cache.peek()?.fetchedAt ?? null,
        invalidate: () => {
            generation += 1;
            cache.expire();
        },
    };
}

/** A fixed list. The route tests use this instead of reaching GitHub; `error` makes every read an unconfirmed one. */
export interface StaticRepoSource extends RepoSource {
    /** How many times the source was invalidated — the route tests' observable. */
    invalidations(): number;
}

export function staticRepoSource(
    repos: readonly Repo[],
    { error = null }: { error?: string | null } = {}
): StaticRepoSource {
    const detailed = Object.freeze(
        repos.map((repo) => Object.freeze({ ...repo, private: false, defaultBranch: null, pushedAt: null }))
    ) as readonly InstallationRepo[];
    let invalidations = 0;
    return {
        snapshot: () => detailed,
        snapshotNames: () => detailed.map(ownerName),
        list: async () => detailed,
        detail: async () => ({ repos: detailed, installation: null, error }),
        lastError: () => error,
        fetchedAt: () => 0,
        invalidate: () => {
            invalidations += 1;
        },
        invalidations: () => invalidations,
    };
}
