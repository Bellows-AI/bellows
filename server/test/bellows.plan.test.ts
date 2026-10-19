import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { GitHubConfig } from '../src/config.js';
import { createGitHubAppClient } from '../src/github/app-client.js';
import type { InstallationTokenProvider } from '../src/github/app-token.js';
import { createPlanReader, planProblems, resolveExecutionPlan } from '../src/workspace/bellows-plan.js';
import { parseServices } from '../src/workspace/bellows-services.js';

/**
 * The execution plan a claim carries: the services half of `.bellows.yaml`, the plan-level
 * refusals no single block can see (port collisions in the pod's shared network namespace) and the
 * reader that resolves both through the GitHub API at ONE pinned revision. The reader runs over a
 * fake GitHub, so the paths it asks for are the evidence there is no filesystem read left.
 */

const GATES = 'environment:\n    image: node:24\n    gates:\n        - name: test\n          command: npm test\n';
const DB = 'services:\n    - name: db\n      image: postgres:17\n      ports: [5432]\n';

describe('parseServices', () => {
    it('reads name, image, user, environment and the declared ports', () => {
        const text = [
            'services:',
            '    - name: db',
            '      image: postgres:17',
            '      user: "999:999"',
            '      ports: [5432, 5433]',
            '      environment:',
            '          POSTGRES_PASSWORD: factory',
        ].join('\n');
        expect(parseServices(text)).toEqual([
            {
                name: 'db',
                image: 'postgres:17',
                user: { uid: 999, gid: 999 },
                ports: [5432, 5433],
                environment: [{ key: 'POSTGRES_PASSWORD', value: 'factory' }],
            },
        ]);
    });

    it('leaves ports off a service that declares none, and skips the gates half', () => {
        expect(parseServices(`${GATES}services:\n    - name: cache\n      image: redis\n`)).toEqual([
            { name: 'cache', image: 'redis', environment: [] },
        ]);
    });

    it.each([
        [
            'a block list',
            'services:\n    - name: db\n      image: postgres\n      ports:\n        - 5432\n',
            /inline list/,
        ],
        [
            'a non-numeric port',
            'services:\n    - name: db\n      image: postgres\n      ports: [pg]\n',
            /not a TCP port/,
        ],
        ['port zero', 'services:\n    - name: db\n      image: postgres\n      ports: [0]\n', /not a TCP port/],
        ['a port past 65535', 'services:\n    - name: db\n      image: postgres\n      ports: [65536]\n', /not a TCP/],
        [
            'a port listed twice',
            'services:\n    - name: db\n      image: postgres\n      ports: [5432, 5432]\n',
            /twice/,
        ],
        ['a service with no image', 'services:\n    - name: db\n', /missing "image"/],
        [
            'an image that smuggles a docker flag',
            'services:\n    - name: db\n      image: "-v /:/host"\n',
            /does not look like an image reference/,
        ],
        [
            'an unknown service key',
            'services:\n    - name: db\n      image: postgres\n      volumes: x\n',
            /unknown service key/,
        ],
        [
            'the hardening opt-out, naming the hardened alternative',
            'services:\n    - name: db\n      image: postgres\n      unhardened: true\n',
            /"unhardened" is not supported.*user: "uid:gid"/,
        ],
    ])('refuses %s', (_label, text, message) => {
        expect(() => parseServices(text)).toThrow(message);
    });
});

describe('planProblems: what cannot share one pod', () => {
    const service = (name: string, ports?: number[]) => ({
        name,
        image: 'img',
        environment: [],
        ...(ports ? { ports } : {}),
    });

    it('accepts services on distinct ports and services that declare none', () => {
        expect(planProblems([service('a', [1]), service('b', [2]), service('c')])).toEqual([]);
    });

    it('names both services and the port of a collision, with what to change', () => {
        const [problem, ...rest] = planProblems([
            service('a', [5432]),
            service('b', [6379, 5432]),
            service('c', [6379]),
        ]);
        expect(rest).toHaveLength(1);
        expect(problem).toMatch(/"a" and "b" both declare port 5432/);
        expect(problem).toMatch(/share one network namespace/);
        expect(problem).toMatch(/give one of them another port/);
        expect(rest[0]).toMatch(/"b" and "c" both declare port 6379/);
    });

    it('refuses a service named localhost and more services than one pod takes', () => {
        expect(planProblems([service('localhost')])).toEqual([
            'service name "localhost" is reserved — pick another name',
        ]);
        const many = Array.from({ length: 11 }, (_, i) => service(`s${i}`));
        expect(planProblems(many)).toEqual(['at most 10 services fit one task pod, got 11']);
    });
});

describe('resolveExecutionPlan', () => {
    it('carries the gates, the services, the policy and the reviewers of one file', () => {
        const plan = resolveExecutionPlan(`${GATES}${DB}policy:\n    gates: required\n`);
        expect(plan.config?.gates).toEqual([{ name: 'test', command: 'npm test' }]);
        expect(plan.services).toEqual([{ name: 'db', image: 'postgres:17', environment: [], ports: [5432] }]);
        expect(plan.policy).toEqual({ gates: true });
        expect(plan.reviewers).toEqual([]);
    });

    it('reads the reviewer profiles of the same file', () => {
        const plan = resolveExecutionPlan(
            'reviewers:\n    - name: security\n      instructions: "Look for secrets."\n'
        );
        expect(plan.reviewers.map((profile) => profile.name)).toEqual(['security']);
    });

    it('refuses a port collision as one actionable configuration error', () => {
        const collide = `${DB}    - name: db2\n      image: mysql:8\n      ports: [5432]\n`;
        expect(() => resolveExecutionPlan(collide)).toThrow(
            /\.bellows\.yaml: the execution plan cannot be scheduled: services "db" and "db2" both declare port 5432/
        );
    });

    it('refuses an unsupported image of a service and of the gate environment', () => {
        expect(() => resolveExecutionPlan('services:\n    - name: db\n      image: "node 24"\n')).toThrow(/image/);
        expect(() => resolveExecutionPlan('environment:\n    image: node:$TAG\n    gates: []\n')).toThrow(/image/);
    });

    it('refuses gates that declare no image', () => {
        expect(() =>
            resolveExecutionPlan('environment:\n    gates:\n        - name: t\n          command: x\n')
        ).toThrow(/declares no image/);
    });
});

const API = 'https://api.github.test';
const github = { mode: 'app', appId: '1', apiUrl: API, privateKey: 'k' } as unknown as Extract<
    GitHubConfig,
    { mode: 'app' }
>;
const tokens: InstallationTokenProvider = {
    get: async () => 'installation-token',
    fresh: async () => ({ token: 'installation-token', expiresAt: '2026-01-01T01:00:00.000Z' }),
    installationId: async () => '4242',
};

type Reply = { status?: number; body?: unknown };

/** The real client over a fake GitHub: unrouted paths are 404s, and every request is recorded. */
function readerOver(routes: Record<string, Reply>, requests: string[]) {
    const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
        const path = String(input).replace(API, '');
        requests.push(path);
        const reply = routes[path] ?? { status: 404, body: { message: 'Not Found' } };
        return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
    }) as typeof fetch;
    return createPlanReader(createGitHubAppClient(github, tokens, fetchFn));
}

const encoded = (text: string) => ({
    type: 'file',
    encoding: 'base64',
    size: text.length,
    content: Buffer.from(text).toString('base64'),
});

describe('createPlanReader: revision-pinned resolution through the GitHub API', () => {
    it('resolves the base branch tip to a sha and reads the file AT that sha', async () => {
        const requests: string[] = [];
        const reader = readerOver(
            {
                '/repos/acme/web/commits/release': { body: { sha: 'abc123' } },
                '/repos/acme/web/contents/.bellows.yaml?ref=abc123': { body: encoded(`${GATES}${DB}`) },
            },
            requests
        );
        const plan = await reader.read('acme/web', 'release');
        expect(requests).toEqual([
            '/repos/acme/web/commits/release',
            '/repos/acme/web/contents/.bellows.yaml?ref=abc123',
        ]);
        expect(plan).toMatchObject({ revision: 'abc123', error: null });
        expect(plan.config?.image).toBe('node:24');
        expect(plan.services.map((service) => service.name)).toEqual(['db']);
    });

    it('reads the default branch through HEAD when the thread has no base branch', async () => {
        const requests: string[] = [];
        const reader = readerOver(
            {
                '/repos/acme/web/commits/HEAD': { body: { sha: 'def456' } },
                '/repos/acme/web/contents/.bellows.yaml?ref=def456': { body: encoded(GATES) },
            },
            requests
        );
        expect((await reader.read('acme/web', null)).revision).toBe('def456');
        expect(requests[0]).toBe('/repos/acme/web/commits/HEAD');
    });

    it('answers no plan, with the revision, for a commit without a .bellows.yaml', async () => {
        const reader = readerOver({ '/repos/acme/web/commits/HEAD': { body: { sha: 'abc123' } } }, []);
        expect(await reader.read('acme/web', null)).toEqual({
            config: null,
            services: [],
            policy: {},
            reviewers: [],
            revision: 'abc123',
            error: null,
        });
    });

    it('refuses a plan with colliding service ports, still naming the revision it read', async () => {
        const text = `${DB}    - name: db2\n      image: mysql:8\n      ports: [5432]\n`;
        const reader = readerOver(
            {
                '/repos/acme/web/commits/HEAD': { body: { sha: 'abc123' } },
                '/repos/acme/web/contents/.bellows.yaml?ref=abc123': { body: encoded(text) },
            },
            []
        );
        const plan = await reader.read('acme/web', null);
        expect(plan.error).toMatch(/both declare port 5432/);
        expect(plan).toMatchObject({ revision: 'abc123', config: null, services: [] });
    });

    it('refuses a branch the installation cannot see, telling the author what to check', async () => {
        const plan = await readerOver({}, []).read('acme/web', 'gone');
        expect(plan.error).toMatch(/cannot read acme\/web at branch "gone"/);
        expect(plan.revision).toBeNull();
    });

    it('refuses a missing contents permission instead of reading it as "no gates"', async () => {
        const reader = readerOver(
            {
                '/repos/acme/web/commits/HEAD': { body: { sha: 'abc123' } },
                '/repos/acme/web/contents/.bellows.yaml?ref=abc123': { status: 403, body: { message: 'Forbidden' } },
            },
            []
        );
        expect((await reader.read('acme/web', null)).error).toMatch(/could not be read.*403/s);
    });

    it('rejects on a rate limit so the claim is retried, never failing the task', async () => {
        const reader = readerOver({ '/repos/acme/web/commits/HEAD': { status: 429, body: {} } }, []);
        await expect(reader.read('acme/web', null)).rejects.toMatchObject({ kind: 'rate_limited' });
    });

    it('refuses an oversize file as the repository’s problem', async () => {
        const reader = readerOver(
            {
                '/repos/acme/web/commits/HEAD': { body: { sha: 'abc123' } },
                '/repos/acme/web/contents/.bellows.yaml?ref=abc123': { body: { ...encoded('x'), size: 70_000 } },
            },
            []
        );
        expect((await reader.read('acme/web', null)).error).toMatch(/larger than 65536 bytes/);
    });
});

describe("this repository's own .bellows.yaml", () => {
    it('resolves as a schedulable plan with its declared service ports', async () => {
        const text = await readFile(new URL('../../.bellows.yaml', import.meta.url), 'utf8');
        const plan = resolveExecutionPlan(text);
        expect(plan.services.map((service) => [service.name, service.ports])).toEqual([
            ['postgres', [5432]],
            ['s3', [9000]],
        ]);
        expect(plan.config?.gates.map((gate) => gate.name)).toEqual(['test', 'lint']);
    });
});

describe('the server reads no .bellows.yaml from disk', () => {
    const sources = ['bellows.ts', 'bellows-plan.ts', 'bellows-services.ts'];

    it.each(sources)('%s imports no filesystem module', async (file) => {
        const text = await readFile(new URL(`../src/workspace/${file}`, import.meta.url), 'utf8');
        expect(text).not.toMatch(/from 'node:(fs|path)/);
    });

    it('exports no checkout reader and routes no post-sync re-read', async () => {
        expect(Object.keys(await import('../src/workspace/bellows.js'))).not.toContain('readGatesFile');
        const routes = await readFile(new URL('../src/routes/jobs.ts', import.meta.url), 'utf8');
        expect(routes).not.toContain('gates-reread');
    });
});
