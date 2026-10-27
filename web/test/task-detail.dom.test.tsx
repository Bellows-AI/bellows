import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import {
    authoredBy,
    followUpThread,
    LOCAL_AUTHOR,
    missingSummaryThread,
    mockedActivityOf,
    publishedThread,
    runningThread,
    type ThreadJob,
} from '../../e2e/fixtures/threads.js';
import { type FetchCall, OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';
import { expectNoPlaceholder } from './fixtures.js';
import { NO_GATES, NO_PRS, runUsage, taskUsage, usageBlock } from './tasks-fixtures.js';

/** The board as the page reads it: the session, and every thread and activity read answered by `jobs`. */
function board(jobs: readonly ThreadJob[], extra: (call: FetchCall) => unknown = () => undefined) {
    return stubFetch((call) => {
        const own = extra(call);
        if (own !== undefined) return own;
        if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (/\/api\/jobs\/[^/]+\/thread/.test(call.url)) return { jobs };
        if (/\/api\/jobs\/[^/]+\/activity/.test(call.url)) return mockedActivityOf(jobs);
    });
}

/** Waits for `selector` to mount under `root`, failing loudly instead of handing back null. */
async function mounted<T extends HTMLElement = HTMLElement>(root: ParentNode, selector: string): Promise<T> {
    return waitFor(() => {
        const element = root.querySelector<T>(selector);
        if (element === null) throw new Error(`${selector} never mounted`);
        return element;
    });
}

describe('the task detail page', () => {
    it('a finished thread reads request, response, history, verification, published work', async () => {
        board(authoredBy(publishedThread, LOCAL_AUTHOR));
        const { container } = renderApp(`/tasks/${publishedThread[0]!.id}`);
        const user = userEvent.setup();

        const conversation = await mounted(container, '.task-conversation');
        await waitFor(() => expect(within(conversation).getByText('Request', { exact: true })).toBeTruthy());
        const main = container.querySelector<HTMLElement>('.task-main')!;
        const support = container.querySelector<HTMLElement>('.task-support')!;
        for (const name of ['Run history', 'Verification', 'Published work']) {
            expect(within(support).getByRole('heading', { name })).toBeTruthy();
            expect(within(main).queryByRole('heading', { name })).toBeNull();
        }
        expect(conversation.textContent).toContain('fix #177 please');

        // The stored summary is the response; the raw output and the run history start collapsed,
        // and each toggles on its own.
        expect(within(conversation).getByText('Rebuilt the task detail layout and outcome summary.')).toBeTruthy();
        const rawOutput = conversation.querySelector<HTMLDetailsElement>('.run-output')!;
        const history = container.querySelector<HTMLDetailsElement>('.run-history')!;
        expect(rawOutput.open).toBe(false);
        expect(history.open).toBe(false);
        await user.click(within(rawOutput).getByText('View raw output'));
        await waitFor(() => expect(rawOutput.open).toBe(true));
        expect(history.open).toBe(false);
        await user.click(within(history).getByRole('heading', { name: 'Run history' }));
        await waitFor(() => expect(history.open).toBe(true));
        expect(rawOutput.open).toBe(true);

        // The outcome answers "what happened and where" without duplicating the gate output.
        const outcome = container.querySelector<HTMLElement>('.task-outcome')!;
        expect(outcome.textContent).toContain('Verification');
        expect(outcome.textContent).toContain('1 passed');
        expect(outcome.textContent).not.toContain('all green');
        expect(outcome.textContent).toContain('#9');
        expect(outcome.textContent).toContain('#177');
        const published = container.querySelector<HTMLElement>('.task-published')!;
        expect(published.textContent).toContain('Pull request #9');
        expect(published.textContent).toContain('fix/177');
        expectNoPlaceholder(document.body.textContent);

        // The outcome's checks link lands focus on the verification panel itself.
        await user.click(screen.getByRole('link', { name: 'View checks' }));
        expect(document.activeElement).toBe(document.getElementById('task-verification'));
    });

    it('a live run’s raw output collapses and reopens from its summary, landing on the tail', async () => {
        board(runningThread);
        const { container } = renderApp(`/tasks/${runningThread[0]!.id}`);
        const user = userEvent.setup();
        const conversation = await mounted(container, '.task-conversation');
        const disclosure = await mounted<HTMLDetailsElement>(conversation, '.run-output');
        const output = disclosure.querySelector<HTMLPreElement>('pre.chat-output')!;
        expect(disclosure.open).toBe(true);
        // jsdom lays nothing out: give the well a height to land on, and record where it scrolls.
        Object.defineProperty(output, 'scrollHeight', { configurable: true, value: 4000 });
        let scrolledTo = 0;
        Object.defineProperty(output, 'scrollTop', {
            configurable: true,
            get: () => scrolledTo,
            set: (value: number) => {
                scrolledTo = value;
            },
        });

        // Enter on a focused <summary> is the browser's own click — jsdom has no such activation,
        // so the click stands in for the key; the focusable summary is what the keyboard reaches.
        const summary = disclosure.querySelector<HTMLElement>('summary')!;
        summary.focus();
        expect(document.activeElement).toBe(summary);
        await user.click(summary);
        await waitFor(() => expect(disclosure.open).toBe(false));
        // The activity line is not the raw log: it stays while the log is collapsed.
        expect(conversation.textContent).toContain('→ Bash npm test');

        scrolledTo = 0;
        await user.click(summary);
        await waitFor(() => expect(disclosure.open).toBe(true));
        expect(scrolledTo).toBe(4000);
    });

    it('reads the thread activity once, from the newest run, however many runs the thread has', async () => {
        const jobs = authoredBy(followUpThread, LOCAL_AUTHOR);
        expect(jobs.length).toBeGreaterThan(1);
        const calls = board(jobs);
        renderApp(`/tasks/${jobs[0]!.id}`);

        await screen.findByRole('button', { name: /Open task statistics/ });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const reads = calls.filter((call) => /\/api\/jobs\/[^/]+\/activity/.test(call.url));
        expect(reads.map((call) => call.url)).toEqual([`/api/jobs/${jobs[jobs.length - 1]!.id}/activity`]);
    });

    it('the activity pulse opens the Task statistics modal and gives focus back', async () => {
        // Partial data: only the root run reported agent turns, and only the latest run — the one
        // the sidebar pulse draws — reported tokens.
        const jobs = authoredBy(followUpThread, LOCAL_AUTHOR).map((job, i) => ({
            ...job,
            agentTurns: i === 0 ? 4 : null,
        }));
        const latest = jobs[jobs.length - 1]!;
        const tokens = { input: 1200, output: 300, cacheRead: 9000, cacheCreation: 50 };
        const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
        const rows = [{ model: 'model-a', rawModels: ['model-a'], querySource: null, tokens }];
        board(jobs, (call) => {
            if (!/\/api\/jobs\/[^/]+\/activity/.test(call.url)) return;
            const measured = call.url.includes(latest.id);
            return {
                jobId: latest.id,
                sessionId: latest.sessionId,
                from: latest.startedAt,
                to: latest.finishedAt,
                bucketMs: 300_000,
                buckets: measured
                    ? [
                          { start: '2026-09-01T12:00:00.000Z', tokens, edits: 1 },
                          { start: '2026-09-01T12:05:00.000Z', tokens: zero, edits: 0 },
                          { start: '2026-09-01T12:10:00.000Z', tokens, edits: 2 },
                      ]
                    : [],
                usage: usageBlock(measured ? tokens : null),
                gates: NO_GATES,
                prs: NO_PRS,
                taskActivity: { gates: NO_GATES, prs: NO_PRS },
                task: taskUsage(
                    jobs[0]!.id,
                    [
                        runUsage(latest.id, 'follow-up', tokens, { block: { rows } }),
                        runUsage(
                            '99999999-9999-4999-8999-999999999999',
                            'review',
                            { output: 40 },
                            { reviewOf: latest.id }
                        ),
                    ],
                    { block: { rows } }
                ),
            };
        });
        const { container } = renderApp(`/tasks/${jobs[0]!.id}`);
        const user = userEvent.setup();

        const trigger = await screen.findByRole('button', { name: /Open task statistics/ });
        // No bars: the sidebar holds a line chart only.
        expect(container.querySelectorAll('.task-activity .bar-primary')).toHaveLength(0);
        await waitFor(() => expect(trigger.querySelectorAll('svg polyline')).toHaveLength(4));

        const dialog = () => screen.queryByRole('dialog', { name: 'Task statistics' });
        // Enter, Space and click each open it; Escape and Close each shut it and return focus.
        trigger.focus();
        await user.keyboard('{Enter}');
        const open = await waitFor(() => {
            const element = dialog();
            if (element === null) throw new Error('the dialog never opened');
            return element;
        });
        expect(within(open.querySelector<HTMLElement>('.task-stats-totals')!).getByText('Agent turns')).toBeTruthy();
        expect(within(open).getByText('Agent turns measured for 1 of 2 runs.')).toBeTruthy();
        // The task total comes from the canonical task: the review is counted though it is no row of the thread.
        expect(within(open).getByText('Includes 1 review run.')).toBeTruthy();
        const usage = within(open.querySelector<HTMLElement>('.task-stats-usage')!);
        expect(usage.getByText('1,200')).toBeTruthy();
        expect(usage.getByText('340')).toBeTruthy();
        // One row per run of the task, the review too, labelled by the run it reviews.
        expect(open.querySelectorAll('.task-stats-runs > table > tbody > tr[data-kind]')).toHaveLength(jobs.length + 1);
        expect(within(open).getByRole('rowheader', { name: /Review of run 2/ })).toBeTruthy();
        // Expanding a run shows the models behind its four figures; the task's Models section is apart.
        expect(open.querySelectorAll('.usage-breakdown')).toHaveLength(1);
        await user.click(within(open).getByRole('button', { name: 'Show usage details for Run 2' }));
        expect(open.querySelectorAll('.usage-breakdown')).toHaveLength(2);
        await user.click(within(open).getByRole('button', { name: 'Hide usage details for Run 2' }));
        expect(open.querySelectorAll('.usage-breakdown')).toHaveLength(1);
        // Each legend swatch wears its own line's color class, four apart.
        const swatches = [...open.querySelectorAll('.pulse-legend .pulse-swatch')].map((swatch) =>
            [...swatch.classList].filter((name) => name !== 'pulse-swatch').join(' ')
        );
        const lines = [...open.querySelectorAll('.pulse-detailed .pulse-line')].map(
            (line) => line.parentElement!.getAttribute('class') ?? ''
        );
        expect(swatches).toEqual(lines);
        expect(new Set(swatches).size).toBe(4);

        await user.keyboard('{Escape}');
        await waitFor(() => expect(dialog()).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(trigger));

        await user.keyboard(' ');
        await waitFor(() => expect(dialog()).not.toBeNull());
        await user.click(within(dialog()!).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(dialog()).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(trigger));

        await user.click(trigger);
        await waitFor(() => expect(dialog()).not.toBeNull());
        // Focus stays trapped inside: Tab never leaves the dialog.
        await user.tab();
        await user.tab();
        await user.tab();
        expect(dialog()!.contains(document.activeElement)).toBe(true);
    });

    it('says the usage is unavailable when the board refuses the activity read, and never a zero', async () => {
        const jobs = authoredBy(followUpThread, LOCAL_AUTHOR);
        board(jobs, (call) =>
            /\/api\/jobs\/[^/]+\/activity/.test(call.url)
                ? { status: 503, body: { error: 'telemetry unavailable', code: 'UNAVAILABLE' } }
                : undefined
        );
        renderApp(`/tasks/${jobs[0]!.id}`);
        const user = userEvent.setup();

        await user.click(await screen.findByRole('button', { name: /Open task statistics/ }));
        const open = await screen.findByRole('dialog', { name: 'Task statistics' });
        expect(within(open).getByText('Usage is unavailable: the telemetry could not be read.')).toBeTruthy();
        expect(within(open).queryByText('0')).toBeNull();
    });

    it("your own task offers the composer, and the board's 403 renders inside it and keeps the draft", async () => {
        const jobs = authoredBy(missingSummaryThread, LOCAL_AUTHOR);
        const refusal = 'Only the account that queued the task can follow it up';
        const calls = board(jobs, (call) =>
            call.method === 'POST' && /\/api\/jobs\/[^/]+\/follow-up$/.test(call.url)
                ? { status: 403, body: { error: refusal, code: 'FORBIDDEN' } }
                : undefined
        );
        const { container } = renderApp(`/tasks/${jobs[0]!.id}`);
        const user = userEvent.setup();

        const box = (await screen.findByLabelText('Ask for a follow-up')) as HTMLTextAreaElement;
        expect(screen.queryByText(/can continue this session/)).toBeNull();
        await user.type(box, 'one more pass');
        await user.click(screen.getByRole('button', { name: 'Send follow-up' }));

        const composer = await mounted(container, '.composer');
        await waitFor(() => expect(composer.textContent).toContain(refusal));
        expect(calls.filter((call) => call.method === 'POST' && call.url.endsWith('/follow-up'))).toHaveLength(1);
        expect(box.value).toBe('one more pass');
    });

    it('an action that resolves after navigating to another task is ignored', async () => {
        const first = authoredBy(publishedThread, LOCAL_AUTHOR);
        const other = authoredBy(missingSummaryThread, LOCAL_AUTHOR);
        const firstId = first[0]!.id;
        let release: () => void = () => undefined;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        let refused = false;
        board(first, async (call) => {
            if (call.url === `/api/jobs/${firstId}/done`) {
                await held;
                refused = true;
                return { status: 409, body: { error: 'Task is running', code: 'TASK_RUNNING' } };
            }
            const jobs = call.url.includes(firstId) ? first : other;
            if (/\/api\/jobs\/[^/]+\/thread/.test(call.url)) return { jobs };
            if (/\/api\/jobs\/[^/]+\/activity/.test(call.url)) return mockedActivityOf(jobs);
        });
        const { container, router } = renderApp(`/tasks/${firstId}`);
        const user = userEvent.setup();
        const header = await mounted(container, '.page-header-actions');

        await user.click(await within(header).findByRole('button', { name: 'Mark done' }));
        const pending = await within(header).findByRole('button', { name: 'Marking done…' });
        expect((pending as HTMLButtonElement).disabled).toBe(true);

        // Client-side navigation, so the in-flight request outlives the task it was sent for.
        await router.navigate(`/tasks/${other[0]!.id}`);
        await screen.findByRole('heading', { level: 1, name: 'seed task' });

        release();
        await waitFor(() => expect(refused).toBe(true));
        // Let the refusal settle before reading what it left behind.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(screen.queryByText('Task is running')).toBeNull();
        const markDone = within(container.querySelector<HTMLElement>('.page-header-actions')!).getByRole('button', {
            name: 'Mark done',
        });
        expect((markDone as HTMLButtonElement).disabled).toBe(false);
    });
});
