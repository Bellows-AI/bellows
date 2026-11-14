import { describe, expect, it } from 'vitest';
import { createBoard } from '../src/board/board.js';
import { parseClaim } from '../src/board/board-claim.js';

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
        const parsed = parseClaim({ ...WIRE, env: { A: '1' }, repo: 'o/r', agent: false, baseBranch: null });
        expect('claim' in parsed && parsed.claim.id).toBe('job-1');
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
