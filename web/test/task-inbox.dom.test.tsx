import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TaskListResponse, TaskSummary } from '../src/api/useTasks.js';
import { renderApp, stubFetch } from './dom.js';

/**
 * The inbox toolbar in jsdom: the quiet triggers open their lists, a pick writes the URL at once
 * (no Filter button), the author panel takes any login, and `/` focuses the search.
 */

const stamp = new Date().toISOString();

const summary = (id: string, login: string): TaskSummary => ({
    id,
    command: `task ${id}`,
    title: null,
    titleOrigin: null,
    titleRevision: 0,
    status: 'succeeded',
    cancelRequestedAt: null,
    doneAt: null,
    repo: 'acme/web',
    executor: null,
    author: { id: login, login, name: null, avatarUrl: null },
    activity: null,
    summary: null,
    waitReason: null,
    waitingSince: null,
    waitTerminalReason: null,
    createdAt: stamp,
    activityAt: stamp,
    needsAnswer: false,
});

const tasksAnswer: TaskListResponse = {
    navigation: { counts: { running: 0, review: 2, past: 0 }, running: [], review: [] },
    page: {
        items: [
            summary('11111111-1111-4111-8111-111111111111', 'octocat'),
            summary('22222222-2222-4222-8222-222222222222', 'hubot'),
        ],
        nextCursor: null,
    },
};

const reposAnswer = {
    repos: [{ owner: 'acme', name: 'web', private: false, defaultBranch: 'main', pushedAt: null }],
    installation: null,
    meta: { fetchedAt: null, error: null },
};

function mount(path: string) {
    stubFetch(({ url }) => {
        if (url.startsWith('/api/tasks')) return tasksAnswer;
        if (url === '/api/repos') return reposAnswer;
    });
    const view = renderApp(path);
    const params = () => new URLSearchParams(view.router.state.location.search);
    return { ...view, params };
}

const toolbar = (container: HTMLElement) => within(container.querySelector<HTMLElement>('.inbox-toolbar')!);

describe('the inbox toolbar', () => {
    it('lists the tracked repositories plus a vanished filter, and applies a pick at once', async () => {
        const user = userEvent.setup();
        const { container, params } = mount('/tasks?repo=acme%2Fgone');
        await waitFor(() => expect(container.querySelectorAll('.inbox-row')).toHaveLength(2));
        await user.click(toolbar(container).getByRole('button', { name: /^Repository:/ }));
        await waitFor(() =>
            expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
                'All repositories',
                'acme/web',
                'acme/gone',
            ])
        );
        await user.click(screen.getByRole('option', { name: 'acme/web' }));
        await waitFor(() => expect(params().get('repo')).toBe('acme/web'));
    });

    it('sorts on pick', async () => {
        const user = userEvent.setup();
        const { container, params } = mount('/tasks');
        await waitFor(() => expect(container.querySelectorAll('.inbox-row')).toHaveLength(2));
        await user.click(toolbar(container).getByRole('button', { name: 'Sort: Newest' }));
        await user.click(await screen.findByRole('option', { name: 'Oldest first' }));
        await waitFor(() => expect(params().get('sort')).toBe('oldest'));
    });

    it('offers the loaded authors, and applies any typed login on Enter', async () => {
        const user = userEvent.setup();
        const { container, params } = mount('/tasks');
        await waitFor(() => expect(container.querySelectorAll('.inbox-row')).toHaveLength(2));
        await user.click(toolbar(container).getByRole('button', { name: 'Author: Anyone' }));
        await screen.findByRole('button', { name: 'hubot' });
        await user.click(screen.getByRole('button', { name: 'octocat' }));
        await waitFor(() => expect(params().get('author')).toBe('octocat'));

        await user.click(toolbar(container).getByRole('button', { name: 'Author: octocat' }));
        const field = await screen.findByLabelText('Author login');
        await user.clear(field);
        await user.type(field, 'someone-else{Enter}');
        await waitFor(() => expect(params().get('author')).toBe('someone-else'));
    });

    it('applies the search on Enter, and / focuses it', async () => {
        const user = userEvent.setup();
        const { container, params } = mount('/tasks');
        await waitFor(() => expect(container.querySelectorAll('.inbox-row')).toHaveLength(2));
        const search = toolbar(container).getByLabelText('Search');
        await user.keyboard('/');
        expect(document.activeElement).toBe(search);
        await user.type(search, 'login{Enter}');
        await waitFor(() => expect(params().get('q')).toBe('login'));
    });
});
