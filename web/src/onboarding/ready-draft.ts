import type { ComposerDraftInput, ComposerDraftState } from '../composer-draft.js';

/**
 * Ready's draft in `sessionStorage`, per member (`draftOwner`: org and user). The shell's draft store
 * is in memory and Ready sits outside the shell, so a Change to another step — or the Repositories
 * reselect round trip, a full page load — would otherwise drop it. Holds the request and the chosen
 * repository, executor, base branch, model and workflow fields; attached files are not kept (the store holds
 * them as in-memory `File`s). Storage that refuses (private mode, quota) keeps nothing, silently.
 */
const keyOf = (owner: string) => `ready-draft:${owner}`;

export function readReadyDraft(owner: string | null): ComposerDraftInput | null {
    if (owner === null) return null;
    try {
        const raw = window.sessionStorage.getItem(keyOf(owner));
        if (raw === null) return null;
        const held = JSON.parse(raw) as Partial<ComposerDraftInput> | null;
        if (typeof held?.draft !== 'string' || typeof held.repo !== 'string') return null;
        // A draft stored before the Model control reads Default.
        return { ...(held as ComposerDraftInput), model: typeof held.model === 'string' ? held.model : '' };
    } catch {
        return null;
    }
}

/** Writes the held draft, or drops it for null. */
export function writeReadyDraft(owner: string | null, held: ComposerDraftState | null): void {
    if (owner === null) return;
    try {
        if (held === null) {
            window.sessionStorage.removeItem(keyOf(owner));
            return;
        }
        const { owner: _owner, ...draft } = held;
        window.sessionStorage.setItem(keyOf(owner), JSON.stringify(draft));
    } catch {
        // Nothing kept: the draft still lives in memory for this page.
    }
}
