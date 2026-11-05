import { describe, expect, it } from 'vitest';
import type { Job, RuntimeVitals } from '../src/api/useJobs.js';
import { NO_GATES, NO_PRS, job, renderDetail, usageBlock } from './tasks-fixtures.js';
import { expectNoPlaceholder } from './fixtures.js';

describe('TaskDetail — task activity (issues #339, #530)', () => {
    const jobId = '11111111-1111-4111-8111-111111111111';
    const activity = {
        [jobId]: {
            jobId,
            sessionId: '33333333-3333-4333-8333-333333333333',
            from: '2026-09-22T20:46:16.000Z',
            to: '2026-09-22T22:46:16.000Z',
            bucketMs: 900_000,
            buckets: [
                {
                    start: '2026-09-22T21:00:00.000Z',
                    tokens: { input: 2_000_000, output: 500_000, cacheRead: 0, cacheCreation: 0 },
                    edits: 3,
                },
            ],
            usage: usageBlock({ input: 2_000_000, output: 500_000, cacheRead: 0, cacheCreation: 0 }),
            task: null,
            gates: NO_GATES,
            prs: NO_PRS,
            taskActivity: { gates: NO_GATES, prs: NO_PRS },
        },
    };

    it('renders the latest run’s pulse in the right column, ahead of the conversation', () => {
        const html = renderDetail({ jobs: [job()], activity });
        expect(html).toContain('Task activity');
        expect(html).toMatch(/data-series="input"/);
        expect(html).not.toContain('bar-primary');
        // The rail leads the DOM: the tile sits in it, before the conversation's first article.
        expect(html.indexOf('Task activity')).toBeGreaterThan(html.indexOf('task-rail'));
        expect(html.indexOf('Task activity')).toBeLessThan(html.indexOf('<article'));
    });

    it('says so in place when the run has no telemetry to chart, and still offers the details', () => {
        const html = renderDetail({ jobs: [job()], activity: { [jobId]: 'unavailable' } });
        expect(html).toContain('No telemetry for this run.');
        expect(html).toContain('Open task statistics');
        // No chart in the activity panel itself — the page's other icons are not the chart's.
        const panel = html.slice(html.indexOf('task-activity'), html.indexOf('task-main'));
        expect(panel).not.toContain('role="img"');
    });
});

describe('TaskDetail', () => {
    it('shows the command, the state and the executor of the task — each once', () => {
        const html = renderDetail({ jobs: [job({ executor: 'main' })] });
        expect(html).toContain('fix the flaky login test');
        expect(html).toContain('Succeeded');
        expect(html).toContain('<dt>Executor</dt><dd>main</dd>');
        // The run carries no status pill or stamp of its own: the controls tile says the state.
        expect(html).not.toContain('<span class="pill">succeeded</span>');
        expect(html).not.toContain('2026-09-01 12:00');
    });

    it('labels turns with their workflow node in the quiet footer, and stays quiet without one', () => {
        // A workflow thread's rows read as the graph they walked: the node sits in the footer of
        // every turn that carries one, and a turn without one renders as before.
        const html = renderDetail({
            jobs: [
                job({ workflowNode: 'implement' }),
                job({
                    id: '22222222-2222-4222-8222-222222222222',
                    status: 'running',
                    workflowNode: null,
                    sessionId: null,
                }),
            ],
        });
        expect(html).toContain('node implement');
        const second = html.slice(html.indexOf('second'), html.indexOf('</article>', html.indexOf('second')));
        expect(second).not.toContain('node ');
        const plain = renderDetail({ jobs: [job()] });
        expect(plain).not.toContain('class="pill">implement</span>');
    });

    it('claims nothing about a task that has not loaded', () => {
        expect(renderDetail({ jobs: null })).toMatch(/Loading the task/);
    });

    it('says so in place when the task could not be loaded', () => {
        const html = renderDetail({ jobs: null, error: 'Request failed (503)' });
        expect(html).toContain('Request failed (503)');
    });
});

describe('TaskDetail — the follow-up composer states', () => {
    const me = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', login: 'me', name: null, avatarUrl: null };
    const other = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', login: 'octo-reviewer', name: null, avatarUrl: null };
    const viewer = { loading: false, id: me.id, admin: false };
    const signedOut = { loading: false, id: null, admin: false };
    const loading = { loading: true, id: null, admin: false };
    const moving = { exitCode: null, finishedAt: null, startedAt: null, output: null };

    type Row = {
        label: string;
        args: Parameters<typeof renderDetail>[0];
        composer: boolean;
        has?: string[];
        lacks?: string[];
    };

    const rows: Row[] = [
        // Stopping is a verdict, not a park: the turn is over, the conversation stays open for an
        // adjustment, and there is no picking the run back up.
        {
            label: 'a stopped task has ended the turn: the composer stays open, and never Resume',
            args: { jobs: [job({ status: 'stopped' })] },
            composer: true,
            lacks: ['Resume'],
        },
        // The run ending is not the task ending: the composer exists exactly for the gap between
        // "the executor stopped" and "I am satisfied".
        {
            label: 'a finished task offers the follow-up composer',
            args: { jobs: [job()] },
            composer: true,
            has: ['Send follow-up'],
        },
        {
            label: 'a queued run offers no composer',
            args: { jobs: [job({ status: 'queued', ...moving })] },
            composer: false,
        },
        {
            label: 'a running run offers no composer',
            args: { jobs: [job({ status: 'running', ...moving })] },
            composer: false,
        },
        // The verdict is visible, not silently implied by the buttons' absence.
        {
            label: 'a task the user has already marked done offers no composer, and shows the verdict',
            args: { jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] },
            composer: false,
            has: ['chat-done'],
        },
        // Only done or removed closes a task: a run that never reported a session — an opencode
        // task, an agent-less workflow step — still takes a follow-up, which the board starts fresh.
        {
            label: 'a run with no session to continue still offers the composer',
            args: { jobs: [job({ sessionId: null })] },
            composer: true,
            lacks: ['no agent session to continue'],
        },
        {
            label: 'your own task offers the composer',
            args: { jobs: [job({ author: me })], viewer },
            composer: true,
            has: ['Ask for a follow-up', 'id="follow-up-command"'],
        },
        {
            label: "another member's task names the author, and offers no composer",
            args: { jobs: [job({ author: other })], viewer },
            composer: false,
            has: ['Only octo-reviewer can continue this session. You can still mark it done.'],
        },
        {
            label: 'a row with no author says "the task author"',
            args: { jobs: [job({ author: null })], viewer },
            composer: false,
            has: ['Only the task author can continue this session.'],
        },
        // A null author and a null viewer are the same nobody — the board's null-safe match.
        {
            label: 'a row with no author, to a viewer with no session, offers the composer',
            args: { jobs: [job({ author: null })], viewer: signedOut },
            composer: true,
        },
        {
            label: 'an authored task is refused to a viewer with no session',
            args: { jobs: [job({ author: me })], viewer: signedOut },
            composer: false,
            has: ['Only me can continue this session.'],
        },
        // Nothing while the session loads, so your own task never flashes a refusal.
        ...[me, other].map((author) => ({
            label: `${author.login}'s task renders nothing while the session loads`,
            args: { jobs: [job({ author })], viewer: loading },
            composer: false,
            lacks: ['can continue this session', 'Follow up'],
        })),
        {
            label: 'a closed task renders nothing, even for another member',
            args: { jobs: [job({ author: other, doneAt: '2026-09-01T13:00:00.000Z' })], viewer },
            composer: false,
            lacks: ['can continue this session'],
        },
    ];

    it.each(rows.map((row) => [row.label, row] as const))('%s', (_label, { args, composer, has = [], lacks = [] }) => {
        const html = renderDetail(args);
        if (composer) expect(html).toContain('<textarea');
        else expect(html).not.toContain('<textarea');
        for (const text of has) expect(html).toContain(text);
        for (const text of lacks) expect(html).not.toContain(text);
    });

    it("keeps the transcript clean of task actions — those are the controls tile's", () => {
        // The main column carries no Stop/Done/Remove — the right column's controls tile does;
        // its own composer's Send follow-up stays, of course.
        const finished = renderDetail({ jobs: [job()] }).split('task-main')[1]!;
        expect(finished).not.toContain('chat-resume');
        expect(finished).not.toContain('chat-stop');
        expect(finished).not.toContain('chat-remove');
        expect(finished).not.toContain('task-actions');
    });

    it('disables the follow-up Send until text is typed', () => {
        const html = renderDetail({ jobs: [job()] });
        const LOOKBEHIND_CHARS = 200;
        const at = html.lastIndexOf('aria-label="Send follow-up"');
        const send = html.slice(at - LOOKBEHIND_CHARS, at);
        expect(send).toContain('disabled');
    });

    it('never emits a placeholder value', () => {
        const html = renderDetail({
            jobs: [
                job({ executor: null, repo: null, output: null, exitCode: null, finishedAt: null, startedAt: null }),
            ],
        });
        expectNoPlaceholder(html);
    });
});

/**
 * The checks a run performed or is performing: a collapsible list per run, expandable to the
 * gate's output. Current/last ran only — the board stores exactly that, so the UI has no
 * history control to offer.
 */
describe('TaskDetail — checks', () => {
    const gates = [
        { name: 'test', status: 'passed' as const, exitCode: 0, output: 'all green' },
        { name: 'lint', status: 'failed' as const, exitCode: 1, output: '2 problems' },
    ];

    it("renders the newest run's verification with a name and status per gate", () => {
        const html = renderDetail({ jobs: [job({ gates })] });
        expect(html).toContain('<h2>Verification</h2>');
        expect(html).toContain('task-section task-verification');
        expect(html).toContain('test');
        expect(html).toContain('lint');
        expect(html).toContain('<details');
    });

    it('draws only the counts that happened — "0 failed" is no news, and never a pill', () => {
        const html = renderDetail({ jobs: [job({ gates: [gates[0]!] })] });
        // One count row: the Verification tile's head.
        expect(html.match(/<span class="pill pill-ok">1(<!-- -->)? (<!-- -->)?passed<\/span>/g)?.length).toBe(1);
        expect(html).not.toMatch(/>0(<!-- -->)? (<!-- -->)?(failed|running)</);
        expect(html).not.toContain('pill-bad');
    });

    it('opens failed gates and leaves passed ones collapsed', () => {
        const html = renderDetail({ jobs: [job({ gates })] });
        const at = (name: string) => html.lastIndexOf('<details', html.indexOf(`<span>${name}</span>`));
        expect(html.slice(at('lint'), at('lint') + 20)).toContain('<details open=""');
        expect(html.slice(at('test'), at('test') + 20)).not.toContain('open');
    });

    it('gives each gate output its own labelled, focusable, copyable mono well', () => {
        const html = renderDetail({ jobs: [job({ gates })] });
        expect(html).toContain('aria-label="Output of lint"');
        expect(html).toContain('<pre class="chat-output gate-output" tabindex="0">2 problems</pre>');
        expect(html).toContain('aria-label="Copy output of lint"');
    });

    it('labels each count with its meaning and status color, failed first', () => {
        const html = renderDetail({
            jobs: [
                job({
                    gates: [...gates, { name: 'build', status: 'running' as const, exitCode: null, output: null }],
                }),
            ],
        });
        const start = html.indexOf('task-section-aside', html.indexOf('task-verification'));
        const counts = html.slice(start, html.indexOf('</summary>', start));
        expect(counts).toContain('pill pill-ok');
        expect(counts).toContain('pill pill-bad');
        expect(counts).toContain('pill pill-done');
        expect(counts.indexOf('failed')).toBeLessThan(counts.indexOf('passed'));
        expect(counts.indexOf('passed')).toBeLessThan(counts.indexOf('running'));
    });

    it('renders no verification for a run without gates', () => {
        expect(renderDetail({ jobs: [job()] })).not.toContain('Verification');
        expect(renderDetail({ jobs: [job({ gates: [] })] })).not.toContain('Verification');
    });

    it('never emits a placeholder value for a gate that has not exited', () => {
        const html = renderDetail({
            jobs: [job({ gates: [{ name: 'test', status: 'running', exitCode: null, output: null }] })],
        });
        expectNoPlaceholder(html);
    });
});

/**
 * The attempt's sampled vitals — the "is it stuck or working" strip: CPU and memory, rendered
 * above the output while the run is going ONLY: the sample is a liveness signal, and a stale
 * "cpu 167%" beside a finished run's verdict lies about a run that is no longer going. The
 * activity line is the sidebar's "currently running task", the view's summary line and the
 * nav and tab summaries, and lives where the task is met.
 */
describe('TaskDetail — runtime', () => {
    const runtime = {
        cpuPercent: 93.4,
        memUsedMb: 544.2,
        memPercent: 7,
        activity: '→ Read src/x.ts',
        sampledAt: '2026-09-09T10:00:00.000Z',
    };

    it('renders cpu and memory above the output while the run is going', () => {
        const html = renderDetail({ jobs: [job({ status: 'running', runtime })] });
        expect(html).toMatch(/cpu (<!-- -->)?93(<!-- -->)?%/);
        expect(html).toMatch(/mem (<!-- -->)?544(<!-- -->)? MiB \((<!-- -->)?7(<!-- -->)?%\)/);
        expect(html).toContain('chat-runtime');
    });

    it('renders no strip once the run has ended, whatever it sampled last', () => {
        for (const status of ['succeeded', 'failed', 'dead', 'stopped'] as const) {
            const html = renderDetail({ jobs: [job({ status, runtime })] });
            expect(html, status).not.toContain('chat-runtime');
        }
    });

    it('renders no strip until the driver has sampled one', () => {
        expect(renderDetail({ jobs: [job({ status: 'running' })] })).not.toContain('chat-runtime');
    });

    /**
     * A services-only sample — the vitals read failed, a metrics-server-less cluster for one
     * — carries no readable numbers: no pills at all beats pills that lie with zeros. The
     * board's key-wise merge OMITS the unreadable halves rather than storing nulls, so the
     * keys can be absent outright; the guard reads both the same.
     */
    it('renders no pills the sample could not read', () => {
        const servicesOnly = {
            memPercent: null,
            activity: '→ Read x',
            sampledAt: '2026-09-01T12:02:00.000Z',
            services: [{ name: 'db', image: 'postgres:16', state: 'running' }],
        } as RuntimeVitals;
        const html = renderDetail({ jobs: [job({ status: 'running', runtime: servicesOnly })] });
        expect(html).not.toContain('chat-runtime');
        expectNoPlaceholder(html);

        const nulls = {
            ...servicesOnly,
            cpuPercent: null,
            memUsedMb: null,
        };
        expect(renderDetail({ jobs: [job({ status: 'running', runtime: nulls })] })).not.toContain('chat-runtime');
    });

    it('omits the percentage the sample does not carry', () => {
        const html = renderDetail({
            jobs: [job({ status: 'running', runtime: { ...runtime, memPercent: null } })],
        });
        expect(html).toMatch(/mem (<!-- -->)?544(<!-- -->)? MiB</);
    });

    it('never emits a placeholder value', () => {
        const html = renderDetail({
            jobs: [job({ status: 'running', runtime: { ...runtime, activity: null, memPercent: null } })],
        });
        expectNoPlaceholder(html);
    });
});

/** The task's live summary moved to the page header's meta (#159). */
/**
 * The per-turn close-time scrape — `ctx … tok · $…` — belongs to EVERY terminal turn,
 * including the newest: the scrape is written at close, so its absence is how a running turn
 * says "not yet", and a finished thread's last turn is usually the most relevant one to read
 * it on (issue #60).
 */
describe('TaskDetail — turn stats', () => {
    const scrape = (contextTokens: number, costUsd: number | null) => ({
        cpuPercent: 12,
        memUsedMb: 300,
        memPercent: null,
        activity: null,
        sampledAt: '2026-09-01T12:02:00.000Z',
        contextTokens,
        costUsd,
    });
    const child = (over: Partial<Job> = {}): Job => {
        const root = job({ command: 'first command' });
        return {
            ...job({ command: 'second command', ...over }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
    };
    /**
     * One turn's meta line: from its command paragraph to the next turn's. Anchored on the
     * turn's own `msg-user` paragraph, not the first occurrence of the command text — the
     * page header's `<h1>` repeats the root command above the thread, and a first-occurrence
     * slice would stop before the turn's meta ever rendered.
     */
    const turnMeta = (html: string, command: string): string => {
        const marker = `<p class="msg-user">${command}</p>`;
        const start = html.indexOf(marker);
        if (start === -1) return '';
        const next = html.indexOf('msg-user', start + marker.length);
        return html.slice(start, next === -1 ? undefined : next);
    };

    it('shows no scrape on any turn — the thread totals are the Task activity tile’s', () => {
        const ROOT_CONTEXT_TOKENS = 30_000;
        const ROOT_COST_USD = 0.1;
        const CHILD_CONTEXT_TOKENS = 90_433;
        const CHILD_COST_USD = 0.21;
        const html = renderDetail({
            jobs: [
                job({ command: 'first command', runtime: scrape(ROOT_CONTEXT_TOKENS, ROOT_COST_USD) }),
                child({ runtime: scrape(CHILD_CONTEXT_TOKENS, CHILD_COST_USD) }),
            ],
        });
        expect(turnMeta(html, 'first command')).not.toContain('ctx');
        expect(turnMeta(html, 'second command')).not.toContain('ctx');
        // Context is the newest run's; cost sums the thread.
        expect(html).toContain('<dt>Context</dt><dd>90,433 tok</dd>');
        expect(html).toContain('<dt>Cost</dt><dd>$0.3100</dd>');
    });

    it('shows no scrape on a turn that is still going', () => {
        const ROOT_CONTEXT_TOKENS = 30_000;
        const ROOT_COST_USD = 0.1;
        const html = renderDetail({
            jobs: [
                job({ command: 'first command', runtime: scrape(ROOT_CONTEXT_TOKENS, ROOT_COST_USD) }),
                child({
                    status: 'running',
                    runtime: {
                        cpuPercent: 12,
                        memUsedMb: 300,
                        memPercent: null,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                    },
                }),
            ],
        });
        expect(turnMeta(html, 'second command')).not.toContain('ctx');
    });

    it('shows the context of a zero-dollar thread in the Task activity tile', () => {
        const ZERO_DOLLAR_CONTEXT_TOKENS = 1_200;
        const html = renderDetail({ jobs: [job({ runtime: scrape(ZERO_DOLLAR_CONTEXT_TOKENS, 0) })] });
        expect(html).toContain('<dt>Context</dt><dd>1,200 tok</dd>');
    });

    it('never emits a placeholder value', () => {
        const html = renderDetail({
            jobs: [
                job({
                    executor: null,
                    workspacePath: null,
                    output: null,
                    exitCode: null,
                    runtime: {
                        cpuPercent: 12,
                        memUsedMb: 300,
                        memPercent: 2,
                        activity: null,
                        sampledAt: '2026-09-01T12:02:00.000Z',
                        contextTokens: null,
                        costUsd: null,
                    },
                }),
            ],
        });
        expectNoPlaceholder(html);
    });
});

/**
 * Who may continue a task (F3): the board refuses a follow-up from anyone but the account that
 * queued the row it is posted to, so the composer is offered to that account alone — and the
 * page says who can, rather than offering a control that can only fail.
 */
describe('TaskDetail — who may follow up', () => {
    const me = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', login: 'me', name: null, avatarUrl: null };
    const other = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', login: 'octo-reviewer', name: null, avatarUrl: null };
    const viewer = { loading: false, id: me.id, admin: false };
    const admin = { loading: false, id: other.id, admin: true };

    it("shows the composer to an admin on another member's task", () => {
        const html = renderDetail({ jobs: [job({ author: me })], viewer: admin });
        expect(html).toContain('id="follow-up-command"');
        expect(html).not.toContain('can continue this session');
    });

    it("names the owner, not the latest turn's admin, to a member", () => {
        const turn = job({ author: other, executionUser: me, actingFor: me });
        const html = renderDetail({ jobs: [turn], viewer: { loading: false, id: 'cccccccc', admin: false } });
        expect(html).toContain('Only me can continue this session.');
    });

    it('marks a turn queued on behalf of the owner', () => {
        const turn = job({ author: other, executionUser: me, actingFor: me });
        const html = renderDetail({ jobs: [turn], viewer: admin });
        expect(html).toContain('queued by octo-reviewer on behalf of me');
    });

    it('marks nothing on an ordinary turn', () => {
        expect(renderDetail({ jobs: [job({ author: me })], viewer: admin })).not.toContain('on behalf of');
    });

    it('says the run ended with a question directly above the composer, for the author (issue #226)', () => {
        const html = renderDetail({ jobs: [job({ author: me, summary: 'Which one: Red or Blue?' })], viewer });
        const notice = 'Claude ended with a question. Reply below to continue the same conversation.';
        expect(html).toContain(notice);
        expect(html.indexOf(notice)).toBeLessThan(html.indexOf('class="composer"'));
        expect(html).not.toContain("The task's author can reply");
    });

    it("tells another member the task's author can reply (issue #226)", () => {
        const html = renderDetail({ jobs: [job({ author: other, summary: 'Which one: Red or Blue?' })], viewer });
        expect(html).toContain('Claude ended with a question. The task&#x27;s author can reply with a follow-up.');
        expect(html).not.toContain('Reply below');
        expect(html).not.toContain('<textarea');
    });

    it('shows no question notice when the summary is not a question', () => {
        const html = renderDetail({ jobs: [job({ author: me, summary: 'Done.' })], viewer });
        expect(html).not.toContain('Claude ended with a question');
    });

    it("renders the server's 403 inside the composer, beside the draft", () => {
        const refusal = 'Only the account that queued the task can follow it up';
        const html = renderDetail({ jobs: [job({ author: me })], viewer, followUpError: refusal });
        const composer = html.slice(html.indexOf('class="composer"'));
        expect(composer).toContain(refusal);
        expect(composer.indexOf(refusal)).toBeLessThan(composer.indexOf('<textarea'));
    });

    it('keeps a stop or Mark done refusal under the head, ahead of both columns, not in the composer', () => {
        const html = renderDetail({ jobs: [job({ author: me })], viewer, actionError: 'Task is running' });
        expect(html.indexOf('Task is running')).toBeGreaterThan(html.indexOf('task-head'));
        expect(html.indexOf('Task is running')).toBeLessThan(html.indexOf('task-rail'));
    });
});

describe('TaskDetail — main column', () => {
    // Issue #796: an interruption is a recorded fact of the thread, not a failed attempt — the
    // Task activity tile lists it.
    it('lists each interruption in the Task activity tile', () => {
        const html = renderDetail({
            jobs: [
                job({
                    interruptions: [{ at: '2026-09-01T12:00:30.000Z', reason: 'the driver was drained', claimSeq: 1 }],
                }),
            ],
        });
        const activity = html.slice(html.indexOf('task-activity'), html.indexOf('task-main'));
        expect(activity).toContain('Claim 1: the driver was drained');
    });

    it('renders no run history', () => {
        expect(renderDetail({ jobs: [job()] })).not.toContain('Run history');
    });

    it('keeps only the conversation and composer in the main column; every other tile is in the rail', () => {
        const runtime = {
            cpuPercent: null,
            memUsedMb: null,
            memPercent: null,
            activity: null,
            sampledAt: '2026-09-01T12:02:00.000Z',
            services: [{ name: 'db', image: 'postgres:16', state: 'exited' }],
        };
        const html = renderDetail({
            jobs: [
                job({
                    output: '[driver] published fix/2 — https://github.com/acme/web/pull/2',
                    gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'ok' }],
                    runtime,
                }),
            ],
        });
        const layout = html.slice(html.indexOf('task-layout'));
        const rail = layout.slice(layout.indexOf('task-rail'), layout.indexOf('task-main'));
        const main = layout.slice(layout.indexOf('task-main'));
        const orderIn = (region: string, headings: string[]) => {
            const order = headings.map((h) => region.indexOf(`<h2>${h}</h2>`));
            expect(order.every((at) => at >= 0)).toBe(true);
            expect(order).toEqual([...order].sort((a, b) => a - b));
        };
        orderIn(main, ['Conversation']);
        // The follow-up input docks under the conversation, with no heading of its own.
        expect(main.indexOf('<h2>Conversation</h2>')).toBeLessThan(main.indexOf('id="follow-up-command"'));
        // Controls first, then the tiles in the mockup's order.
        expect(rail.indexOf('task-controls')).toBeLessThan(rail.indexOf('<h2>Outcome</h2>'));
        orderIn(rail, ['Outcome', 'Verification', 'Task activity', 'Services']);
        for (const heading of ['Outcome', 'Verification', 'Task activity', 'Services']) {
            expect(main).not.toContain(`<h2>${heading}</h2>`);
        }
        // The rail leads the DOM, so a narrow screen reads the controls and tiles before the conversation.
        expect(html.indexOf('task-head')).toBeLessThan(html.indexOf('task-rail'));
        expect(html.indexOf('task-rail')).toBeLessThan(html.indexOf('task-main'));
    });

    it('opens the Outcome tile, opens Verification only on a failed gate, and keeps the rest shut', () => {
        const runtime = {
            cpuPercent: null,
            memUsedMb: null,
            memPercent: null,
            activity: null,
            sampledAt: '2026-09-01T12:02:00.000Z',
            services: [{ name: 'db', image: 'postgres:16', state: 'exited' }],
        };
        const tile = (html: string, name: string) =>
            html.match(new RegExp(`<details class="panel task-section ${name}"( open="")?`))?.[1];
        const passed = renderDetail({
            jobs: [
                job({
                    output: '[driver] published fix/2 — https://github.com/acme/web/pull/2',
                    gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'ok' }],
                    runtime,
                }),
            ],
        });
        expect(tile(passed, 'task-outcome')).toBe(' open=""');
        expect(tile(passed, 'task-verification')).toBeUndefined();
        expect(tile(passed, 'task-activity')).toBeUndefined();
        expect(passed).toMatch(/<details class="panel task-section">/);
        const failed = renderDetail({
            jobs: [job({ gates: [{ name: 'lint', status: 'failed', exitCode: 1, output: 'x' }] })],
        });
        expect(tile(failed, 'task-verification')).toBe(' open=""');
    });
});

describe('TaskDetail — surface hierarchy (BEL-232)', () => {
    it('draws the conversation on the canvas, not as a soft panel; no panel nests in another', () => {
        const html = renderDetail({
            jobs: [
                job({
                    output: '[driver] published fix/2 — https://github.com/acme/web/pull/2',
                    gates: [{ name: 'test', status: 'passed', exitCode: 0, output: 'ok' }],
                }),
            ],
        });
        const classes = (el: string) => new RegExp(`<[a-z]+ [^>]*class="([^"]*${el}[^"]*)"`).exec(html)![1]!.split(' ');
        expect(classes('task-conversation')).not.toContain('panel');
        const conversation = html.slice(
            html.indexOf('task-conversation'),
            html.indexOf('<section class="task-follow-up"')
        );
        expect(conversation).not.toMatch(/class="([^"]* )?panel[ "]/);
        // The outcome rail stays a soft section.
        expect(classes('task-outcome')).toContain('panel');
    });
});
