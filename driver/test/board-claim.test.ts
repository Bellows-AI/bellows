import { describe, expect, it } from 'vitest';
import { createBoard } from '../src/board/board.js';
import { parseClaim } from '../src/board/board-claim.js';
import { githubRef } from './fixtures/repo-ref.js';

const WIRE = {
    id: 'job-1',
    command: 'echo hi',
    attempts: 1,
    claimSeq: 1,
    leaseToken: 'token-1',
    // The telemetry export credential the runner's config is rendered with: no claim runs without it.
    ingestToken: 'ingest-1',
    leaseExpiresAt: '2026-08-21T12:05:00.000Z',
};

const malformedOf = (raw: unknown) => {
    const parsed = parseClaim(raw);
    return 'malformed' in parsed ? parsed.malformed : null;
};

describe('parseClaim', () => {
    it('reads a well-formed claim into the job', () => {
        const parsed = parseClaim({ ...WIRE, env: { A: '1' }, repo: githubRef('o/r'), agent: false, baseBranch: null });
        expect('claim' in parsed && parsed.claim.id).toBe('job-1');
    });

    it("reads the claim's repo as a ref, and a repo-less claim as no repo", () => {
        const ref = { forge: 'gitlab', host: 'gl.example', path: 'g/sub/p' };
        const parsed = parseClaim({ ...WIRE, repo: ref });
        expect('claim' in parsed && parsed.claim.repo).toEqual(ref);
        expect(malformedOf({ ...WIRE, repo: null })).toBeNull();
        expect(malformedOf(WIRE)).toBeNull();
    });

    it('keeps the organization key the board issued, and drops one that is not a string', () => {
        const keyed = parseClaim({ ...WIRE, orgKey: 'org-key' });
        expect('claim' in keyed && keyed.claim.orgKey).toBe('org-key');
        const odd = parseClaim({ ...WIRE, orgKey: 7 });
        expect('claim' in odd && 'orgKey' in odd.claim).toBe(false);
    });

    it.each(Object.keys(WIRE))('refuses a claim missing %s', (field) => {
        const { [field]: _dropped, ...rest } = WIRE as Record<string, unknown>;
        expect(malformedOf(rest)).toEqual([field]);
    });

    it.each([
        ['id', 7],
        ['leaseToken', null],
        ['claimSeq', '1'],
        ['attempts', Number.NaN],
        ['repo', 5],
        ['repo', 'o/n'],
        ['repo', { forge: 'svn', host: 'h', path: 'o/n' }],
        ['repo', { forge: 'github', host: 'a/b', path: 'o/n' }],
        ['repo', { forge: 'github', host: 'github.com', path: 'g/sub/p' }],
        ['env', { A: 1 }],
        ['env', 'A=1'],
        ['agent', true],
        ['gates', { image: 1 }],
        ['maxAttempts', '3'],
        ['workspacePath', 4],
        ['rootJobId', 4],
        ['gateEnv', [] as unknown],
        ['taskGeneration', 'x'],
    ])('refuses a claim whose %s is %j', (field, value) => {
        expect(malformedOf({ ...WIRE, [field]: value })).toEqual([field]);
    });

    it.each([null, undefined, 'claim', 7, []])('refuses a claim that is %j', (raw) => {
        expect(malformedOf(raw)).toEqual(['claim']);
    });

    it('names every offending field', () => {
        expect(malformedOf({ ...WIRE, id: 1, env: 2 })).toEqual(['id', 'env']);
    });

    // A class name off the wire picks where agent code runs: a value of the wrong type is the board
    // breaking its contract, left to the lease, never read as "the default class".
    it('a non-string runnerClass is a malformed claim', () => {
        expect(malformedOf({ ...WIRE, runnerClass: 5 })).toEqual(['runnerClass']);
        expect(malformedOf({ ...WIRE, runnerClass: { name: 'sandbox' } })).toEqual(['runnerClass']);
        const named = parseClaim({ ...WIRE, runnerClass: 'sandbox' });
        expect('claim' in named && named.claim.runnerClass).toBe('sandbox');
        for (const wire of [WIRE, { ...WIRE, runnerClass: null }]) {
            const parsed = parseClaim(wire);
            expect('claim' in parsed && parsed.claim.runnerClass).toBeNull();
        }
    });
});

describe('the board client on a malformed claim', () => {
    const boardOn = (body: string, onMalformedClaim: (fields: string[]) => void) =>
        createBoard({
            url: 'http://board',
            leaseSeconds: 300,
            onMalformedClaim,
            fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch,
        });

    it('reports it and returns no job, leaving the lease to expire', async () => {
        const seen: string[][] = [];
        const job = await boardOn(JSON.stringify({ ...WIRE, leaseToken: undefined }), (f) => seen.push(f)).claim('w');
        expect(job).toBeNull();
        expect(seen).toEqual([['leaseToken']]);
    });

    it('treats an unparseable body the same way', async () => {
        const seen: string[][] = [];
        expect(await boardOn('<html>', (f) => seen.push(f)).claim('w')).toBeNull();
        expect(seen).toEqual([['claim']]);
    });
});
