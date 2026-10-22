import { describe, expect, it } from 'vitest';
import { createDriverMetrics, dockerCommandOf, endpointOf, k8sCallOf, statusClassOf } from '../src/driver-metrics.js';
import type { K8sRequest } from '../src/k8s-transport.js';

const UUID = '3f1c2a4e-9b7d-4c1a-8e2f-5a6b7c8d9e0f';
const LABEL_VALUES = /="([^"]*)"/g;

const labelValues = (text: string): string[] => [...text.matchAll(LABEL_VALUES)].map((m) => m[1]!);

const BOARD = 'http://board:8080';

describe('endpoint normalisation: a finite allowlist relative to the board base', () => {
    it.each([
        [`${BOARD}/api/jobs/${UUID}/heartbeat`, '/api/jobs/:id/heartbeat'],
        [`${BOARD}/api/jobs/${UUID}/heartbeat?leaseSeconds=30`, '/api/jobs/:id/heartbeat'],
        [`${BOARD}/api/jobs/claim`, '/api/jobs/claim'],
        [`${BOARD}/api/jobs/leases`, '/api/jobs/leases'],
        [`${BOARD}/api/reclaims/${UUID}/ack`, '/api/reclaims/:id/ack'],
        [`${BOARD}/api/jobs/${UUID.toUpperCase()}/artifact/chunk?n=1`, '/api/jobs/:id/artifact/chunk'],
        [`${BOARD}/api/jobs/abc123/checkpoint/chunk`, '/api/jobs/:id/checkpoint/chunk'],
        // Not on the list: folded, whatever the segments look like.
        [`${BOARD}/api/jobs/12345/not-an-endpoint`, 'other'],
        [`${BOARD}/api/private-org/secret-name`, 'other'],
        [`${BOARD}/api/jobs/${UUID}/heartbeat/extra`, 'other'],
        [`${BOARD}/elsewhere`, 'other'],
        ['not a url at all', 'other'],
    ])('%s -> %s', (url, expected) => {
        expect(endpointOf(url, BOARD)).toBe(expected);
    });

    it('strips a base path first, so a path-prefixed board never puts the prefix in a label', () => {
        const base = 'http://board/api/private-org';
        expect(endpointOf(`${base}/api/jobs/claim`, base)).toBe('/api/jobs/claim');
        expect(endpointOf(`${base}/api/jobs/${UUID}/complete`, base)).toBe('/api/jobs/:id/complete');
        expect(endpointOf('http://board/api/jobs/claim', base)).toBe('other');
    });

    it('never lets a lowercase id or an unlisted segment reach a label', async () => {
        const base = 'http://board/api/private-org';
        const metrics = createDriverMetrics({
            boardUrl: base,
            fetch: async () => new Response('', { status: 200 }),
        });
        await metrics.fetch(`${base}/api/jobs/claim`);
        await metrics.fetch(`${base}/api/jobs/deadbeefdeadbeef/surprise`);
        const text = await metrics.render();
        expect(text).toContain('endpoint="/api/jobs/claim"');
        expect(text).not.toContain('private-org');
        expect(text).not.toContain('deadbeef');
    });
});

describe('kubernetes call parsing', () => {
    it.each([
        ['GET', '/api/v1/namespaces/ns/pods?labelSelector=a%3Db', { verb: 'list', resource: 'pods' }],
        ['GET', '/api/v1/namespaces/ns/pods/p-1', { verb: 'get', resource: 'pods' }],
        ['GET', '/api/v1/namespaces/ns/pods/p-1/log?tailLines=5', { verb: 'get', resource: 'pods/log' }],
        ['POST', '/apis/batch/v1/namespaces/ns/jobs', { verb: 'create', resource: 'batch/jobs' }],
        ['PATCH', '/api/v1/namespaces/ns/pods/p-1', { verb: 'patch', resource: 'pods' }],
        [
            'PUT',
            '/api/v1/namespaces/ns/persistentvolumeclaims/c-1',
            { verb: 'update', resource: 'persistentvolumeclaims' },
        ],
        ['DELETE', '/api/v1/namespaces/ns/pods/p-1', { verb: 'delete', resource: 'pods' }],
        ['DELETE', '/api/v1/namespaces/ns/pods?labelSelector=x', { verb: 'deletecollection', resource: 'pods' }],
        [
            'GET',
            '/apis/metrics.k8s.io/v1beta1/namespaces/ns/pods/p-1',
            { verb: 'get', resource: 'metrics.k8s.io/pods' },
        ],
        ['GET', '/api/v1/namespaces/ns/widgets/w-1', { verb: 'get', resource: 'other' }],
        ['GET', '/healthz', { verb: 'get', resource: 'other' }],
        ['GET', '', { verb: 'get', resource: 'other' }],
    ] as const)('%s %s', (method, path, expected) => {
        expect(k8sCallOf(method, path)).toEqual(expected);
    });
});

describe('docker command allowlist', () => {
    it('names a known command and folds everything else into other', () => {
        expect(dockerCommandOf(['ps', '-a'])).toBe('ps');
        expect(dockerCommandOf(['volume', 'rm', 'x'])).toBe('volume');
        expect(dockerCommandOf(['--host', 'tcp://x', 'ps'])).toBe('other');
        expect(dockerCommandOf([])).toBe('other');
        expect(dockerCommandOf([`${UUID}`])).toBe('other');
    });
});

describe('status class', () => {
    it('maps codes and a thrown call', () => {
        expect(statusClassOf(200)).toBe('2xx');
        expect(statusClassOf(404)).toBe('4xx');
        expect(statusClassOf(503)).toBe('5xx');
        expect(statusClassOf(null)).toBe('error');
    });
});

describe('the board fetch wrapper', () => {
    it('observes a response by endpoint and status class, and hands the response back untouched', async () => {
        const response = new Response('{}', { status: 409 });
        const metrics = createDriverMetrics({ boardUrl: BOARD, fetch: async () => response });
        expect(await metrics.fetch(`${BOARD}/api/jobs/${UUID}/heartbeat`, { method: 'POST' })).toBe(response);
        const text = await metrics.render();
        expect(text).toContain(
            'factory_driver_board_request_duration_seconds_count{endpoint="/api/jobs/:id/heartbeat",status_class="4xx"} 1'
        );
        expect(labelValues(text).join('\n')).not.toContain(UUID);
    });

    it('records a thrown fetch as error exactly once and rethrows it', async () => {
        const failure = new TypeError('fetch failed');
        const metrics = createDriverMetrics({
            boardUrl: BOARD,
            fetch: async () => {
                throw failure;
            },
        });
        await expect(metrics.fetch(`${BOARD}/api/jobs/claim`)).rejects.toBe(failure);
        const text = await metrics.render();
        expect(text).toContain('endpoint="/api/jobs/claim",status_class="error"} 1');
    });
});

describe('the kubernetes request wrapper', () => {
    it('forwards method, path, body and the very same options object', async () => {
        const seen: unknown[][] = [];
        const reply = { status: 200, body: '{}' };
        const inner: K8sRequest = async (...args) => {
            seen.push(args);
            return reply;
        };
        const metrics = createDriverMetrics({ boardUrl: BOARD });
        const options = { signal: new AbortController().signal, timeoutMs: 5 };
        const body = { a: 1 };
        const wrapped = metrics.k8s(inner, 'runner');
        expect(await wrapped('PATCH', '/api/v1/namespaces/ns/pods/p-1', body, options)).toBe(reply);
        expect(seen).toHaveLength(1);
        expect(seen[0]![0]).toBe('PATCH');
        expect(seen[0]![1]).toBe('/api/v1/namespaces/ns/pods/p-1');
        expect(seen[0]![2]).toBe(body);
        expect(seen[0]![3]).toBe(options);
        const text = await metrics.render();
        expect(text).toContain(
            'factory_driver_k8s_request_duration_seconds_count{client="runner",verb="patch",resource="pods",status_class="2xx"} 1'
        );
    });

    it('records a rejection once as error and rethrows it', async () => {
        const failure = new Error('socket hang up');
        const metrics = createDriverMetrics({ boardUrl: BOARD });
        const wrapped = metrics.k8s(async () => {
            throw failure;
        }, 'reaper');
        await expect(wrapped('GET', '/api/v1/namespaces/ns/pods')).rejects.toBe(failure);
        const text = await metrics.render();
        expect(text).toContain('client="reaper",verb="list",resource="pods",status_class="error"} 1');
    });

    it('records an aborted call as error', async () => {
        const metrics = createDriverMetrics({ boardUrl: BOARD });
        const controller = new AbortController();
        controller.abort();
        const wrapped = metrics.k8s(async (_m, _p, _b, options) => {
            if (options?.signal?.aborted) throw new Error('the call was abandoned');
            return { status: 200, body: '' };
        }, 'runner');
        await expect(
            wrapped('GET', '/api/v1/namespaces/ns/pods/p', undefined, { signal: controller.signal })
        ).rejects.toThrow();
        expect(await metrics.render()).toContain('status_class="error"} 1');
    });
});

describe('the docker exec wrapper', () => {
    it('counts a command by outcome with a closed vocabulary and forwards its result and options', async () => {
        const options = { timeout: 5 };
        let forwarded: unknown;
        const metrics = createDriverMetrics({ boardUrl: BOARD });
        const wrapped = metrics.docker(async (_args, o) => {
            forwarded = o;
            return { stdout: 'ok' };
        }, 'runner');
        expect(await wrapped(['ps', '-a'], options)).toEqual({ stdout: 'ok' });
        expect(forwarded).toBe(options);
        const failing = metrics.docker(async () => {
            throw new Error('exit 1');
        }, 'reaper');
        await expect(failing(['rm', '-f', 'factory-job-x'])).rejects.toThrow('exit 1');
        const text = await metrics.render();
        expect(text).toContain('factory_driver_docker_commands_total{client="runner",command="ps",outcome="ok"} 1');
        expect(text).toContain('factory_driver_docker_commands_total{client="reaper",command="rm",outcome="error"} 1');
        expect(text).not.toContain('factory-job-x');
    });
});

describe('the step and reaper observers', () => {
    it('exposes step durations by kind and outcome and the reaper sweep series', async () => {
        const metrics = createDriverMetrics({ boardUrl: BOARD });
        metrics.step('sync', 'ok', 1.5);
        metrics.reaper.sweep('aborted', 0.2);
        metrics.reaper.scanned('groups', 3);
        metrics.reaper.scanned('groups', 2);
        const text = await metrics.render();
        expect(text).toContain('factory_driver_step_seconds_count{kind="sync",outcome="ok"} 1');
        expect(text).toContain('factory_driver_reaper_sweep_seconds_count{outcome="aborted"} 1');
        expect(text).toContain('factory_driver_reaper_scanned_total{what="groups"} 5');
    });
});
