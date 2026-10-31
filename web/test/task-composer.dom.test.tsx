import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspacePayload } from '../src/api/useWorkspace.js';
import { type FetchCall, type FetchReply, OPEN_BOARD_SESSION, renderApp, stubFetch, stubObjectUrls } from './dom.js';

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

const LIMITS = {
    maxFilesPerRequest: 10,
    maxFileBytes: 20 * 1024 * 1024,
    maxRequestBytes: 50 * 1024 * 1024,
    maxImageSide: 16384,
    maxImagePixels: 64_000_000,
    formats: [
        { mediaType: 'image/png', extensions: ['.png'], kind: 'image' },
        { mediaType: 'text/plain', extensions: ['.txt'], kind: 'text' },
    ],
};

const metaFor = (name: string, index: number) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    name,
    mediaType: name.endsWith('.png') ? 'image/png' : 'text/plain',
    size: 1,
    sha256: 'ab',
    state: 'pending',
});

/** The composer over a board that stores attachments; `upload` answers each file (by display name). */
function openWithAttachments(options: {
    upload?: (name: string, attempt: number) => FetchReply;
    launch?: (attempt: number) => FetchReply;
}) {
    const attempts = new Map<string, number>();
    let launches = 0;
    let stored = 0;
    const calls = stubFetch((call: FetchCall) => {
        const { method, url } = call;
        if (url === '/api/workspace') return workspace;
        if (url === '/api/repos') return reposReply(['web']);
        if (url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (url === '/api/attachments/limits') return LIMITS;
        if (method === 'POST' && url === '/api/attachments') {
            const name = decodeURIComponent(call.headers['x-attachment-name'] ?? '');
            const attempt = (attempts.get(name) ?? 0) + 1;
            attempts.set(name, attempt);
            stored += 1;
            return options.upload?.(name, attempt) ?? { status: 201, body: metaFor(name, stored) };
        }
        if (method === 'DELETE' && url.startsWith('/api/attachments/')) return { status: 204 };
        if (method === 'POST' && url === '/api/jobs') {
            launches += 1;
            return options.launch?.(launches) ?? { status: 201, body: { id: LAUNCHED_ID, status: 'queued' } };
        }
    });
    const view = renderApp('/tasks/new');
    return { ...view, calls, launches: () => calls.filter((c) => c.method === 'POST' && c.url === '/api/jobs') };
}

const textFile = (name: string) => new File(['hello'], name, { type: 'text/plain' });
const attachInput = async () => (await screen.findByLabelText('Attach files')) as HTMLInputElement;

describe('the composer attachments', () => {
    let urls: ReturnType<typeof stubObjectUrls>;
    beforeEach(() => {
        urls = stubObjectUrls();
    });

    it('offers a keyboard-reachable picker: a button and a hidden input with a name', async () => {
        openWithAttachments({});
        const input = await attachInput();
        expect(input.type).toBe('file');
        expect(input.hidden).toBe(true);
        expect(input.accept).toBe('.png,.txt');
        expect(screen.getByRole('button', { name: 'Attach files' })).toBeTruthy();
    });

    it('uploads a picked file as a raw body with its percent-encoded name and shows a chip', async () => {
        const user = userEvent.setup();
        const { calls } = openWithAttachments({});
        await user.upload(await attachInput(), textFile('notes & plan.txt'));
        const list = await screen.findByRole('list', { name: 'Attached files' });
        await waitFor(() => expect(within(list).getByText('Ready')).toBeTruthy());
        expect(within(list).getByText('notes & plan.txt')).toBeTruthy();
        const upload = calls.find((c) => c.method === 'POST' && c.url === '/api/attachments')!;
        expect(upload.headers['x-attachment-name']).toBe(encodeURIComponent('notes & plan.txt'));
        expect(upload.headers['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
        expect(upload.body).toBeInstanceOf(File);
    });

    it('adds dropped files, and a pasted image only when the clipboard carries no text', async () => {
        openWithAttachments({});
        await attachInput();
        const prompt = screen.getByLabelText('What should the agent do?');
        fireEvent.drop(prompt, { dataTransfer: { files: [textFile('dropped.txt')], types: ['Files'] } });
        await screen.findByText('dropped.txt');

        const shot = new File(['png'], 'shot.png', { type: 'image/png' });
        fireEvent.paste(prompt, { clipboardData: { files: [shot], getData: () => 'some text' } });
        expect(screen.queryByText('shot.png')).toBeNull();
        fireEvent.paste(prompt, { clipboardData: { files: [shot], getData: () => '' } });
        await screen.findByText('shot.png');
        expect(urls.created).toHaveLength(1);
    });

    it('keeps Start dark while a file uploads or after one failed, until it is removed or retried', async () => {
        const user = userEvent.setup();
        let release: (reply: unknown) => void = () => undefined;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        openWithAttachments({
            upload: (name, attempt) =>
                name === 'slow.txt'
                    ? held
                    : name === 'bad.txt' && attempt === 1
                      ? {
                            status: 415,
                            body: { error: 'That file type is not accepted', code: 'ATTACHMENT_UNSUPPORTED' },
                        }
                      : undefined,
        });
        await user.type(await screen.findByLabelText('What should the agent do?'), 'fix it');
        const start = (await screen.findByRole('button', { name: 'Start task' })) as HTMLButtonElement;
        await waitFor(() => expect(start.disabled).toBe(false));

        await user.upload(await attachInput(), [textFile('slow.txt'), textFile('bad.txt'), textFile('good.txt')]);
        await screen.findByText('Failed: That file type is not accepted');
        expect(screen.getByText('good.txt')).toBeTruthy();
        expect(start.disabled).toBe(true);
        expect(screen.getByText('Wait for the files to finish uploading.')).toBeTruthy();

        release({ status: 201, body: metaFor('slow.txt', 9) });
        await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(2));
        expect(start.disabled).toBe(true);
        expect(screen.getByText('Remove or retry the failed files to continue.')).toBeTruthy();

        await user.click(screen.getByRole('button', { name: 'Retry bad.txt' }));
        await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(3));
        expect(start.disabled).toBe(false);

        await user.click(screen.getByRole('button', { name: 'Remove good.txt' }));
        expect(screen.queryByText('good.txt')).toBeNull();
        expect(start.disabled).toBe(false);
    });

    it('revokes a removed image thumbnail exactly once', async () => {
        const user = userEvent.setup();
        openWithAttachments({});
        await user.upload(await attachInput(), new File(['png'], 'shot.png', { type: 'image/png' }));
        await screen.findByText('Ready');
        await user.click(screen.getByRole('button', { name: 'Remove shot.png' }));
        expect(urls.revoked).toEqual(urls.created);
        expect(urls.revoked).toHaveLength(1);
    });

    it('sends the completed ids, and a refused submission keeps text and files and retries with the same key', async () => {
        const user = userEvent.setup();
        const { launches, router } = openWithAttachments({
            launch: (attempt) =>
                attempt === 1
                    ? { status: 500, body: { error: 'The board hiccuped' } }
                    : { status: 201, body: { id: LAUNCHED_ID, status: 'queued' } },
        });
        const prompt = (await screen.findByLabelText('What should the agent do?')) as HTMLTextAreaElement;
        await user.type(prompt, 'use the files');
        await user.upload(await attachInput(), [textFile('a.txt'), textFile('b.txt')]);
        await waitFor(() => expect(screen.getAllByText('Ready')).toHaveLength(2));
        const start = screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement;

        await user.click(start);
        await screen.findByText('The board hiccuped');
        expect(prompt.value).toBe('use the files');
        expect(screen.getByText('a.txt')).toBeTruthy();

        await user.click(start);
        await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${LAUNCHED_ID}`));
        const [first, second] = launches();
        expect(first!.headers['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
        expect(second!.headers['idempotency-key']).toBe(first!.headers['idempotency-key']);
        expect((first!.body as { attachments: string[] }).attachments).toHaveLength(2);
        expect((second!.body as { attachments: string[] }).attachments).toEqual(
            (first!.body as { attachments: string[] }).attachments
        );
    });

    it('leaves a text-only submission exactly as it was: no attachments, no key', async () => {
        const user = userEvent.setup();
        const { launches, router } = openWithAttachments({});
        await user.type(await screen.findByLabelText('What should the agent do?'), 'just words');
        await user.click(await screen.findByRole('button', { name: 'Start task' }));
        await waitFor(() => expect(router.state.location.pathname).toBe(`/tasks/${LAUNCHED_ID}`));
        const [only] = launches();
        expect(only!.body).not.toHaveProperty('attachments');
        expect(only!.headers['idempotency-key']).toBeUndefined();
    });

    it('survive the Settings detour with the text and their completed ids', async () => {
        const user = userEvent.setup();
        const { router } = openWithAttachments({});
        await user.type(await screen.findByLabelText('What should the agent do?'), 'keep me');
        await user.upload(await attachInput(), textFile('keep.txt'));
        await screen.findByText('Ready');

        await act(() => router.navigate('/settings/repos'));
        await waitFor(() => expect(screen.queryByLabelText('What should the agent do?')).toBeNull());
        await act(() => router.navigate('/tasks/new'));

        expect(((await screen.findByLabelText('What should the agent do?')) as HTMLTextAreaElement).value).toBe(
            'keep me'
        );
        expect(screen.getByText('keep.txt')).toBeTruthy();
        expect(screen.getByText('Ready')).toBeTruthy();
    });
});
