import { type ReactNode, createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef } from 'react';
import type { AttachmentMeta, ExecutorScope } from '@factory-ai/core';
import type { Session } from './api/useSession.js';
import type { freshWorkflowDraft } from './task-composer.js';

type WorkflowDraft = ReturnType<typeof freshWorkflowDraft>;

/**
 * The composer's in-progress task, held above the routed page so a trip to Settings and back
 * finds it where the member left it. In memory only: a reload is a fresh start.
 */
export interface ComposerDraftState {
    /** `${organization.id}:${user.id}` of the session that saved it. */
    owner: string;
    draft: string;
    executor: string;
    /** The scope `executor` names (issue 391): a personal and an org profile may share a name. */
    executorScope: ExecutorScope;
    repo: string;
    repoTouched: boolean;
    workflowRepo: string;
    workflow: string;
    storedParams: WorkflowDraft['storedParams'];
    paramTouched: WorkflowDraft['paramTouched'];
}

/** What the composer hands over; the store stamps the owner itself. */
export type ComposerDraftInput = Omit<ComposerDraftState, 'owner'>;

/** One chosen file: its bytes stay in memory, `meta` arrives when the board has accepted it. */
export interface DraftAttachment {
    localId: string;
    file: File;
    /** A thumbnail URL for an image; revoked exactly once, where the attachment or its draft goes. */
    objectUrl: string | null;
    /** The upload's own Idempotency-Key, minted once so a retry of one file cannot store it twice. */
    uploadKey: string;
    status: 'uploading' | 'done' | 'failed';
    meta?: AttachmentMeta;
    error?: string | undefined;
}

/** The files of one draft and the key its next submission carries, kept until it succeeds. */
export interface FileDraft {
    attachments: DraftAttachment[];
    submissionKey: string | null;
}

export interface FollowUpDraft extends FileDraft {
    text: string;
}

export const EMPTY_FILES: FileDraft = { attachments: [], submissionKey: null };

/** Everything the shell holds, stamped with the session that saved it. */
export interface ComposerDraftHeld {
    owner: string;
    task: ComposerDraftInput | null;
    /** The new-task composer's files: apart from `task`, which the composer rewrites wholesale. */
    files: FileDraft;
    /** Follow-up drafts by thread root. */
    followUps: Record<string, FollowUpDraft>;
}

export interface ComposerDraftStore {
    /** The new-task fields, with the owner that saved them. */
    state: ComposerDraftState | null;
    save(next: ComposerDraftInput): void;
    /** Drops the new-task fields only; files and follow-up drafts have their own clears. */
    clear(): void;
    files: FileDraft;
    /** Functional on purpose: an upload settling after a navigation must patch what is held now. */
    updateTaskFiles(update: (files: FileDraft) => FileDraft): void;
    clearTaskFiles(): void;
    followUps: Readonly<Record<string, FollowUpDraft>>;
    saveFollowUp(root: string, draft: FollowUpDraft): void;
    updateFollowUp(root: string, update: (draft: FollowUpDraft) => FollowUpDraft): void;
    clearFollowUp(root: string): void;
}

type DraftAction =
    | { type: 'save'; next: ComposerDraftInput; owner: string }
    | { type: 'clear' }
    | { type: 'taskFiles'; update: (files: FileDraft) => FileDraft; owner: string }
    | { type: 'clearTaskFiles' }
    | { type: 'followUp'; root: string; update: (draft: FollowUpDraft) => FollowUpDraft; owner: string }
    | { type: 'clearFollowUp'; root: string };

export function draftOwner(session: Session | null): string | null {
    return session ? `${session.organization.id}:${session.user.id}` : null;
}

const emptyHeld = (owner: string): ComposerDraftHeld => ({ owner, task: null, files: EMPTY_FILES, followUps: {} });

/** Nothing held at all is null, so a cleared store reads exactly like a fresh one. */
function settled(held: ComposerDraftHeld): ComposerDraftHeld | null {
    const empty = held.task === null && held.files.attachments.length === 0 && Object.keys(held.followUps).length === 0;
    return empty ? null : held;
}

const followUpEmpty = (draft: FollowUpDraft) => draft.text === '' && draft.attachments.length === 0;

export function composerDraftReducer(held: ComposerDraftHeld | null, action: DraftAction): ComposerDraftHeld | null {
    // Another owner's draft is never merged into: the next account starts from nothing.
    const base = (owner: string) => (held?.owner === owner ? held : emptyHeld(owner));
    switch (action.type) {
        case 'save':
            return { ...base(action.owner), task: action.next };
        case 'clear':
            return held === null ? null : settled({ ...held, task: null });
        case 'taskFiles': {
            const current = base(action.owner);
            return settled({ ...current, files: action.update(current.files) });
        }
        case 'clearTaskFiles':
            return held === null ? null : settled({ ...held, files: EMPTY_FILES });
        case 'followUp': {
            const current = base(action.owner);
            const before = current.followUps[action.root] ?? { text: '', ...EMPTY_FILES };
            const after = action.update(before);
            const { [action.root]: _dropped, ...others } = current.followUps;
            return settled({
                ...current,
                followUps: followUpEmpty(after) ? others : { ...others, [action.root]: after },
            });
        }
        case 'clearFollowUp': {
            if (held === null) return null;
            const { [action.root]: _dropped, ...others } = held.followUps;
            return settled({ ...held, followUps: others });
        }
    }
}

/**
 * The held drafts, only for the session that saved them: after a sign-out and a different sign-in,
 * the next account reads null. An org switch needs no check here — `switchOrg` reloads the page
 * (api/org.ts), and the reload drops this in-memory state with everything else.
 */
export function ownedDraft(held: ComposerDraftHeld | null, owner: string | null): ComposerDraftHeld | null {
    return owner !== null && held?.owner === owner ? held : null;
}

const urlsOf = (attachments: readonly DraftAttachment[]): string[] =>
    attachments.flatMap((attachment) => (attachment.objectUrl === null ? [] : [attachment.objectUrl]));

const ComposerDraftContext = createContext<ComposerDraftStore | null>(null);

export function ComposerDraftProvider({ session, children }: { session: Session | null; children: ReactNode }) {
    const [held, dispatch] = useReducer(composerDraftReducer, null);
    const owner = draftOwner(session);
    // What is held right now, kept in step with every dispatch so a clear revokes the URLs of the
    // draft it drops — once, even when two clears land before the next render.
    const heldRef = useRef(held);
    heldRef.current = held;
    const send = useCallback(
        (action: DraftAction, revoke: (before: ComposerDraftHeld | null) => string[] = () => []) => {
            for (const url of revoke(heldRef.current)) URL.revokeObjectURL(url);
            heldRef.current = composerDraftReducer(heldRef.current, action);
            dispatch(action);
        },
        []
    );
    // A different sign-in or a closed shell releases whatever the last owner left behind.
    useEffect(
        () => () => {
            const left = heldRef.current;
            if (left === null) return;
            for (const url of [
                ...urlsOf(left.files.attachments),
                ...Object.values(left.followUps).flatMap((d) => urlsOf(d.attachments)),
            ]) {
                URL.revokeObjectURL(url);
            }
        },
        [owner]
    );
    // Every callback keeps its identity across saves on purpose: a composer that syncs from an
    // effect lists them as dependencies, and one that changed with the state would loop. A write
    // with no session yet has no owner to stamp, and is dropped.
    const store = useMemo<ComposerDraftStore>(() => {
        const write = (build: (owner: string) => DraftAction) => {
            if (owner !== null) send(build(owner));
        };
        const updateFollowUp = (root: string, update: (draft: FollowUpDraft) => FollowUpDraft) =>
            write((o) => ({ type: 'followUp', root, update, owner: o }));
        return {
            state: null,
            save: (next) => write((o) => ({ type: 'save', next, owner: o })),
            clear: () => send({ type: 'clear' }),
            files: EMPTY_FILES,
            updateTaskFiles: (update) => write((o) => ({ type: 'taskFiles', update, owner: o })),
            clearTaskFiles: () => send({ type: 'clearTaskFiles' }, (before) => urlsOf(before?.files.attachments ?? [])),
            followUps: {},
            saveFollowUp: (root, draft) => updateFollowUp(root, () => draft),
            updateFollowUp,
            clearFollowUp: (root) =>
                send({ type: 'clearFollowUp', root }, (before) => urlsOf(before?.followUps[root]?.attachments ?? [])),
        };
    }, [owner, send]);
    const owned = ownedDraft(held, owner);
    const value = useMemo<ComposerDraftStore>(
        () => ({
            ...store,
            state: owned?.task ? { ...owned.task, owner: owned.owner } : null,
            files: owned?.files ?? EMPTY_FILES,
            followUps: owned?.followUps ?? NO_FOLLOW_UPS,
        }),
        [store, owned]
    );
    return <ComposerDraftContext.Provider value={value}>{children}</ComposerDraftContext.Provider>;
}

const NO_FOLLOW_UPS: Readonly<Record<string, FollowUpDraft>> = {};

export function useComposerDraftStore(): ComposerDraftStore {
    const value = useContext(ComposerDraftContext);
    if (!value) throw new Error('useComposerDraftStore must be used within a ComposerDraftProvider');
    return value;
}
