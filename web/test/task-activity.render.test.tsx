import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { JobActivity, ThreadActivity } from '../src/api/useJobActivity.js';
import { FORBIDDEN, job } from './tasks-fixtures.js';
import { TaskActivity } from '../src/panels/TaskActivity.js';

/**
 * The task activity summary (issues #339, #530): the latest run's pulse by token type, and the
 * thread's counts, as ONE button that opens the statistics modal. Props in, markup out — the hook
 * is the page's. The modal's open interaction (click, Enter, Space, Escape, focus return) lives in
 * `web/test/task-detail.dom.test.tsx`; effects and portals never run under `renderToStaticMarkup`.
 */

const RUN_ID = '11111111-1111-4111-8111-111111111111';

const payload = (over: Partial<JobActivity> = {}): JobActivity => ({
    jobId: RUN_ID,
    sessionId: '33333333-3333-4333-8333-333333333333',
    from: '2026-09-22T20:46:16.000Z',
    to: '2026-09-22T22:46:16.000Z',
    bucketMs: 900_000,
    buckets: [
        {
            start: '2026-09-22T20:45:00.000Z',
            tokens: { input: 2_000_000, output: 500_000, cacheRead: 9_000_000, cacheCreation: 100_000 },
            edits: 3,
        },
        {
            start: '2026-09-22T21:00:00.000Z',
            tokens: { input: 1_200_000, output: 0, cacheRead: 0, cacheCreation: 0 },
            edits: 0,
        },
        {
            start: '2026-09-22T21:15:00.000Z',
            tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
            edits: 0,
        },
    ],
    totals: { input: 3_200_000, output: 500_000, cacheRead: 9_000_000, cacheCreation: 100_000 },
    ...over,
});

const render = (activity: ThreadActivity, jobs = [job({ id: RUN_ID, agentTurns: 12 })]) =>
    renderToStaticMarkup(<TaskActivity jobs={jobs} activity={activity} />);

describe('TaskActivity', () => {
    it('renders a bar-free pulse with one line per token type, scoped to the latest run', () => {
        const html = render({ [RUN_ID]: payload() });
        for (const type of ['input', 'output', 'cacheRead', 'cacheCreation']) {
            expect(html).toContain(`data-series="${type}"`);
        }
        expect(html).toContain('Latest run (Run 1)');
        expect(html).toContain('polyline');
        expect(html).not.toContain('bar-primary');
        expect(html).not.toContain('<rect');
        for (const forbidden of FORBIDDEN) expect(html, forbidden).not.toContain(forbidden);
    });

    it('is one labeled button over the whole summary, which opens a dialog', () => {
        const html = render({ [RUN_ID]: payload() });
        const button = html.match(/<button[^>]*task-stats-trigger[^>]*>([\s\S]*?)<\/button>/);
        expect(button).not.toBeNull();
        expect(button![0]).toContain('aria-label="Open task statistics: 1 run, 12 agent turns"');
        expect(button![0]).toContain('aria-haspopup="dialog"');
        // The chart and the counts are inside the button — the whole summary is the target.
        expect(button![1]).toContain('<svg');
        expect(button![1]).toContain('1 run · 12 agent turns');
    });

    it('keeps the summary actionable, with no chart, when the run has no telemetry', () => {
        for (const answer of ['unavailable' as const, payload({ buckets: [], totals: null })]) {
            const html = render({ [RUN_ID]: answer });
            expect(html).toContain('No telemetry for this run.');
            expect(html).not.toContain('<svg');
            expect(html).toContain('task-stats-trigger');
        }
    });

    it('says the telemetry is loading until the run is answered, and shows unmeasured turns as a dash', () => {
        const html = render({}, [job({ id: RUN_ID, agentTurns: null })]);
        expect(html).toContain('Loading telemetry…');
        expect(html).not.toContain('No telemetry for this run.');
        expect(html).toContain('1 run · — agent turns');
    });

    it('counts the thread, not just the latest run, and sums only measured agent turns', () => {
        const second = '22222222-2222-4222-8222-222222222222';
        const html = render({ [RUN_ID]: payload(), [second]: payload({ jobId: second }) }, [
            job({ id: RUN_ID, agentTurns: 4 }),
            job({ id: second, agentTurns: 9 }),
        ]);
        expect(html).toContain('Latest run (Run 2)');
        expect(html).toContain('2 runs · 13 agent turns');
    });
});
