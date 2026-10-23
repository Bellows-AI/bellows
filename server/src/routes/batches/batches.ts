import type { FastifyPluginAsync } from 'fastify';
import type { OrgRegistry } from '../../orgs.js';
import {
    handleAccept,
    handleCancel,
    handleCreate,
    handleGet,
    handleList,
    handleReplace,
    handleReport,
    handleRetry,
    handleStart,
    handleValidate,
} from './batch-handlers.js';
import { BODY_LIMIT, CONTROL_BODY_LIMIT } from '../jobs/job-limits.js';

/**
 * The batch lifecycle's HTTP surface (docs/batches.md): human credentials only — the hook walls
 * every `/api/batches` path as `user`, and a worker or organization credential never reaches a
 * handler. The org is the caller's; no body field names it. Handlers are in
 * `batch-handlers.ts`, the launch checks in `batch-launch.ts`, scheduling in
 * `db/batches/batch-store-schedule.ts`.
 */
export const batchRoutes =
    ({ orgs }: { orgs: OrgRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.post('/api/batches', { bodyLimit: BODY_LIMIT }, (request, reply) => handleCreate(orgs, request, reply));
        app.get('/api/batches', (request, reply) => handleList(orgs, request, reply));
        app.get('/api/batches/:id', (request, reply) => handleGet(orgs, request, reply));
        app.get('/api/batches/:id/report', (request, reply) => handleReport(orgs, request, reply));
        app.put('/api/batches/:id', { bodyLimit: BODY_LIMIT }, (request, reply) => handleReplace(orgs, request, reply));
        app.post('/api/batches/:id/validate', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleValidate(orgs, request, reply)
        );
        app.post('/api/batches/:id/start', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleStart(orgs, request, reply)
        );
        app.post('/api/batches/:id/tasks/:key/retry', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleRetry(orgs, request, reply)
        );
        app.post('/api/batches/:id/tasks/:key/accept', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleAccept(orgs, request, reply)
        );
        app.post('/api/batches/:id/cancel', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleCancel(orgs, request, reply)
        );
    };
