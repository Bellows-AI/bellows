import { describe, expect, it } from 'vitest';
import { createDriverMetrics, dockerCommandOf, endpointOf, k8sCallOf, statusClassOf } from '../src/driver-metrics.js';
import type { K8sRequest } from '../src/k8s/k8s-transport.js';
import { countOf, metricsHarness } from './helpers-metrics.js';

const UUID = '3f1c2a4e-9b7d-4c1a-8e2f-5a6b7c8d9e0f';

const BOARD_DURATION = 'bellows.driver.board.request.duration';
const K8S_DURATION = 'bellows.driver.k8s.request.duration';
const DOCKER_DURATION = 'bellows.driver.docker.command.duration';
const DOCKER_COMMANDS = 'bellows.driver.docker.commands';

/** Every attribute value of every point of a collection, as one string a leak would show in. */
const attributeText = async (harness: ReturnType<typeof metricsHarness>): Promise<string> =>
    JSON.stringify((await harness.collect()).flatMap((m) => m.dataPoints.map((p) => p.attributes)));

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

    it('never lets a lowercase id or an unlisted segment reach an attribute', async () => {
        const base = 'http://board/api/private-org';
        const harness = metricsHarness();
        const metrics = createDriverMetrics({
            boardUrl: base,
            fetch: async () => new Response('', { status: 200 }),
            meter: harness.meter,
        });
        await metrics.fetch(`${base}/api/jobs/claim`);
        await metrics.fetch(`${base}/api/jobs/deadbeefdeadbeef/surprise`);
        const text = await attributeText(harness);
        expect(text).toContain('/api/jobs/claim');
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
        const harness = metricsHarness();
        const response = new Response('{}', { status: 409 });
        const metrics = createDriverMetrics({ boardUrl: BOARD, fetch: async () => response, meter: harness.meter });
        expect(await metrics.fetch(`${BOARD}/api/jobs/${UUID}/heartbeat`, { method: 'POST' })).toBe(response);
        const points = await harness.points(BOARD_DURATION);
        expect(countOf(points, { endpoint: '/api/jobs/:id/heartbeat', status_class: '4xx' })).toBe(1);
        expect(await attributeText(harness)).not.toContain(UUID);
    });

    it('records a thrown fetch as error exactly once and rethrows it', async () => {
        const harness = metricsHarness();
        const failure = new TypeError('fetch failed');
        const metrics = createDriverMetrics({
            boardUrl: BOARD,
            fetch: async () => {
                throw failure;
            },
            meter: harness.meter,
        });
        await expect(metrics.fetch(`${BOARD}/api/jobs/claim`)).rejects.toBe(failure);
        expect(
            countOf(await harness.points(BOARD_DURATION), { endpoint: '/api/jobs/claim', status_class: 'error' })
        ).toBe(1);
    });

    it('records seconds, with the carried-over bucket boundaries', async () => {
        const harness = metricsHarness();
        const metrics = createDriverMetrics({
            boardUrl: BOARD,
            fetch: async () => new Response(''),
            meter: harness.meter,
        });
        await metrics.fetch(`${BOARD}/api/jobs/claim`);
        const collected = await harness.collect();
        const metric = collected.find((m) => m.descriptor.name === BOARD_DURATION)!;
        expect(metric.descriptor.unit).toBe('s');
        const [point] = metric.dataPoints as unknown as { value: { buckets: { boundaries: number[] } } }[];
        expect(point!.value.buckets.boundaries).toEqual([
            0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60,
        ]);
    });
});

describe('the kubernetes request wrapper', () => {
    it('forwards method, path, body and the very same options object', async () => {
        const harness = metricsHarness();
        const seen: unknown[][] = [];
        const reply = { status: 200, body: '{}' };
        const inner: K8sRequest = async (...args) => {
            seen.push(args);
            return reply;
        };
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
        const options = { signal: new AbortController().signal, timeoutMs: 5 };
        const body = { a: 1 };
        const wrapped = metrics.k8s(inner, 'runner');
        expect(await wrapped('PATCH', '/api/v1/namespaces/ns/pods/p-1', body, options)).toBe(reply);
        expect(seen).toHaveLength(1);
        expect(seen[0]![0]).toBe('PATCH');
        expect(seen[0]![1]).toBe('/api/v1/namespaces/ns/pods/p-1');
        expect(seen[0]![2]).toBe(body);
        expect(seen[0]![3]).toBe(options);
        expect(
            countOf(await harness.points(K8S_DURATION), {
                client: 'runner',
                verb: 'patch',
                resource: 'pods',
                status_class: '2xx',
            })
        ).toBe(1);
    });

    it('records a rejection once as error and rethrows it', async () => {
        const harness = metricsHarness();
        const failure = new Error('socket hang up');
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
        const wrapped = metrics.k8s(async () => {
            throw failure;
        }, 'reaper');
        await expect(wrapped('GET', '/api/v1/namespaces/ns/pods')).rejects.toBe(failure);
        expect(
            countOf(await harness.points(K8S_DURATION), {
                client: 'reaper',
                verb: 'list',
                resource: 'pods',
                status_class: 'error',
            })
        ).toBe(1);
    });

    it('records an aborted call as error', async () => {
        const harness = metricsHarness();
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
        const controller = new AbortController();
        controller.abort();
        const wrapped = metrics.k8s(async (_m, _p, _b, options) => {
            if (options?.signal?.aborted) throw new Error('the call was abandoned');
            return { status: 200, body: '' };
        }, 'runner');
        await expect(
            wrapped('GET', '/api/v1/namespaces/ns/pods/p', undefined, { signal: controller.signal })
        ).rejects.toThrow();
        expect(
            countOf(await harness.points(K8S_DURATION), {
                client: 'runner',
                verb: 'get',
                resource: 'pods',
                status_class: 'error',
            })
        ).toBe(1);
    });
});

describe('the docker exec wrapper', () => {
    it('counts a command by outcome with a closed vocabulary and forwards its result and options', async () => {
        const harness = metricsHarness();
        const options = { timeout: 5 };
        let forwarded: unknown;
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
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
        const points = await harness.points(DOCKER_COMMANDS);
        expect(countOf(points, { client: 'runner', command: 'ps', outcome: 'ok' })).toBe(1);
        expect(countOf(points, { client: 'reaper', command: 'rm', outcome: 'error' })).toBe(1);
        expect(await attributeText(harness)).not.toContain('factory-job-x');
    });
});

describe('docker command timing and claim slots', () => {
    it('times a command once, by closed vocabulary, on success, on a throw and on a timeout', async () => {
        const harness = metricsHarness();
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
        await metrics.docker(async () => ({ stdout: '' }), 'runner')(['ps', '-a']);
        await expect(
            metrics.docker(async () => {
                throw new Error('exit 1');
            }, 'reaper')(['rm', '-f', 'factory-job-x'])
        ).rejects.toThrow('exit 1');
        await expect(
            metrics.docker(async () => {
                throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
            }, 'runner')(['wait', 'factory-job-x'], { timeout: 5 })
        ).rejects.toThrow('timed out');

        const collected = await harness.collect();
        expect(collected.find((m) => m.descriptor.name === DOCKER_DURATION)?.descriptor.unit).toBe('s');
        const points = await harness.points(DOCKER_DURATION);
        expect(points).toHaveLength(3);
        expect(countOf(points, { client: 'runner', command: 'ps', outcome: 'ok' })).toBe(1);
        expect(countOf(points, { client: 'reaper', command: 'rm', outcome: 'error' })).toBe(1);
        expect(countOf(points, { client: 'runner', command: 'wait', outcome: 'error' })).toBe(1);
        expect(await attributeText(harness)).not.toContain('factory-job-x');
        const counted = await harness.points(DOCKER_COMMANDS);
        expect(countOf(counted, { client: 'runner', command: 'ps', outcome: 'ok' })).toBe(1);
        expect(countOf(counted, { client: 'reaper', command: 'rm', outcome: 'error' })).toBe(1);
    });

    it('reports claim slots by state', async () => {
        const harness = metricsHarness();
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
        metrics.observeSlots(() => ({ busy: 2, open: 0 }));
        const points = await harness.points('bellows.driver.slots');
        expect(countOf(points, { state: 'busy' })).toBe(2);
        expect(countOf(points, { state: 'open' })).toBe(0);
    });
});

describe('the step and reaper observers', () => {
    it('records step durations by kind and outcome and the reaper sweep series', async () => {
        const harness = metricsHarness();
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
        metrics.step('sync', 'ok', 1.5);
        metrics.reaper.sweep('aborted', 0.2);
        metrics.reaper.scanned('groups', 3);
        metrics.reaper.scanned('groups', 2);
        expect(countOf(await harness.points('bellows.driver.step.duration'), { kind: 'sync', outcome: 'ok' })).toBe(1);
        expect(countOf(await harness.points('bellows.driver.reaper.sweep.duration'), { outcome: 'aborted' })).toBe(1);
        expect(countOf(await harness.points('bellows.driver.reaper.scanned'), { what: 'groups' })).toBe(5);
    });

    it('records a gate run’s duration and the guest’s resources by gate name, and nothing without a sample', async () => {
        const harness = metricsHarness();
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
        metrics.gate('test', 'timeout', 12.5, {
            samples: 3,
            seconds: 12,
            cpu: { user: 10, system: 29, iowait: 24, steal: 20, idle: 17 },
            throttledPeriods: 4,
            throttledMs: 1500,
            load: { start: 1, max: 6.5, end: 2 },
            memAvailableMb: { min: 512, end: 900 },
            memTotalMb: 4000,
        });
        metrics.gate('lint', 'passed', 3);
        expect(
            countOf(await harness.points('bellows.driver.gate.duration'), { gate: 'test', outcome: 'timeout' })
        ).toBe(1);
        expect(countOf(await harness.points('bellows.driver.gate.duration'), { gate: 'lint', outcome: 'passed' })).toBe(
            1
        );
        const share = await harness.points('bellows.driver.gate.cpu.share');
        for (const mode of ['user', 'system', 'iowait', 'steal', 'idle']) {
            expect(countOf(share, { gate: 'test', mode }), mode).toBe(1);
        }
        expect(countOf(share, { gate: 'lint', mode: 'user' })).toBeUndefined();
        expect(countOf(await harness.points('bellows.driver.gate.throttled.duration'), { gate: 'test' })).toBe(1);
        expect(countOf(await harness.points('bellows.driver.gate.load.max'), { gate: 'test' })).toBe(1);
        expect(countOf(await harness.points('bellows.driver.gate.memory.available.min'), { gate: 'test' })).toBe(1);
    });

    it('counts the reaper volume exports by result, a loss apart from a drain (issue #938)', async () => {
        const harness = metricsHarness();
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
        metrics.reaper.volumeExport?.('drained');
        metrics.reaper.volumeExport?.('inconclusive');
        metrics.reaper.volumeExport?.('lost');
        metrics.reaper.volumeExport?.('lost');
        const points = await harness.points('bellows.driver.reaper.volume_export');
        expect(countOf(points, { result: 'drained' })).toBe(1);
        expect(countOf(points, { result: 'inconclusive' })).toBe(1);
        expect(countOf(points, { result: 'lost' })).toBe(2);
    });

    it('counts a malformed claim by its first offending field', async () => {
        const harness = metricsHarness();
        const metrics = createDriverMetrics({ boardUrl: BOARD, meter: harness.meter });
        metrics.malformedClaim(['leaseToken', 'env']);
        expect(countOf(await harness.points('bellows.driver.claims.malformed'), { field: 'leaseToken' })).toBe(1);
    });
});

describe('the retired exposition', () => {
    it('has no render: the driver serves no scrape', () => {
        expect(createDriverMetrics({ boardUrl: BOARD, meter: metricsHarness().meter })).not.toHaveProperty('render');
    });
});
