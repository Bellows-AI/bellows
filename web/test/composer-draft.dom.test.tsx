import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { stubObjectUrls } from './dom.js';
import { memberSession } from './fixtures.js';
import {
    type ComposerDraftStore,
    type DraftAttachment,
    ComposerDraftProvider,
    useComposerDraftStore,
} from '../src/composer-draft.js';

/** The provider's side effects: an object URL is revoked exactly once, when its draft goes. */

const withUrl = (name: string): DraftAttachment => ({
    localId: name,
    file: new File(['x'], name),
    objectUrl: `blob:${name}`,
    uploadKey: name,
    status: 'done',
});

function mount() {
    const seen: { store: ComposerDraftStore | null } = { store: null };
    function Probe() {
        seen.store = useComposerDraftStore();
        return null;
    }
    render(
        <ComposerDraftProvider session={memberSession()}>
            <Probe />
        </ComposerDraftProvider>
    );
    return () => seen.store!;
}

let urls: ReturnType<typeof stubObjectUrls>;
beforeEach(() => {
    urls = stubObjectUrls();
});

describe('the draft store revokes object URLs', () => {
    it('for exactly the follow-up draft that is cleared, once', () => {
        const store = mount();
        act(() => store().saveFollowUp('root-a', { text: '', attachments: [withUrl('a.png')], submissionKey: null }));
        act(() => store().saveFollowUp('root-b', { text: '', attachments: [withUrl('b.png')], submissionKey: null }));
        act(() => store().clearFollowUp('root-a'));
        act(() => store().clearFollowUp('root-a'));
        expect(urls.revoked).toEqual(['blob:a.png']);
        expect(store().followUps['root-b']).toBeDefined();
    });

    it('for the new-task files when they are cleared, and not for the fields', () => {
        const store = mount();
        act(() => store().updateTaskFiles(() => ({ attachments: [withUrl('t.png')], submissionKey: 'k' })));
        act(() => store().clear());
        expect(urls.revoked).toEqual([]);
        act(() => store().clearTaskFiles());
        expect(urls.revoked).toEqual(['blob:t.png']);
        expect(store().files.attachments).toEqual([]);
    });

    it('keeps follow-up drafts across a task-draft clear', () => {
        const store = mount();
        act(() => store().saveFollowUp('root-a', { text: 'hi', attachments: [], submissionKey: null }));
        act(() => store().clear());
        expect(store().followUps['root-a']?.text).toBe('hi');
    });
});
