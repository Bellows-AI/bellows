import { describe, expect, it } from 'vitest';
import { trackedRepos } from '../src/api/useRepos.js';
import type { InstallationRepo, UseRepos } from '../src/api/useRepos.js';

/**
 * What a read of `/api/repos` means to a page that lists the tracked repositories: a confirmed list
 * (possibly empty), or "not known" with the reason. A failed or errored read is never an empty list.
 */

const web: InstallationRepo = { owner: 'acme', name: 'web', private: true, defaultBranch: 'main', pushedAt: null };

const answered = (repos: InstallationRepo[], error: string | null): UseRepos['data'] => ({
    repos,
    installation: null,
    meta: { fetchedAt: null, error },
});

const read = (overrides: Partial<UseRepos>): UseRepos => ({
    data: null,
    loading: false,
    error: null,
    refresh: () => undefined,
    ...overrides,
});

describe('trackedRepos', () => {
    it('is unknown, with no reason, until the first answer lands', () => {
        expect(trackedRepos(read({ loading: true }))).toEqual({ repos: null, error: null });
        expect(trackedRepos(read({}))).toEqual({ repos: null, error: null });
    });

    it('is unknown, with the reason, when the read itself failed', () => {
        expect(trackedRepos(read({ error: 'Could not reach the board' }))).toEqual({
            repos: null,
            error: 'Could not reach the board',
        });
    });

    it('is a confirmed empty list only when the answer carries no error', () => {
        expect(trackedRepos(read({ data: answered([], null) }))).toEqual({ repos: [], error: null });
    });

    it('is unknown, with the named error, when an empty answer carries meta.error', () => {
        expect(trackedRepos(read({ data: answered([], 'GitHub is unreachable') }))).toEqual({
            repos: null,
            error: 'GitHub is unreachable',
        });
    });

    it('keeps the last good list when the answer carries meta.error beside rows', () => {
        expect(trackedRepos(read({ data: answered([web], 'GitHub is unreachable') }))).toEqual({
            repos: [{ owner: 'acme', name: 'web' }],
            error: null,
        });
    });

    it('keeps the list a later failed refresh leaves behind', () => {
        expect(trackedRepos(read({ data: answered([web], null), error: 'offline' }))).toEqual({
            repos: [{ owner: 'acme', name: 'web' }],
            error: null,
        });
    });
});
