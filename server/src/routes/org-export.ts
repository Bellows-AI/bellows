import { Readable } from 'node:stream';
import { ERROR_CODES } from '@factory-ai/core';
import type { FastifyPluginAsync } from 'fastify';
import { callerOf } from '../auth/plugin.js';
import type { OrgRegistry } from '../orgs.js';
import { bad } from './helpers.js';

/**
 * `GET /api/org/export`: the caller's organization as one tar (`db/org-export.ts`), streamed as it is read. An `admin`
 * row in ROUTE_CLASSES, so a member is refused by the auth hook before this runs.
 *
 * The audit row is written before the first byte. Fastify destroys the stream when the client goes away and ends the
 * response when a read fails, before the archive's end blocks, so a cut-off download is never a complete archive;
 * either way the generator's `return` stops further reads, and the response's close aborts an in-flight listing or
 * object read.
 */

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_UNAVAILABLE = 503;

export const orgExportRoutes =
    ({ orgs }: { orgs: OrgRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/org/export', async (request, reply) => {
            const caller = callerOf(request);
            if (!caller) return bad(reply, ERROR_CODES.UNAUTHENTICATED, 'Sign in required', HTTP_UNAUTHORIZED);
            const exporter = (await orgs.for(caller.org.id))?.orgExport;
            if (!exporter) {
                return bad(
                    reply,
                    ERROR_CODES.WORKSPACE_UNAVAILABLE,
                    'No export for this organization',
                    HTTP_UNAVAILABLE
                );
            }
            await exporter.record(caller.user.id);
            const aborted = new AbortController();
            const stream = Readable.from(exporter.archive(aborted.signal), { objectMode: false });
            // The response's own close, not the stream's: Readable.from closes only once its pending read settles,
            // so a listing or object read in flight when the client goes away is aborted from here.
            reply.raw.once('close', () => aborted.abort());
            stream.once('close', () => aborted.abort());
            const day = new Date().toISOString().slice(0, 10);
            return reply
                .code(HTTP_OK)
                .type('application/x-tar')
                .header('content-disposition', `attachment; filename="bellows-export-${caller.org.id}-${day}.tar"`)
                .send(stream);
        });
    };
