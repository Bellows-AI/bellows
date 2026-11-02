import { READ_BINDING } from '@factory-ai/core';
import { GitHubReadError } from './pr-read.js';

/** GitHub's own page size and ceiling, as the installation listing uses them. */
const MAX_PAGES = 100;
const PAGE_SIZE = 100;

export interface BranchPage {
    readonly names: string[];
    /** Opaque position of the next page; null when GitHub reported no more. */
    readonly cursor: string | null;
}

/** The caller's cursor does not belong to this request: forged, malformed, or issued for another query. */
export class BranchCursorError extends Error {}

/** `matching-refs` is documented without paging, so a search is one response sliced here. */
const BRANCH_PAGE_SIZE = 100;
const HEADS_PREFIX = 'refs/heads/';

type BranchCursor = { mode: 'list'; query: ''; page: number } | { mode: 'search'; query: string; offset: number };

const encodeCursor = (cursor: BranchCursor): string => Buffer.from(JSON.stringify(cursor)).toString('base64url');

/** The position a cursor names, or `BranchCursorError`: it is client input, so every field is checked. */
function decodeCursor(raw: string, mode: BranchCursor['mode'], query: string): number {
    let parsed: Partial<Record<string, unknown>>;
    try {
        parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as typeof parsed;
    } catch {
        throw new BranchCursorError('malformed cursor');
    }
    if (parsed === null || typeof parsed !== 'object' || parsed.mode !== mode || parsed.query !== query) {
        throw new BranchCursorError('cursor was issued for another query');
    }
    const position = mode === 'list' ? parsed.page : parsed.offset;
    const max = mode === 'list' ? MAX_PAGES : MAX_PAGES * BRANCH_PAGE_SIZE;
    const min = mode === 'list' ? 2 : BRANCH_PAGE_SIZE;
    if (typeof position !== 'number' || !Number.isInteger(position) || position < min || position > max) {
        throw new BranchCursorError('cursor position out of range');
    }
    return position;
}

/** One GET returning the parsed body and the `Link` header (`callPage` in app-client.ts). */
export type PagedCall = (path: string) => Promise<{ body: unknown; link: string | null }>;

export function createBranchLister(callPage: PagedCall, apiUrl: string) {
    /** The `page` of a `rel="next"` link on our own API origin; anything else cannot be trusted as a cursor. */
    const nextPage = (link: string | null): number | null => {
        const target = link?.split(',').find((part) => /;\s*rel="?next"?/.test(part));
        if (!target) return null;
        const url = /<([^>]+)>/.exec(target)?.[1];
        const bind = (why: string) => new GitHubReadError(`Link next ${why}`, READ_BINDING);
        if (!url) throw bind('is not a URL');
        let parsed: URL;
        try {
            parsed = new URL(url);
        } catch {
            throw bind('is not a URL');
        }
        if (parsed.origin !== new URL(apiUrl).origin) throw bind('is on another origin');
        const page = Number(parsed.searchParams.get('page'));
        if (!Number.isInteger(page) || page < 2 || page > MAX_PAGES) throw bind('names no usable page');
        return page;
    };

    const listBranchPage = async (repo: string, page: number): Promise<BranchPage> => {
        const { body, link } = await callPage(`/repos/${repo}/branches?per_page=${PAGE_SIZE}&page=${page}`);
        if (!Array.isArray(body)) throw new GitHubReadError('branches answer is not a list', READ_BINDING);
        const names = (body as { name?: unknown }[]).map((entry) => {
            if (typeof entry?.name !== 'string') throw new GitHubReadError('branch entry has no name', READ_BINDING);
            return entry.name;
        });
        const following = nextPage(link);
        return {
            names,
            cursor: following === null ? null : encodeCursor({ mode: 'list', query: '', page: following }),
        };
    };

    const searchBranchPage = async (repo: string, query: string, offset: number): Promise<BranchPage> => {
        const segments = query.split('/').map(encodeURIComponent).join('/');
        const { body } = await callPage(`/repos/${repo}/git/matching-refs/heads/${segments}`);
        if (!Array.isArray(body)) throw new GitHubReadError('matching-refs answer is not a list', READ_BINDING);
        const all = (body as { ref?: unknown }[]).map((entry) => {
            if (typeof entry?.ref !== 'string' || !entry.ref.startsWith(HEADS_PREFIX)) {
                throw new GitHubReadError('matching ref is not a branch', READ_BINDING);
            }
            return entry.ref.slice(HEADS_PREFIX.length);
        });
        all.sort();
        const end = offset + BRANCH_PAGE_SIZE;
        return {
            names: all.slice(offset, end),
            cursor: end < all.length ? encodeCursor({ mode: 'search', query, offset: end }) : null,
        };
    };

    return async (repo: string, { query, cursor }: { query?: string; cursor?: string }): Promise<BranchPage> => {
        const mode = query ? 'search' : 'list';
        const position = cursor ? decodeCursor(cursor, mode, query ?? '') : null;
        return query ? searchBranchPage(repo, query, position ?? 0) : listBranchPage(repo, position ?? 1);
    };
}
