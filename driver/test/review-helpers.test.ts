import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HELPER_REGISTRY, parseHelperOutput } from '../src/helpers.js';
import { REVIEW_COLLECT_PROBE_ID, REVIEW_REPLY_PROBE_ID } from '../src/review-helpers.js';
import { cleanupTempDirs, fixture, runSource, writeFixture } from './fixtures/review-script-support.js';

/**
 * End-to-end coverage of the github-review-reconcile block's two composed helper bodies (issue
 * #133) against a stub `gh`, mirroring `review-collect-script.test.ts`'s own convention but
 * driving the ASSEMBLED body (prelude + the unmodified #201 script + postlude), never a single
 * file — the pieces are unit-testable on their own, but only the assembly proves the HELPER_INPUT
 * mapping, the stdout capture/restore, and the final envelope all actually compose end to end.
 */

afterEach(cleanupTempDirs);

const PUBLICATION = { repo: 'octo/factory', prNumber: 7 };

/** Writes a registry descriptor's composed body to a temp file `runSource` can execute. */
function writeComposedBody(id: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'review-helper-'));
    const path = join(dir, `${id}.cjs`);
    writeFileSync(path, HELPER_REGISTRY.get(id)!.scriptBody);
    return path;
}

/** A fresh working directory for one probe run. */
const tempCwd = (): string => mkdtempSync(join(tmpdir(), 'review-cwd-'));

/**
 * Runs helper `id`'s composed body against the stub `gh` with PUBLICATION as its input, in `cwd`;
 * answers the run and its verdict (the last stdout line).
 */
async function probe(
    id: string,
    env: Record<string, string> = {},
    opts: { cwd?: string; token?: boolean } = {}
): Promise<{ run: Awaited<ReturnType<typeof runSource>>; verdict: Record<string, unknown> }> {
    const run = await runSource(
        writeComposedBody(id),
        { HELPER_INPUT: JSON.stringify({ publication: PUBLICATION }), ...env },
        { ...opts, cwd: opts.cwd ?? tempCwd() }
    );
    return { run, verdict: JSON.parse(run.stdout.trim().split('\n').filter(Boolean).pop()!) };
}

/** An empty-but-well-shaped gh-responses.json fixture: no feedback, no requested reviewers. */
function emptyFixture(
    over: { decision?: string | null; users?: string[]; teams?: string[]; checkStatuses?: string[] } = {}
): string {
    return writeFixture({
        general: [],
        reviews: [],
        inline: [],
        checks: {
            total_count: (over.checkStatuses ?? []).length,
            check_runs: (over.checkStatuses ?? []).map((status, i) => ({ name: `check-${i}`, status })),
        },
        requested: {
            users: (over.users ?? []).map((login) => ({ login })),
            teams: (over.teams ?? []).map((name) => ({ name })),
        },
        threads: {
            data: {
                repository: {
                    pullRequest: {
                        reviewDecision: over.decision ?? null,
                        headRefOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                        reviewThreads: { totalCount: 0, nodes: [] },
                    },
                },
            },
        },
    });
}

const emptyThreads = () => ({
    data: {
        repository: {
            pullRequest: {
                reviewDecision: null,
                headRefOid: 'a'.repeat(40),
                reviewThreads: { totalCount: 0, nodes: [] },
            },
        },
    },
});

/** A worktree whose digest presents `keys` and whose repair agent declared `intents`. */
function replyState(keys: string[], intents: { key: string; reply: string; resolve: boolean }[]): string {
    const cwd = tempCwd();
    const stateDir = join(cwd, '.factory', 'review-reconcile');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
        join(stateDir, 'digest.json'),
        JSON.stringify({ schema: 'review-reconcile-digest/v1', version: 1, items: keys.map((key) => ({ key })) })
    );
    writeFileSync(
        join(stateDir, 'intents.json'),
        JSON.stringify({ schema: 'review-reconcile-intents/v1', items: intents })
    );
    return cwd;
}

/** The gh calls that write to the PR: a posted comment, a reply, a thread resolve. */
const writesOf = (args: string[][]): string[][] =>
    args.filter((a) => {
        const joined = a.join(' ');
        return (
            (joined.includes('/comments') && a.includes('-f')) ||
            (joined.includes('graphql') && a.some((x) => x.includes('resolveReviewThread')))
        );
    });

describe('the review-collect-probe helper', () => {
    it('registers with the generic helper transport under its own schema', () => {
        const descriptor = HELPER_REGISTRY.get(REVIEW_COLLECT_PROBE_ID);
        expect(descriptor?.schema).toBe('review-collect-probe/v1');
        expect(descriptor?.version).toBe(1);
    });

    it('concludes REVIEW-CLEAN when the PR is approved with nothing outstanding', async () => {
        const { run, verdict } = await probe(REVIEW_COLLECT_PROBE_ID, {
            GH_FIXTURES: emptyFixture({ decision: 'APPROVED' }),
        });
        expect(verdict).toEqual({
            schema: 'review-collect-probe/v1',
            version: 1,
            ok: true,
            output: 'REVIEW-CLEAN',
            control: 'conclude',
        });
        const result = parseHelperOutput(HELPER_REGISTRY.get(REVIEW_COLLECT_PROBE_ID)!, run.stdout);
        expect(result).toEqual({ ok: true, output: 'REVIEW-CLEAN', control: 'conclude' });
    });

    // Regression (the head-check rows): collect ran 17s after the PR opened, while the CI run
    // carrying the claude[bot] review job was still in progress, concluded REVIEW-CLEAN and ended
    // the block before the review landed — a review bot may still be running.
    it.each<[string, Parameters<typeof emptyFixture>[0], string]>([
        ['a reviewer is requested but nothing is actionable yet', { users: ['reviewer-a'] }, 'REVIEW-WAIT'],
        ['a head check run is queued', { checkStatuses: ['completed', 'queued'] }, 'REVIEW-WAIT'],
        ['a head check run is in_progress', { checkStatuses: ['completed', 'in_progress'] }, 'REVIEW-WAIT'],
        ['every head check run completed', { checkStatuses: ['completed', 'completed'] }, 'REVIEW-CLEAN'],
    ])('concludes when %s', async (_label, over, marker) => {
        const { verdict } = await probe(REVIEW_COLLECT_PROBE_ID, { GH_FIXTURES: emptyFixture(over) });
        expect(verdict.output).toBe(marker);
        expect(verdict.control).toBe('conclude');
    });

    it("surfaces a review bot's feedback — only Factory's own marked replies are skipped", async () => {
        // Regression: every `[bot]` author was dropped, so claude[bot]'s Major inline finding
        // never reached the digest and the block concluded REVIEW-CLEAN over it.
        const cwd = tempCwd();
        const gh = writeFixture({
            general: [
                {
                    id: 501,
                    user: { login: 'claude[bot]' },
                    body: '1 Major finding',
                    created_at: '2026-09-05T00:00:00Z',
                },
            ],
            reviews: [
                {
                    id: 61,
                    user: { login: 'claude[bot]' },
                    state: 'COMMENTED',
                    body: 'see inline',
                    submitted_at: '2026-09-05T00:00:00Z',
                    commit_id: 'abc',
                },
            ],
            inline: [],
            requested: { users: [], teams: [] },
            threads: {
                data: {
                    repository: {
                        pullRequest: {
                            reviewDecision: null,
                            reviewThreads: {
                                totalCount: 1,
                                nodes: [
                                    {
                                        id: 'T_bot',
                                        isResolved: false,
                                        isOutdated: false,
                                        path: 'src/request.js',
                                        line: 124,
                                        comments: {
                                            totalCount: 1,
                                            nodes: [
                                                {
                                                    id: 'IC_bot',
                                                    databaseId: 701,
                                                    author: { login: 'claude' },
                                                    body: 'Major — the fallback also applies to email and SMS.',
                                                    createdAt: '2026-09-05T00:00:00Z',
                                                },
                                            ],
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const { verdict } = await probe(REVIEW_COLLECT_PROBE_ID, { GH_FIXTURES: gh }, { cwd });
        expect(verdict.output).toBe('REVIEW-ACTIONABLE');
        const digest = JSON.parse(readFileSync(join(cwd, '.factory', 'review-reconcile', 'digest.json'), 'utf8'));
        const keys = digest.items.map((i: { key: string }) => i.key).sort();
        expect(keys).toEqual(['general:501', 'review:61', 'thread:T_bot']);
    });

    it('answers REVIEW-ACTIONABLE and writes a digest when unresolved feedback exists', async () => {
        const cwd = tempCwd();
        // The shared gh-responses.json fixture (review-collect-script.test.ts's own data): a
        // CHANGES_REQUESTED review, two general comments, an unresolved thread and a resolved one.
        const { verdict } = await probe(REVIEW_COLLECT_PROBE_ID, {}, { cwd });
        expect(verdict).toEqual({
            schema: 'review-collect-probe/v1',
            version: 1,
            ok: true,
            output: 'REVIEW-ACTIONABLE',
        });

        const digestPath = join(cwd, '.factory', 'review-reconcile', 'digest.json');
        expect(existsSync(digestPath)).toBe(true);
        const digest = JSON.parse(readFileSync(digestPath, 'utf8'));
        expect(digest.schema).toBe('review-reconcile-digest/v1');
        const keys = digest.items.map((i: { key: string }) => i.key).sort();
        // general:401/402 (unresolved conversation comments), review:23 (CHANGES_REQUESTED with a
        // body), thread:T_a (unresolved) — thread:T_b is resolved and excluded, and inline 111/112
        // are excluded as already covered by thread T_a's own comments (never double-counted).
        expect(keys).toEqual(['general:401', 'general:402', 'review:23', 'thread:T_a']);
    });

    it('never re-surfaces a general/review item once a bot reply carrying its marker exists', async () => {
        // Regression: a general/review item's own body never gets the addressed marker — the
        // reply lands as a brand-new, SEPARATE general comment (review-reply-probe-middle.cjs's
        // generalTarget). The digest must look for the marker across `general`, not on the
        // original comment's own body, or the item would loop as actionable forever.
        const cwd = tempCwd();
        const base = JSON.parse(readFileSync(fixture('gh-responses.json'), 'utf8'));
        const gh = writeFixture({
            ...base,
            general: [
                ...base.general,
                {
                    id: 999,
                    user: { login: 'factory-ai[bot]' },
                    body: 'added a regression test\n\n<!-- factory-review-reconcile addressed general:401 -->\n\naddressed review:23 too\n\n<!-- factory-review-reconcile addressed review:23 -->',
                    created_at: '2026-09-04T00:00:00Z',
                },
            ],
        });
        await probe(REVIEW_COLLECT_PROBE_ID, { GH_FIXTURES: gh }, { cwd });
        const digestPath = join(cwd, '.factory', 'review-reconcile', 'digest.json');
        const digest = JSON.parse(readFileSync(digestPath, 'utf8'));
        const keys = digest.items.map((i: { key: string }) => i.key).sort();
        // general:401 and review:23 are now addressed; general:402 and thread:T_a still stand.
        expect(keys).toEqual(['general:402', 'thread:T_a']);
    });

    it('fails (never a marker) on an unreadable collection, so the retry edge can re-attempt it', async () => {
        const { run, verdict } = await probe(REVIEW_COLLECT_PROBE_ID, {}, { token: false });
        expect(verdict.ok).toBe(false);
        const result = parseHelperOutput(HELPER_REGISTRY.get(REVIEW_COLLECT_PROBE_ID)!, run.stdout);
        expect(result.ok).toBe(false);
    });
});

describe('the review-reply-probe helper', () => {
    it('registers with the generic helper transport under its own schema', () => {
        const descriptor = HELPER_REGISTRY.get(REVIEW_REPLY_PROBE_ID);
        expect(descriptor?.schema).toBe('review-reply-probe/v1');
        expect(descriptor?.version).toBe(1);
    });

    it('replies only to digest-presented, still-live targets and concludes REVIEW-REPLIED', async () => {
        const cwd = tempCwd();
        const stateDir = join(cwd, '.factory', 'review-reconcile');
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(
            join(stateDir, 'digest.json'),
            JSON.stringify({
                schema: 'review-reconcile-digest/v1',
                version: 1,
                items: [
                    { key: 'general:401', kind: 'general', path: null, body: 'add a test' },
                    { key: 'thread:T_a', kind: 'thread', path: 'src/parse.ts', body: 'null here blows up' },
                ],
            })
        );
        writeFileSync(
            join(stateDir, 'intents.json'),
            JSON.stringify({
                schema: 'review-reconcile-intents/v1',
                items: [
                    { key: 'general:401', reply: 'added a regression test', resolve: false },
                    { key: 'thread:T_a', reply: 'fixed the null path', resolve: true },
                    // Not present in the digest — must never reach the plan.
                    { key: 'general:999', reply: 'should never post', resolve: false },
                ],
            })
        );
        const { run, verdict } = await probe(REVIEW_REPLY_PROBE_ID, {}, { cwd });
        expect(verdict).toEqual({
            schema: 'review-reply-probe/v1',
            version: 1,
            ok: true,
            output: 'REVIEW-REPLIED',
            control: 'conclude',
        });

        // One general comment posted, one inline reply anchored on the thread's first comment
        // (databaseId 111), and one resolve mutation on the thread's real node id — never a
        // fourth call for the stale "general:999" intent the digest never presented.
        const posted = run.args.filter(
            (a) => a.join(' ').includes('issues/7/comments') && a.some((x) => x.startsWith('-f'))
        );
        const replied = run.args.filter((a) => a.join(' ').includes('comments/111/replies'));
        const resolved = run.args.filter(
            (a) => a.join(' ').includes('graphql') && a.some((x) => x.includes('resolveReviewThread'))
        );
        expect(posted.length).toBe(1);
        expect(replied.length).toBe(1);
        expect(resolved.length).toBe(1);
        expect(run.args.some((a) => a.join(' ').includes('999'))).toBe(false);
    });

    it('runs with zero targets when the digest/intents files are absent, and still concludes', async () => {
        const { verdict } = await probe(REVIEW_REPLY_PROBE_ID);
        expect(verdict).toEqual({
            schema: 'review-reply-probe/v1',
            version: 1,
            ok: true,
            output: 'REVIEW-REPLIED',
            control: 'conclude',
        });
    });

    it('never re-posts a reply whose addressed marker the live PR carries past the collection caps', async () => {
        // A replayed reply (issue #826): the first run's writes landed, its answer was lost. Each
        // marker sits past the section the collection keeps (50 general/inline rows, 10 comments
        // per thread) while the item it answers is still inside it.
        const marked = (id: number, key: string) => ({
            id,
            user: { login: 'factory[bot]' },
            body: `done\n\n<!-- factory-review-reconcile addressed ${key} -->`,
            path: 'src/parse.ts',
            line: 5,
            diff_hunk: '@@',
            created_at: '2026-09-04T10:00:00Z',
            in_reply_to_id: null,
            pull_request_review_id: 23,
        });
        const filler = (from: number) =>
            Array.from({ length: 49 }, (_, i) => ({
                ...marked(from + i, 'none'),
                user: { login: 'watcher' },
                body: 'noted',
            }));
        const threadComments = Array.from({ length: 10 }, (_, i) => ({
            id: `IC_${i}`,
            databaseId: 111 + i,
            author: { login: 'naysayer' },
            body: 'still null',
            createdAt: '2026-09-03T13:01:00Z',
        }));
        const gh = writeFixture({
            general: [
                { ...marked(401, 'none'), user: { login: 'commenter' }, body: 'add a test' },
                ...filler(500),
                marked(600, 'general:401'),
                marked(601, 'review:23'),
            ],
            reviews: [{ id: 23, user: { login: 'naysayer' }, state: 'COMMENTED', body: 'see inline' }],
            inline: [
                { ...marked(301, 'none'), user: { login: 'naysayer' }, body: 'rename this' },
                ...filler(700),
                marked(800, 'inline:301'),
                { ...marked(801, 'thread:T_a'), in_reply_to_id: 111 },
            ],
            requested: { users: [], teams: [] },
            reply: { id: 999, body: 'ok', html_url: 'https://example.test/comment/999' },
            threads: {
                data: {
                    repository: {
                        pullRequest: {
                            reviewDecision: 'CHANGES_REQUESTED',
                            headRefOid: 'a'.repeat(40),
                            reviewThreads: {
                                totalCount: 1,
                                nodes: [
                                    {
                                        id: 'T_a',
                                        isResolved: false,
                                        isOutdated: false,
                                        path: 'src/parse.ts',
                                        line: 5,
                                        comments: { totalCount: 11, nodes: threadComments },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const keys = ['general:401', 'review:23', 'inline:301', 'thread:T_a'];
        const cwd = replyState(
            keys,
            keys.map((key) => ({ key, reply: 'addressed', resolve: false }))
        );
        const { run, verdict } = await probe(REVIEW_REPLY_PROBE_ID, { GH_FIXTURES: gh }, { cwd });
        expect(writesOf(run.args)).toEqual([]);
        expect(verdict).toMatchObject({ ok: true, output: 'REVIEW-REPLIED' });
    });

    it('resolves a marked thread whose resolve never landed, without replying to it again', async () => {
        // The reply and the resolve are two writes: a run lost between them leaves the marker on an
        // unresolved thread, and the replay owes exactly the resolve.
        const gh = writeFixture({
            general: [],
            reviews: [],
            inline: [],
            requested: { users: [], teams: [] },
            resolve: { data: { resolveReviewThread: { thread: { id: 'T_a', isResolved: true } } } },
            threads: {
                data: {
                    repository: {
                        pullRequest: {
                            reviewDecision: 'CHANGES_REQUESTED',
                            headRefOid: 'a'.repeat(40),
                            reviewThreads: {
                                totalCount: 1,
                                nodes: [
                                    {
                                        id: 'T_a',
                                        isResolved: false,
                                        isOutdated: false,
                                        path: 'src/parse.ts',
                                        line: 5,
                                        comments: {
                                            totalCount: 2,
                                            nodes: [
                                                {
                                                    id: 'IC_a1',
                                                    databaseId: 111,
                                                    author: { login: 'naysayer' },
                                                    body: 'null here blows up',
                                                    createdAt: '2026-09-03T13:01:00Z',
                                                },
                                                {
                                                    id: 'IC_a2',
                                                    databaseId: 112,
                                                    author: { login: 'factory[bot]' },
                                                    body: 'fixed\n\n<!-- factory-review-reconcile addressed thread:T_a -->',
                                                    createdAt: '2026-09-03T13:05:00Z',
                                                },
                                            ],
                                        },
                                    },
                                ],
                            },
                        },
                    },
                },
            },
        });
        const cwd = replyState(['thread:T_a'], [{ key: 'thread:T_a', reply: 'fixed', resolve: true }]);
        const { run, verdict } = await probe(REVIEW_REPLY_PROBE_ID, { GH_FIXTURES: gh }, { cwd });
        expect(verdict).toMatchObject({ ok: true, output: 'REVIEW-REPLIED' });
        expect(writesOf(run.args).map((a) => (a.join(' ').includes('graphql') ? 'resolve' : 'post'))).toEqual([
            'resolve',
        ]);
    });

    it('fails (never REVIEW-REPLIED) when the live collection collapsed past its output bound', async () => {
        // A collapsed collection carries no section at all: planning against it would answer every
        // intent "gone" and acknowledge replies that were never written.
        const big = (id: number) => ({
            id,
            user: { login: 'bulk' },
            body: '汉'.repeat(2000),
            path: 'src/a.ts',
            line: 1,
            diff_hunk: 'x'.repeat(500),
            created_at: '2026-09-03T10:00:00Z',
            in_reply_to_id: null,
            pull_request_review_id: null,
        });
        const gh = writeFixture({
            general: Array.from({ length: 50 }, (_, i) => big(1000 + i)),
            reviews: [],
            inline: Array.from({ length: 50 }, (_, i) => big(2000 + i)),
            requested: { users: [], teams: [] },
            threads: emptyThreads(),
        });
        const cwd = replyState(['general:1000'], [{ key: 'general:1000', reply: 'done', resolve: false }]);
        const { run, verdict } = await probe(REVIEW_REPLY_PROBE_ID, { GH_FIXTURES: gh }, { cwd });
        expect(verdict.ok).toBe(false);
        expect(writesOf(run.args)).toEqual([]);
    });

    it('fails the helper (never concludes) when the underlying collect fetch fails', async () => {
        // GH_HTTP_STATUS fails every gh call, including the fresh re-fetch this node always runs
        // first — proving a reply-step failure propagates as ok:false, never a marker, so the
        // block's own reply->reply retry edge (server/src/db/workflow-blocks/
        // github-review-reconcile.ts) is what re-attempts it.
        const { verdict } = await probe(REVIEW_REPLY_PROBE_ID, { GH_HTTP_STATUS: '403' });
        expect(verdict.ok).toBe(false);
    });
});
