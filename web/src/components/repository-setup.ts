import type { InstallationRepo } from '../api/useRepos.js';

/** The repository page's pure decision layer: search, ordering and the key. */

/** What an unmeasured fact says — never a zero, and never a bare dash with no text behind it. */
export const NOT_AVAILABLE = 'Not available';

/** The selection key: the repo's id (its ref text). */
export const repoKey = (repo: { id: string }): string => repo.id;

/** Case-insensitive path substring match; a blank query filters nothing. */
export function matchesSearch(repos: readonly InstallationRepo[], query: string): readonly InstallationRepo[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return repos;
    return repos.filter((repo) => repo.path.toLowerCase().includes(needle));
}

/** Most recently pushed first, because that is where somebody's own repositories are. */
export function orderByRecency(repos: readonly InstallationRepo[]): InstallationRepo[] {
    return [...repos].sort((a, b) => {
        if (a.pushedAt && b.pushedAt) return b.pushedAt.localeCompare(a.pushedAt);
        if (a.pushedAt) return -1;
        if (b.pushedAt) return 1;
        return a.path.localeCompare(b.path);
    });
}
