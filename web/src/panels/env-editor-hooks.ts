import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyRawText, isDirty, rowsToRawText, seedRows } from './env-draft.js';
import type { EnvRowState, EnvStoredRow } from './env-draft.js';

/**
 * The variables editor's stateful hooks (`EnvVarsSection`): the rows (baseline, draft,
 * add/edit/remove/undo and the focus routing they trigger), the save-error state and the
 * list/raw mode.
 */

type FocusTarget = 'name' | 'value' | 'edit' | 'undo' | 'add';

/** The focusable controls per row, plus the one New button, resolved after a state change. */
export interface EnvFocusRefs {
    nameRefs: { current: Map<string, HTMLInputElement | null> };
    valueRefs: { current: Map<string, HTMLInputElement | null> };
    editRefs: { current: Map<string, HTMLButtonElement | null> };
    undoRefs: { current: Map<string, HTMLButtonElement | null> };
    addRef: { current: HTMLButtonElement | null };
}

function resolvePendingFocus(request: { id: string; target: FocusTarget } | null, refs: EnvFocusRefs): void {
    if (!request) return;
    const byTarget = {
        name: refs.nameRefs,
        value: refs.valueRefs,
        edit: refs.editRefs,
        undo: refs.undoRefs,
    } as const;
    if (request.target === 'add') refs.addRef.current?.focus();
    else byTarget[request.target].current.get(request.id)?.focus();
}

/** The row open for editing: its id, the row as it was when editing began (Cancel restores it),
 * and whether its errors may show yet — a fresh row is not scolded before it is touched. */
export interface EnvEditing {
    id: string;
    snapshot: EnvRowState;
    touched: boolean;
}

/**
 * The scope's rows: the baseline and the local draft, the one row open for editing, add / edit /
 * remove / undo, and the focus routing they trigger. Edits write the draft live; Cancel puts the
 * row back as it was, and cancelling a row the draft just added drops it.
 */
export function useEnvRows(initialVars: readonly EnvStoredRow[], clearConfirmation: () => void) {
    // The seed is captured once per mount — initialVars may arrive as a new array on every parent
    // render (an after-save refetch), and adopting one would silently wipe a typing hand's draft.
    const [baseline, setBaseline] = useState<EnvRowState[]>(() => seedRows(initialVars));
    const [rows, setRows] = useState<EnvRowState[]>(() => seedRows(initialVars));
    const [editing, setEditing] = useState<EnvEditing | null>(null);
    const nextIdCounter = useRef(0);
    const nextId = () => {
        nextIdCounter.current += 1;
        return `r${nextIdCounter.current}`;
    };

    const pendingFocus = useRef<{ id: string; target: FocusTarget } | null>(null);
    const refs: EnvFocusRefs = {
        nameRefs: useRef(new Map<string, HTMLInputElement | null>()),
        valueRefs: useRef(new Map<string, HTMLInputElement | null>()),
        editRefs: useRef(new Map<string, HTMLButtonElement | null>()),
        undoRefs: useRef(new Map<string, HTMLButtonElement | null>()),
        addRef: useRef<HTMLButtonElement | null>(null),
    };
    const focus = (id: string, target: FocusTarget) => {
        pendingFocus.current = { id, target };
    };

    useEffect(() => {
        const request = pendingFocus.current;
        pendingFocus.current = null;
        resolvePendingFocus(request, refs);
    }, [rows, editing]);

    const updateRow = (id: string, patch: Partial<EnvRowState>) => {
        clearConfirmation();
        setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
        setEditing((current) => (current?.id === id ? { ...current, touched: true } : current));
    };

    const startEdit = (row: EnvRowState) => {
        setEditing({ id: row.id, snapshot: row, touched: false });
        focus(row.id, 'value');
    };

    const addRow = (isSecret: boolean) => {
        clearConfirmation();
        const row: EnvRowState = {
            id: nextId(),
            name: '',
            value: '',
            isSecret,
            isNew: true,
            pendingRemove: false,
            updatedAt: null,
        };
        setRows((current) => [...current, row]);
        setEditing({ id: row.id, snapshot: row, touched: false });
        focus(row.id, 'name');
    };

    /** Done: closes the edit when the row is legal; otherwise its errors show and focus stays. */
    const finishEdit = (rowIsValid: boolean): boolean => {
        if (!editing) return true;
        if (!rowIsValid) {
            setEditing({ ...editing, touched: true });
            focus(editing.id, 'name');
            return false;
        }
        setEditing(null);
        focus(editing.id, 'edit');
        return true;
    };

    const cancelEdit = () => {
        if (!editing) return;
        const { snapshot } = editing;
        clearConfirmation();
        setEditing(null);
        if (snapshot.isNew && snapshot.name === '' && (snapshot.value ?? '') === '') {
            setRows((current) => current.filter((row) => row.id !== snapshot.id));
            focus(snapshot.id, 'add');
            return;
        }
        setRows((current) => current.map((row) => (row.id === snapshot.id ? snapshot : row)));
        focus(snapshot.id, 'edit');
    };

    const removeRow = (row: EnvRowState) => {
        clearConfirmation();
        if (row.isNew && row.name.trim() === '' && (row.value ?? '') === '') {
            // An untouched blank addition never made it into the draft's meaning: it vanishes
            // without an Undo, and focus returns to the New button.
            setRows((current) => current.filter((candidate) => candidate.id !== row.id));
            focus(row.id, 'add');
            return;
        }
        setRows((current) =>
            current.map((candidate) => (candidate.id === row.id ? { ...candidate, pendingRemove: true } : candidate))
        );
        focus(row.id, 'undo');
    };

    const undoRemove = (row: EnvRowState) => {
        clearConfirmation();
        setRows((current) =>
            current.map((candidate) => (candidate.id === row.id ? { ...candidate, pendingRemove: false } : candidate))
        );
        focus(row.id, 'edit');
    };

    /** Adopts the stored rows — a successful save's echo, or Discard's baseline. */
    const reset = useCallback((next: EnvRowState[]) => {
        setBaseline(next);
        setRows(next);
        setEditing(null);
    }, []);

    const dirty = useMemo(() => isDirty(baseline, rows), [baseline, rows]);

    return {
        baseline,
        rows,
        setRows,
        editing,
        nextId,
        refs,
        dirty,
        updateRow,
        startEdit,
        addRow,
        finishEdit,
        cancelEdit,
        removeRow,
        undoRemove,
        reset,
    };
}

/** The save state: in flight, the error and its focus, the "saved" confirmation, and clearing
 * both on any further edit. */
export function useEnvSaveState() {
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const saveErrorRef = useRef<HTMLParagraphElement | null>(null);

    useEffect(() => {
        if (saveError) saveErrorRef.current?.focus();
    }, [saveError]);

    const clearConfirmation = () => {
        setSaveError(null);
        setSaved(false);
    };

    return { saving, setSaving, saved, setSaved, saveError, setSaveError, saveErrorRef, clearConfirmation };
}

export type EnvEditMode = 'list' | 'env';

/**
 * The list/raw mode over the ONE shared draft: the rows stay the truth.
 * Entering raw mode serializes them; every edit of the text re-reads it live — valid text
 * replaces the variable rows at once (no Apply step), malformed text only records its
 * line-numbered errors and leaves the rows as they were, so a bad edit can never overwrite a
 * value. Leaving raw mode is refused while the text is malformed.
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

    /** Back to the list with no text and no errors — Discard's half of a reset. */
    const reset = useCallback(() => {
        setMode('list');
        setText('');
        setErrors([]);
    }, []);

    return { mode, text, errors, showText, showList, editText, reset };
}
