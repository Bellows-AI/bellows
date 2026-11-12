import { OBJECTIVE_MODE } from '@factory-ai/core';
import { cleanup, render as mount, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { Job } from '../src/api/useJobs.js';
import { RecentTasksPanel } from '../src/panels/RecentTasksPanel.js';

/**
 * The dashboard's Task board section, queried by role and name under jsdom: the task's identity is the ROOT
 * COMMAND's first line — the agent's closing summary is outcome text, not identity — linked to
 * the task page, the finish stamp is relative with the precise time on hover/focus, a failed
 * poll keeps the last good rows beside its alert, and the null-not-zero contract survives to
 * the markup.
 */

const NOW = new Date('2026-08-21T14:00:00.000Z');

const job = (over: Partial<Job> = {}): Job => ({
    id: '11111111-1111-4111-8111-111111111111',
    command: 'fix the failing gates',
    title: null,
    titleOrigin: null,
    titleRevision: 0,
    status: 'succeeded',
    attempts: 1,
    author: { id: 'u-alice', login: 'alice', name: 'Alice Doe', avatarUrl: 'https://example.com/alice.png' },
    stoppedBy: null,
    doneBy: null,
    sessionId: null,
    exitCode: 0,
    output: null,
    summary: null,
    failureKind: null,
    gates: null,
    runtime: null,
    repo: 'Bellows-AI/bellows',
    executor: null,
    workflowNode: null,
    workflowName: null,
    mode: OBJECTIVE_MODE,
    followUpTo: null,
    rootJobId: '11111111-1111-4111-8111-111111111111',
    doneAt: null,
    cancelRequestedAt: null,
    workspacePath: null,
    createdAt: '2026-08-21T12:00:00.000Z',
    startedAt: '2026-08-21T12:00:01.000Z',
    finishedAt: '2026-08-21T13:40:00.000Z',
    wallClockMs: null,
    agentTurns: null,
    setupMs: null,
    interruptions: [],
    taskWallClockMs: null,
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
    questions: [],
    connections: [],
    bindingRevision: 0,
    attachments: [],
    integrationRequirements: [],
    executionUser: null,
    actingFor: null,
    ...over,
});

const render = (jobs: Job[] | null, error: string | null) =>
    mount(
        <MemoryRouter>
            <RecentTasksPanel jobs={jobs} error={error} now={NOW} />
        </MemoryRouter>
    );

const cells = () => screen.getAllByRole('cell');

describe('the task board section', () => {
    afterEach(cleanup);

    it('keeps titles and dates out of the identifier face and right-aligns the figures', () => {
        const { container } = render([job({})], null);
        expect(container.querySelector('.mono')).toBeNull();
        expect(container.querySelectorAll('td.align-end')).toHaveLength(3);
    });

    it('heads the section Recent tasks with a Task board pill and the range/scope caption', () => {
        render([job({})], null);
        expect(screen.getByRole('heading', { level: 2, name: 'Recent tasks' })).toBeTruthy();
        // The range/scope note rides on the pill: a tooltip, and the note's accessible name.
        const note = screen.getByRole('note', { name: 'Task board — not affected by range or scope' });
        expect(note.textContent).toBe('Task board');
        expect(note.getAttribute('title')).toBe('Not affected by range or scope');
        // View all tasks sits in the head row, beside the title.
        const link = screen.getByRole('link', { name: 'View all tasks' });
        expect(link.getAttribute('href')).toBe('/tasks');
        expect(screen.getByRole('heading', { level: 2 }).parentElement?.contains(link)).toBe(true);
        expect(screen.queryByText('Latest finished tasks from the board')).toBeNull();
    });

    it('shows the author as an avatar, with the name as its alt text and tooltip', () => {
        render([job({})], null);
        const avatar = screen.getByRole('img', { name: 'Alice Doe' });
        expect(avatar.getAttribute('src')).toBe('https://example.com/alice.png');
        expect(avatar.parentElement?.getAttribute('title')).toBe('Alice Doe');
        cleanup();
        // No avatar: the name stays as text.
        render([job({ author: { id: 'u-bob', login: 'bob', name: null, avatarUrl: null } })], null);
        expect(screen.queryByRole('img')).toBeNull();
        expect(screen.getByText('bob').getAttribute('title')).toBe('bob');
    });

    it.each([
        ['succeeded', {}, 'Succeeded · Needs review'],
        ['failed', { status: 'failed' }, 'Failed · Needs review'],
        ['marked done', { doneAt: '2026-08-21T13:50:00.000Z' }, 'Done'],
    ] as [string, Partial<Job>, string][])('renders %s as the taskStatusLabel', (_name, over, label) => {
        render([job(over)], null);
        expect(within(screen.getByRole('table')).getByText(label)).toBeTruthy();
    });

    it('never renders the raw job status', () => {
        render([job({})], null);
        expect(screen.queryByText('succeeded')).toBeNull();
    });

    it('titles the row from the root command and links it to the task page', () => {
        render([job({ summary: 'Fixed the failing gates and pushed', command: 'fix the failing gates' })], null);
        const link = screen.getByRole('link', { name: 'fix the failing gates' });
        expect(link.getAttribute('href')).toBe('/tasks/11111111-1111-4111-8111-111111111111');
        // The agent's summary is outcome text, never the task's identity.
        expect(screen.queryByText('Fixed the failing gates and pushed')).toBeNull();
    });

    it('titles the row from the stored title when one is set', () => {
        render([job({ title: 'Gate repair', titleOrigin: 'user', titleRevision: 1 })], null);
        expect(screen.getByRole('link', { name: 'Gate repair' })).toBeTruthy();
        expect(screen.queryByText('fix the failing gates')).toBeNull();
    });

    it('uses the first NON-empty command line and stops there', () => {
        render([job({ command: '\n  \nrefactor the ingest path\nsecond line' })], null);
        expect(screen.getByRole('link', { name: 'refactor the ingest path' })).toBeTruthy();
        expect(screen.queryByText(/second line/)).toBeNull();
    });

    it('renders the finish stamp relative, with the precise UTC time on hover/focus', () => {
        const { container } = render([job({ finishedAt: '2026-08-21T13:40:00.000Z' })], null);
        expect(screen.getByText('20m ago')).toBeTruthy();
        const stamp = container.querySelector('time');
        expect(stamp?.getAttribute('datetime')).toBe('2026-08-21T13:40:00.000Z');
        expect(stamp?.getAttribute('title')).toBe('2026-08-21 13:40');
    });

    it('renders the thread wall clock, not the head run’s own slice', () => {
        // One row per task: the row carries the head run's own banked clock beside the
        // thread total, and the panel shows the thread figure — what the task view's head clock
        // shows.
        render([job({ wallClockMs: 300_000, taskWallClockMs: 1_200_000 })], null);
        const text = cells().map((cell) => cell.textContent);
        expect(text).toContain('20m');
        expect(text).not.toContain('5m');
    });

    it('renders unmeasured context and wall clock as em dashes, never zeros', () => {
        const { container } = render([job()], null);
        const text = cells().map((cell) => cell.textContent);
        expect(text).toContain('—');
        expect(text).not.toContain('0');
        expect(container.textContent).not.toContain('NaN');
    });

    it('links to the full task list after the table', () => {
        render([job()], null);
        expect(screen.getByRole('link', { name: 'View all tasks' }).getAttribute('href')).toBe('/tasks');
    });

    it('keeps the last good rows on screen beside the failure alert', () => {
        // The hook survives a failed tick with the previous answer intact; the panel's job is to
        // say the read failed AND keep the rows — not to blank the section.
        render([job({ id: '22222222-2222-4222-8222-222222222222' })], 'connection refused');
        expect(screen.getByRole('alert').textContent).toBe('The board could not be read — connection refused.');
        expect(screen.getByRole('link', { name: 'fix the failing gates' }).getAttribute('href')).toBe(
            '/tasks/22222222-2222-4222-8222-222222222222'
        );
    });

    it('renders a cold read failure as an alert instead of a blank section', () => {
        render(null, 'connection refused');
        expect(screen.getByRole('alert').textContent).toContain('connection refused');
        expect(screen.queryByRole('link', { name: 'View all tasks' })).toBeNull();
    });

    it('renders the empty state', () => {
        render([], null);
        expect(screen.getByText('No completed tasks yet.')).toBeTruthy();
    });

    it('renders a loading state before the first answer', () => {
        render(null, null);
        expect(screen.getByRole('status').textContent).toBe('Loading…');
    });
});
