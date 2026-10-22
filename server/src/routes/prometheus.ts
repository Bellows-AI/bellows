import type { FastifyPluginAsync } from 'fastify';
import type { ServerMetrics } from '../metrics.js';
import { CONTENT_TYPE } from '../prometheus.js';

/**
 * The Prometheus scrape. Under `/api/` so the auth wall covers it (everything else is the SPA's),
 * and a worker route: the shared board secret is the scraper's credential, a session is not.
 * docs/telemetry.md.
 */
export const prometheusRoutes =
    (metrics: ServerMetrics): FastifyPluginAsync =>
    async (app) => {
        app.get('/api/metrics', async (_request, reply) => reply.type(CONTENT_TYPE).send(await metrics.render()));
    };
