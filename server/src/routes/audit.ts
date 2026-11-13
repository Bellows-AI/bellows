import { Readable } from 'node:stream';
import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { AuthStore } from '../auth/store.js';
import type { AuditEventView, AuditRange } from '../db/audit-log.js';
import { bad } from './helpers.js';

/**
 * `GET /api/audit?from&to`: the caller's organization's audit log over `[from, to)`, one JSON object per line. An
 * `admin` row in ROUTE_CLASSES, so a member is refused by the auth hook before this runs.
 *
 * The rows stream from a database cursor and are never gathered. Fastify destroys the stream when the client goes
 * away and ends the response when the read fails; either way the generator's `return` closes the cursor, so its
 * connection goes back to the pool.
 */

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const NDJSON = 'application/x-ndjson; charset=utf-8';

/** Both edges are required: an export names its window. A bare date is UTC midnight. */
function parseRange(query: unknown): AuditRange | string {
    const { from, to } = (query ?? {}) as { from?: unknown; to?: unknown };
    if (typeof from !== 'string' || typeof to !== 'string') return 'from and to are both required';
    const range = { from: new Date(from), to: new Date(to) };
    if (Number.isNaN(range.from.getTime())) return `Unparseable from '${from}'`;
    if (Number.isNaN(range.to.getTime())) return `Unparseable to '${to}'`;
    if (range.from >= range.to) return 'from must precede to';
    return range;
}

async function* lines(events: AsyncIterable<AuditEventView>): AsyncGenerator<string> {
    for await (const event of events) yield `${JSON.stringify(event)}\n`;
}

export const auditRoutes =
    ({ store }: { store: AuthStore }): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/audit', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            const range = parseRange(request.query);
            if (typeof range === 'string') return bad(reply, ERROR_CODES.BAD_RANGE, range);
            const stream = Readable.from(lines(store.auditEvents(caller.org.id, range)), { objectMode: false });
            return reply.code(HTTP_OK).type(NDJSON).send(stream);
        });
    };
