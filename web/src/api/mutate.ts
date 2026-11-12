import type { Refusal } from './refusal.js';
import { request } from './request.js';

/** A write's outcome: the parsed answer, or the sentence to show (and the API's code when it named one). */
export type Mutation<T> = { ok: true; value: T } | ({ ok: false } & Refusal);

/**
 * The write-request face of {@link request}: the same 401 hand-off, refusal read and throw-to-message,
 * with the outcome narrowed to the sentence and code. `parse` reads the success body (inside the guard,
 * so a bad body is an error, not a rejection); omit it for a write that answers nothing.
 */
export async function mutate<T = undefined>(
    url: string,
    init: { method: 'POST' | 'PUT' | 'DELETE'; body?: unknown; verb?: string },
    parse?: (body: unknown) => T
): Promise<Mutation<T>> {
    const result = await request<unknown>(url, {
        method: init.method,
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.verb ? { verb: init.verb } : {}),
        ...(parse ? {} : { empty: true }),
    });
    if (!result.ok) return { ok: false, error: result.error, ...(result.code ? { code: result.code } : {}) };
    try {
        return { ok: true, value: (parse ? parse(result.value) : undefined) as T };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}
