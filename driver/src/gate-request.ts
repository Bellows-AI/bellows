import type { IncomingMessage } from 'node:http';
import { readBody } from './http.js';
import { parseJsonObject } from './json-parse.js';

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;

/**
 * `{"tool":"gate:<≤64 chars>"}` or `{"tool":"exec","input":{"command":"<command>"}}` — a body many times a gate
 * name is an attack, not a request, and an exec command past it is a script to write into the worktree and run by name.
 */
const BODY_LIMIT = 4096;

/** A filter is a test name or path pattern, not a program: bounded, printable, one line. */
const FILTER_MAX_CHARS = 256;
const PRINTABLE_FILTER = /^[\x20-\x7e]+$/;
/** The id prefix of a declared gate (`tools.ts`): `gate:<name>`. */
const GATE_PREFIX = 'gate:';

export type GateRequest =
    | { ok: true; gate: string; filter?: string; last?: true; full?: true }
    | { ok: true; exec: string }
    | { ok: false; status: number; error: string };

const refused = (error: string): GateRequest => ({ ok: false, status: HTTP_BAD_REQUEST, error });

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The exec tool's input, exactly `{"command": "<command>"}`: one non-blank command with no NUL, which no `sh -c` argument can carry. */
const execRequest = (input: Record<string, unknown>): GateRequest => {
    if (Object.keys(input).some((key) => key !== 'command')) return refused('an exec input carries command alone');
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0')) {
        return refused('command must be a non-blank command with no NUL byte');
    }
    return { ok: true, exec: input.command };
};

/** `{"last": true}` or `{"last": true, "full": true}`: the stored report, never with a filter, and `full` only beside `last`. */
const lastRequest = (gate: string, input: Record<string, unknown>): GateRequest => {
    if (input.last === undefined) return refused('full reads the last report: it needs last');
    if (input.last !== true) return refused('last must be true');
    if (input.filter !== undefined) return refused('last reads a stored report: it takes no filter');
    if (input.full === undefined) return { ok: true, gate, last: true };
    if (input.full !== true) return refused('full must be true');
    return { ok: true, gate, last: true, full: true };
};

/** A gate tool's input: none, `{"filter": "<pattern>"}`, `{"last": true}` or `{"last": true, "full": true}`. */
const gateRequest = (gate: string, input: Record<string, unknown> | undefined): GateRequest => {
    if (!gate.trim()) return refused('gate must be a name');
    if (input === undefined) return { ok: true, gate };
    if (Object.keys(input).some((key) => key !== 'filter' && key !== 'last' && key !== 'full')) {
        return refused('a gate input carries filter, or last with full, alone');
    }
    if (input.last !== undefined || input.full !== undefined) return lastRequest(gate, input);
    if (input.filter === undefined) return { ok: true, gate };
    if (typeof input.filter !== 'string' || !input.filter.trim() || input.filter.length > FILTER_MAX_CHARS) {
        return refused(`filter must be 1-${FILTER_MAX_CHARS} printable characters`);
    }
    if (!PRINTABLE_FILTER.test(input.filter)) return refused('filter must be printable ASCII on one line');
    return { ok: true, gate, filter: input.filter };
};

/**
 * Reads and validates a tool call's body, `{"tool": "<id>", "input"?: {...}}`: `exec` with `{"command"}`, or
 * `gate:<declared name>` with no input, `{"filter"}` or `{"last": true}`. Any other id is `404 no tool`.
 */
export const parseGateRequest = async (request: IncomingMessage): Promise<GateRequest> => {
    const raw = await readBody(request, BODY_LIMIT);
    if (raw === null) return { ok: false, status: HTTP_PAYLOAD_TOO_LARGE, error: 'body too large' };
    const parsed = parseJsonObject(raw);
    if (parsed === null) return refused('body must be JSON');
    if (Object.keys(parsed).some((key) => key !== 'tool' && key !== 'input')) {
        return refused('a tool call carries tool and input alone');
    }
    const { tool, input } = parsed;
    if (typeof tool !== 'string' || !tool.trim()) return refused('tool must be an id');
    if (input !== undefined && !isObject(input)) return refused('input must be an object');
    if (tool === 'exec') return input === undefined ? refused('exec takes a command') : execRequest(input);
    if (tool.startsWith(GATE_PREFIX)) return gateRequest(tool.slice(GATE_PREFIX.length), input);
    return { ok: false, status: HTTP_NOT_FOUND, error: `no tool "${tool}"` };
};
