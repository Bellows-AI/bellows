import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
    authoredBy,
    LOCAL_AUTHOR,
    missingSummaryThread,
    mockedActivityOf,
    publishedThread,
    type ThreadJob,
} from '../../e2e/fixtures/threads.js';
import { type FetchCall, OPEN_BOARD_SESSION, renderApp, stubFetch, stubObjectUrls } from './dom.js';

/**
 * A thread's follow-up draft lives in the shell's draft store, not in the composer: the text, the
 * chosen files, their completed ids and the submission key come back after a trip away and back,
 * and belong to that thread alone.
 */

const A = authoredBy(missingSummaryThread, LOCAL_AUTHOR);
const B = authoredBy(publishedThread, LOCAL_AUTHOR);
const SENT_ID = 'cccccccc-0000-4000-8000-000000000001';

const LIMITS = {
    maxFilesPerRequest: 10,
    maxFileBytes: 1024,
    maxRequestBytes: 4096,
    maxImageSide: 100,
    maxImagePixels: 10_000,
    formats: [{ mediaType: 'text/plain', extensions: ['.txt'], kind: 'text' }],
};

function board(options: { followUp?: (attempt: number) => unknown } = {}) {
    const threads = new Map<string, readonly ThreadJob[]>([...A, ...B].map((j) => [j.id, j.id === A[0]!.id ? A : B]));
    let uploads = 0;
    let followUps = 0;
    const calls = stubFetch((call: FetchCall) => {
        if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
        if (call.url === '/api/attachments/limits') return LIMITS;
        if (call.method === 'POST' && call.url === '/api/attachments') {
            uploads += 1;
            return {
                status: 201,
                body: {
                    id: `00000000-0000-4000-8000-00000000000${uploads}`,
                    name: decodeURIComponent(call.headers['x-attachment-name'] ?? ''),
                    mediaType: 'text/plain',
                    size: 5,
                    sha256: 'ab',
                    state: 'pending',
                },
            };
        }
        if (call.method === 'POST' && /\/follow-up$/.test(call.url)) {
            followUps += 1;
            return options.followUp?.(followUps) ?? { status: 201, body: { id: SENT_ID } };
        }
        const thread = /\/api\/jobs\/([^/]+)\/(thread|activity)/.exec(call.url);
        if (thread) {
            const jobs = threads.get(thread[1]!);
            if (jobs) return thread[2] === 'thread' ? { jobs } : mockedActivityOf(jobs);
        }
    });
    return { calls, sent: () => calls.filter((c) => c.method === 'POST' && /\/follow-up$/.test(c.url)) };
}

const file = (name: string) => new File(['hello'], name, { type: 'text/plain' });
const box = async () => (await screen.findByLabelText('Ask for a follow-up')) as HTMLTextAreaElement;

describe('the follow-up composer drafts', () => {
    beforeEach(() => {
        stubObjectUrls();
    });

    it('come back after the composer unmounts and remounts, and belong to their thread', async () => {
        const user = userEvent.setup();
        board();
        const { router } = renderApp(`/tasks/${A[0]!.id}`);
        await user.type(await box(), 'one more pass');
        await user.upload((await screen.findByLabelText('Attach files')) as HTMLInputElement, file('spec.txt'));
        await screen.findByText('Ready');

        await act(() => router.navigate('/settings/repos'));
        await waitFor(() => expect(screen.queryByLabelText('Ask for a follow-up')).toBeNull());
        await act(() => router.navigate(`/tasks/${A[0]!.id}`));

        const restored = await box();
        expect(restored.value).toBe('one more pass');
        expect(screen.getByText('spec.txt')).toBeTruthy();
        expect(screen.getByText('Ready')).toBeTruthy();

        await act(() => router.navigate(`/tasks/${B[0]!.id}`));
        await waitFor(async () => expect((await box()).value).toBe(''));
        expect(screen.queryByText('spec.txt')).toBeNull();
    });

    it('send the text and the ids, retry a refusal with the same key, and clear on success', async () => {
        const user = userEvent.setup();
        const { sent } = board({
            followUp: (attempt) =>
                attempt === 1 ? { status: 403, body: { error: 'Not allowed right now' } } : undefined,
        });
        renderApp(`/tasks/${A[0]!.id}`);
        const text = await box();
        await user.type(text, 'with a file');
        await user.upload((await screen.findByLabelText('Attach files')) as HTMLInputElement, file('spec.txt'));
        await screen.findByText('Ready');
        const send = screen.getByRole('button', { name: 'Send follow-up' });

        await user.click(send);
        await screen.findByText('Not allowed right now');
        expect(text.value).toBe('with a file');
        expect(screen.getByText('spec.txt')).toBeTruthy();

        await user.click(send);
        await waitFor(() => expect(text.value).toBe(''));
        expect(screen.queryByText('spec.txt')).toBeNull();
        const [first, second] = sent();
        expect(first!.body).toEqual({ command: 'with a file', attachments: ['00000000-0000-4000-8000-000000000001'] });
        expect(second!.body).toEqual(first!.body);
        expect(first!.headers['idempotency-key']).toMatch(/^[0-9a-f]{32}$/);
        expect(second!.headers['idempotency-key']).toBe(first!.headers['idempotency-key']);
    });

    it('keep a text-only follow-up as it was: only the command', async () => {
        const user = userEvent.setup();
        const { sent } = board();
        renderApp(`/tasks/${A[0]!.id}`);
        await user.type(await box(), 'just words');
        await user.click(screen.getByRole('button', { name: 'Send follow-up' }));
        await waitFor(() => expect(sent()).toHaveLength(1));
        expect(sent()[0]!.body).toEqual({ command: 'just words' });
        expect(sent()[0]!.headers['idempotency-key']).toBeUndefined();
    });

    it('freezes while the follow-up is in flight: a late drop is not accepted', async () => {
        const user = userEvent.setup();
        let release: (reply: unknown) => void = () => undefined;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        board({ followUp: () => held });
        renderApp(`/tasks/${A[0]!.id}`);
        const text = await box();
        await user.type(text, 'go');
        await screen.findByLabelText('Attach files');
        await user.click(screen.getByRole('button', { name: 'Send follow-up' }));
        await waitFor(() => expect(text.readOnly).toBe(true));
        fireEvent.drop(text, { dataTransfer: { files: [file('late.txt')], types: ['Files'] } });
        expect(screen.queryByText('late.txt')).toBeNull();
        release({ status: 201, body: { id: SENT_ID } });
        await waitFor(() => expect(text.value).toBe(''));
    });

    it('stays locked after a trip away and back, and success clears exactly that thread draft', async () => {
        const user = userEvent.setup();
        let release: (reply: unknown) => void = () => undefined;
        const held = new Promise((resolve) => {
            release = resolve;
        });
        const { sent } = board({ followUp: () => held });
        const { router } = renderApp(`/tasks/${A[0]!.id}`);
        await user.type(await box(), 'go');
        await user.upload((await screen.findByLabelText('Attach files')) as HTMLInputElement, file('spec.txt'));
        await screen.findByText('Ready');
        await user.click(screen.getByRole('button', { name: 'Send follow-up' }));
        await waitFor(() => expect(sent()).toHaveLength(1));

        await act(() => router.navigate('/settings/repos'));
        await waitFor(() => expect(screen.queryByLabelText('Ask for a follow-up')).toBeNull());
        await act(() => router.navigate(`/tasks/${A[0]!.id}`));
        const back = await box();
        expect(back.value).toBe('go');
        expect(back.readOnly).toBe(true);
        fireEvent.drop(back, { dataTransfer: { files: [file('late.txt')], types: ['Files'] } });
        expect(screen.queryByText('late.txt')).toBeNull();
        expect((screen.getByRole('button', { name: 'Remove spec.txt' }) as HTMLButtonElement).disabled).toBe(true);

        release({ status: 201, body: { id: SENT_ID } });
        await waitFor(() => expect(back.value).toBe(''));
        expect(screen.queryByText('spec.txt')).toBeNull();
    });

    it('releases the lock on a refusal and keeps the draft and its key', async () => {
        const user = userEvent.setup();
        const { sent } = board({
            followUp: (n) => (n === 1 ? { status: 403, body: { error: 'Not now' } } : undefined),
        });
        renderApp(`/tasks/${A[0]!.id}`);
        const text = await box();
        await user.type(text, 'go');
        await user.upload((await screen.findByLabelText('Attach files')) as HTMLInputElement, file('spec.txt'));
        await screen.findByText('Ready');
        await user.click(screen.getByRole('button', { name: 'Send follow-up' }));
        await screen.findByText('Not now');
        expect(text.readOnly).toBe(false);
        expect(text.value).toBe('go');
        await user.click(screen.getByRole('button', { name: 'Send follow-up' }));
        await waitFor(() => expect(sent()).toHaveLength(2));
        expect(sent()[1]!.headers['idempotency-key']).toBe(sent()[0]!.headers['idempotency-key']);
    });
});
