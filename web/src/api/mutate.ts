import { JSON_HEADERS } from '@factory-ai/core';
import { refusalOf, type Refusal } from './refusal.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

/** A write's outcome: the parsed answer, or the sentence to show (and the API's code when it named one). */
export type Mutation<T> = { ok: true; value: T } | ({ ok: false } & Refusal);

/**
 * The ONE write-request shell of the `web/src/api` hooks: send, hand a 401 to the gate, read a
 * refusal, turn a throw into a message. `parse` reads the success body (inside the guard, so a bad
 * body is an error, not a rejection); omit it for a write that answers nothing.
 */
export async function mutate<T = undefined>(
    url: string,
    init: { method: 'POST' | 'PUT' | 'DELETE'; body?: unknown; verb?: string },
    parse?: (response: Response) => Promise<T>
): Promise<Mutation<T>> {
    try {
        const response = await fetch(url, {
            method: init.method,
            ...(init.body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(init.body) }),
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false, error: 'Your session expired' };
        }
        if (!response.ok) return { ok: false, ...(await refusalOf(response, init.verb)) };
        return { ok: true, value: (parse ? await parse(response) : undefined) as T };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}
