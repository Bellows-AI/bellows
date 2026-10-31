import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { memberSession } from './fixtures.js';
import {
    type ComposerDraftInput,
    type ComposerDraftStore,
    type DraftAttachment,
    type FollowUpDraft,
    ComposerDraftProvider,
    composerDraftReducer,
    draftOwner,
    ownedDraft,
    useComposerDraftStore,
} from '../src/composer-draft.js';

/**
 * The draft store's contract, pinned through its pure transitions: the web suite renders with
 * `react-dom/server` and runs no effects, so the reducer and the owner check are what carry the
 * behavior, and the provider is proven to publish them.
 */

const sessionFor = (orgId: string, userId: string) =>
    memberSession({
        user: { id: userId, name: null },
        organization: { id: orgId, name: orgId },
        organizations: [{ id: orgId, name: orgId }],
    });

const next: ComposerDraftInput = {
    draft: 'Fix the flaky test',
    executor: 'main',
    executorScope: 'user',
    repo: 'acme/app',
    repoTouched: true,
    workflowRepo: 'acme/app',
    workflow: 'w1',
    storedParams: { workflowId: 'w1', values: { issue: '#12' } },
    paramTouched: { issue: true },
};

const OWNER = 'org-1:user-1';

describe('composer draft store', () => {
    it('derives the owner from the organization and the user', () => {
        expect(draftOwner(sessionFor('org-1', 'user-1'))).toBe(OWNER);
        expect(draftOwner(null)).toBeNull();
    });

    it('stamps the owner on save', () => {
        expect(composerDraftReducer(null, { type: 'save', next, owner: OWNER })).toEqual({
            owner: OWNER,
            task: next,
            files: { attachments: [], submissionKey: null },
            followUps: {},
        });
    });

    it('hands the draft back to its owner', () => {
        const stamped = composerDraftReducer(null, { type: 'save', next, owner: OWNER });
        expect(ownedDraft(stamped, OWNER)).toBe(stamped);
    });

    it('returns null on an owner mismatch', () => {
        const stamped = composerDraftReducer(null, { type: 'save', next, owner: OWNER });
        expect(ownedDraft(stamped, 'org-1:user-2')).toBeNull();
        expect(ownedDraft(stamped, 'org-2:user-1')).toBeNull();
        expect(ownedDraft(stamped, null)).toBeNull();
    });

    it('clears the draft', () => {
        const stamped = composerDraftReducer(null, { type: 'save', next, owner: OWNER });
        expect(composerDraftReducer(stamped, { type: 'clear' })).toBeNull();
    });

    it('publishes an empty store from the provider', () => {
        let seen: ComposerDraftStore | null = null;
        function Probe() {
            seen = useComposerDraftStore();
            return null;
        }
        renderToStaticMarkup(
            <ComposerDraftProvider session={sessionFor('org-1', 'user-1')}>
                <Probe />
            </ComposerDraftProvider>
        );
        expect(seen).not.toBeNull();
        const store = seen as unknown as ComposerDraftStore;
        expect(store.state).toBeNull();
        expect(typeof store.save).toBe('function');
        expect(typeof store.clear).toBe('function');
    });

    it('refuses to be read outside the provider', () => {
        function Probe() {
            useComposerDraftStore();
            return null;
        }
        expect(() => renderToStaticMarkup(<Probe />)).toThrow(/ComposerDraftProvider/);
    });

    describe('attachments and follow-up drafts', () => {
        const file = (name: string, patch: Partial<DraftAttachment> = {}): DraftAttachment => ({
            localId: name,
            file: new File(['x'], name),
            objectUrl: null,
            uploadKey: `key-${name}`,
            status: 'done',
            meta: { id: `id-${name}`, name, mediaType: 'text/plain', size: 1, sha256: 'ab', state: 'pending' },
            ...patch,
        });
        const followUp = (text: string, ...names: string[]): FollowUpDraft => ({
            text,
            attachments: names.map((name) => file(name)),
            submissionKey: `key-${text}`,
        });
        const saveFollowUp = (held: ReturnType<typeof composerDraftReducer>, root: string, draft: FollowUpDraft) =>
            composerDraftReducer(held, { type: 'followUp', root, update: () => draft, owner: OWNER });

        it('keeps the new-task draft attachments beside its fields for the same owner', () => {
            const saved = composerDraftReducer(null, { type: 'save', next, owner: OWNER });
            const held = composerDraftReducer(saved, {
                type: 'taskFiles',
                owner: OWNER,
                update: (files) => ({ attachments: [...files.attachments, file('a.txt')], submissionKey: 'k1' }),
            });
            expect(ownedDraft(held, OWNER)?.task).toEqual(next);
            expect(ownedDraft(held, OWNER)?.files.attachments.map((a) => a.localId)).toEqual(['a.txt']);
            expect(ownedDraft(held, OWNER)?.files.submissionKey).toBe('k1');
        });

        it('keys follow-up drafts per thread root, each holding text, selections, ids and its key', () => {
            const held = saveFollowUp(saveFollowUp(null, 'root-a', followUp('A', 'a.txt')), 'root-b', followUp('B'));
            const owned = ownedDraft(held, OWNER)!;
            expect(owned.followUps['root-a']).toMatchObject({ text: 'A', submissionKey: 'key-A' });
            expect(owned.followUps['root-a']!.attachments[0]).toMatchObject({
                status: 'done',
                meta: { id: 'id-a.txt' },
            });
            expect(owned.followUps['root-b']!.attachments).toEqual([]);
            expect(owned.followUps['root-c']).toBeUndefined();
        });

        it('reads null for both kinds from another account or organization', () => {
            let held = composerDraftReducer(null, { type: 'save', next, owner: OWNER });
            held = saveFollowUp(held, 'root-a', followUp('A', 'a.txt'));
            expect(ownedDraft(held, 'org-1:user-2')).toBeNull();
            expect(ownedDraft(held, 'org-2:user-1')).toBeNull();
        });

        it('starts over for a different owner instead of mixing drafts', () => {
            const held = saveFollowUp(null, 'root-a', followUp('A'));
            const other = composerDraftReducer(held, {
                type: 'followUp',
                root: 'root-b',
                owner: 'org-1:user-2',
                update: () => followUp('B'),
            });
            expect(Object.keys(other!.followUps)).toEqual(['root-b']);
        });

        it('clears one thread without touching the others or the task draft', () => {
            let held = composerDraftReducer(null, { type: 'save', next, owner: OWNER });
            held = saveFollowUp(held, 'root-a', followUp('A'));
            held = saveFollowUp(held, 'root-b', followUp('B'));
            const cleared = composerDraftReducer(held, { type: 'clearFollowUp', root: 'root-a' })!;
            expect(Object.keys(cleared.followUps)).toEqual(['root-b']);
            expect(cleared.task).toEqual(next);
        });

        it('holds no draft for a thread whose draft became empty', () => {
            const held = saveFollowUp(null, 'root-a', { text: '', attachments: [], submissionKey: null });
            expect(held).toBeNull();
        });
    });
});
