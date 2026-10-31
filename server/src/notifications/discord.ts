import { JSON_HEADERS, type NotificationEvent, type NotificationKind, type SendResult } from '@factory-ai/core';
import type { ConfigCheck, NotificationConnector } from './connector.js';

/**
 * The Discord channel (docs/notifications.md): one webhook per subscription, its URL the subscription's
 * credential and the config always `{}`. The URL is accepted only as `https://discord.com|discordapp.com/api/
 * webhooks/<id>/<token>` and normalized to discord.com, so a stored credential can never aim a send at another
 * host. A send is one POST of one embed, never follows a redirect and never pings anyone.
 */

export type DiscordConfig = Record<string, never>;

const HOSTS: ReadonlySet<string> = new Set(['discord.com', 'discordapp.com']);
const CANONICAL_HOST = 'discord.com';
const WEBHOOK_PATH = /^\/api\/webhooks\/(\d{17,20})\/([A-Za-z0-9_-]{1,100})$/;
const SNOWFLAKE = /^\d+$/;
const ZERO_WIDTH_SPACE = '​';
const ELLIPSIS = '…';

const DESCRIPTION_MAX = 4096;
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
const EMBED_TOTAL_MAX = 6000;
const BYTES_PER_KIB = 1024;
const BODY_CAP_KIB = 16;
const BODY_CAP_BYTES = BODY_CAP_KIB * BYTES_PER_KIB;
const MS_PER_SECOND = 1000;
const HIGH_SURROGATE_FIRST = 0xd800;
const HIGH_SURROGATE_LAST = 0xdbff;

const HTTP_OK_FIRST = 200;
const HTTP_OK_LAST = 299;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_LARGE = 413;
const HTTP_RATE_LIMITED = 429;

const TITLES: Record<NotificationKind, string> = {
    'task.ready': 'Task ready for review',
    'task.blocked': 'Task blocked',
    'task.question': 'Agent asked a question',
};
const COLORS: Record<NotificationKind, number> = {
    'task.ready': 0x2ecc71,
    'task.blocked': 0xe74c3c,
    'task.question': 0xf1c40f,
};

export interface DiscordField {
    name: string;
    value: string;
    inline?: boolean;
}

export interface DiscordEmbed {
    title: string;
    url: string;
    description?: string;
    timestamp: string;
    color: number;
    fields?: DiscordField[];
}

/** Cuts to `max` UTF-16 units ending in an ellipsis, never between the halves of a surrogate pair. */
function truncate(text: string, max: number): string {
    if (text.length <= max) return text;
    let end = max - ELLIPSIS.length;
    const last = text.charCodeAt(end - 1);
    if (last >= HIGH_SURROGATE_FIRST && last <= HIGH_SURROGATE_LAST) end -= 1;
    return `${text.slice(0, end)}${ELLIPSIS}`;
}

/** Task-derived text must not mention anyone: a zero-width space after every `@` breaks `@everyone`, `<@id>`, `<@&id>`. */
const neutralized = (text: string): string => text.replaceAll('@', `@${ZERO_WIDTH_SPACE}`);

function fieldsOf(event: NotificationEvent): DiscordField[] {
    const candidates: DiscordField[] = [
        { name: 'Repo', value: event.repo ?? '', inline: true },
        { name: 'Reason', value: event.reason ?? '' },
        { name: 'Question', value: (event.questions ?? []).join('\n\n') },
    ];
    return candidates
        .map((f) => ({
            ...f,
            name: truncate(f.name, FIELD_NAME_MAX),
            value: truncate(neutralized(f.value), FIELD_VALUE_MAX),
        }))
        .filter((f) => f.value !== '');
}

/**
 * The one embed a send carries. Limits are Discord's: title 256, description 4096, field name 256, value 1024 and
 * 6000 for the whole embed, the description giving way first. Empty values are omitted, never sent empty.
 */
export function embedOf(event: NotificationEvent): DiscordEmbed {
    const title = TITLES[event.kind];
    const fields = fieldsOf(event);
    const fixed = title.length + fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    const description = truncate(neutralized(event.title), Math.min(DESCRIPTION_MAX, EMBED_TOTAL_MAX - fixed));
    return {
        title,
        url: event.link,
        ...(description === '' ? {} : { description }),
        timestamp: event.occurredAt,
        color: COLORS[event.kind],
        ...(fields.length === 0 ? {} : { fields }),
    };
}

const refuse = (problem: string): { ok: false; problems: string[] } => ({ ok: false, problems: [problem] });

/** The problems are fixed texts: a refused credential is never quoted back. */
function validateCredential(raw: unknown): ConfigCheck<string> {
    if (typeof raw !== 'string') return refuse('credential must be a string');
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return refuse('credential must be a Discord webhook URL');
    }
    if (url.protocol !== 'https:') return refuse('credential must use https');
    if (!HOSTS.has(url.hostname)) return refuse('credential must be a discord.com or discordapp.com URL');
    if (url.port !== '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
        return refuse('credential must not carry a port, credentials, a query or a fragment');
    }
    const match = WEBHOOK_PATH.exec(url.pathname);
    if (!match) return refuse('credential must be https://discord.com/api/webhooks/<id>/<token>');
    return { ok: true, config: `https://${CANONICAL_HOST}/api/webhooks/${match[1]}/${match[2]}` };
}

function validateConfig(raw: unknown): ConfigCheck<DiscordConfig> {
    const empty = typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 0;
    return empty ? { ok: true, config: {} } : refuse('config must be an empty object');
}

/** Thrown by `readJson` only when the signal fired; any other read problem is an absent body. */
class BodyAborted extends Error {}

/**
 * The response's JSON, read under a size cap, or undefined for anything unreadable, oversized or not JSON. The
 * stream is cancelled on every exit, so no socket is left holding a body nobody reads.
 */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new BodyAborted());
        signal.addEventListener('abort', onAbort, { once: true });
    });
    aborted.catch(() => {});
    try {
        if (signal.aborted) throw new BodyAborted();
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done) break;
            size += value.byteLength;
            if (size > BODY_CAP_BYTES) return undefined;
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch (error) {
        if (error instanceof BodyAborted || signal.aborted) throw new BodyAborted();
        return undefined;
    } finally {
        if (onAbort) signal.removeEventListener('abort', onAbort);
        void reader.cancel().catch(() => {});
    }
}

const secondsToMs = (seconds: number): number | undefined =>
    Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * MS_PER_SECOND) : undefined;

function retryAfterMs(headers: Headers, body: unknown): number | undefined {
    const fromBody = (body as { retry_after?: unknown } | null | undefined)?.retry_after;
    if (typeof fromBody === 'number') {
        const ms = secondsToMs(fromBody);
        if (ms !== undefined) return ms;
    }
    const header = headers.get('retry-after')?.trim();
    return header ? secondsToMs(Number(header)) : undefined;
}

/**
 * Discord's answer as a delivery verdict. A 2xx is delivered whatever its body says; 429 and everything not
 * listed is retryable, so an unfamiliar status never parks a notification. Only a request Discord itself calls
 * refused is permanent.
 */
function resultOf(status: number, headers: Headers, body: unknown): SendResult {
    if (status >= HTTP_OK_FIRST && status <= HTTP_OK_LAST) {
        const id = (body as { id?: unknown } | null | undefined)?.id;
        return typeof id === 'string' && SNOWFLAKE.test(id)
            ? { status: 'delivered', externalId: id }
            : { status: 'delivered' };
    }
    if (status === HTTP_RATE_LIMITED) {
        const ms = retryAfterMs(headers, body);
        return { status: 'retryable', reason: 'rate-limited', ...(ms === undefined ? {} : { retryAfterMs: ms }) };
    }
    if (status === HTTP_BAD_REQUEST || status === HTTP_TOO_LARGE)
        return { status: 'permanent', reason: 'payload-refused' };
    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN || status === HTTP_NOT_FOUND) {
        return { status: 'permanent', reason: 'destination-refused' };
    }
    return { status: 'retryable', reason: 'upstream-error' };
}

/** `fetch` is injectable so a test aims it at a local fake; production uses the global one. */
export function createDiscordConnector({
    fetch: fetchFn = globalThis.fetch,
}: {
    fetch?: typeof globalThis.fetch;
} = {}): NotificationConnector<DiscordConfig> {
    return {
        kind: 'discord',
        validateConfig,
        validateCredential,
        async send(event, _config, credential, signal) {
            let response: Response;
            try {
                response = await fetchFn(`${credential}?wait=true`, {
                    method: 'POST',
                    headers: JSON_HEADERS,
                    body: JSON.stringify({ embeds: [embedOf(event)], allowed_mentions: { parse: [] } }),
                    redirect: 'error',
                    signal,
                });
            } catch {
                return { status: 'retryable', reason: signal.aborted ? 'aborted' : 'transport' };
            }
            const { status, headers } = response;
            const readsBody = (status >= HTTP_OK_FIRST && status <= HTTP_OK_LAST) || status === HTTP_RATE_LIMITED;
            if (!readsBody) {
                void response.body?.cancel().catch(() => {});
                return resultOf(status, headers, undefined);
            }
            try {
                return resultOf(status, headers, await readJson(response, signal));
            } catch {
                return { status: 'retryable', reason: 'aborted' };
            }
        },
    };
}
