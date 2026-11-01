import {
    type ReactNode,
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
} from 'react';
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

/** A request in flight for one draft: the key it carries and the draft revision it was built from. */
export interface Submit {
    key: string | null;
    revision: number;
}

/** The draft a submission belongs to: the new-task draft, or one thread's follow-up draft. */
export type SubmitScope = 'task' | `thread:${string}`;
export const TASK_SCOPE: SubmitScope = 'task';
export const threadScope = (root: string): SubmitScope => `thread:${root}`;

/** Everything the shell holds, stamped with the session that saved it. */
export interface ComposerDraftHeld {
    owner: string;
    task: ComposerDraftInput | null;
    /** The new-task composer's files: apart from `task`, which the composer rewrites wholesale. */
    files: FileDraft;
    /** Follow-up drafts by thread root. */
    followUps: Record<string, FollowUpDraft>;
    /** Accepted mutations per draft: a submission clears its draft only if none came after it began. */
    revisions: Partial<Record<SubmitScope, number>>;
    /** The drafts with a request in flight. Every mutation of such a draft is refused until it settles. */
    submits: Partial<Record<SubmitScope, Submit>>;
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
    /** The drafts whose request is in flight; they refuse every mutation, wherever the composer is mounted. */
    submits: Readonly<Partial<Record<SubmitScope, Submit>>>;
    /** Locks the draft for a request built from it as it stands. */
    beginSubmit(scope: SubmitScope, key: string | null): void;
    /** Releases the lock; on success clears the draft that was submitted (and only that draft). */
    finishSubmit(scope: SubmitScope, succeeded: boolean): void;
    /** Counts launched new-task drafts, so a composer mounted meanwhile can drop its stale copy. */
    taskCompletions: number;
}

type DraftAction =
    | { type: 'save'; next: ComposerDraftInput; owner: string }
    | { type: 'clear' }
    | { type: 'taskFiles'; update: (files: FileDraft) => FileDraft; owner: string }
    | { type: 'clearTaskFiles' }
    | { type: 'followUp'; root: string; update: (draft: FollowUpDraft) => FollowUpDraft; owner: string }
    | { type: 'clearFollowUp'; root: string }
    | { type: 'begin'; scope: SubmitScope; key: string | null }
    | { type: 'finish'; scope: SubmitScope; succeeded: boolean };

export function draftOwner(session: Session | null): string | null {
    return session ? `${session.organization.id}:${session.user.id}` : null;
}

const emptyHeld = (owner: string): ComposerDraftHeld => ({
    owner,
    task: null,
    files: EMPTY_FILES,
    followUps: {},
    revisions: {},
    submits: {},
});

/** Nothing held at all is null, so a cleared store reads exactly like a fresh one. */
function settled(held: ComposerDraftHeld): ComposerDraftHeld | null {
    const empty =
        held.task === null &&
        held.files.attachments.length === 0 &&
        Object.keys(held.followUps).length === 0 &&
        Object.keys(held.submits).length === 0;
    return empty ? null : held;
}

const followUpEmpty = (draft: FollowUpDraft) => draft.text === '' && draft.attachments.length === 0;

const bump = (held: ComposerDraftHeld, scope: SubmitScope): ComposerDraftHeld => ({
    ...held,
    revisions: { ...held.revisions, [scope]: (held.revisions[scope] ?? 0) + 1 },
});

function without<T extends object>(record: T, key: string): T {
    const { [key as keyof T]: _dropped, ...rest } = record;
    return rest as T;
}

/** The draft a submission clears when it succeeds. */
function clearScope(held: ComposerDraftHeld, scope: SubmitScope): ComposerDraftHeld {
    if (scope === TASK_SCOPE) return { ...held, task: null, files: EMPTY_FILES };
    return { ...held, followUps: without(held.followUps, scope.slice('thread:'.length)) };
}

/** The attachments of the draft a finished submission would clear: what the provider must revoke. */
export function submittedAttachments(held: ComposerDraftHeld | null, scope: SubmitScope): DraftAttachment[] {
    if (held === null) return [];
    if (scope === TASK_SCOPE) return held.files.attachments;
    return held.followUps[scope.slice('thread:'.length)]?.attachments ?? [];
}

function finish(held: ComposerDraftHeld, scope: SubmitScope, succeeded: boolean): ComposerDraftHeld | null {
    const submit = held.submits[scope];
    if (submit === undefined) return held;
    const released = { ...held, submits: without(held.submits, scope) };
    // The lock refused every mutation since the request began, so the revision matches; the
    // comparison is the guarantee that nothing unsent is ever cleared.
    if (!succeeded || (held.revisions[scope] ?? 0) !== submit.revision) return settled(released);
    return settled({ ...clearScope(released, scope), revisions: without(released.revisions, scope) });
}

/** The draft an action mutates; the lifecycle actions (`begin`, `finish`) mutate none. */
function mutatedScope(action: DraftAction): SubmitScope | null {
    switch (action.type) {
        case 'save':
        case 'clear':
        case 'taskFiles':
        case 'clearTaskFiles':
            return TASK_SCOPE;
        case 'followUp':
        case 'clearFollowUp':
            return threadScope(action.root);
        default:
            return null;
    }
}

export function composerDraftReducer(held: ComposerDraftHeld | null, action: DraftAction): ComposerDraftHeld | null {
    // The one guard: a draft with a request in flight refuses every mutation, whoever asks.
    const target = mutatedScope(action);
    if (target !== null && held?.submits[target] !== undefined) return held;
    // Another owner's draft is never merged into: the next account starts from nothing.
    const base = (owner: string) => (held?.owner === owner ? held : emptyHeld(owner));
    switch (action.type) {
        case 'save':
            return bump({ ...base(action.owner), task: action.next }, TASK_SCOPE);
        case 'clear':
            return held && settled(bump({ ...held, task: null }, TASK_SCOPE));
        case 'taskFiles': {
            const current = base(action.owner);
            return settled(bump({ ...current, files: action.update(current.files) }, TASK_SCOPE));
        }
        case 'clearTaskFiles':
            return held && settled(bump({ ...held, files: EMPTY_FILES }, TASK_SCOPE));
        case 'followUp': {
            const current = base(action.owner);
            const before = current.followUps[action.root] ?? { text: '', ...EMPTY_FILES };
            const after = action.update(before);
            const others = without(current.followUps, action.root);
            const followUps = followUpEmpty(after) ? others : { ...others, [action.root]: after };
            return settled(bump({ ...current, followUps }, threadScope(action.root)));
        }
        case 'clearFollowUp':
            return (
                held &&
                settled(bump({ ...held, followUps: without(held.followUps, action.root) }, threadScope(action.root)))
            );
        case 'begin': {
            if (held === null) return held;
            const submit = { key: action.key, revision: held.revisions[action.scope] ?? 0 };
            return { ...held, submits: { ...held.submits, [action.scope]: submit } };
        }
        case 'finish':
            return held && finish(held, action.scope, action.succeeded);
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
    const [taskCompletions, setTaskCompletions] = useState(0);
    const owner = draftOwner(session);
    // What is held right now, kept in step with every dispatch so a clear revokes the URLs of the
    // draft it drops — once, even when two clears land before the next render.
    const heldRef = useRef(held);
    heldRef.current = held;
    const send = useCallback(
        (action: DraftAction, revoke: (before: ComposerDraftHeld | null) => string[] = () => []) => {
            const before = heldRef.current;
            const after = composerDraftReducer(before, action);
            // A refused mutation changes nothing, and so revokes nothing.
            if (after === before) return;
            for (const url of revoke(before)) URL.revokeObjectURL(url);
            heldRef.current = after;
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
        // `send` revokes only for an action the guard accepted, so a refused clear frees nothing.
        const dropped =
            (urls: (before: ComposerDraftHeld) => DraftAttachment[]) => (before: ComposerDraftHeld | null) =>
                before === null ? [] : urlsOf(urls(before));
        return {
            state: null,
            save: (next) => write((o) => ({ type: 'save', next, owner: o })),
            clear: () => send({ type: 'clear' }),
            files: EMPTY_FILES,
            updateTaskFiles: (update) => write((o) => ({ type: 'taskFiles', update, owner: o })),
            clearTaskFiles: () =>
                send(
                    { type: 'clearTaskFiles' },
                    dropped((before) => before.files.attachments)
                ),
            followUps: {},
            saveFollowUp: (root, draft) => updateFollowUp(root, () => draft),
            updateFollowUp,
            clearFollowUp: (root) =>
                send(
                    { type: 'clearFollowUp', root },
                    dropped((before) => before.followUps[root]?.attachments ?? [])
                ),
            submits: {},
            beginSubmit: (scope, key) => send({ type: 'begin', scope, key }),
            finishSubmit: (scope, succeeded) => {
                send({ type: 'finish', scope, succeeded }, (before) => {
                    const submit = before?.submits[scope];
                    return before && submit && succeeded && (before.revisions[scope] ?? 0) === submit.revision
                        ? urlsOf(submittedAttachments(before, scope))
                        : [];
                });
                if (succeeded && scope === TASK_SCOPE) setTaskCompletions((n) => n + 1);
            },
            taskCompletions: 0,
        };
    }, [owner, send]);
    const owned = ownedDraft(held, owner);
    const value = useMemo<ComposerDraftStore>(
        () => ({
            ...store,
            state: owned?.task ? { ...owned.task, owner: owned.owner } : null,
            files: owned?.files ?? EMPTY_FILES,
            followUps: owned?.followUps ?? NO_FOLLOW_UPS,
            submits: owned?.submits ?? NO_SUBMITS,
            taskCompletions,
        }),
        [store, owned, taskCompletions]
    );
    return <ComposerDraftContext.Provider value={value}>{children}</ComposerDraftContext.Provider>;
}

const NO_FOLLOW_UPS: Readonly<Record<string, FollowUpDraft>> = {};
const NO_SUBMITS: Readonly<Partial<Record<SubmitScope, Submit>>> = {};

export function useComposerDraftStore(): ComposerDraftStore {
    const value = useContext(ComposerDraftContext);
    if (!value) throw new Error('useComposerDraftStore must be used within a ComposerDraftProvider');
    return value;
}
