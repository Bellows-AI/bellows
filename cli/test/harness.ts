import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type RunIo, run } from '../src/run.js';

/** The board every CLI test talks to. */
export const BOARD_URL = 'http://board';
export const ENV = { FACTORY_URL: BOARD_URL, FACTORY_TOKEN: 'fat_abc' };
/** A default settings path that never exists, so no test reads the developer's own file. */
export const NO_SETTINGS = { path: join(tmpdir(), `bellows-absent-${randomUUID()}`, 'settings.json'), explicit: false };

export const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

export const refusal = (status: number, code: string, error: string) => Response.json({ error, code }, { status });

/** One request the CLI sent, read off fetch's arguments. */
export interface Sent {
    url: string;
    /** The URL with the board origin stripped. */
    path: string;
    method: string;
    body: unknown;
    key: string | null;
    authorization: string | null;
}

/**
 * A board that answers each request with `respond` and records what was sent, plus the io a
 * `run()` needs: output collected, read retries backing off without spending real time. `io`
 * overrides any of it (`env`, `settings`, `now`, `sleep`, `readFile`, `readStdin`).
 */
export function recordingBoard(
    respond: (sent: Sent, index: number) => Response | Promise<Response>,
    io: Partial<RunIo> = {}
) {
    const out: string[] = [];
    const err: string[] = [];
    const sent: Sent[] = [];
    const fetch = (async (url: string | URL | globalThis.Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        const entry: Sent = {
            url: String(url),
            path: String(url).replace(BOARD_URL, ''),
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
            key: headers.get('idempotency-key'),
            authorization: headers.get('authorization'),
        };
        sent.push(entry);
        return respond(entry, sent.length - 1);
    }) as unknown as typeof globalThis.fetch;
    const runIo: RunIo = {
        env: ENV,
        settings: NO_SETTINGS,
        fetch,
        sleep: async () => {},
        stdout: (text: string) => out.push(text),
        stderr: (text: string) => err.push(text),
        ...io,
    };
    return { out, err, sent, io: runIo };
}

/** A board that answers each path from `routes`; a path not listed answers 404. */
export const routed = (routes: Record<string, () => Response>) => (sent: Sent) =>
    routes[sent.path]?.() ?? json({ error: `unrouted ${sent.path}`, code: 'NOT_FOUND' }, 404);

/** One CLI run against `recordingBoard(respond, io)`, its output joined. */
export async function runCli(
    argv: string[],
    respond: (sent: Sent, index: number) => Response | Promise<Response>,
    io: Partial<RunIo> = {}
) {
    const b = recordingBoard(respond, io);
    const code = await run(argv, b.io);
    return { code, out: b.out.join(''), err: b.err.join(''), sent: b.sent };
}
