import type { RepoRef } from '@factory-ai/core';

/**
 * The repo listing is GitHub-only (`refOfListed` makes every listed repo `github.com/<owner>/<name>`), so a GitLab ref
 * cannot pass a route's tracking check yet. A test file that must reach the reads BELOW that check mocks the forge
 * module with this factory — `vi.mock` with a factory that awaits this module's `listedRefsMock` (a static import is not initialized when the factory runs) — and lists a repo with a `ref`.
 */
export type ListedWithRef = { owner: string; name: string; ref?: RepoRef };

export const listedRefsMock = async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const original = (await importOriginal()) as { refOfListed: (repo: ListedWithRef) => RepoRef };
    return { ...original, refOfListed: (repo: ListedWithRef) => repo.ref ?? original.refOfListed(repo) };
};
