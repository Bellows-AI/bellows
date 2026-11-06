import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { emptyBlock, inputTokens, telemetryStats } from '@factory-ai/core';
import type { TelemetryStats, TokenTotals } from '@factory-ai/core';
import type { TelemetryMeta } from '../src/api/useStats.js';
import type { StatsPayload } from '../src/api/useStats.js';
import { UsageByModel, UsageSummaryPanel } from '../src/panels/UsageSummaryPanel.js';
import { TokenUsagePanel, chartPoints } from '../src/panels/TokenUsagePanel.js';
import { emptyUsage, fixtureRollups, fixtureStats } from './telemetry-fixture.js';
import { TaskUsagePanel } from '../src/panels/TaskUsagePanel.js';
import { duration, pct, tokens } from '../src/format.js';
import { figure, totalTokens } from '../src/components/usage/usage-format.js';
import { PAD } from '../src/charts/scale.js';
import type { TaskUsageStats } from '@factory-ai/core';

/**
 * A render smoke test, not a UI test. It exists because the null-not-zero contract is only
 * real if it survives to the markup: everything upstream can be correct and a single `?? 0`
 * in a panel still puts "0 tokens" on the page next to a session nobody measured.
 *
 * react-dom/server needs no DOM, so this stays in the default offline suite.
 */

const REPO = 'Bellows-AI/bellows.ai';

const input = fixtureRollups;

const NOW = new Date('2026-08-21T12:00:00.000Z');
const telemetry = fixtureStats({ repos: [REPO], now: NOW });
const empty = telemetryStats(
    { sessions: [], coverage: { from: null, to: null } },
    { repos: [REPO], now: NOW, usage: emptyUsage(NOW) }
);

const telemetryMeta = (over: Partial<TelemetryMeta> = {}): TelemetryMeta => ({
    status: 'ok',
    reason: null,
    source: 'fixture',
    fetchedAt: NOW.toISOString(),
    ageSeconds: 0,
    stale: false,
    repoFilter: [REPO],
    otherRepoSessions: 1,
    sessionsWithoutHook: 1,
    ...over,
});

/** Full payload meta: the summary speaks for the rendered selection, so it needs range and scope. */
const meta = (over: Partial<TelemetryMeta> = {}, metaOver: Partial<StatsPayload['meta']> = {}): StatsPayload['meta'] =>
    ({
        fetchedAt: NOW.toISOString(),
        ageSeconds: 0,
        stale: false,
        organization: { mode: 'config', current: { id: 'bellows', name: 'Bellows AI' }, available: [] },
        repos: [{ owner: 'Bellows-AI', name: 'bellows.ai' }],
        range: { preset: 'custom', from: '2026-08-14T12:00:00Z', to: NOW.toISOString() },
        scope: 'org',
        scopeLogin: null,
        telemetry: telemetryMeta(over),
        ...metaOver,
    }) as StatsPayload['meta'];

const render = (t: TelemetryStats, m: StatsPayload['meta']) =>
    [
        renderToStaticMarkup(<UsageSummaryPanel telemetry={t} meta={m} />),
        renderToStaticMarkup(<TokenUsagePanel telemetry={t} meta={m.telemetry} />),
    ].join('\n');

describe('telemetry panels render', () => {
    it('renders real figures on the happy path', () => {
        const html = render(telemetry, meta());
        expect(html).toContain('synthetic fixture');
        expect(html).not.toContain('NaN');
        expect(html).not.toContain('Infinity');
        expect(html).not.toContain('undefined');
    });
});

describe('telemetry panels render — usage summary panel', () => {
    /** One metric card's markup, from its label to the next card. */
    const card = (html: string, label: string): string => {
        const at = html.indexOf(`<span class="usage-label">${label}`);
        const start = html.lastIndexOf('class="usage-group"', at);
        const end = html.indexOf('class="usage-group"', at);
        return html.slice(start, end === -1 ? undefined : end);
    };

    it('renders four metrics in order: Sessions, Total tokens, Active time, Edit acceptance', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        // DOM order IS the reading order at every width.
        expect(html.match(/class="usage-group"/g)).toHaveLength(4);
        const labels = ['Sessions', 'Total tokens', 'Active time', 'Edit acceptance'].map((label) =>
            html.indexOf(`>${label}`)
        );
        expect(labels.every((at) => at !== -1)).toBe(true);
        expect([...labels].sort((x, y) => x - y)).toEqual(labels);
    });

    it('puts the label above the figure: the figure is the only bold text in a card', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        const sessions = card(html, 'Sessions');
        expect(sessions.indexOf('usage-label')).toBeLessThan(sessions.indexOf('<strong'));
        expect(sessions.match(/<strong/g)).toHaveLength(1);
    });

    it('headlines Total tokens beside its Input and Output parts, with the cache rate as caption', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        const t = telemetry.usage.totals.tokens;
        const { total, cacheHitRatio } = inputTokens(t);
        // Total input is every prompt token — uncached + cache read + cache write; Total tokens adds
        // output, and both parts always render beside the sum (docs/metrics.md).
        expect(total).toBe((t.input ?? 0) + (t.cacheRead ?? 0) + (t.cacheCreation ?? 0));
        expect(totalTokens(t)).toBe((total ?? 0) + (t.output ?? 0));
        const tokensCard = card(html, 'Total tokens');
        expect(tokensCard).toContain(`<strong>${tokens(totalTokens(t))}</strong>`);
        expect(tokensCard).toContain(`<dt>Input</dt><dd>${tokens(total)}</dd>`);
        expect(tokensCard).toContain(`<dt>Output</dt><dd>${tokens(t.output)}</dd>`);
        expect(tokensCard).toContain(`Cache rate ${pct(cacheHitRatio)}`);
    });

    it('keeps the exact four types and Total input in the info popover', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        const t = telemetry.usage.totals.tokens;
        const pop = card(html, 'Total tokens');
        expect(pop).toContain('aria-label="Token breakdown"');
        for (const label of ['Uncached input', 'Cache read', 'Cache write', 'Output', 'Total input']) {
            expect(pop).toContain(`>${label}</dt>`);
        }
        expect(pop).toContain(figure(t.cacheRead));
    });

    it('names each unmeasured token part rather than zeroing it', () => {
        const unmeasured: TelemetryStats = {
            ...telemetry,
            usage: { ...telemetry.usage, totals: emptyBlock('unmeasured') },
        };
        const tokensCard = card(
            renderToStaticMarkup(<UsageSummaryPanel telemetry={unmeasured} meta={meta()} />),
            'Total tokens'
        );
        expect(tokensCard).toContain('<strong class="usage-unmeasured">—</strong>');
        expect(tokensCard).toContain('Cache rate not measured');
        expect(tokensCard).toContain('<dt>Input</dt><dd>—</dd>');
        expect(tokensCard).toContain('<dt>Output</dt><dd>—</dd>');
    });

    it('never renders a partial Total: an unmeasured output dashes the sum', () => {
        const noOutput: TelemetryStats = {
            ...telemetry,
            usage: {
                ...telemetry.usage,
                totals: {
                    ...telemetry.usage.totals,
                    tokens: { ...telemetry.usage.totals.tokens, output: null },
                },
            },
        };
        const tokensCard = card(
            renderToStaticMarkup(<UsageSummaryPanel telemetry={noOutput} meta={meta()} />),
            'Total tokens'
        );
        expect(tokensCard).toContain('<strong class="usage-unmeasured">—</strong>');
        expect(tokensCard).toContain('<dt>Output</dt><dd>—</dd>');
    });

    it('draws the sessions series as a decorative sparkline captioned by its peak bucket', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        const sessions = card(html, 'Sessions');
        expect(sessions).toContain('class="sparkline"');
        expect(sessions).toContain('aria-hidden="true"');
        const peak = Math.max(...telemetry.series.points.map((p) => p.sessions));
        expect(sessions).toMatch(new RegExp(`Peak ${peak} in the week of [A-Z][a-z]{2} \\d{1,2}`));
    });

    it('carries no trend, comparison or cost', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        expect(html).not.toMatch(/↑|↓|vs\.? previous|trend|estimated cost|\$/i);
    });

    it('carries the required supporting copy for every group', () => {
        const html = renderToStaticMarkup(<UsageSummaryPanel telemetry={telemetry} meta={meta()} />);
        // Sessions: the scope line above the page already names the selection and the repos.
        expect(html).not.toContain('Aug 14–21 · Organization');
        expect(html).not.toContain(REPO);
        // Active time: the per-session average, nothing more.
        const { activeHours, sessions } = telemetry.totals;
        expect(html).toContain(`≈ ${duration((activeHours ?? 0) / sessions)} per session`);
        expect(html).not.toContain('idle time excluded');
    });

    it('offers By model as a collapsed disclosure with Total, Input, Output and Cache rate per model', () => {
        const html = renderToStaticMarkup(<UsageByModel telemetry={telemetry} />);
        expect(html).toMatch(/^<details class="usage-by-model chart-disclosure"><summary>By model<\/summary>/);
        expect(html).not.toContain('<details open');
        for (const header of ['Model', 'Share of total', 'Total', 'Input', 'Output', 'Cache rate']) {
            expect(html).toContain(`>${header}</th>`);
        }
        expect(html).toContain('>All models</th>');
        // The exact four types ride on the Total cell's hover.
        expect(html).toMatch(/title="Uncached input [\d,—]+\nCache read [\d,—]+\nCache write [\d,—]+\nOutput [\d,—]+"/);
        // Share bars are decoration beside the percent.
        expect(html).toMatch(/<span class="usage-track" aria-hidden="true">/);
    });

    it('renders em dashes, never zeros, on an empty store', () => {
        const html = render(empty, meta({ status: 'empty' }));
        expect(html).toContain('—');
        expect(html).not.toContain('NaN');
        expect(html).not.toContain('0 tokens');
        expect(html).toContain('No sessions in the coverage window yet');
    });

    it('renders billions as B rather than thousands of M', () => {
        // A real run reported 4.5e9 cache-read tokens, which rendered as "4543.89M".
        const BILLIONS_OF_TOKENS = 4_543_894_453;
        expect(tokens(BILLIONS_OF_TOKENS)).toBe('4.54B');
        const MILLIONS_OF_TOKENS = 20_300_494;
        expect(tokens(MILLIONS_OF_TOKENS)).toBe('20.3M');
        expect(tokens(null)).toBe('—');
    });

    it('renders a reason and no numbers when unreachable', () => {
        const html = render(empty, meta({ status: 'unreachable', reason: 'connection refused' }));
        expect(html).toMatch(/class="panel[^"]* bad"/);
        expect(html).toContain('connection refused');
        expect(html).not.toContain('NaN');
    });

    it('renders no PR vocabulary anywhere', () => {
        const html = render(telemetry, meta());
        expect(html).not.toMatch(/pull request/i);
        expect(html).not.toContain('merged');
        expect(html).not.toMatch(/revert rate/i);
    });
});

describe('edit acceptance rendering', () => {
    const withEdits = (accepted: number | null, rejected: number | null) =>
        telemetryStats(
            {
                sessions: [
                    {
                        ...input.sessions.find((s) => s.sessionId === 's01-token-heavy')!,
                        repo: REPO,
                        editsAccepted: accepted,
                        editsRejected: rejected,
                    },
                ],
                coverage: { from: null, to: null },
            },
            { repos: [REPO], now: NOW, usage: emptyUsage(NOW) }
        );
    const summary = (accepted: number | null, rejected: number | null) =>
        renderToStaticMarkup(<UsageSummaryPanel telemetry={withEdits(accepted, rejected)} meta={meta()} />);

    it('shows the measured denominator beside a decorative meter: A of D edits accepted', () => {
        const ACCEPTED = 2;
        const REJECTED = 1;
        const html = summary(ACCEPTED, REJECTED);
        expect(html).toContain('67%');
        expect(html).toContain('2 of 3 edits accepted');
        expect(html).toMatch(/<span class="usage-meter" aria-hidden="true"><span style="width:66\.6+\d*%"><\/span>/);
    });

    it('says Not measured instead of a ratio when no decision was recorded', () => {
        const html = summary(null, null);
        expect(html).toContain('Not measured');
        expect(html).not.toContain('usage-meter');
        expect(html).not.toContain('NaN');
    });

    it('names the partial measurement instead of fabricating an acceptance count', () => {
        // Rejections measured, acceptances not: a denominator exists but the ratio must not
        // pretend to one.
        const REJECTED = 3;
        const html = summary(null, REJECTED);
        expect(html).toContain('3 edit decisions measured');
        expect(html).toContain('not recorded');
        expect(html).not.toContain('of 3 measured');
    });

    it('renders a measured zero-out-of-zero as the real zero it is', () => {
        const html = summary(0, 0);
        expect(html).toContain('0 measured edit decisions');
    });
});

describe('per-task usage panel', () => {
    const dist = (avg: number, p50: number, p95: number, tasks: number) => ({ avg, p50, p95, tasks });
    const tokenDists = (d: ReturnType<typeof dist>) => {
        const t = { ...d, partial: 0, tasksInScope: d.tasks };
        return { all: { input: t, cacheRead: t, cacheCreation: t, output: t }, byModel: [] };
    };
    const MEASURED_TASKS = 7;
    const TOKENS_AVG = 51_200;
    const TOKENS_P50 = 43_000;
    const TOKENS_P95 = 96_000;
    const JOB_TURNS_AVG = 1.9;
    const JOB_TURNS_P50 = 1;
    const JOB_TURNS_P95 = 4;
    const AGENT_TURNS_AVG = 18.3;
    const AGENT_TURNS_P50 = 12;
    const AGENT_TURNS_P95 = 44;
    const WALL_CLOCK_AVG_MS = 4_212_000;
    const WALL_CLOCK_P50_MS = 3_600_000;
    const WALL_CLOCK_P95_MS = 10_800_000;
    const populated: TaskUsageStats = {
        tokens: tokenDists(dist(TOKENS_AVG, TOKENS_P50, TOKENS_P95, MEASURED_TASKS)),
        jobTurnsPerTask: dist(JOB_TURNS_AVG, JOB_TURNS_P50, JOB_TURNS_P95, MEASURED_TASKS),
        agentTurnsPerTask: dist(AGENT_TURNS_AVG, AGENT_TURNS_P50, AGENT_TURNS_P95, MEASURED_TASKS),
        wallClockPerTask: dist(WALL_CLOCK_AVG_MS, WALL_CLOCK_P50_MS, WALL_CLOCK_P95_MS, MEASURED_TASKS),
    };
    const emptyStats: TaskUsageStats = {
        tokens: tokenDists(dist(0, 0, 0, 0)),
        jobTurnsPerTask: dist(0, 0, 0, 0),
        agentTurnsPerTask: dist(0, 0, 0, 0),
        wallClockPerTask: dist(0, 0, 0, 0),
    };

    it('renders four cards, median first: Output, Runs, Agent turns, Wall clock per task', () => {
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={telemetryMeta()} />);
        // Each card named — the terminology rule: never a bare "turns".
        const labels = ['Output per task', 'Runs per task', 'Agent turns per task', 'Wall clock per task'].map(
            (label) => html.indexOf(`>${label}</span>`)
        );
        expect(labels.every((at) => at !== -1)).toBe(true);
        expect([...labels].sort((x, y) => x - y)).toEqual(labels);
        // Token types are distributed apart and medians do not add: no input or summed card.
        for (const label of ['Uncached input per task', 'Cache read per task', 'Tokens per task', 'Input per task']) {
            expect(html).not.toContain(label);
        }
        expect(html).not.toMatch(/>\s*turns\s*</);
        // The median is the figure; average and P95 sit beneath it, beside the task count.
        expect(html).toContain('<strong>43k</strong>');
        expect(html).toContain('avg 51.2k · P95 96k · 7 tasks');
        expect(html).not.toContain('p50');
        expect(html).not.toContain('<table');
        expect(html).not.toContain('NaN');
    });

    it('renders an explicit empty state, never zero figures, when no task is in range', () => {
        const html = renderToStaticMarkup(
            <TaskUsagePanel tasks={emptyStats} meta={telemetryMeta({ status: 'empty' })} />
        );
        // ONE empty state, not four zero/dash cards.
        expect(html).toContain('No attributed tasks in this range yet.');
        expect(html).not.toContain('usage-group');
        expect(html).not.toContain('NaN');
        // And it renders nothing at all when there is no snapshot yet.
        expect(renderToStaticMarkup(<TaskUsagePanel tasks={null} meta={telemetryMeta()} />)).toBe('');
    });

    it('carries the unmeasured-run caveat in the info popover', () => {
        // Failed close-time reads store null; a task holding one is
        // excluded. The panel says so instead of rendering a quietly small number.
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={telemetryMeta()} />);
        expect(html).toContain('aria-label="How per-task usage is calculated"');
        expect(html).toContain('a task with any unmeasured run is left out, never counted as zero');
    });

    it('formats the wall clock distribution as a duration, not a raw millisecond count', () => {
        // avg 4_212_000ms renders as "1.2h" — a millisecond figure beside tokens would be noise.
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={telemetryMeta()} />);
        expect(html).toContain('<strong>1h</strong>');
        expect(html).toContain('avg 1.2h');
        expect(html).not.toContain('4212000');
    });

    it('shows the partial count and the standing sentence only when output is partial', () => {
        const PARTIAL_TASKS = 2;
        const partialOutput = { avg: 10, p50: 10, p95: 10, tasks: 7, partial: PARTIAL_TASKS, tasksInScope: 9 };
        const tasks: TaskUsageStats = {
            ...populated,
            tokens: { ...populated.tokens, all: { ...populated.tokens.all, output: partialOutput } },
        };
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={tasks} meta={telemetryMeta()} />);
        expect(html).toContain('7 tasks (2 partial)');
        expect(html).toContain('Figures describe observed usage, not guaranteed complete consumption');
        const clean = renderToStaticMarkup(<TaskUsagePanel tasks={populated} meta={telemetryMeta()} />);
        expect(clean).not.toContain('partial)');
        expect(clean).not.toContain('observed usage');
    });

    it('offers each model, naming the raw variants of the selected one', () => {
        const t = { avg: 1, p50: 1, p95: 1, tasks: 1, partial: 0, tasksInScope: 3 };
        const tasks: TaskUsageStats = {
            ...populated,
            tokens: {
                ...populated.tokens,
                byModel: [
                    {
                        model: 'model-a',
                        rawModels: ['model-a', 'model-a[1m]'],
                        dist: { input: t, cacheRead: t, cacheCreation: t, output: t },
                    },
                    {
                        model: 'unknown',
                        rawModels: ['unknown'],
                        dist: { input: t, cacheRead: t, cacheCreation: t, output: t },
                    },
                ],
            },
        };
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={tasks} meta={telemetryMeta()} />);
        expect(html).toContain('>All models</option>');
        expect(html).toContain('>model-a</option>');
        expect(html).toContain('>Unknown model</option>');
    });

    it('keeps each measured count even when the distributions have different denominators', () => {
        const FEWER_MEASURED_TASKS = 5;
        const mixed: TaskUsageStats = {
            ...populated,
            agentTurnsPerTask: dist(AGENT_TURNS_AVG, AGENT_TURNS_P50, AGENT_TURNS_P95, FEWER_MEASURED_TASKS),
        };
        const html = renderToStaticMarkup(<TaskUsagePanel tasks={mixed} meta={telemetryMeta()} />);
        // Output, runs and wall clock carry seven tasks; only five measured agent turns.
        const REMAINING_SEVEN_COUNT = 3;
        expect(html.match(/ · 7 tasks/g)?.length).toBe(REMAINING_SEVEN_COUNT);
        expect(html).toContain(' · 5 tasks');
    });
});

describe('token usage series granularity', () => {
    it('names the buckets beside the legend, with no paragraph before the chart', () => {
        expect(telemetry.series.granularity).toBe('week');
        const weeklyHtml = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={telemetryMeta()} />);
        expect(weeklyHtml).toContain('>By ISO week</span>');
        expect(weeklyHtml).toContain('panel panel-compact');
        expect(weeklyHtml).not.toContain('<p class="muted">');
        expect(weeklyHtml.indexOf('<svg')).toBeGreaterThan(-1);
        // Each bucket's readout lists the four types, an unmeasured one as a dash.
        for (const label of ['Uncached input', 'Cache read', 'Cache write', 'Output']) {
            expect(weeklyHtml).toMatch(new RegExp(`${label} [\\d,—]+`));
        }

        // The month preset spans 30 days: day buckets, named as days.
        const daily = fixtureStats({
            repos: [REPO],
            now: NOW,
            range: { preset: 'custom', from: '2026-07-22T12:00:00Z', to: '2026-08-21T12:00:00Z' },
        });
        expect(daily.series.granularity).toBe('day');
        const dailyHtml = renderToStaticMarkup(<TokenUsagePanel telemetry={daily} meta={telemetryMeta()} />);
        expect(dailyHtml).toContain('>By day</span>');
        // The popover's "hatched bucket" keys a real fill: the pattern the partial bucket is painted with.
        expect(dailyHtml.match(/<pattern[^>]*id="partial-hatch"/g)).toHaveLength(1);
        expect(dailyHtml).not.toContain('NaN');
    });

    it('joins the session series and the token series by bucket start, never zeroing a missing side', () => {
        const block = (output: number) => ({
            ...emptyBlock('measured'),
            tokens: { ...emptyBlock('measured').tokens, output },
        });
        const stats: TelemetryStats = {
            ...empty,
            series: {
                granularity: 'day',
                points: [
                    { start: '2026-08-19', sessions: 2, linesAdded: 0, linesRemoved: 0, partial: false },
                    { start: '2026-08-20', sessions: 1, linesAdded: 0, linesRemoved: 0, partial: false },
                ],
            },
            usage: {
                ...empty.usage,
                series: {
                    granularity: 'day',
                    points: [
                        { start: '2026-08-20', partial: false, usage: block(7) },
                        { start: '2026-08-21', partial: true, usage: block(9) },
                    ],
                },
            },
        };
        expect(chartPoints(stats).map((p) => [p.start, p.sessions, p.tokens?.output ?? null, p.partial])).toEqual([
            ['2026-08-19', 2, null, false],
            ['2026-08-20', 1, 7, false],
            ['2026-08-21', 0, 9, true],
        ]);
    });

    it('leaves a gap for a type the bucket never measured, beside a bar for the type it did', () => {
        const block = {
            ...emptyBlock('measured'),
            tokens: { input: 1000, output: null, cacheRead: null, cacheCreation: null },
        };
        const stats: TelemetryStats = {
            ...empty,
            series: {
                granularity: 'day',
                points: [{ start: '2026-08-20', sessions: 1, linesAdded: 0, linesRemoved: 0, partial: false }],
            },
            usage: {
                ...empty.usage,
                series: { granularity: 'day', points: [{ start: '2026-08-20', partial: false, usage: block }] },
            },
        };
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={stats} meta={telemetryMeta()} />);
        expect(html.match(/<rect\b[^>]*data-series="input"/g)).toHaveLength(1);
        expect(html).not.toMatch(/<rect\b[^>]*data-series="output"/);
        expect(html).toMatch(/aria-label="[^"]*Output —/);
    });

    it('toggles Input and Output from accessible legend buttons, with no sessions series', () => {
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={telemetryMeta()} />);
        const PRESSED_LEGEND_COUNT = 2;
        expect(html.match(/aria-pressed="true"/g)).toHaveLength(PRESSED_LEGEND_COUNT);
        for (const name of ['Input', 'Output']) {
            expect(html).toContain(`>${name}</button>`);
        }
        expect(html).not.toContain('>Sessions</button>');
        expect(html).not.toContain('class="line"');
    });

    it('plots total input — uncached plus cache read and write — in each bucket', () => {
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={telemetryMeta()} />);
        const point = chartPoints(telemetry).find((p) => p.tokens?.cacheRead != null);
        const tokensOfPoint = point?.tokens as TokenTotals;
        const total = inputTokens(tokensOfPoint).total as number;
        expect(total).toBeGreaterThan(tokensOfPoint.input ?? 0);
        expect(html).toContain(`Input ${total.toLocaleString('en-US')}`);
    });

    it('explains the calculation in the "?" popover', () => {
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={telemetryMeta()} />);
        expect(html).toContain('aria-label="How this is calculated"');
        expect(html).toContain('Input counts uncached input plus cache reads and writes');
        expect(html).toContain('92');
        expect(html).toContain('Quiet buckets are kept');
        expect(html).not.toContain('<details');
    });

    it('exposes full bucket dates and exact un-abbreviated values in the bucket labels', () => {
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={telemetryMeta()} />);
        // Weekly buckets carry the full "Week of YYYY-MM-DD", not the axis's abbreviated MM-DD.
        expect(html).toMatch(/aria-label="[^"]*Week of \d{4}-\d{2}-\d{2}/);
        // Exact numbers with thousands separators — the abbreviated axis form is not the tooltip form.
        expect(html).toMatch(/aria-label="[^"]*\d,\d{3}/);
        expect(html).toMatch(/aria-label="[^"]*partial period/);
    });

    it('renders a one-bucket range as a compact chart with exact detail', () => {
        const pointTokens = { input: 12345, output: 6789, cacheRead: null, cacheCreation: null };
        const block = { ...emptyBlock('measured'), tokens: pointTokens };
        const one: TelemetryStats = {
            totals: {
                sessions: 3,
                activeHours: null,
                linesAdded: null,
                linesRemoved: null,
                editAcceptance: { accepted: null, rejected: null, decisions: null, ratio: null },
            },
            otherRepoSessions: 0,
            sessionsWithoutHook: 0,
            series: {
                granularity: 'day',
                points: [{ start: '2026-08-21', sessions: 3, linesAdded: 0, linesRemoved: 0, partial: true }],
            },
            coverage: { from: null, to: null },
            usage: {
                totals: block,
                series: { granularity: 'day', points: [{ start: '2026-08-21', partial: true, usage: block }] },
                diagnostics: {
                    unresolvedOwnership: { sessions: 0, tokens: emptyBlock('unmeasured').tokens },
                    excludedRepo: { sessions: 0, tokens: emptyBlock('unmeasured').tokens },
                },
            },
        };
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={one} meta={telemetryMeta()} />);
        const [, width, height] = html.match(/viewBox="0 0 (\d+) (\d+)"/)!.map(Number);
        const COMPACT_WIDTH_CEILING = 900;
        const COMPACT_HEIGHT_CEILING = 280;
        expect(width).toBeLessThan(COMPACT_WIDTH_CEILING);
        expect(height).toBeLessThan(COMPACT_HEIGHT_CEILING);
        // A real bar, never a filled panel: no bar mark exceeds a quarter of the compact plot
        // (the old behavior stretched one bar across the whole band). The hatch is a band-wide
        // rect by design, so only `bar <series-class>` marks count here.
        const widths = [...html.matchAll(/<rect\b[^>]*>/g)]
            .map((m) => m[0])
            .filter((t) => /^bar[\s"]/.test(t.match(/\bclass="([^"]*)"/)?.[1] ?? ''))
            .map((t) => Number(t.match(/\bwidth="([\d.]+)"/)?.[1]));
        expect(widths.length).toBeGreaterThan(0);
        const QUARTER_PLOT_DIVISOR = 4;
        expect(Math.max(...widths)).toBeLessThanOrEqual((width! - PAD.left - PAD.right) / QUARTER_PLOT_DIVISOR);
        expect(html).toMatch(/aria-label="[^"]*Input 12,345/);
        expect(html).toMatch(/aria-label="[^"]*partial period/);
    });

    it('draws the multi-bucket chart as a 110px band', () => {
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={telemetry} meta={telemetryMeta()} />);
        const [, , height] = html.match(/viewBox="0 0 (\d+) (\d+)"/)!.map(Number);
        const MAIN_PLOT_HEIGHT = 110;
        expect(height! - PAD.top - PAD.bottom).toBe(MAIN_PLOT_HEIGHT);
    });

    it('keeps the x-axis legible at 92 daily points', () => {
        // A 92-day window is the widest range that still renders daily bars: 92 points with
        // labels every ceil(92/12) bars. Counting the rendered ticks pins the label thinning —
        // a regression to labelEvery=1 renders 92 tick texts and a hairline wall of numbers.
        const WIDE_WINDOW_DAYS = 92;
        const MS_PER_DAY = 86_400_000;
        const from = new Date(NOW.getTime() - WIDE_WINDOW_DAYS * MS_PER_DAY).toISOString();
        const wide = fixtureStats({
            repos: [REPO],
            now: NOW,
            range: { preset: 'custom', from, to: NOW.toISOString() },
        });
        const points = chartPoints(wide).length;
        const MIN_WIDE_POINTS = 80;
        expect(points).toBeGreaterThan(MIN_WIDE_POINTS);
        const html = renderToStaticMarkup(<TokenUsagePanel telemetry={wide} meta={telemetryMeta()} />);
        const LABEL_TARGET_COUNT = 12;
        const every = Math.ceil(points / LABEL_TARGET_COUNT);
        // X ticks: every `every`-th point plus the last. The bars' left axis renders 5 ticks, so
        // five of the rendered ticks are never x labels (there is no right axis without a line).
        const xTicks = Math.floor((points - 1) / every) + 1 + (points % every === 0 ? 0 : 1);
        const ticks = html.match(/class="tick"/g)?.length ?? 0;
        expect(ticks).toBe(xTicks + 5);
    });
});
