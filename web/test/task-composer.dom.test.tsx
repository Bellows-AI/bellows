import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { WorkspacePayload, WorkspaceRepo } from '../src/api/useWorkspace.js';
import { type FetchReply, OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';

/**
 * The composer's launch triggers over a stubbed board: Start and Ctrl/Cmd+Enter share one gate, and
 * with nothing synced both open the No repos synced dialog instead of queueing. The cross-page
 * launch journey stays in e2e/journeys.spec.ts.
 */

const CREATED = '2026-01-01T00:00:00.000Z';
const LAUNCHED_ID = '11111111-1111-4111-8111-111111111111';

const repo = (status: WorkspaceRepo['status'], name = 'web'): WorkspaceRepo => ({
    owner: 'acme',
    name,
    status,
    error: null,
    selectedAt: CREATED,
    readyAt: status === 'ready' ? CREATED : null,
    branch: null,
    lastCommit: null,
    sizeBytes: null,
    cacheSizeBytes: null,
});

const workspace = (repos: WorkspaceRepo[]): WorkspacePayload => ({
    root: '/e2e/workspace',
    repos,
    orphaned: [],
    checkoutTotalBytes: null,
    executors: [
        {
            id: '22222222-2222-4222-8222-222222222222',
            name: 'e2e-executor',
            suspended: false,
            type: 'claude-code',
            createdAt: CREATED,
            gateFixRounds: 3,
        },
    ],
    orgExecutors: [],
    defaultExecutor: { scope: 'user', name: 'e2e-executor' },
});

function openComposer(
    repos: WorkspaceRepo[],
    launchReply: FetchReply = { status: 201, body: { id: LAUNCHED_ID, status: 'queued' } }
) {
    const calls = stubFetch(({ method, url }) => {
        if (url === '/api/workspace') return workspace(repos);
        // The held draft belongs to a session, so /api/auth/me must answer.
        if (url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (method === 'POST' && url === '/api/jobs') return launchReply;
    });
    const view = renderApp('/tasks/new');
    const launches = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/jobs');
    return { ...view, launches };
}

const KEYBOARD_LAUNCH = '{Control>}{Enter}{/Control}';

describe('the composer launch triggers', () => {
    it('share the button validation on the keyboard: an empty prompt never queues', async () => {
        const user = userEvent.setup();
        const { router, launches } = openComposer([repo('ready')]);
        const prompt = await screen.findByLabelText('What should the agent do?');
        await waitFor(() => expect(screen.getByRole('button', { name: /^Executor: / })).toBeTruthy());

        // The shortcut is the button, never a bypass: an empty prompt sends nothing and says why.
        await user.click(prompt);
        await user.keyboard(KEYBOARD_LAUNCH);
        expect(screen.getByText('Describe the task to continue.')).toBeTruthy();
        expect(launches()).toHaveLength(0);
        expect(router.state.location.pathname).toBe('/tasks/new');

        // A prompt lets the same shortcut queue, and the page walks straight to the new task.
        await user.type(prompt, 'fix the login crash');
        await user.keyboard(KEYBOARD_LAUNCH);
        await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${LAUNCHED_ID}`));
        expect(launches()).toHaveLength(1);
    });

    it('with nothing synced, both open the dialog, queue nothing, and Cancel keeps the draft', async () => {
        const user = userEvent.setup();
        const { launches } = openComposer([repo('cloning')]);
        const prompt = (await screen.findByLabelText('What should the agent do?')) as HTMLTextAreaElement;
        await user.type(prompt, 'fix the login crash');
        const start = screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement;
        await waitFor(() => expect(start.disabled).toBe(false));
        await waitFor(() =>
            expect(document.querySelector('.composer .banner-bad')?.textContent).toContain('No repos synced')
        );

        await user.click(start);
        let dialog = await screen.findByRole('dialog', { name: 'No repos synced' });
        expect(dialog.textContent).toContain(
            'Go to the Repositories page to select and sync a repository before running a task.'
        );
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(start));
        expect(prompt.value).toBe('fix the login crash');

        await user.click(prompt);
        await user.keyboard(KEYBOARD_LAUNCH);
        dialog = await screen.findByRole('dialog', { name: 'No repos synced' });
        await user.keyboard('{Escape}');
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() => expect(document.activeElement).toBe(prompt));
        expect(launches()).toHaveLength(0);
    });

    it('Go to Repositories carries the draft there and back', async () => {
        const user = userEvent.setup();
        const { router } = openComposer([]);
        const prompt = await screen.findByLabelText('What should the agent do?');
        await user.type(prompt, 'fix the login crash');
        await user.click(screen.getByRole('button', { name: 'Start task' }));
        const dialog = await screen.findByRole('dialog', { name: 'No repos synced' });
        await user.click(within(dialog).getByRole('button', { name: 'Go to Repositories' }));
        await waitFor(() =>
            expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(
                '/settings/repos?return=/tasks/new'
            )
        );
        await user.click(await screen.findByRole('link', { name: 'Back to new task' }));
        const back = (await screen.findByLabelText('What should the agent do?')) as HTMLTextAreaElement;
        expect(back.value).toBe('fix the login crash');
    });

    it('a chosen repository that is not ready blocks launch even though another is ready', async () => {
        const user = userEvent.setup();
        const { launches } = openComposer([repo('ready'), repo('cloning', 'api')]);
        const prompt = await screen.findByLabelText('What should the agent do?');
        await user.type(prompt, 'fix the login crash');
        await user.click(await screen.findByRole('button', { name: /^Repository: / }));
        await user.click(await screen.findByRole('option', { name: 'acme/api' }));
        await waitFor(() =>
            expect(document.querySelector('.composer .banner-bad')?.textContent).toContain('Repository not synced')
        );
        expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(true);

        await user.click(prompt);
        await user.keyboard(KEYBOARD_LAUNCH);
        expect(launches()).toHaveLength(0);
    });

    it("the board's refusal shows in the composer as an alert and keeps the draft", async () => {
        const user = userEvent.setup();
        const { router, launches } = openComposer([repo('ready')], {
            status: 503,
            body: { error: 'The board is unavailable' },
        });
        const prompt = (await screen.findByLabelText('What should the agent do?')) as HTMLTextAreaElement;
        await user.type(prompt, 'fix the login crash');
        const start = screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement;
        await waitFor(() => expect(start.disabled).toBe(false));
        await user.click(start);

        const composer = document.querySelector<HTMLElement>('.composer')!;
        await waitFor(() => expect(within(composer).getByRole('alert').textContent).toContain('unavailable'));
        expect(launches()).toHaveLength(1);
        expect(prompt.value).toBe('fix the login crash');
        expect(router.state.location.pathname).toBe('/tasks/new');
    });
});
