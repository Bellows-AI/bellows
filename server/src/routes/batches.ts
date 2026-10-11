import type { FastifyPluginAsync } from 'fastify';
import type { OrgRegistry } from '../orgs.js';
import {
    BATCH_OPERATION_ACCEPT,
    BATCH_OPERATION_CANCEL,
    BATCH_OPERATION_RETRY,
    handleCreate,
    handleGet,
    handleList,
    handleReplace,
    handleStart,
    handleUnsupported,
    handleValidate,
} from './batch-handlers.js';
import { BODY_LIMIT, CONTROL_BODY_LIMIT } from './job-limits.js';

/**
 * The batch lifecycle's HTTP surface (docs/batches.md): human credentials only — the hook walls
 * every `/api/batches` path as `user`, and a worker or organization credential never reaches a
 * handler. The org is the caller's; no body field names it. Dispatch, retry, cancel and PR-bound
 * acceptance answer `409 BATCH_UNSUPPORTED` until their issues replace the stubs below. Handlers
 * are in `batch-handlers.ts`, the launch checks in `batch-launch.ts`.
 */
export const batchRoutes =
    ({ orgs }: { orgs: OrgRegistry }): FastifyPluginAsync =>
    async (app) => {
        app.post('/api/batches', { bodyLimit: BODY_LIMIT }, (request, reply) => handleCreate(orgs, request, reply));
        app.get('/api/batches', (request, reply) => handleList(orgs, request, reply));
        app.get('/api/batches/:id', (request, reply) => handleGet(orgs, request, reply));
        app.put('/api/batches/:id', { bodyLimit: BODY_LIMIT }, (request, reply) => handleReplace(orgs, request, reply));
        app.post('/api/batches/:id/validate', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleValidate(orgs, request, reply)
        );
        app.post('/api/batches/:id/start', { bodyLimit: CONTROL_BODY_LIMIT }, (request, reply) =>
            handleStart(orgs, request, reply)
        );
        app.post(
            '/api/batches/:id/tasks/:key/retry',
            { bodyLimit: CONTROL_BODY_LIMIT },
            handleUnsupported(orgs, BATCH_OPERATION_RETRY, true)
        );
        app.post(
            '/api/batches/:id/tasks/:key/accept',
            { bodyLimit: CONTROL_BODY_LIMIT },
            handleUnsupported(orgs, BATCH_OPERATION_ACCEPT, true)
        );
        app.post(
            '/api/batches/:id/cancel',
            { bodyLimit: CONTROL_BODY_LIMIT },
            handleUnsupported(orgs, BATCH_OPERATION_CANCEL, false)
        );
    };
