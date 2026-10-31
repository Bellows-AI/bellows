import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AttachmentMeta } from '@factory-ai/core';
import { authoredBy, failedGateFollowUpThread, LOCAL_AUTHOR, mockedActivityOf } from '../../e2e/fixtures/threads.js';
import { OPEN_BOARD_SESSION, renderApp, stubFetch } from './dom.js';

/** Each request in the history lists the files it carried: images preview inline, the rest download. */

const IMAGE: AttachmentMeta = {
    id: '00000000-0000-4000-8000-0000000000a1',
    name: 'shot.png',
    mediaType: 'image/png',
    size: 2048,
    sha256: 'aa',
    state: 'bound',
};
const TEXT: AttachmentMeta = {
    id: '00000000-0000-4000-8000-0000000000a2',
    name: 'notes.txt',
    mediaType: 'text/plain',
    size: 5,
    sha256: 'bb',
    state: 'bound',
};
const LATER: AttachmentMeta = { ...TEXT, id: '00000000-0000-4000-8000-0000000000a3', name: 'later.txt' };

const jobs = authoredBy(failedGateFollowUpThread, LOCAL_AUTHOR).map((j, i) => ({
    ...j,
    attachments: i === 0 ? [IMAGE, TEXT] : [LATER],
}));

function open() {
    stubFetch((call) => {
        if (call.url === '/api/auth/me') return OPEN_BOARD_SESSION;
        const thread = /\/api\/jobs\/[^/]+\/(thread|activity)/.exec(call.url);
        if (thread) return thread[1] === 'thread' ? { jobs } : mockedActivityOf(jobs);
    });
    renderApp(`/tasks/${jobs[0]!.id}`);
}

const exchanges = async () => {
    await screen.findByText('shot.png');
    return Array.from(document.querySelectorAll<HTMLElement>('.chat-exchange'));
};

describe('the attachments in the task history', () => {
    it('list each request with its own files', async () => {
        open();
        const [first, second] = await exchanges();
        expect(within(first!).getByText('shot.png')).toBeTruthy();
        expect(within(first!).getByText('notes.txt')).toBeTruthy();
        expect(within(first!).queryByText('later.txt')).toBeNull();
        expect(within(second!).getByText('later.txt')).toBeTruthy();
        expect(within(second!).queryByText('shot.png')).toBeNull();
    });

    it('preview an image from the original and offer a download link for every file', async () => {
        open();
        const [first] = await exchanges();
        const img = first!.querySelector('img')!;
        expect(img.getAttribute('src')).toBe(`/api/attachments/${IMAGE.id}/content?disposition=inline`);
        const text = within(first!).getByRole('link', { name: /Download notes\.txt/ });
        expect(text.getAttribute('href')).toBe(`/api/attachments/${TEXT.id}/content`);
        expect(text.hasAttribute('download')).toBe(true);
        expect(first!.querySelectorAll('img').length).toBe(1);
    });

    it('say a preview is unavailable when the image cannot be read', async () => {
        open();
        const [first] = await exchanges();
        fireEvent.error(first!.querySelector('img')!);
        await waitFor(() => expect(within(first!).getByText('Preview unavailable')).toBeTruthy());
        expect(first!.querySelector('img')).toBeNull();
        expect(within(first!).getByRole('link', { name: /Download shot\.png/ })).toBeTruthy();
    });
});
