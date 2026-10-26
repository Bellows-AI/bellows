import type { IncomingMessage } from 'node:http';
import { readBody } from './http.js';
import { parseJsonObject } from './json-parse.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

/** `{"gate":"<≤64 chars>"}` — a body many times that size is an attack, not a request. */
const BODY_LIMIT = 4096;

/** A filter is a test name or path pattern, not a program: bounded, printable, one line. */
const FILTER_MAX_CHARS = 256;
const PRINTABLE_FILTER = /^[\x20-\x7e]+$/;

export type GateRequest = { ok: true; gate: string; filter?: string } | { ok: false; status: number; error: string };

/** Reads and validates the ad-hoc endpoint's request body: `{"gate": "<declared name>"}`. */
export const parseGateRequest = async (request: IncomingMessage): Promise<GateRequest> => {
    const raw = await readBody(request, BODY_LIMIT);
    if (raw === null) return { ok: false, status: HTTP_PAYLOAD_TOO_LARGE, error: 'body too large' };
    const parsed = parseJsonObject(raw);
    if (parsed === null) return { ok: false, status: HTTP_BAD_REQUEST, error: 'body must be JSON' };
    if (typeof parsed.gate !== 'string' || !parsed.gate.trim()) {
        return { ok: false, status: HTTP_BAD_REQUEST, error: 'gate must be a name' };
    }
    if (parsed.filter === undefined) return { ok: true, gate: parsed.gate };
    if (typeof parsed.filter !== 'string' || !parsed.filter.trim() || parsed.filter.length > FILTER_MAX_CHARS) {
        return {
            ok: false,
            status: HTTP_BAD_REQUEST,
            error: `filter must be 1-${FILTER_MAX_CHARS} printable characters`,
        };
    }
    if (!PRINTABLE_FILTER.test(parsed.filter)) {
        return { ok: false, status: HTTP_BAD_REQUEST, error: 'filter must be printable ASCII on one line' };
    }
    return { ok: true, gate: parsed.gate, filter: parsed.filter };
};
