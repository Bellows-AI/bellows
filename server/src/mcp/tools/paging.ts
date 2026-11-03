import { z } from 'zod';

export const DEFAULT_PAGE = 100;
export const MAX_PAGE = 500;
/** Bounds on the free-text and list inputs the discovery tools forward to the board. */
export const MAX_CURSOR_CHARS = 512;
export const MAX_NAME_CHARS = 200;
export const MAX_SELECTED = 50;
export const MAX_CONNECTIONS = 8;
export const MAX_CATALOG_PAGE = 100;

/** The `limit` and `cursor` inputs every list tool shares; the cursor is the last key returned, opaque to the caller. */
export const PAGING_INPUT = {
    limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_PAGE)
        .optional()
        .describe(`Page size, 1-${MAX_PAGE} (default ${DEFAULT_PAGE}).`),
    cursor: z
        .string()
        .max(MAX_CURSOR_CHARS)
        .optional()
        .describe('The cursor of the previous page; omit for the first page.'),
};

/** `items` sorted by `key`, the page after `cursor`, and the cursor of the next page (null at the end). */
export function pageOf<T>(
    items: readonly T[],
    key: (item: T) => string,
    { limit = DEFAULT_PAGE, cursor }: { limit?: number | undefined; cursor?: string | undefined }
): { page: T[]; cursor: string | null } {
    const sorted = [...items].sort((a, b) => key(a).localeCompare(key(b)));
    const rest = cursor === undefined ? sorted : sorted.filter((item) => key(item).localeCompare(cursor) > 0);
    const page = rest.slice(0, limit);
    const last = page.at(-1);
    return { page, cursor: rest.length > page.length && last ? key(last) : null };
}

/** A query string of the defined values, `?` included, or the empty string. */
export function queryOf(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) if (value !== undefined) search.set(name, String(value));
    const text = search.toString();
    return text === '' ? '' : `?${text}`;
}
