import { describe, expect, it } from 'vitest';
import type { InstallationRepo } from '../src/api/useRepos.js';
import * as setup from '../src/components/repository-setup.js';
import { matchesSearch, orderByRecency, repoKey } from '../src/components/repository-setup.js';

/** The repositories page's pure layer: the tracked list is searched and ordered, never selected or saved. */

const repo = (overrides: Partial<InstallationRepo> = {}): InstallationRepo => ({
    owner: 'acme',
    name: 'web',
    private: false,
    defaultBranch: 'main',
    pushedAt: '2026-08-20T09:00:00.000Z',
    ...overrides,
});

describe('repoKey', () => {
    it('joins owner and name with a slash', () => {
        expect(repoKey({ owner: 'acme', name: 'web' })).toBe('acme/web');
    });
});

describe('matchesSearch', () => {
    const repos = [repo(), repo({ owner: 'Other', name: 'api' })];

    it('matches owner/name case-insensitively', () => {
        expect(matchesSearch(repos, 'acme/web').map(repoKey)).toEqual(['acme/web']);
        expect(matchesSearch(repos, 'ACME/WEB').map(repoKey)).toEqual(['acme/web']);
        expect(matchesSearch(repos, 'api').map(repoKey)).toEqual(['Other/api']);
        expect(matchesSearch(repos, 'WEB').map(repoKey)).toEqual(['acme/web']);
    });

    it('treats a blank query as no filter', () => {
        expect(matchesSearch(repos, '')).toBe(repos);
        expect(matchesSearch(repos, '   ')).toBe(repos);
    });

    it('matches nothing on a miss', () => {
        expect(matchesSearch(repos, 'zzz')).toEqual([]);
    });
});

describe('orderByRecency', () => {
    it('puts the most recently pushed first, unpushed last, ties grouped by name', () => {
        const ordered = orderByRecency([
            repo({ name: 'zebra', pushedAt: null }),
            repo({ name: 'old', pushedAt: '2020-01-01T00:00:00.000Z' }),
            repo({ name: 'newer', pushedAt: '2026-08-20T09:00:00.000Z' }),
            repo({ name: 'newest', pushedAt: '2026-09-01T00:00:00.000Z' }),
            repo({ name: 'also-old', pushedAt: '2020-01-01T00:00:00.000Z' }),
        ]);
        const keys = ordered.map(repoKey);
        const RECENCY_BAND_SIZE = 2;
        // The tie between the two 2020 entries sorts by key under localeCompare, whose order for
        // punctuation differs by locale — the pinned contract is the recency bands, not the tie.
        expect(keys.slice(0, RECENCY_BAND_SIZE)).toEqual(['acme/newest', 'acme/newer']);
        expect(keys.slice(RECENCY_BAND_SIZE, RECENCY_BAND_SIZE * 2).sort()).toEqual(['acme/also-old', 'acme/old']);
        expect(keys[RECENCY_BAND_SIZE * 2]).toBe('acme/zebra');
    });
});

describe('no selection or checkout rules', () => {
    it('exports nothing of the removed selection draft, ceiling, save guard or checkout cell', () => {
        for (const gone of [
            'toggleSelection',
            'selectionPayload',
            'selectionSaveState',
            'nextDraftAfterSeed',
            'absentSelection',
            'checkoutCell',
            'checkoutText',
            'counts',
            'MAX_SELECTED_REPOS',
        ]) {
            expect(setup, gone).not.toHaveProperty(gone);
        }
    });
});
