import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { WorkspacePayload } from '../src/api/useWorkspace.js';
import { type FetchReply, OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';

/**
 * The composer's launch triggers over a stubbed board: Start and Ctrl/Cmd+Enter share one gate, and
 * with no tracked repository both stay dark behind the inline banner instead of queueing. The
 * cross-page launch journey stays in e2e/journeys.spec.ts.
 */

const CREATED = '2026-01-01T00:00:00.000Z';
const LAUNCHED_ID = '11111111-1111-4111-8111-111111111111';

const tracked = (name = 'web') => ({
    owner: 'acme',
    name,
    private: true,
    defaultBranch: 'main',
    pushedAt: null,
});

const reposReply = (names: string[], error: string | null = null) => ({
    repos: names.map((name) => tracked(name)),
    installation: null,
    meta: { fetchedAt: CREATED, error },
});

const workspace: WorkspacePayload = {
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
};

function openComposer(
    repos: FetchReply,
    launchReply: FetchReply = { status: 201, body: { id: LAUNCHED_ID, status: 'queued' } }
) {
    let reposAnswer = repos;
    const calls = stubFetch(({ method, url }) => {
        if (url === '/api/workspace') return workspace;
        if (url === '/api/repos') return reposAnswer;
        // The held draft belongs to a session, so /api/auth/me must answer.
        if (url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (method === 'POST' && url === '/api/jobs') return launchReply;
    });
    const view = renderApp('/tasks/new');
    const launches = () => calls.filter((c) => c.method === 'POST' && c.url === '/api/jobs');
    const reads = (path: string) => calls.filter((c) => c.method === 'GET' && c.url === path);
    return {
        ...view,
        launches,
        reads,
        answerRepos: (next: FetchReply) => {
            reposAnswer = next;
        },
    };
}

const KEYBOARD_LAUNCH = '{Control>}{Enter}{/Control}';

describe('the composer launch triggers', () => {
    it('share the button validation on the keyboard: an empty prompt never queues', async () => {
        const user = userEvent.setup();
        const { router, launches } = openComposer(reposReply(['web']));
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

    it('with nothing tracked, Start stays dark behind the inline banner and no shortcut queues', async () => {
        const user = userEvent.setup();
        const { launches } = openComposer(reposReply([]));
        const prompt = (await screen.findByLabelText('What should the agent do?')) as HTMLTextAreaElement;
        await user.type(prompt, 'fix the login crash');
        const start = screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement;
        await waitFor(() =>
            expect(document.querySelector('.composer .banner-bad')?.textContent).toContain('No repositories tracked')
        );
        expect(start.disabled).toBe(true);
        expect(screen.queryByRole('dialog')).toBeNull();

        await user.click(prompt);
        await user.keyboard(KEYBOARD_LAUNCH);
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(launches()).toHaveLength(0);
        expect(prompt.value).toBe('fix the login crash');
    });

    it('the banner link carries the draft to Repositories and back', async () => {
        const user = userEvent.setup();
        const { router } = openComposer(reposReply([]));
        const prompt = await screen.findByLabelText('What should the agent do?');
        await user.type(prompt, 'fix the login crash');
        await user.click(await screen.findByRole('link', { name: 'Go to Repositories' }));
        await waitFor(() =>
            expect(`${router.state.location.pathname}${router.state.location.search}`).toBe(
                '/settings/repos?return=/tasks/new'
            )
        );
        await user.click(await screen.findByRole('link', { name: 'Back to new task' }));
        const back = (await screen.findByLabelText('What should the agent do?')) as HTMLTextAreaElement;
        expect(back.value).toBe('fix the login crash');
    });

    it('any tracked repository launches, with the chosen one on the request', async () => {
        const user = userEvent.setup();
        const { launches, router } = openComposer(reposReply(['web', 'api']));
        const prompt = await screen.findByLabelText('What should the agent do?');
        await user.type(prompt, 'fix the login crash');
        await user.click(await screen.findByRole('button', { name: /^Repository: / }));
        await user.click(await screen.findByRole('option', { name: 'acme/api' }));
        expect(document.querySelector('.composer .banner-bad')).toBeNull();
        const start = screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement;
        await waitFor(() => expect(start.disabled).toBe(false));
        await user.click(start);
        await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${LAUNCHED_ID}`));
        expect(launches()).toHaveLength(1);
        expect((launches()[0]!.body as { repo: string }).repo).toBe('acme/api');
    });

    it('a failed repositories read is not "no repositories tracked", and Retry re-reads only /api/repos', async () => {
        const user = userEvent.setup();
        const { reads, answerRepos } = openComposer({ status: 503, body: { error: 'Repositories are unavailable' } });
        expect(await screen.findByText(/Repositories are unavailable/)).toBeTruthy();
        expect(screen.queryByText('No repositories tracked')).toBeNull();
        expect(screen.queryByLabelText('What should the agent do?')).toBeNull();

        answerRepos(reposReply(['web']));
        await user.click(screen.getByRole('button', { name: 'Retry' }));
        expect(await screen.findByLabelText('What should the agent do?')).toBeTruthy();
        expect(reads('/api/repos')).toHaveLength(2);
        expect(reads('/api/workspace')).toHaveLength(1);
    });

    it('an empty list carrying meta.error is an unreadable list, not a confirmed empty one', async () => {
        const { reads } = openComposer(reposReply([], 'GitHub is unreachable'));
        expect(await screen.findByText(/GitHub is unreachable/)).toBeTruthy();
        expect(screen.queryByText('No repositories tracked')).toBeNull();
        expect(reads('/api/repos')).toHaveLength(1);
    });

    it("the board's refusal shows in the composer as an alert and keeps the draft", async () => {
        const user = userEvent.setup();
        const { router, launches } = openComposer(reposReply(['web']), {
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
