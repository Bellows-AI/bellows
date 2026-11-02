import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authoredBy, LOCAL_AUTHOR, missingSummaryThread, mockedActivityOf } from '../../e2e/fixtures/threads.js';
import { AttachmentDropZone } from '../src/panels/AttachmentDropZone.js';
import { type FetchCall, OPEN_BOARD_SESSION, renderApp, stubFetch, stubObjectUrls } from './dom.js';

const file = (name: string) => new File(['hello'], name, { type: 'text/plain' });
const withFiles = (files: File[] = []) => ({ dataTransfer: { files, types: ['Files'] } });
const OVERLAY = 'Drop files to attach';

describe('the attachment drop zone', () => {
    const zone = (accepts = true) => {
        const onFiles = vi.fn();
        render(
            <AttachmentDropZone className="x" accepts={() => accepts} onFiles={onFiles}>
                <p>outer</p>
                <button type="button">inner</button>
            </AttachmentDropZone>
        );
        return { onFiles, root: screen.getByText('outer').parentElement! };
    };

    it('shows the overlay while files are dragged over, steady across child elements', () => {
        const { root } = zone();
        const inner = screen.getByText('inner');
        fireEvent.dragEnter(root, withFiles());
        expect(screen.getByText(OVERLAY)).toBeTruthy();
        // Crossing into a child enters it before the zone is left.
        fireEvent.dragEnter(inner, withFiles());
        fireEvent.dragLeave(root, withFiles());
        expect(screen.getByText(OVERLAY)).toBeTruthy();
        fireEvent.dragLeave(inner, withFiles());
        expect(screen.queryByText(OVERLAY)).toBeNull();
    });

    it('takes a drop anywhere inside, cancels the navigation and hides the overlay', () => {
        const { root, onFiles } = zone();
        fireEvent.dragEnter(root, withFiles());
        const dropped = [file('a.txt')];
        const notPrevented = fireEvent.drop(screen.getByText('inner'), withFiles(dropped));
        expect(notPrevented).toBe(false);
        expect(onFiles).toHaveBeenCalledWith(dropped);
        expect(screen.queryByText(OVERLAY)).toBeNull();
    });

    it('ignores drags that carry no files, and zones that accept none', () => {
        const { root, onFiles } = zone();
        fireEvent.dragEnter(root, { dataTransfer: { files: [], types: ['text/plain'] } });
        expect(screen.queryByText(OVERLAY)).toBeNull();
        expect(onFiles).not.toHaveBeenCalled();

        document.body.innerHTML = '';
        const closed = zone(false);
        fireEvent.dragEnter(closed.root, withFiles());
        expect(screen.queryByText(OVERLAY)).toBeNull();
        expect(fireEvent.drop(closed.root, withFiles([file('b.txt')]))).toBe(true);
        expect(closed.onFiles).not.toHaveBeenCalled();
    });
});

describe('dropping on the task page', () => {
    beforeEach(() => {
        stubObjectUrls();
    });

    it('attaches to the follow-up composer from anywhere on the conversation', async () => {
        const thread = authoredBy(missingSummaryThread, LOCAL_AUTHOR);
        stubFetch((call: FetchCall) => {
            if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
            if (call.url === '/api/attachments/limits') {
                return {
                    maxFilesPerRequest: 10,
                    maxFileBytes: 1024,
                    maxRequestBytes: 4096,
                    maxImageSide: 100,
                    maxImagePixels: 10_000,
                    formats: [{ mediaType: 'text/plain', extensions: ['.txt'], kind: 'text' }],
                };
            }
            if (call.method === 'POST' && call.url === '/api/attachments') {
                return {
                    status: 201,
                    body: {
                        id: '00000000-0000-4000-8000-000000000001',
                        name: 'dropped.txt',
                        mediaType: 'text/plain',
                        size: 5,
                        sha256: 'ab',
                        state: 'pending',
                    },
                };
            }
            const match = /\/api\/jobs\/([^/]+)\/(thread|activity)/.exec(call.url);
            if (match) return match[2] === 'thread' ? { jobs: thread } : mockedActivityOf(thread);
        });
        renderApp(`/tasks/${thread[0]!.id}`);
        await screen.findByLabelText('Ask for a follow-up');
        await screen.findByLabelText('Attach files');
        const conversation = document.querySelector('.task-conversation')!;
        fireEvent.dragEnter(conversation, withFiles());
        expect(screen.getByText(OVERLAY)).toBeTruthy();
        fireEvent.drop(conversation, withFiles([file('dropped.txt')]));
        await screen.findByText('dropped.txt');
        await waitFor(() => expect(screen.queryByText(OVERLAY)).toBeNull());
    });
});

describe('the page-level file drop guard', () => {
    beforeEach(() => {
        stubObjectUrls();
    });

    it('cancels a file drop outside every zone without attaching, and leaves other drags alone', async () => {
        stubFetch((call: FetchCall) => {
            if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
            if (call.url === '/api/attachments/limits') {
                return {
                    maxFilesPerRequest: 10,
                    maxFileBytes: 1024,
                    maxRequestBytes: 4096,
                    maxImageSide: 100,
                    maxImagePixels: 10_000,
                    formats: [{ mediaType: 'text/plain', extensions: ['.txt'], kind: 'text' }],
                };
            }
        });
        renderApp('/tasks/new');
        const heading = await screen.findByRole('heading', { name: 'New task' });
        expect(fireEvent.dragOver(heading, withFiles())).toBe(false);
        expect(fireEvent.drop(heading, withFiles([file('stray.txt')]))).toBe(false);
        expect(screen.queryByText('stray.txt')).toBeNull();
        const text = { dataTransfer: { files: [], types: ['text/plain'] } };
        expect(fireEvent.dragOver(heading, text)).toBe(true);
        expect(fireEvent.drop(heading, text)).toBe(true);
    });
});
