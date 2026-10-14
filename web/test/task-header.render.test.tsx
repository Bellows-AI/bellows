import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeDialogBody, removeDialogTitle } from '../src/components/TaskRemoveDialog.js';
import { job, question, renderHeader } from './tasks-fixtures.js';
import { expectNoPlaceholder } from './fixtures.js';

describe('the task page header', () => {
    /**
     * The page-level head of `/tasks/:id`: the task's name as the page's one `h1`, its status,
     * wall clock and live activity in the meta slots, and every action the task can take in the
     * actions slot — lifted out of the conversation panel (#159).
     */

    it("names the task after its opening command, as the page's one h1", () => {
        const html = renderHeader({ jobs: [job()] });
        expect(html.match(/<h1/g)?.length).toBe(1);
        expect(html).toContain('<h1>fix the flaky login test</h1>');

        // A multi-line command is prose; the header carries its first line, the turn carries it all.
        const multiline = renderHeader({ jobs: [job({ command: 'first line\nsecond line' })] });
        expect(multiline).toContain('<h1>first line</h1>');
        expect(multiline).not.toContain('second line');
    });

    it('keeps the plain Tasks heading while nothing is loaded', () => {
        // No task yet, so there is nothing to name — the detail poll has not landed.
        const html = renderHeader({ jobs: null });
        expect(html).toContain('<h1>Tasks</h1>');
        expect(html).not.toContain('>Stop run<');
        expect(html).not.toContain('>Mark done<');
        expect(html).not.toContain('More task actions');
    });

    it('shows the status beside the title as the shared label in its tone, with the header’s own classes', () => {
        const html = renderHeader({ jobs: [job()] });
        expect(html).toContain('page-header-meta');
        expect(html).toMatch(/<span class="pill pill-accent" aria-live="polite">.*Succeeded · Needs review<\/span>/);
        const running = renderHeader({ jobs: [job({ status: 'running', finishedAt: null, exitCode: null })] });
        expect(running).toMatch(
            /<span class="pill pill-ok" aria-live="polite"><span class="sidenav-dot sidenav-dot-running"/
        );
        const waiting = { status: 'queued' as const, waitReason: 'review' as const, finishedAt: null, exitCode: null };
        expect(renderHeader({ jobs: [job(waiting)] })).toContain('class="pill pill-done task-pill-wait"');
        expect(renderHeader({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] })).toContain(
            'class="pill pill-done task-pill-done"'
        );
    });

    it('shows Needs answer ahead of Running while any question in the thread is answerable', () => {
        const live = { status: 'running' as const, finishedAt: null, exitCode: null };
        const asking = renderHeader({ jobs: [job(), job({ ...live, id: 'head', questions: [question()] })] });
        expect(asking).toMatch(
            /<span class="pill pill-accent" aria-live="polite"><svg[\s\S]*?<\/svg>Needs answer<\/span>/
        );
        expect(asking).not.toContain('Running');
        const answered = question({ status: 'answered', answerable: false, answers: { 'Which database?': 'SQLite' } });
        const after = renderHeader({ jobs: [job({ ...live, questions: [answered] })] });
        expect(after).toContain('Running');
        expect(after).not.toContain('Needs answer');
    });

    it('names the task #id · Opened … by login · repo', () => {
        const author = { id: 'a', login: 'octocat', name: 'Octo Cat', avatarUrl: null };
        const html = renderHeader({ jobs: [job({ author, repo: 'acme/web' })] });
        expect(html).toContain('page-header-description');
        expect(html).toContain('title="11111111-1111-4111-8111-111111111111">#11111111<');
        expect(html).toContain('<time dateTime="2026-09-01T12:00:00.000Z"');
        expect(html).toContain('<span class="avatar avatar-fallback" aria-hidden="true">O</span>octocat');
        expect(html).toContain('acme/web');

        // A pre-accounts row says so; no repository, no repository segment.
        const bare = renderHeader({ jobs: [job()] });
        expect(bare).toContain('<span class="task-opened-by">unknown</span>');
        expect(bare).not.toContain('acme/web');
    });

    it('adds a Verification failed pill while the newest run has a failed gate', () => {
        const gates = [{ name: 'lint', status: 'failed' as const, exitCode: 1, output: 'nope' }];
        expect(renderHeader({ jobs: [job({ gates })] })).toContain('Verification failed');
        expect(renderHeader({ jobs: [job()] })).not.toContain('Verification failed');
    });

    it('preserves Stop run while waiting, with copy explaining it cancels automation but not the PR', () => {
        const html = renderHeader({
            jobs: [
                job({
                    status: 'queued',
                    waitReason: 'review',
                    exitCode: null,
                    finishedAt: null,
                    startedAt: null,
                    output: null,
                }),
            ],
        });
        expect(html).toContain('>Stop run<');
        expect(html).toMatch(/cancels remaining automation/i);
        expect(html).toMatch(/not close|does not close/i);
    });

    it('says Stopping while the stop request itself is in flight, and cannot be re-clicked', () => {
        const task = job({ status: 'running', exitCode: null, finishedAt: null, startedAt: null, output: null });
        const html = renderHeader({ jobs: [task], stoppingId: task.id });
        expect(html).toContain('Stopping…');
        expect(html).not.toContain('>Stop run<');
        const LOOKBEHIND_CHARS = 300;
        const stop = html.slice(html.indexOf('Stopping…') - LOOKBEHIND_CHARS, html.indexOf('Stopping…'));
        expect(stop).toContain('disabled');
    });
});

describe('the task page header — Mark done, overflow and meta', () => {
    it('labels an in-flight Mark done and disables it', () => {
        const task = job();
        const html = renderHeader({ jobs: [task], doneId: task.id });
        expect(html).toContain('Marking done…');
        expect(html).not.toContain('>Mark done<');
        const LOOKBEHIND_CHARS = 300;
        const done = html.slice(html.indexOf('Marking done…') - LOOKBEHIND_CHARS, html.indexOf('Marking done…'));
        expect(done).toContain('disabled');
    });

    it('shows closure attribution as status text, never a disabled control', () => {
        const author = { id: 'a', login: 'octocat', name: null, avatarUrl: null };
        const attributed = renderHeader({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z', doneBy: author })] });
        expect(attributed).toContain('Closed by octocat · <time dateTime="2026-09-01T13:00:00.000Z"');
        expect(attributed).not.toContain('disabled');

        // No actor recorded — pre-accounts row — still says the closure out loud.
        const plain = renderHeader({ jobs: [job({ doneAt: '2026-09-01T13:00:00.000Z' })] });
        expect(plain).toContain('Closed · <time dateTime="2026-09-01T13:00:00.000Z"');
        expect(plain).not.toContain('disabled');
        expect(plain).not.toContain('>Mark done<');
    });

    it('hides More task actions while any member of the thread is running', () => {
        const moving = { exitCode: null, finishedAt: null, startedAt: null, output: null };
        expect(renderHeader({ jobs: [job({ status: 'running', ...moving })] })).not.toContain('More task actions');

        // A follow-up still going closes the whole thread's menu — the removal would race the run.
        const root = job({ status: 'stopped' });
        const child = {
            ...job({ status: 'running', ...moving }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        expect(renderHeader({ jobs: [root, child] })).not.toContain('More task actions');

        // Queued members do not block it: the board has no run to refuse.
        const queued = {
            ...job({ status: 'queued', ...moving }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        expect(renderHeader({ jobs: [root, queued] })).toContain('More task actions');
    });

    it('renders the actions on the newest run only — history runs grow none', () => {
        const root = job({ command: 'first command' });
        const child = {
            ...job({ command: 'second command', status: 'stopped' }),
            id: '44444444-4444-4444-8444-444444444444',
            followUpTo: root.id,
            rootJobId: root.id,
        };
        const html = renderHeader({ jobs: [root, child] });
        expect(html.match(/>Mark done</g)).toHaveLength(1);
        expect(html.match(/More task actions/g)).toHaveLength(1);
        expect(html).not.toContain('>Stop run<');
    });

    it('renders no empty action wrapper in any state', () => {
        for (const status of ['queued', 'running', 'succeeded', 'failed', 'dead', 'stopped'] as const) {
            const html = renderHeader({ jobs: [job({ status })] });
            expect(html, status).not.toContain('<div class="task-actions"></div>');
        }
    });

    it('shows the overall wall clock in the meta, and a dash where nothing is measurable', () => {
        const timed = renderHeader({ jobs: [job({ taskWallClockMs: 5_400_000 })] });
        expect(timed).toContain('1.5h');

        const untimed = renderHeader({ jobs: [job()] });
        expect(untimed).toContain('—');
    });

    it('shows the live activity line in the meta while the newest run is going', () => {
        // Same line the sidebar's "Task" row and the sidenav read — page level now (#159).
        const runtime = {
            cpuPercent: 12,
            memUsedMb: 300,
            memPercent: null,
            activity: '→ Bash npm test',
            sampledAt: '2026-09-01T12:02:00.000Z',
        };
        const html = renderHeader({ jobs: [job({ status: 'running', runtime })] });
        expect(html).toContain('task-summary');
        expect(html).toContain('→ Bash npm test');

        // Not on a task whose newest run is not going.
        const quiet = renderHeader({ jobs: [job()] });
        expect(quiet).not.toContain('task-summary');
    });

    it('never emits a placeholder value', () => {
        const html = renderHeader({
            jobs: [job({ taskWallClockMs: null, output: null, exitCode: null, finishedAt: null, startedAt: null })],
        });
        expectNoPlaceholder(html);
    });
});

describe('the task page header — the action matrix (plan §3.2)', () => {
    /** The action matrix: stoppable = queued/running, done = the one primary, closed = text. */
    const me = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', login: 'me', name: null, avatarUrl: null };
    const other = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', login: 'kim', name: null, avatarUrl: null };
    const viewer = { loading: false, id: me.id };
    const someoneElse = { loading: false, id: 'someone-else' };
    const stranger = { loading: false, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const moving = { exitCode: null, finishedAt: null, output: null };
    const unstarted = { ...moving, startedAt: null };
    const wait = { waitReason: 'review', waitingSince: '2026-09-01T12:30:00.000Z' };
    const failedGate = [{ name: 'lint', status: 'failed' as const, exitCode: 1, output: 'nope' }];
    const doneAt = '2026-09-01T13:00:00.000Z';
    const MARK_DONE_COPY = 'Closes this task in Bellows. Does not merge or close the pull request.';
    const PARKED_COPY = 'No executor is running. The workflow is waiting for review.';
    const STOPPING_BUTTON =
        '<button type="button" class="chat-resume chat-stop" disabled="" aria-busy="true">Stopping…</button>';
    /** The primary button's markup: the one `class="primary"` button in the row. */
    const primaryOf = (html: string) => html.match(/<button type="button" class="primary"[^>]*>([^<]*)</)?.[1] ?? null;

    type Row = {
        label: string;
        args: Parameters<typeof renderHeader>[0];
        /** The one primary button's label; `null` = no primary; absent = not asserted. */
        primary?: string | null;
        has?: string[];
        lacks?: string[];
        /**
         * More task actions present (true) or hidden (false). Present also pins that Remove lives
         * only in the client-rendered menu and that the overflow trigger is never the primary.
         */
        more?: boolean;
    };

    const rows: Row[] = [
        // The board accepts queued stops, not just a moving run.
        ...(['queued', 'running'] as const).map((status) => ({
            label: `${status}: offers Stop run`,
            args: { jobs: [job({ status, ...unstarted })] },
            has: ['>Stop run<', 'chat-stop'],
        })),
        ...(['succeeded', 'failed', 'dead', 'stopped'] as const).map((status) => ({
            label: `${status}: no Stop run and no Stopping`,
            args: { jobs: [job({ status })] },
            lacks: ['>Stop run<', 'Stopping…'],
        })),
        {
            // The board settles the stop at the worker's next heartbeat: pending is not terminal,
            // so the pending state is a disabled, busy control. A run in flight cannot be removed
            // yet: the board refuses with TASK_RUNNING.
            label: 'stop requested, not yet parked: Stopping, not Stop run, and no More',
            args: {
                jobs: [job({ status: 'running', cancelRequestedAt: '2026-09-01T12:01:00.000Z', ...unstarted })],
            },
            has: ['Stopping…'],
            lacks: ['>Stop run<'],
            more: false,
        },
        {
            label: 'open task: Mark done is the one primary',
            args: { jobs: [job()] },
            primary: 'Mark done',
            has: ['>Mark done<'],
        },
        // Failed, dead and stopped are open too until somebody closes them; a failure the viewer
        // cannot follow up (another member's) offers Mark done as its primary.
        ...(['failed', 'dead', 'stopped'] as const).map((status) => ({
            label: `${status}, another member's: Mark done`,
            args: { jobs: [job({ status })], viewer: someoneElse },
            has: ['>Mark done<'],
        })),
        { label: 'done: no Mark done', args: { jobs: [job({ doneAt })] }, lacks: ['>Mark done<'] },
        {
            // Done is unrelated to sessions and stays available for a run without one.
            label: 'sessionless: Mark done',
            args: { jobs: [job({ sessionId: null })] },
            has: ['>Mark done<'],
        },
        ...(['queued', 'succeeded', 'failed', 'dead', 'stopped'] as const).map((status) => ({
            label: `${status}: Remove task behind More task actions`,
            args: { jobs: [job({ status })] },
            more: true,
        })),
        {
            label: 'queued: Stop run, with Remove in More and no Mark done',
            args: { jobs: [job({ status: 'queued', startedAt: null, ...moving })], viewer },
            primary: null,
            has: ['>Stop run<'],
            more: true,
        },
        {
            label: 'running: Stop run, and no More while a member runs',
            args: { jobs: [job({ status: 'running', ...moving })], viewer },
            has: ['>Stop run<'],
            more: false,
        },
        {
            label: 'running with a stop requested: one disabled, busy Stopping… button',
            args: {
                jobs: [job({ status: 'running', cancelRequestedAt: '2026-09-01T12:01:00.000Z', ...moving })],
                viewer,
            },
            has: [STOPPING_BUTTON],
            lacks: ['>Stop run<'],
            more: false,
        },
        // A failure parked on its review wait is the wait's to settle — no Ask for another pass.
        ...(['succeeded', 'failed'] as const).map((status) => ({
            label: `${status} with an open wait: Mark done and the parked copy, never Stop run`,
            args: { jobs: [job({ status, author: me, ...wait })], viewer },
            primary: 'Mark done',
            has: [PARKED_COPY],
            lacks: ['>Stop run<'],
            more: true,
        })),
        ...[
            ['failed', job({ status: 'failed', author: me })],
            ['dead', job({ status: 'dead', author: me })],
            ['verification failed', job({ author: me, gates: failedGate })],
            ['failed and sessionless', job({ status: 'failed', author: me, sessionId: null })],
        ].map(([what, latest]) => ({
            label: `${what as string}, and eligible: Ask for another pass, Mark done moves to More`,
            args: { jobs: [latest as ReturnType<typeof job>], viewer },
            primary: 'Ask for another pass',
            lacks: [MARK_DONE_COPY],
            more: true,
        })),
        {
            label: 'failed and not eligible, another member: Mark done',
            args: { jobs: [job({ status: 'failed', author: other })], viewer },
            primary: 'Mark done',
            lacks: ['Ask for another pass'],
        },
        {
            label: 'failed and not eligible, a session still loading: Mark done',
            args: { jobs: [job({ status: 'failed', author: me })], viewer: { loading: true, id: null } },
            primary: 'Mark done',
            lacks: ['Ask for another pass'],
        },
        {
            label: 'stopped: Mark done',
            args: { jobs: [job({ status: 'stopped', author: me })], viewer },
            primary: 'Mark done',
        },
        {
            label: 'done, whatever the wait: no primary, the closure, and Remove in More',
            args: { jobs: [job({ status: 'failed', author: me, doneAt, doneBy: me, ...wait })], viewer },
            primary: null,
            has: ['Closed by me'],
            lacks: [PARKED_COPY],
            more: true,
        },
        // Stop, Mark done and Remove carry no author restriction.
        {
            label: "a stranger on another member's running task: Stop run",
            args: { jobs: [job({ status: 'running', author: other, ...moving })], viewer: stranger },
            has: ['>Stop run<'],
        },
        {
            label: "a stranger on another member's open task: Mark done, and Remove in More",
            args: { jobs: [job({ author: other })], viewer: stranger },
            primary: 'Mark done',
            more: true,
        },
    ];

    it.each(rows.map((row) => [row.label, row] as const))(
        '%s',
        (_label, { args, primary, has = [], lacks = [], more }) => {
            const html = renderHeader(args);
            if (primary !== undefined) expect(primaryOf(html)).toBe(primary);
            for (const text of has) expect(html).toContain(text);
            for (const text of lacks) expect(html).not.toContain(text);
            if (more === false) expect(html).not.toContain('More task actions');
            if (more === true) {
                expect(html).toContain('More task actions');
                // The destructive item lives in the anchored menu, which only the client renders;
                // the server-rendered action row must carry no Remove control of its own.
                expect(html).not.toContain('>Remove task<');
                expect(html).not.toContain('>Remove<');
                // The overflow trigger is a secondary control — the page's one primary is Mark done.
                const at = html.indexOf('More task actions');
                expect(html.slice(html.lastIndexOf('<button', at), at)).not.toContain('primary');
            }
        }
    );

    it('succeeded with no wait: Mark done, with what it does and does not do', () => {
        const html = renderHeader({ jobs: [job({ author: me })], viewer });
        expect(primaryOf(html)).toBe('Mark done');
        expect(html).toContain(MARK_DONE_COPY);
        expect(html).not.toContain(PARKED_COPY);
        const describedBy = html.match(/aria-describedby="([^"]+)"/)?.[1];
        expect(describedBy).toBeDefined();
        expect(html).toContain(`id="${describedBy}">${MARK_DONE_COPY}`);
    });
});

describe('TaskRemoveDialog', () => {
    /**
     * The remove confirmation is a Headless UI Dialog, so it portals, and a static render does not
     * render portals. The in-dialog contracts (initial focus, Escape,
     * backdrop, focus restoration, the live error) are a real browser's to assert —
     * e2e/task-detail.spec.ts owns them. What a static render CAN hold is the copy the dialog
     * renders: the helpers below are the component's source of truth, exported pure.
     */
    it('names the task in the title \u2014 the root command\u2019s first line, whatever the prose', () => {
        expect(removeDialogTitle('fix the flaky login test')).toBe('Remove \u201Cfix the flaky login test\u201D?');
        expect(removeDialogTitle('first line\nsecond line')).toBe('Remove \u201Cfirst line\u201D?');
    });

    it('states every consequence in the body, with the thread\u2019s real run count', () => {
        const RUN_COUNT = 3;
        const body = removeDialogBody(RUN_COUNT);
        expect(body).toContain('permanently deletes all 3 runs');
        expect(body).toContain('their transcript');
        expect(body).toContain('worktree will be queued for deletion');
        expect(body).toContain('Published branches and pull requests are not deleted');
        expect(body).toContain('cannot be undone');
        // The count is the thread's length, not a decoration: one run reads as one.
        expect(removeDialogBody(1)).toContain('deletes all 1 runs');
    });
});

describe('the remove flow', () => {
    /** The `window.confirm` path is the thing this dialog replaces — it must be gone outright. */
    it('carries no window.confirm anywhere in the task actions', () => {
        const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
        expect(read('../src/pages/TaskDetailPage.tsx')).not.toContain('window.confirm');
        expect(read('../src/panels/TaskHeader.tsx')).not.toContain('window.confirm');
    });
});
