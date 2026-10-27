import { EventEmitter } from 'node:events';
import type { readFileSync } from 'node:fs';
import { Agent, globalAgent } from 'node:https';
import type { request as httpsRequest } from 'node:https';
import type { RequestOptions } from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_LIMIT, OUTPUT_LIMIT } from '../src/runner.js';
import {
    DIAGNOSIS_BODY_CHARS,
    inClusterRequest,
    is2xx,
    isMalformedRequest400,
    isRecord,
    readAnswer,
    refusalDiagnosis,
} from '../src/k8s/k8s-transport.js';
import { asNamed, asPod } from '../src/k8s/k8s-pod-shapes.js';
import { asJob, readTypedList } from '../src/k8s/k8s-poll.js';
import { withSignal, type K8sDeps, type K8sRequest } from '../src/k8s/k8s-transport.js';

const METRICS_PATH = '/apis/metrics.k8s.io/v1beta1/namespaces/factory/pods/runner-1';
const LOG_PATH = '/api/v1/namespaces/factory/pods/runner-1/log?tailLines=1000';
const status = (message: string, reason?: string) => JSON.stringify({ kind: 'Status', message, reason, code: 400 });
const CREATING = status('container "runner" in pod "runner-1" is waiting to start: ContainerCreating', 'BadRequest');

describe('is2xx', () => {
    it('holds for 200 through 299 and nothing else', () => {
        expect([199, 200, 204, 299, 300, 404].map(is2xx)).toEqual([false, true, true, true, false, false]);
    });
});

const itemsShape = (body: unknown): unknown[] | null =>
    isRecord(body) && Array.isArray(body.items) ? body.items : null;

describe('readAnswer', () => {
    const answer = (status: number, body: string) => readAnswer({ status, body }, 'listing the pods', itemsShape);

    it('reads a 404 as the confirmed absence', () => {
        expect(answer(404, '{"kind":"Status","reason":"NotFound"}')).toEqual({ kind: 'absent' });
    });

    it('reads any other non-2xx answer as inconclusive, with the apiserver’s words', () => {
        expect(answer(503, 'unavailable')).toEqual({
            kind: 'inconclusive',
            reason: expect.stringMatching(/listing the pods answered 503/),
        });
        expect(answer(301, '')).toMatchObject({ kind: 'inconclusive', reason: expect.stringMatching(/301/) });
    });

    it.each([
        ['an object that is no list', '{}'],
        ['null', 'null'],
        [
            'a Status object under a 200',
            JSON.stringify({ kind: 'Status', status: 'Failure', message: 'etcd leader changed' }),
        ],
        ['a body cut short', '{"items":[{"metadata":{"na'],
        ['text', '<html>502</html>'],
        ['an array', '[]'],
    ])('reads %s as inconclusive, never as an empty list', (_name, body) => {
        expect(answer(200, body).kind).toBe('inconclusive');
    });

    it('reads a list of the shape asked for as its value', () => {
        expect(answer(200, '{"items":[]}')).toEqual({ kind: 'value', value: [] });
        expect(answer(200, '{"items":[{"a":1}]}')).toEqual({ kind: 'value', value: [{ a: 1 }] });
    });

    it('reads a Job with a uid and a status as a value, and one without either as inconclusive', () => {
        const job = (body: string) => readAnswer({ status: 200, body }, 'reading the Job', asJob);
        const uid = '"metadata":{"uid":"job-uid-1"}';
        expect(job(`{${uid},"status":{"succeeded":1}}`)).toEqual({
            kind: 'value',
            value: { metadata: { uid: 'job-uid-1' }, status: { succeeded: 1 } },
        });
        expect(job(`{${uid},"status":{}}`).kind).toBe('value');
        expect(job(`{${uid}}`).kind).toBe('inconclusive');
        expect(job(`{${uid},"status":"done"}`).kind).toBe('inconclusive');
        // A Job that cannot say which incarnation it is proves nothing about one (#869).
        expect(job('{"status":{"succeeded":1}}').kind).toBe('inconclusive');
        expect(job('{"metadata":{},"status":{}}').kind).toBe('inconclusive');
    });

    it.each([
        ['a string', '"1"'],
        ['a negative number', '-1'],
        ['a fraction', '1.5'],
        ['null', 'null'],
    ])('reads a Job whose count is %s as inconclusive, never as pending', (_name, count) => {
        for (const field of ['succeeded', 'failed', 'active']) {
            const read = readAnswer(
                { status: 200, body: `{"metadata":{"uid":"job-uid-1"},"status":{"${field}":${count}}}` },
                'reading the Job',
                asJob
            );
            expect(read.kind).toBe('inconclusive');
        }
    });
});

describe('the typed list reader', () => {
    const deps = (body: string, status = 200): K8sDeps =>
        ({ request: async () => ({ status, body }), sleep: async () => undefined }) as unknown as K8sDeps;
    const read = (body: string) =>
        readTypedList(deps(body), '/pods', 'listing the pods', { entry: asNamed, once: true });

    it('reads a list of named entries as their value', async () => {
        const entry = { metadata: { name: 'a', uid: 'u', labels: { k: 'v' } }, status: { phase: 'Running' } };
        expect(await read(JSON.stringify({ items: [entry] }))).toEqual({ kind: 'value', value: [entry] });
    });

    it.each([
        ['an empty entry', '{"items":[{}]}'],
        ['a null entry', '{"items":[null]}'],
        ['an entry named by a number', '{"items":[{"metadata":{"name":5}}]}'],
        ['an entry with an empty name', '{"items":[{"metadata":{"name":""}}]}'],
        ['an entry whose labels are not strings', '{"items":[{"metadata":{"name":"a","labels":{"k":1}}}]}'],
        ['an entry whose uid is a number', '{"items":[{"metadata":{"name":"a","uid":7}}]}'],
        ['an entry whose status is no object', '{"items":[{"metadata":{"name":"a"},"status":"up"}]}'],
        ['an entry with a corrupt Job count', '{"items":[{"metadata":{"name":"a"},"status":{"succeeded":"x"}}]}'],
        ['a good entry beside a bad one', '{"items":[{"metadata":{"name":"a"}},{"metadata":{}}]}'],
    ])('makes the whole read inconclusive for %s', async (_name, body) => {
        expect((await read(body)).kind).toBe('inconclusive');
    });

    const unknownStatus = (name: string, state: unknown) => ({
        metadata: { name, creationTimestamp: null, deletionTimestamp: null },
        status: { phase: 'Failed', containerStatuses: [{ name: 'supervisor', state }] },
    });
    const readPods = (items: unknown[]) =>
        readTypedList(deps(JSON.stringify({ items })), '/pods', 'listing the pods', { entry: asPod, once: true });

    it('reads a killed pod whose kubelet left times null as a value (ContainerStatusUnknown)', async () => {
        const killed = unknownStatus('p1', {
            terminated: { exitCode: 137, reason: 'ContainerStatusUnknown', startedAt: null, finishedAt: null },
        });
        expect(await readPods([killed])).toEqual({ kind: 'value', value: [killed] });
    });

    it('names the refused entry and field in the inconclusive reason', async () => {
        const good = unknownStatus('p1', { running: { startedAt: null } });
        const bad = unknownStatus('p2', { terminated: { exitCode: 'x' } });
        expect(await readPods([good, bad])).toEqual({
            kind: 'inconclusive',
            reason: 'listing the pods answered an unexpected shape: items[1] (p2): status.containerStatuses[supervisor].state.terminated.exitCode',
        });
    });

    it('still refuses a started time that is not RFC 3339', async () => {
        const bad = unknownStatus('p1', { running: { startedAt: 'yesterday' } });
        expect((await readPods([bad])).kind).toBe('inconclusive');
    });

    it('reads a transport failure past its retries as inconclusive, naming what failed', async () => {
        const failing = {
            request: async () => Promise.reject(new Error('connection reset')),
            sleep: async () => undefined,
        };
        const result = await readTypedList(failing as unknown as K8sDeps, '/pods', 'listing the pods', {
            entry: asNamed,
            once: true,
        });
        expect(result).toEqual({ kind: 'inconclusive', reason: 'listing the pods: connection reset' });
    });
});

describe('refusalDiagnosis', () => {
    it('stays quiet for the expected metrics 404 and ContainerCreating log 400 only', () => {
        expect(refusalDiagnosis('GET', METRICS_PATH, 404, status('not found', 'NotFound'))).toBeNull();
        expect(refusalDiagnosis('GET', METRICS_PATH, 404, '')).toBeNull();
        expect(refusalDiagnosis('GET', LOG_PATH, 400, CREATING)).toBeNull();
        expect(refusalDiagnosis('GET', LOG_PATH, 200, 'ok')).toBeNull();
    });

    it('keeps every look-alike diagnosable', () => {
        const cases: [string, string, number, string][] = [
            ['GET', '/api/v1/namespaces/factory/pods/runner-1', 404, status('pod not found', 'NotFound')],
            ['DELETE', METRICS_PATH, 404, ''],
            ['GET', METRICS_PATH, 403, status('forbidden', 'Forbidden')],
            ['GET', METRICS_PATH, 500, 'boom'],
            ['GET', LOG_PATH, 400, status('previous terminated container not found', 'BadRequest')],
            ['GET', LOG_PATH, 400, '400 Bad Request'],
            ['GET', LOG_PATH, 400, 'ContainerCreating'],
            ['GET', LOG_PATH, 404, CREATING],
            ['POST', LOG_PATH, 400, CREATING],
            ['GET', '/api/v1/namespaces/factory/pods/runner-1/status', 400, CREATING],
        ];
        for (const [method, path, code, body] of cases) {
            expect(refusalDiagnosis(method, path, code, body), `${method} ${path} ${code}`).toContain(
                `${method} ${path} answered ${code}`
            );
        }
    });

    it('reduces a Status to its message and reason, without the raw JSON', () => {
        const line = refusalDiagnosis('GET', '/api/v1/pods', 403, status('pods is forbidden', 'Forbidden'));

        expect(line).toBe('GET /api/v1/pods answered 403: pods is forbidden (Forbidden)');
    });

    it('previews plain text and invalid JSON, bounded', () => {
        const long = `{"kind":"Status","message":"${'z'.repeat(2 * DIAGNOSIS_BODY_CHARS)}`;
        const hugeMessage = status('m'.repeat(2 * DIAGNOSIS_BODY_CHARS));

        expect(refusalDiagnosis('GET', '/x', 502, 'bad gateway')).toBe('GET /x answered 502 body=bad gateway');
        expect(refusalDiagnosis('GET', '/x', 502, long)).toHaveLength(
            'GET /x answered 502 body='.length + DIAGNOSIS_BODY_CHARS
        );
        expect(refusalDiagnosis('GET', '/x', 400, hugeMessage)).toHaveLength(
            'GET /x answered 400: '.length + DIAGNOSIS_BODY_CHARS
        );
    });
});

interface TransportCall {
    options: RequestOptions;
    writes: string[];
    request: EventEmitter;
}

const OK_STATUS = 200;

function fakeTransport(
    plans: {
        status?: number;
        chunks?: string[];
        timeout?: boolean;
        hang?: boolean;
        headers?: Record<string, string>;
        /** After the headers and `chunks`: no end (`stall`), a byte every few ms (`trickle`), or a broken response. */
        after?: 'stall' | 'trickle' | 'error' | 'aborted' | 'close';
    }[]
) {
    const calls: TransportCall[] = [];
    const request = ((options: RequestOptions, respond: (response: EventEmitter) => void) => {
        const plan = plans[calls.length] ?? {};
        const req = new EventEmitter();
        const call = { options, writes: [] as string[], request: req };
        let trickle: ReturnType<typeof setInterval> | undefined;
        calls.push(call);
        Object.assign(req, {
            write(chunk: string) {
                call.writes.push(chunk);
                return true;
            },
            end() {
                if (plan.hang) return req;
                if (plan.timeout) {
                    queueMicrotask(() => req.emit('timeout'));
                    return req;
                }
                const response = new EventEmitter();
                Object.assign(response, {
                    statusCode: plan.status ?? OK_STATUS,
                    setEncoding: vi.fn(),
                    headers: plan.headers ?? {},
                });
                respond(response);
                queueMicrotask(() => {
                    for (const chunk of plan.chunks ?? []) response.emit('data', chunk);
                    if (plan.after === 'trickle') {
                        trickle = setInterval(() => response.emit('data', 'x'), 5);
                    } else if (plan.after === 'error') response.emit('error', new Error('read ECONNRESET'));
                    else if (plan.after === 'aborted') response.emit('aborted');
                    else if (plan.after === 'close') response.emit('close');
                    else if (plan.after !== 'stall') response.emit('end');
                });
                return req;
            },
            destroy(error: Error) {
                clearInterval(trickle);
                queueMicrotask(() => req.emit('error', error));
                return req;
            },
        });
        return req;
    }) as unknown as typeof httpsRequest;
    return { request, calls };
}

const CLUSTER_ENV = { KUBERNETES_SERVICE_HOST: '10.0.0.1' };
const POD_LOG = '/api/v1/namespaces/factory/pods/runner-1/log?container=agent';
const CREDENTIALS = (() => 'credential') as unknown as typeof readFileSync;

describe('the malformed-request classifier', () => {
    it('names the API server pre-handler 400 Bad Request answer', () => {
        expect(isMalformedRequest400(400, '400 Bad Request')).toBe(true);
        expect(isMalformedRequest400(400, '400 Bad Request: Client sent an HTTP request to an HTTPS server.')).toBe(
            true
        );
        expect(isMalformedRequest400(400, '400 Bad Request\n')).toBe(true);
    });

    it('never names a genuine API Status refusal or any other answer', () => {
        expect(
            isMalformedRequest400(
                400,
                '{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Invalid","code":400}'
            )
        ).toBe(false);
        expect(isMalformedRequest400(503, 'unavailable')).toBe(false);
        expect(isMalformedRequest400(400, 'container "sync" in pod "x" has not started')).toBe(false);
        expect(isMalformedRequest400(200, '400 Bad Request')).toBe(false);
    });
});

describe('the in-cluster kubernetes transport', () => {
    it('fails at construction when the driver is not running in a cluster', () => {
        expect(() => inClusterRequest({ env: {} })).toThrow(/KUBERNETES_SERVICE_HOST is not set/);
    });

    it('pins the cluster CA, rotates the bearer token per call, and preserves raw responses', async () => {
        const transport = fakeTransport([
            { status: 201, chunks: ['cre', 'ated'] },
            { status: 200, chunks: ['read'] },
        ]);
        let tokenReads = 0;
        const readFile = ((path: string) => {
            if (path.endsWith('/ca.crt')) return 'cluster-ca';
            tokenReads += 1;
            return ` token-${tokenReads} \n`;
        }) as typeof readFileSync;
        const request = inClusterRequest({
            env: { KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: '6443' },
            readFile,
            request: transport.request,
            serviceAccountDir: '/service-account',
        });

        await expect(request('POST', '/apis/batch/v1/jobs', { name: 'runner' })).resolves.toEqual({
            status: 201,
            body: 'created',
        });
        await expect(request('GET', '/apis/batch/v1/jobs/runner')).resolves.toEqual({ status: 200, body: 'read' });

        expect(transport.calls.map((call) => call.options)).toMatchObject([
            {
                host: '10.0.0.1',
                port: 6443,
                method: 'POST',
                path: '/apis/batch/v1/jobs',
                ca: 'cluster-ca',
                headers: { authorization: 'Bearer token-1', 'content-type': 'application/json' },
            },
            { headers: { authorization: 'Bearer token-2' } },
        ]);
        expect(transport.calls[0]?.writes).toEqual(['{"name":"runner"}']);
        expect(transport.calls[1]?.writes).toEqual([]);
        expect(tokenReads).toBe(2);
    });

    it('sends a PATCH as a JSON merge patch, the media type the API server requires of one', async () => {
        const transport = fakeTransport([{ status: 200, chunks: ['{}'] }]);
        const request = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
        });

        await request('PATCH', '/apis/batch/v1/namespaces/factory/jobs/runner', { spec: { activeDeadlineSeconds: 9 } });

        expect(transport.calls[0]?.options).toMatchObject({
            method: 'PATCH',
            headers: { 'content-type': 'application/merge-patch+json' },
        });
        expect(transport.calls[0]?.writes).toEqual(['{"spec":{"activeDeadlineSeconds":9}}']);
    });

    it('destroys a timed-out request so a half-open API connection cannot hold a lease forever', async () => {
        const transport = fakeTransport([{ timeout: true }]);
        const request = inClusterRequest({
            env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
            readFile: CREDENTIALS,
            request: transport.request,
        });

        await expect(request('GET', '/version')).rejects.toThrow(/API server did not answer within/);
    });

    it('bounds the socket by the smaller of the default and the own timeout of a call, and hands the signal on', async () => {
        const transport = fakeTransport([{}, {}]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });
        const controller = new AbortController();

        await request('GET', '/version', undefined, { timeoutMs: 1_000, signal: controller.signal });
        await request('GET', '/version', undefined, { timeoutMs: 90_000 });

        expect(transport.calls[0]?.options).toMatchObject({ timeout: 1_000, signal: controller.signal });
        expect(transport.calls[1]?.options.timeout).toBe(30_000);
    });

    it('lets a pod log transfer run to the own timeout of its call, past the default a request gets', async () => {
        const transport = fakeTransport([{}, {}]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });

        await request('GET', '/api/v1/namespaces/factory/pods/p/log', undefined, { timeoutMs: 90_000 });
        await request('GET', '/api/v1/namespaces/factory/pods/p/log?tailLines=5');

        expect(transport.calls[0]?.options.timeout).toBe(90_000);
        expect(transport.calls[1]?.options.timeout).toBe(30_000);
    });

    it('takes a patch media type from its options', async () => {
        const transport = fakeTransport([{}]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });

        await request('PATCH', '/x', {}, { contentType: 'application/strategic-merge-patch+json' });

        expect(transport.calls[0]?.options.headers).toMatchObject({
            'content-type': 'application/strategic-merge-patch+json',
        });
    });

    it('rejects at once for a signal already aborted, and when the signal aborts a call in flight', async () => {
        const transport = fakeTransport([{ hang: true }, { hang: true }]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });
        const done = AbortSignal.abort();
        await expect(request('GET', '/version', undefined, { signal: done })).rejects.toThrow(/abandoned|abort/i);

        const controller = new AbortController();
        const pending = request('GET', '/version', undefined, { signal: controller.signal });
        controller.abort();
        await expect(pending).rejects.toThrow(/abandoned|abort/i);
    });

    it('rejects at the deadline for a response that keeps trickling bytes', async () => {
        const transport = fakeTransport([{ chunks: ['a'], after: 'trickle' }]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });
        const started = Date.now();

        await expect(request('GET', '/version', undefined, { timeoutMs: 60 })).rejects.toThrow(/within 60ms/);

        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('rejects at the deadline for a stalled-open response, though destroy never answers', async () => {
        const transport = fakeTransport([{ chunks: ['a'], after: 'stall' }]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });
        await expect(request('GET', '/version', undefined, { timeoutMs: 60 })).rejects.toThrow(/within 60ms/);
    });

    it.each(['error', 'aborted', 'close'] as const)(
        'rejects a response that breaks after headers and part of the body (%s)',
        async (after) => {
            const transport = fakeTransport([{ chunks: ['{"ite'], after }]);
            const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });

            await expect(request('GET', '/version')).rejects.toThrow(/ECONNRESET|aborted|closed/i);
        }
    );

    it('answers a pod log its stream buffer cut as the tail alone, flagged truncated', async () => {
        const OVERSIZED_MULTIPLIER = 3;
        const transport = fakeTransport([
            { chunks: ['head-', 'x'.repeat(OVERSIZED_MULTIPLIER * ARTIFACT_LIMIT), '-end'] },
        ]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });

        const response = await request('GET', POD_LOG);

        expect(response.truncated).toBe(true);
        expect(response.body.startsWith('head-')).toBe(false);
        expect(response.body.endsWith('x-end')).toBe(true);
        expect(Buffer.byteLength(response.body)).toBeGreaterThanOrEqual(ARTIFACT_LIMIT);
    });

    it('answers a pod log inside the stream buffer whole and unflagged', async () => {
        // Past the buffer this transport once cut at (4 × OUTPUT_LIMIT), inside the one it keeps now.
        const body = 'y'.repeat(ARTIFACT_LIMIT + 1);
        expect(body.length).toBeGreaterThan(4 * OUTPUT_LIMIT);
        const transport = fakeTransport([{ chunks: [body.slice(0, OUTPUT_LIMIT), body.slice(OUTPUT_LIMIT)] }]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });

        await expect(request('GET', POD_LOG)).resolves.toEqual({ status: 200, body });
    });

    it('keeps at least ARTIFACT_LIMIT bytes of a multibyte pod log it cut', async () => {
        const OVERSIZED_MULTIPLIER = 3;
        const transport = fakeTransport([{ chunks: ['あ'.repeat(OVERSIZED_MULTIPLIER * ARTIFACT_LIMIT)] }]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });

        const response = await request('GET', POD_LOG);

        expect(response.truncated).toBe(true);
        expect(Buffer.byteLength(response.body)).toBeGreaterThanOrEqual(ARTIFACT_LIMIT);
    });

    it('reads a structured answer whole, however large — a cut JSON body could only parse wrong', async () => {
        const OVERSIZED_MULTIPLIER = 3;
        const body = JSON.stringify({ items: [{ pad: 'z'.repeat(OVERSIZED_MULTIPLIER * ARTIFACT_LIMIT) }] });
        const transport = fakeTransport([{ chunks: [body.slice(0, OUTPUT_LIMIT), body.slice(OUTPUT_LIMIT)] }]);
        const request = inClusterRequest({ env: CLUSTER_ENV, readFile: CREDENTIALS, request: transport.request });

        const response = await request('GET', '/apis/batch/v1/namespaces/factory/jobs?labelSelector=x');

        expect(response).toEqual({ status: 200, body });
        expect(() => JSON.parse(response.body)).not.toThrow();
    });

    it('preserves the 400 Bad Request prefix of an oversized refusal for classification and the log', async () => {
        const refusal = `400 Bad Request: label does not match selector ${'x'.repeat(4 * OUTPUT_LIMIT)}`;
        const transport = fakeTransport([
            {
                status: 400,
                chunks: [refusal.slice(0, 17), refusal.slice(17)],
                headers: { 'content-type': 'text/plain' },
            },
        ]);
        const logs: string[] = [];
        const request = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
            log: (message) => logs.push(message),
        });

        const response = await request('GET', '/apis/batch/v1/namespaces/default/jobs/factory-sync-x');

        expect(isMalformedRequest400(response.status, response.body)).toBe(true);
        expect(response).toEqual({ status: 400, body: refusal });
        expect(logs).toHaveLength(1);
        expect(logs[0]).toContain(refusal.slice(0, DIAGNOSIS_BODY_CHARS));
    });

    it('keeps the 400 Bad Request start ahead of the tail of a pod-log refusal it cut, flagged', async () => {
        const OVERSIZED_MULTIPLIER = 3;
        const refusal = `400 Bad Request: ${'x'.repeat(OVERSIZED_MULTIPLIER * ARTIFACT_LIMIT)}`;
        const transport = fakeTransport([{ status: 400, chunks: [refusal.slice(0, 17), refusal.slice(17)] }]);
        const request = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
            log: () => undefined,
        });

        const response = await request('GET', POD_LOG);

        expect(response.truncated).toBe(true);
        expect(isMalformedRequest400(response.status, response.body)).toBe(true);
        expect(response.body.startsWith(refusal.slice(0, DIAGNOSIS_BODY_CHARS))).toBe(true);
        expect(response.body.length).toBeLessThan(refusal.length);
    });

    it('answers every call through one dedicated agent, never the global one', async () => {
        const transport = fakeTransport([{ status: 200 }, { status: 200 }]);
        const sentinel = new Agent({ keepAlive: false });
        const injected = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
            agent: sentinel,
        });
        await injected('GET', '/version');

        expect(transport.calls[0]?.options.agent).toBe(sentinel);

        const defaulted = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
        });
        await defaulted('GET', '/version');
        await defaulted('GET', '/version');

        const agent = transport.calls[1]?.options.agent;
        expect(agent).toBeDefined();
        expect(agent).not.toBe(globalAgent);
        expect((agent as Agent & { keepAlive: boolean }).keepAlive).toBe(false);
        expect(transport.calls[2]?.options.agent).toBe(agent);
    });

    it('logs method, path, status, headers and a bounded body on refused answers (400, 500)', async () => {
        const oversized = `boom-${'y'.repeat(DIAGNOSIS_BODY_CHARS + 50)}`;
        const transport = fakeTransport([
            { status: 400, chunks: ['400 ', 'Bad Request'], headers: { 'content-type': 'text/plain' } },
            { status: 200, chunks: ['ok'] },
            { status: 500, chunks: [oversized], headers: {} },
        ]);
        const logs: string[] = [];
        const request = inClusterRequest({
            env: CLUSTER_ENV,
            readFile: CREDENTIALS,
            request: transport.request,
            log: (message) => logs.push(message),
        });

        await request('GET', '/apis/batch/v1/namespaces/default/jobs/factory-sync-x');
        await request('GET', '/version');
        await request('POST', '/apis/batch/v1/namespaces/default/jobs');

        expect(logs).toHaveLength(2);
        expect(logs[0]).toContain('GET');
        expect(logs[0]).toContain('/apis/batch/v1/namespaces/default/jobs/factory-sync-x');
        expect(logs[0]).toContain('400');
        expect(logs[0]).toContain('400 Bad Request');
        expect(logs[0]).not.toContain('headers');
        expect(logs[1]).toContain('POST');
        expect(logs[1]).toContain('500');
        expect(logs[1]).toContain(oversized.slice(0, DIAGNOSIS_BODY_CHARS));
        expect(logs[1]).not.toContain(oversized.slice(0, DIAGNOSIS_BODY_CHARS + 1));
    });
});

describe('withSignal', () => {
    it('hands the signal into each request, and refuses every call once it aborts', async () => {
        const seen: (AbortSignal | undefined)[] = [];
        const request: K8sRequest = async (_method, _path, _body, options) => {
            seen.push(options?.signal);
            return { status: 200, body: '' };
        };
        const controller = new AbortController();
        const deps = withSignal({ request } as unknown as K8sDeps, controller.signal);

        await deps.request('GET', '/version');
        controller.abort();

        expect(seen[0]?.aborted).toBe(true);
        await expect(deps.request('GET', '/version')).rejects.toThrow(/abandoned/);
        expect(seen).toHaveLength(1);
    });

    it('is the deps themselves without a signal', () => {
        const deps = { request: vi.fn() } as unknown as K8sDeps;
        expect(withSignal(deps)).toBe(deps);
    });
});
