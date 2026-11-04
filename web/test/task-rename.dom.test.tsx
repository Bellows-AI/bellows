import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { authoredBy, LOCAL_AUTHOR, missingSummaryThread, mockedActivityOf } from '../../e2e/fixtures/threads.js';
import { type FetchCall, type FetchReply, OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';

/**
 * Renaming a task from its header (BEL-252): the dialog sends the revision the page rendered, a stale
 * revision shows the server's current title and stays open, and a terminal thread (whose detail poll
 * has stopped) still updates the header after a local rename because the page refetches.
 */

const THREAD = authoredBy(missingSummaryThread, LOCAL_AUTHOR);
const ID = THREAD[0]!.id;

function board(rename: (call: FetchCall) => FetchReply) {
    let stored: { title: string | null; titleOrigin: 'user' | 'agent' | null; titleRevision: number } = {
        title: null,
        titleOrigin: null,
        titleRevision: 0,
    };
    const calls = stubFetch((call) => {
        if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (call.method === 'PUT' && call.url === `/api/jobs/${ID}/title`) {
            const reply = rename(call);
            const ok = reply as { title?: string; revision?: number };
            if (ok.title !== undefined && ok.revision !== undefined) {
                stored = { title: ok.title, titleOrigin: 'user', titleRevision: ok.revision };
            }
            return reply;
        }
        if (call.url === `/api/jobs/${ID}/thread`) return { jobs: THREAD.map((job) => ({ ...job, ...stored })) };
        if (call.url === `/api/jobs/${ID}/activity`) return mockedActivityOf(THREAD);
    });
    return {
        puts: () => calls.filter((c) => c.method === 'PUT'),
        threadReads: () => calls.filter((c) => c.url === `/api/jobs/${ID}/thread`),
    };
}

const openDialog = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.click(await screen.findByRole('button', { name: 'Rename task' }));
    return within(await screen.findByRole('dialog'));
};

describe('the rename dialog', () => {
    it('sends the title and revision, closes, and the header shows it though the thread is terminal', async () => {
        const user = userEvent.setup();
        const { puts, threadReads } = board(() => ({ title: 'Fix the login crash', origin: 'user', revision: 1 }));
        renderApp(`/tasks/${ID}`);
        const dialog = await openDialog(user);
        const field = dialog.getByLabelText('Task title') as HTMLInputElement;
        expect(field.value).toBe('seed task');
        await user.clear(field);
        await user.type(field, 'Fix the login crash');
        const reads = threadReads().length;
        await user.click(dialog.getByRole('button', { name: 'Save' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(puts()[0]!.body).toEqual({ title: 'Fix the login crash', revision: 0 });
        await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Fix the login crash'));
        expect(threadReads().length).toBeGreaterThan(reads);
    });

    it('keeps the dialog open on a 409, shows the newer title, and retries on its revision', async () => {
        const user = userEvent.setup();
        let attempt = 0;
        const { puts } = board(() => {
            attempt += 1;
            if (attempt === 1) {
                return {
                    status: 409,
                    body: {
                        error: 'The title changed since it was loaded',
                        code: 'TITLE_STALE',
                        title: 'Agent chose this',
                        origin: 'agent',
                        revision: 3,
                    },
                };
            }
            return { title: 'Mine', origin: 'user', revision: 4 };
        });
        renderApp(`/tasks/${ID}`);
        const dialog = await openDialog(user);
        const field = dialog.getByLabelText('Task title') as HTMLInputElement;
        await user.clear(field);
        await user.type(field, 'Mine');
        await user.click(dialog.getByRole('button', { name: 'Save' }));

        expect((await dialog.findByRole('alert')).textContent).toContain('Agent chose this');
        expect(screen.getByRole('dialog')).toBeTruthy();
        await user.click(dialog.getByRole('button', { name: 'Save' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(puts()[1]!.body).toEqual({ title: 'Mine', revision: 3 });
    });

    it('disables Save for a blank title', async () => {
        const user = userEvent.setup();
        board(() => ({ status: 500 }));
        renderApp(`/tasks/${ID}`);
        const dialog = await openDialog(user);
        await user.clear(dialog.getByLabelText('Task title'));
        expect((dialog.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
    });
});
