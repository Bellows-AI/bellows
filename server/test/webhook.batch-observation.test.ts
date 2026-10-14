import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { BatchPrObserver } from '../src/batch-pr-observer.js';
import type { RefreshHint } from '../src/db/batch-store-observation.js';
import { githubAuth, memoryAuthStore, staticRegistry, stubTelemetryClient, testConfig } from './helpers.js';
import { HTTP_OK, HTTP_UNAUTHORIZED } from './helpers-http.js';

/**
 * Webhooks are hints for the batch PR observer (docs/batches.md): a delivery that can move a
 * check or a mergeability asks for a refresh and never reads, writes state or fails the delivery.
 */
const SECRET = 'webhook-secret-for-the-installation-round-trip';
const ORG = '424242';

let app: FastifyInstance | null = null;
afterEach(async () => {
    await app?.close();
    app = null;
});

function observer(overrides: Partial<BatchPrObserver> = {}) {
    const hints: RefreshHint[] = [];
    const stub: BatchPrObserver = {
        observeDue: async () => 0,
        requestRefresh: async (hint) => {
            hints.push(hint);
            return 1;
        },
        list: async () => [],
        ...overrides,
    };
    return { stub, hints };
}

async function build(batchObserver?: BatchPrObserver) {
    const config = testConfig({ auth: githubAuth(), webhookSecret: SECRET });
    app = await buildApp({
        config,
        orgs: staticRegistry({ config, telemetry: stubTelemetryClient(), ...(batchObserver ? { batchObserver } : {}) }),
        auth: memoryAuthStore(),
    });
}

const sign = (body: string, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

const deliver = (event: string, payload: Record<string, unknown>, secret = SECRET) => {
    const body = JSON.stringify({
        installation: { id: Number(ORG) },
        repository: { full_name: 'acme/web' },
        ...payload,
    });
    return app!.inject({
        method: 'POST',
        url: '/api/github/webhook',
        payload: body,
        headers: {
            'content-type': 'application/json',
            'x-github-event': event,
            'x-github-delivery': `d-${event}`,
            'x-hub-signature-256': sign(body, secret),
        },
    });
};

describe('webhook → batch PR observation hints', () => {
    it.each([
        {
            what: 'a pushed commit',
            event: 'pull_request',
            payload: { action: 'synchronize', pull_request: { number: 7, head: { sha: 'h2' } } },
            numbers: [7],
            headSha: 'h2',
        },
        {
            what: 'a review',
            event: 'pull_request_review',
            payload: { action: 'submitted', pull_request: { number: 7 } },
            numbers: [7],
            headSha: null,
        },
        {
            what: 'a finished check run',
            event: 'check_run',
            payload: {
                action: 'completed',
                check_run: { head_sha: 'h1', pull_requests: [{ number: 7 }, { number: 9 }] },
            },
            numbers: [7, 9],
            headSha: 'h1',
        },
        {
            what: 'a check suite',
            event: 'check_suite',
            payload: { action: 'completed', check_suite: { head_sha: 'h1', pull_requests: [] } },
            numbers: [],
            headSha: 'h1',
        },
        {
            what: 'a commit status',
            event: 'status',
            payload: { sha: 'h1', state: 'failure' },
            numbers: [],
            headSha: 'h1',
        },
    ])('$what asks for a refresh of the PRs it names', async ({ event, payload, numbers, headSha }) => {
        const { stub, hints } = observer();
        await build(stub);

        const response = await deliver(event, payload);

        expect(response.statusCode).toBe(HTTP_OK);
        expect(hints).toEqual([{ repo: 'acme/web', numbers, headSha }]);
    });

    it('hints on a merged close too: the merge path answers first, the hint is beside it', async () => {
        const { stub, hints } = observer();
        await build(stub);

        const response = await deliver('pull_request', { action: 'closed', pull_request: { number: 7, merged: true } });

        expect(response.statusCode).toBe(HTTP_OK);
        expect(hints).toHaveLength(1);
    });

    it('ignores an event that cannot move a check, and a delivery naming no installation', async () => {
        const { stub, hints } = observer();
        await build(stub);

        await deliver('issue_comment', { action: 'created', issue: { number: 7, pull_request: {} } });
        await deliver('push', { ref: 'refs/heads/main' });
        await deliver('status', { installation: null, sha: 'h1' });

        expect(hints).toEqual([]);
    });

    it('never asks on behalf of an unsigned delivery', async () => {
        const { stub, hints } = observer();
        await build(stub);

        const response = await deliver('status', { sha: 'h1' }, 'a-secret-nobody-configured');

        expect(response.statusCode).toBe(HTTP_UNAUTHORIZED);
        expect(hints).toEqual([]);
    });

    it('answers 200 when the observer fails: GitHub must not retry a delivery for our fault', async () => {
        const { stub } = observer({
            requestRefresh: async () => {
                throw new Error('database down');
            },
        });
        await build(stub);

        const response = await deliver('check_run', { action: 'completed', check_run: { head_sha: 'h1' } });

        expect(response.statusCode).toBe(HTTP_OK);
    });

    it('acks a runtime with no observer', async () => {
        await build();

        const response = await deliver('status', { sha: 'h1' });

        expect(response.statusCode).toBe(HTTP_OK);
    });
});
