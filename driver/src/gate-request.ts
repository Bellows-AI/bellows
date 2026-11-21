import type { IncomingMessage } from 'node:http';
import { readBody } from './http.js';
import { parseJsonObject } from './json-parse.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_PAYLOAD_TOO_LARGE = 413;

/**
 * `{"gate":"<≤64 chars>"}` or `{"exec":"<command>"}` — a body many times a gate name is an attack, not a
 * request, and an exec command past it is a script to write into the worktree and run by name.
 */
const BODY_LIMIT = 4096;

/** A filter is a test name or path pattern, not a program: bounded, printable, one line. */
const FILTER_MAX_CHARS = 256;
const PRINTABLE_FILTER = /^[\x20-\x7e]+$/;

export type GateRequest =
    | { ok: true; gate: string; filter?: string; last?: true }
    | { ok: true; exec: string }
    | { ok: false; status: number; error: string };

const refused = (error: string): GateRequest => ({ ok: false, status: HTTP_BAD_REQUEST, error });

/** `{"exec": "<command>"}` alone: one non-blank command with no NUL, which no `sh -c` argument can carry. */
const execRequest = (parsed: Record<string, unknown>): GateRequest => {
    if (Object.keys(parsed).some((key) => key !== 'exec')) return refused('an exec request carries exec alone');
    if (typeof parsed.exec !== 'string' || !parsed.exec.trim() || parsed.exec.includes('\0')) {
        return refused('exec must be a non-blank command with no NUL byte');
    }
    return { ok: true, exec: parsed.exec };
};

/**
 * Reads and validates the ad-hoc endpoint's request body: exactly one of `{"gate": "<declared name>",
 * "filter"?: "<pattern>"}`, `{"gate": "<declared name>", "last": true}` or `{"exec": "<command>"}`.
 */
export const parseGateRequest = async (request: IncomingMessage): Promise<GateRequest> => {
    const raw = await readBody(request, BODY_LIMIT);
    if (raw === null) return { ok: false, status: HTTP_PAYLOAD_TOO_LARGE, error: 'body too large' };
    const parsed = parseJsonObject(raw);
    if (parsed === null) return refused('body must be JSON');
    if (parsed.exec !== undefined) return execRequest(parsed);
    if (typeof parsed.gate !== 'string' || !parsed.gate.trim()) return refused('gate must be a name');
    if (parsed.last !== undefined) {
        if (parsed.last !== true) return refused('last must be true');
        if (parsed.filter !== undefined) return refused('last reads a stored report: it takes no filter');
        return { ok: true, gate: parsed.gate, last: true };
    }
    if (parsed.filter === undefined) return { ok: true, gate: parsed.gate };
    if (typeof parsed.filter !== 'string' || !parsed.filter.trim() || parsed.filter.length > FILTER_MAX_CHARS) {
        return refused(`filter must be 1-${FILTER_MAX_CHARS} printable characters`);
    }
    if (!PRINTABLE_FILTER.test(parsed.filter)) return refused('filter must be printable ASCII on one line');
    return { ok: true, gate: parsed.gate, filter: parsed.filter };
};
