/**
 * Regenerates telemetry-usage.json (the synthetic usage facts the offline dashboard and the
 * tests replay):
 *
 *     node core/test/fixtures/generate-telemetry.mjs
 *
 * Committed so the fixture is reproducible and reviewable as intent rather than as thousands of
 * lines of JSON. This is SYNTHETIC — hence the loud badge the UI shows when it is the active source.
 *
 * The degradation cases are the point of this file. Each session is labelled with the case it
 * exercises; deleting one silently removes a test. A session is declared once and expanded into
 * what the board and the telemetry store would hold for it: an execution (the board's evidence),
 * a branch report (the hook, unless the case is "no hook"), token points per measured type,
 * a span, field totals and a run row.
 */
import { writeFileSync } from 'node:fs';

const REPO = 'Bellows-AI/bellows.ai';
const AGENT = 'claude-code';
const ORG = 'fixture';

const ALICE = { id: 'u-alice', login: 'alice', name: 'Alice Doe', avatarUrl: 'https://example.com/alice.png' };
const BOB = { id: 'u-bob', login: 'bob', name: null, avatarUrl: null };

const board = [];
const branch = [];
const contributions = [];
const spans = [];
const fields = [];
const runs = [];

const MINUTE = 60_000;
const TYPES = ['input', 'output', 'cacheRead', 'cacheCreation'];

// Two delta points per measured type, a third and two thirds into the session. A type left null
// has no point at all: partial measurement is a missing series, never a zero.
function points(sessionId, { from, to }, tokens, { model, querySource }) {
    const span = Date.parse(to) - Date.parse(from);
    for (const type of TYPES) {
        const value = tokens[type];
        if (value === null) continue;
        const first = Math.round(value * 0.6);
        [first, value - first].forEach((amount, index) => {
            const observedAt = new Date(Date.parse(from) + (span * (index + 1)) / 3).toISOString();
            contributions.push({
                selection: { agent: AGENT, sessionId },
                source: 'otel',
                series: {
                    agent: AGENT,
                    sessionId,
                    metric: 'claude_code.token.usage',
                    field: type,
                    temporality: 'delta',
                    startTime: null,
                    attrsKey: '[]',
                },
                model,
                querySource,
                tokens: { input: null, output: null, cacheRead: null, cacheCreation: null, [type]: amount },
                observedAt,
                support: { from: observedAt, to: observedAt },
                kind: 'timed',
                precision: 'exact',
                reasons: [],
            });
        });
    }
}

function session(id, opts) {
    const {
        repo = REPO,
        from,
        to,
        tokens,
        linesAdded,
        linesRemoved,
        editsAccepted,
        editsRejected,
        activeSeconds,
        commits = 0,
        user = null,
        // The board execution that ran the session: `job` is the run, `root` its thread. Absent
        // means no board task — only the hook knows the session.
        job = null,
        root = job,
        review = null,
        removed = false,
        hook = true,
        model = 'claude-sonnet-4-5',
        querySource = 'main',
        extraJobs = [],
    } = opts;

    spans.push({ agent: AGENT, sessionId: id, firstSeen: from, lastSeen: to });
    points(id, { from, to }, tokens, { model, querySource });
    for (const [field, value] of [
        ['lines_added', linesAdded],
        ['lines_removed', linesRemoved],
        ['edits_accept', editsAccepted],
        ['edits_reject', editsRejected],
        ['active_seconds', activeSeconds],
        ['commits', commits],
    ]) {
        if (value !== undefined) fields.push({ agent: AGENT, sessionId: id, field, value });
    }
    if (hook) branch.push({ orgId: ORG, agent: AGENT, sessionId: id, repo });
    for (const jobId of job === null ? [] : [job, ...extraJobs]) {
        board.push({
            orgId: ORG,
            jobId,
            claimSeq: 1,
            sessionId: id,
            agent: AGENT,
            rootJobId: root,
            requestingJobId: review?.job ?? null,
            requestingRootJobId: review?.root ?? null,
            authorId: user?.id ?? null,
            repo,
            launch: 'observed',
            adoptsClaimSeq: null,
            origin: 'claim',
            startedAt: new Date(Date.parse(from) - 2 * MINUTE).toISOString(),
            endedAt: new Date(Date.parse(to) + MINUTE).toISOString(),
            live: false,
            removed,
            operational: !removed,
        });
    }
    if (job !== null && !opts.noRun) {
        runs.push({
            rootJobId: root,
            repo,
            createdBy: user?.id ?? null,
            createdAt: new Date(Date.parse(from) - 3 * MINUTE).toISOString(),
            agentTurns:
                opts.agentTurns === undefined
                    ? Math.round((Date.parse(to) - Date.parse(from)) / MINUTE / 2)
                    : opts.agentTurns,
            wallClockMs: Date.parse(to) - Date.parse(from) + 3 * MINUTE,
        });
    }
}

// Named fields rather than positional args: each token count is then an object property value,
// which is its own name — the point of this file is the numbers being reviewable as intent.
const T = ({ input, output, cacheRead, cacheCreation }) => ({ input, output, cacheRead, cacheCreation });

session('s01-token-heavy', {
    from: '2026-08-21T06:20:00Z',
    to: '2026-08-21T06:45:00Z',
    tokens: T({ input: 74000, output: 12000, cacheRead: 410000, cacheCreation: 31000 }),
    linesAdded: 380,
    linesRemoved: 116,
    editsAccepted: 18,
    editsRejected: 2,
    activeSeconds: 1320,
    commits: 3,
    user: ALICE,
    job: 't-s01',
});

session('s02-mid-a', {
    from: '2026-08-17T08:20:00Z',
    to: '2026-08-17T08:45:00Z',
    tokens: T({ input: 51000, output: 9000, cacheRead: 288000, cacheCreation: 17000 }),
    linesAdded: 240,
    linesRemoved: 90,
    editsAccepted: 11,
    editsRejected: 1,
    activeSeconds: 1080,
    commits: 2,
    user: ALICE,
    job: 't-s02',
});

session('s03-mid-b', {
    from: '2026-08-17T08:46:00Z',
    to: '2026-08-17T09:02:00Z',
    tokens: T({ input: 33000, output: 6000, cacheRead: 190000, cacheCreation: 8000 }),
    linesAdded: 300,
    linesRemoved: 44,
    editsAccepted: 7,
    editsRejected: 3,
    activeSeconds: 720,
    commits: 1,
    user: ALICE,
    job: 't-s03',
});

session('s04-april', {
    from: '2026-04-20T14:30:00Z',
    to: '2026-04-20T16:00:00Z',
    tokens: T({ input: 60000, output: 10000, cacheRead: 300000, cacheCreation: 20000 }),
    linesAdded: 200,
    linesRemoved: 50,
    editsAccepted: 10,
    editsRejected: 5,
    activeSeconds: 3000,
    commits: 4,
    user: BOB,
    job: 't-s04',
});

// Stretches the weekly window so the seeded-series assertion has interior gaps to catch.
session('s05-april-earliest', {
    from: '2026-04-15T12:00:00Z',
    to: '2026-04-15T14:00:00Z',
    tokens: T({ input: 48000, output: 8000, cacheRead: 260000, cacheCreation: 14000 }),
    linesAdded: 150,
    linesRemoved: 30,
    editsAccepted: 9,
    editsRejected: 2,
    activeSeconds: 2400,
    commits: 2,
    user: BOB,
    job: 't-s05',
});

session('s06-may', {
    from: '2026-05-12T09:50:00Z',
    to: '2026-05-12T11:00:00Z',
    tokens: T({ input: 29000, output: 5000, cacheRead: 150000, cacheCreation: 9000 }),
    linesAdded: 120,
    linesRemoved: 60,
    editsAccepted: 6,
    editsRejected: 1,
    activeSeconds: 3600,
    commits: 2,
    user: BOB,
    job: 't-s06',
});

session('s07-july-a', {
    from: '2026-07-10T09:00:00Z',
    to: '2026-07-10T09:30:00Z',
    tokens: T({ input: 12000, output: 2000, cacheRead: 60000, cacheCreation: 3000 }),
    linesAdded: 40,
    linesRemoved: 10,
    editsAccepted: 3,
    editsRejected: 4,
    activeSeconds: 900,
});

session('s08-july-b', {
    from: '2026-07-11T09:00:00Z',
    to: '2026-07-11T09:20:00Z',
    tokens: T({ input: 7000, output: 1200, cacheRead: 30000, cacheCreation: 1500 }),
    linesAdded: 12,
    linesRemoved: 4,
    editsAccepted: 1,
    editsRejected: 0,
    activeSeconds: 600,
});

// Case: another repo -> excluded from totals, counted in otherRepoSessions. Deliberately the
// largest session in the file, so a broken filter shows up as an obviously inflated total.
// Carries a user: out-of-repo-scope sessions must stay out of byUser even when attributed.
session('s09-other-repo', {
    repo: 'Bellows-AI/other-service',
    from: '2026-07-12T09:00:00Z',
    to: '2026-07-12T10:00:00Z',
    tokens: T({ input: 90000, output: 15000, cacheRead: 500000, cacheCreation: 40000 }),
    linesAdded: 900,
    linesRemoved: 300,
    editsAccepted: 40,
    editsRejected: 5,
    activeSeconds: 3600,
    commits: 6,
    user: BOB,
    job: 't-s09',
});

// Case: a board-owned session the hook never reported -> attributed and counted, but named by
// sessionsWithoutHook (the plugin is missing, or failing).
session('s10-no-hook', {
    from: '2026-07-13T09:00:00Z',
    to: '2026-07-13T09:40:00Z',
    tokens: T({ input: 20000, output: 4000, cacheRead: 100000, cacheCreation: 6000 }),
    linesAdded: 70,
    linesRemoved: 20,
    editsAccepted: 5,
    editsRejected: 1,
    activeSeconds: 1500,
    commits: 1,
    user: ALICE,
    job: 't-s10',
    hook: false,
});

session('s11-july-c', {
    from: '2026-07-21T06:00:00Z',
    to: '2026-07-21T06:30:00Z',
    tokens: T({ input: 18000, output: 3000, cacheRead: 95000, cacheCreation: 5000 }),
    linesAdded: 100,
    linesRemoved: 25,
    editsAccepted: 4,
    editsRejected: 0,
    activeSeconds: 1500,
    commits: 1,
});

session('s12-june', {
    from: '2026-06-01T09:00:00Z',
    to: '2026-06-01T09:25:00Z',
    tokens: T({ input: 9000, output: 1500, cacheRead: 40000, cacheCreation: 2000 }),
    linesAdded: 25,
    linesRemoved: 8,
    editsAccepted: 2,
    editsRejected: 1,
    activeSeconds: 780,
    user: ALICE,
    job: 't-s12',
});

session('s13-august', {
    from: '2026-08-20T10:00:00Z',
    to: '2026-08-20T10:50:00Z',
    tokens: T({ input: 41000, output: 7000, cacheRead: 220000, cacheCreation: 12000 }),
    linesAdded: 160,
    linesRemoved: 55,
    editsAccepted: 8,
    editsRejected: 2,
    activeSeconds: 2700,
    commits: 2,
    user: BOB,
    job: 't-s13',
});

session('s14-july-d', {
    from: '2026-07-02T21:05:00Z',
    to: '2026-07-02T21:20:00Z',
    tokens: T({ input: 37000, output: 6500, cacheRead: 180000, cacheCreation: 11000 }),
    linesAdded: 140,
    linesRemoved: 35,
    editsAccepted: 9,
    editsRejected: 1,
    activeSeconds: 900,
    commits: 2,
});

session('s15-june-b', {
    from: '2026-06-29T20:58:00Z',
    to: '2026-06-29T21:06:00Z',
    tokens: T({ input: 22000, output: 4000, cacheRead: 110000, cacheCreation: 7000 }),
    linesAdded: 80,
    linesRemoved: 20,
    editsAccepted: 5,
    editsRejected: 2,
    activeSeconds: 480,
    commits: 2,
    user: ALICE,
    job: 't-s15',
});

// Case: a follow-up run of the first task, in a session of its own -> one task, two runs.
session('s16-follow-up', {
    from: '2026-08-21T08:00:00Z',
    to: '2026-08-21T08:20:00Z',
    tokens: T({ input: 11000, output: 2500, cacheRead: 70000, cacheCreation: 4000 }),
    linesAdded: 45,
    linesRemoved: 12,
    editsAccepted: 3,
    editsRejected: 0,
    activeSeconds: 700,
    commits: 1,
    user: ALICE,
    job: 't-s01-f1',
    root: 't-s01',
});

// Case: a review of the second task -> its tokens fold into that task, the run stays its own.
session('s17-review', {
    from: '2026-08-17T09:10:00Z',
    to: '2026-08-17T09:25:00Z',
    tokens: T({ input: 8000, output: 1800, cacheRead: 40000, cacheCreation: 2500 }),
    linesAdded: 0,
    linesRemoved: 0,
    editsAccepted: 0,
    editsRejected: 0,
    activeSeconds: 600,
    user: ALICE,
    job: 't-s02-review',
    review: { job: 't-s02', root: 't-s02' },
});

// Case: a task removed from the board -> its usage is retained and named removed, not lost.
session('s18-removed', {
    from: '2026-08-19T13:00:00Z',
    to: '2026-08-19T13:30:00Z',
    tokens: T({ input: 15000, output: 2200, cacheRead: 80000, cacheCreation: 3000 }),
    linesAdded: 60,
    linesRemoved: 15,
    editsAccepted: 4,
    editsRejected: 1,
    activeSeconds: 1100,
    commits: 1,
    user: BOB,
    job: 't-s18',
    removed: true,
    noRun: true,
});

// Case: partial measurement -> cache types were never reported, so they read null, not zero.
session('s19-partial', {
    from: '2026-08-18T10:00:00Z',
    to: '2026-08-18T10:30:00Z',
    tokens: T({ input: 14000, output: 2600, cacheRead: null, cacheCreation: null }),
    linesAdded: 50,
    linesRemoved: 10,
    editsAccepted: 2,
    editsRejected: 1,
    activeSeconds: 900,
    user: BOB,
    job: 't-s19',
    agentTurns: null,
});

// Case: no model and no query source on the points -> the `unknown` row, never a dropped amount.
session('s20-unknown-model', {
    from: '2026-08-14T11:00:00Z',
    to: '2026-08-14T11:20:00Z',
    tokens: T({ input: 9000, output: 1700, cacheRead: 36000, cacheCreation: 1800 }),
    linesAdded: 30,
    linesRemoved: 6,
    editsAccepted: 2,
    editsRejected: 0,
    activeSeconds: 700,
    user: ALICE,
    job: 't-s20',
    model: null,
    querySource: null,
});

// Case: two tasks claim one session -> unresolved ownership, kept out of every figure and
// named in the diagnostics instead of being guessed onto one of them.
session('s21-conflict', {
    from: '2026-08-12T15:00:00Z',
    to: '2026-08-12T15:30:00Z',
    tokens: T({ input: 6000, output: 900, cacheRead: 21000, cacheCreation: 1000 }),
    linesAdded: 10,
    linesRemoved: 2,
    editsAccepted: 1,
    editsRejected: 0,
    activeSeconds: 400,
    user: BOB,
    job: 't-c1',
    extraJobs: ['t-c2'],
    noRun: true,
});

// The second claimant of the conflicting session carries a different thread.
board.find((e) => e.jobId === 't-c2').rootJobId = 't-c2';

const users = [ALICE, BOB];
const byTime = (a, b) => a.localeCompare(b);
const payload = {
    orgId: ORG,
    board: board.sort((a, b) => byTime(a.startedAt, b.startedAt) || byTime(a.jobId, b.jobId)),
    branch,
    foreignSessionIds: [],
    contributions: contributions.sort((a, b) => byTime(a.observedAt, b.observedAt)),
    spans: spans.sort((a, b) => byTime(a.firstSeen, b.firstSeen)),
    users,
    fields,
    runs: runs.sort((a, b) => byTime(a.createdAt, b.createdAt)),
};

writeFileSync(new URL('./telemetry-usage.json', import.meta.url), `${JSON.stringify(payload, null, 1)}\n`);
console.log(`wrote ${spans.length} sessions, ${contributions.length} points, ${runs.length} runs`);
