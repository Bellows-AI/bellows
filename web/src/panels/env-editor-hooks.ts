import { useEffect, useMemo, useRef, useState } from 'react';
import { applyRawText, isDirty, rowsToRawText, seedRows } from './env-draft.js';
import type { EnvPayloadRow, EnvRowState } from './env-draft.js';

/**
 * The editor's stateful hooks, shared by the inline `EnvVarsPanel` and the modal
 * `EnvVarsDialog`: the rows (baseline, draft, add/update/remove/undo and the focus routing they
 * trigger) and the save-confirmation state. Moved out of the panel unchanged.
 */

/** Focus routing after add/remove/undo: a request recorded during the state update, resolved
 * once the rows (and their inputs) exist. Split out so the effect that runs it stays a one-liner. */
function resolvePendingFocus(
    request: { id: string; kind: 'name' | 'undo' | 'add' } | null,
    refs: {
        addRefs: { current: { variables: HTMLButtonElement | null; secrets: HTMLButtonElement | null } };
        nameRefs: { current: Map<string, HTMLInputElement | null> };
        undoRefs: { current: Map<string, HTMLButtonElement | null> };
    }
): void {
    if (!request) return;
    if (request.kind === 'add') {
        refs.addRefs.current[request.id as 'variables' | 'secrets']?.focus();
    } else if (request.kind === 'name') {
        refs.nameRefs.current.get(request.id)?.focus();
    } else {
        refs.undoRefs.current.get(request.id)?.focus();
    }
}

/**
 * The scope's rows: the baseline and the local draft, add/update/remove/undo, and the focus
 * routing they trigger. Split out of `EnvVarsPanel` so its own state and effect do not add to
 * the panel's line count.
 */
export function useEnvRows(initialVars: readonly EnvPayloadRow[], clearConfirmation: () => void) {
    // The seed is captured once per mount — initialVars may arrive as a new array on every parent
    // render (an after-save refetch), and adopting one would silently wipe a typing hand's draft.
    const [baseline, setBaseline] = useState<EnvRowState[]>(() => seedRows(initialVars));
    const [rows, setRows] = useState<EnvRowState[]>(() => seedRows(initialVars));
    const nextIdCounter = useRef(0);
    const nextId = () => {
        nextIdCounter.current += 1;
        return `r${nextIdCounter.current}`;
    };

    const pendingFocus = useRef<{ id: string; kind: 'name' | 'undo' | 'add' } | null>(null);
    const nameRefs = useRef(new Map<string, HTMLInputElement | null>());
    const undoRefs = useRef(new Map<string, HTMLButtonElement | null>());
    const addRefs = useRef<{ variables: HTMLButtonElement | null; secrets: HTMLButtonElement | null }>({
        variables: null,
        secrets: null,
    });

    useEffect(() => {
        const request = pendingFocus.current;
        pendingFocus.current = null;
        resolvePendingFocus(request, { addRefs, nameRefs, undoRefs });
    }, [rows]);

    const updateRow = (id: string, patch: Partial<EnvRowState>) => {
        clearConfirmation();
        setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    };

    const addRow = (isSecret: boolean) => {
        clearConfirmation();
        const id = nextId();
        setRows((current) => [...current, { id, name: '', value: '', isSecret, isNew: true, pendingRemove: false }]);
        pendingFocus.current = { id, kind: 'name' };
    };

    const removeRow = (row: EnvRowState) => {
        clearConfirmation();
        if (row.isNew && row.name.trim() === '' && (row.value === '' || row.value === null)) {
            // An untouched blank addition never made it into the draft's meaning: it may vanish
            // without ceremony, and focus returns to the Add button that created it.
            setRows((current) => current.filter((candidate) => candidate.id !== row.id));
            pendingFocus.current = { id: row.isSecret ? 'secrets' : 'variables', kind: 'add' };
            return;
        }
        setRows((current) =>
            current.map((candidate) => (candidate.id === row.id ? { ...candidate, pendingRemove: true } : candidate))
        );
        pendingFocus.current = { id: row.id, kind: 'undo' };
    };

    const undoRemove = (row: EnvRowState) => {
        clearConfirmation();
        setRows((current) =>
            current.map((candidate) => (candidate.id === row.id ? { ...candidate, pendingRemove: false } : candidate))
        );
        pendingFocus.current = { id: row.id, kind: 'name' };
    };

    const dirty = useMemo(() => isDirty(baseline, rows), [baseline, rows]);

    return {
        baseline,
        setBaseline,
        rows,
        setRows,
        nextId,
        nameRefs,
        undoRefs,
        addRefs,
        dirty,
        updateRow,
        addRow,
        removeRow,
        undoRemove,
    };
}

/** The save-confirmation state: status text, the error and its focus, and clearing both on any
 * further edit. Split out of `EnvVarsPanel` for the same reason as `useEnvRows`. */
export function useEnvSaveState() {
    const [saving, setSaving] = useState(false);
    const [statusText, setStatusText] = useState('');
    const [saveError, setSaveError] = useState<string | null>(null);
    const saveErrorRef = useRef<HTMLParagraphElement | null>(null);

    useEffect(() => {
        if (saveError) saveErrorRef.current?.focus();
    }, [saveError]);

    const clearConfirmation = () => {
        setStatusText('');
        setSaveError(null);
    };

    return { saving, setSaving, statusText, setStatusText, saveError, setSaveError, saveErrorRef, clearConfirmation };
}

export type EnvEditMode = 'list' | 'env';

/**
 * The modal's list/`.env` mode over the ONE shared draft (BEL-262): the rows stay the truth.
 * Entering text mode serializes them; every edit of the text re-reads it live — valid text
 * replaces the variable rows at once (no Apply step), malformed text only records its
 * line-numbered errors and leaves the rows as they were, so a bad edit can never overwrite a
 * value. Leaving text mode is refused while the text is malformed.
 */
export function useEnvTextMode(input: {
    rows: EnvRowState[];
    setRows: (rows: EnvRowState[]) => void;
    nextId: () => string;
    clearConfirmation: () => void;
}) {
    const { rows, setRows, nextId, clearConfirmation } = input;
    const [mode, setMode] = useState<EnvEditMode>('list');
    const [text, setText] = useState('');
    const [errors, setErrors] = useState<string[]>([]);

    const showText = () => {
        setText(rowsToRawText(rows));
        setErrors([]);
        setMode('env');
    };

    /** False when the switch is refused because the text does not parse. */
    const showList = () => {
        if (errors.length > 0) return false;
        setMode('list');
        return true;
    };

    const editText = (next: string) => {
        clearConfirmation();
        setText(next);
        const result = applyRawText(next, rows, nextId);
        if (result.ok) {
            setRows(result.rows);
            setErrors([]);
        } else {
            setErrors(result.errors);
        }
    };

    return { mode, text, errors, showText, showList, editText };
}
