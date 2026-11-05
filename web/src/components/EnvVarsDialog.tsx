import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from '@headlessui/react';
import type { EnvSaveResult } from '../api/useEnv.js';
import { countActive, envPayload, hasErrors, rowFieldErrors, scopeError, secretsNote } from '../panels/env-draft.js';
import type { EnvPayloadRow, EnvRowState, RowFieldErrors } from '../panels/env-draft.js';
import { useEnvRows, useEnvSaveState, useEnvTextMode } from '../panels/env-editor-hooks.js';
import { EnvTable } from '../panels/env-vars-panel-parts.js';
import { ConfigurationScope } from './ConfigurationScope.js';
import type { ConfigurationScopeProps } from './ConfigurationScope.js';
import { UNSAVED_CHANGES_LABEL } from './SettingsSaveActions.js';
import { UnsavedChangesDialog, useGuardedDraft } from './UnsavedChangesDialog.js';

export interface EnvVarsDialogProps {
    /** The dialog's accessible name and the discard confirm's subject. */
    title: string;
    /** Which scope this editor writes: its impact, editability and precedence render in the body. */
    scope: ConfigurationScopeProps;
    /** The scope's stored rows, captured once per mount — mount the dialog only while it is open. */
    initialVars: readonly EnvPayloadRow[];
    /** The whole-list PUT, unchanged. The dialog closes through `onClose` when it succeeds. */
    onSave: (vars: EnvPayloadRow[]) => Promise<EnvSaveResult>;
    /** Every way out: a clean close, a confirmed discard, and a successful save. */
    onClose: () => void;
    /** Read-only: the scope is not the caller's to edit. */
    disabled?: boolean;
    /** The scope's stable id in the settings area's unsaved-change guard — set when editable. */
    draftId?: string;
    /** The scope's label in the guard dialog's body sentence. */
    draftLabel?: string;
    /** Dirty mirror for a page that must ask before swapping the editor. */
    onDirtyChange?: (dirty: boolean) => void;
}

/** One kind's heading, its count and its Add button. */
function EnvSectionHead({
    label,
    count,
    addLabel,
    locked,
    onAdd,
    addRef,
}: {
    label: string;
    count: number;
    addLabel: string;
    locked: boolean;
    onAdd: () => void;
    addRef: (el: HTMLButtonElement | null) => void;
}) {
    return (
        <div className="env-dialog-section-head">
            <h3>
                {label} <span className="muted">({count})</span>
            </h3>
            <button type="button" className="env-add" onClick={onAdd} disabled={locked} ref={addRef}>
                {addLabel}
            </button>
        </div>
    );
}

/** The `.env` text mode: the textarea, its live errors and the count of the secrets it omits. */
function EnvTextEditor({
    uid,
    text,
    errors,
    secretCount,
    locked,
    onChange,
    textRef,
}: {
    uid: string;
    text: string;
    errors: readonly string[];
    secretCount: number;
    locked: boolean;
    onChange: (text: string) => void;
    textRef: { current: HTMLTextAreaElement | null };
}) {
    const note = secretsNote(secretCount);
    return (
        <div className="env-raw">
            <textarea
                ref={(el) => {
                    textRef.current = el;
                }}
                className="env-dialog-text"
                aria-label="Variables as .env text"
                aria-invalid={errors.length > 0}
                aria-describedby={errors.length > 0 ? `${uid}-text-errors` : undefined}
                value={text}
                disabled={locked}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                onChange={(event) => onChange(event.target.value)}
            />
            <p className="muted">One NAME=value per line; surrounding quotes are stripped, nothing is escaped.</p>
            {note ? <p className="muted">{note}</p> : null}
            {errors.length > 0 ? (
                <p id={`${uid}-text-errors`} className="status env-errors error" role="alert">
                    {errors.join('\n')}
                </p>
            ) : null}
        </div>
    );
}

/** The list mode: variables then secrets, each its own table with its own Add. */
function EnvListEditor(props: {
    rows: readonly EnvRowState[];
    errors: Map<string, RowFieldErrors>;
    locked: boolean;
    rowsState: ReturnType<typeof useEnvRows>;
}) {
    const { rows, errors, locked, rowsState } = props;
    const table = {
        rows,
        errors,
        locked,
        onUpdate: rowsState.updateRow,
        onRemove: rowsState.removeRow,
        onUndoRemove: rowsState.undoRemove,
        nameRefs: rowsState.nameRefs,
        undoRefs: rowsState.undoRefs,
    };
    return (
        <>
            <section>
                <EnvSectionHead
                    label="Variables"
                    count={countActive(rows, false)}
                    addLabel="Add variable"
                    locked={locked}
                    onAdd={() => rowsState.addRow(false)}
                    addRef={(el) => {
                        rowsState.addRefs.current.variables = el;
                    }}
                />
                <EnvTable kind="variable" {...table} />
            </section>
            <section>
                <EnvSectionHead
                    label="Secrets"
                    count={countActive(rows, true)}
                    addLabel="Add secret"
                    locked={locked}
                    onAdd={() => rowsState.addRow(true)}
                    addRef={(el) => {
                        rowsState.addRefs.current.secrets = el;
                    }}
                />
                <EnvTable kind="secret" {...table} />
            </section>
        </>
    );
}

/**
 * The variables editor as a modal (BEL-262): one draft shared by the list and the `.env` text,
 * no Apply step, nothing persisted until Save. Every close path — Escape, the backdrop, Cancel —
 * goes through one guard: a clean draft closes, a dirty one (a malformed text included) asks via
 * the nested `UnsavedChangesDialog`. Save and Cancel sit in a footer outside the scrolling body,
 * so they stay reachable with any number of rows. Secrets stay write-only rows in the list; the
 * text never carries them. State is per mount: the caller mounts it while it is open, which also
 * clears the text and the draft exactly once on every exit.
 *
 * No `<form>`: the CSP sends `form-action 'none'`.
 */
export function EnvVarsDialog({
    title,
    scope,
    initialVars,
    onSave,
    onClose,
    disabled = false,
    draftId,
    draftLabel,
    onDirtyChange,
}: EnvVarsDialogProps) {
    const uid = useId();
    const saveState = useEnvSaveState();
    const rowsState = useEnvRows(initialVars, saveState.clearConfirmation);
    const textMode = useEnvTextMode({
        rows: rowsState.rows,
        setRows: rowsState.setRows,
        nextId: rowsState.nextId,
        clearConfirmation: saveState.clearConfirmation,
    });
    const textRef = useRef<HTMLTextAreaElement | null>(null);
    const [confirmOpen, setConfirmOpen] = useState(false);

    const errors = useMemo(() => rowFieldErrors(rowsState.rows), [rowsState.rows]);
    const scopeMsg = useMemo(() => scopeError(rowsState.rows), [rowsState.rows]);
    const invalid = hasErrors(errors, scopeMsg);
    const textBroken = textMode.mode === 'env' && textMode.errors.length > 0;
    const dirty = rowsState.dirty || textBroken;
    const locked = disabled || saveState.saving;
    const canSave = !locked && dirty && !invalid && !textBroken;

    useEffect(() => {
        onDirtyChange?.(dirty);
    }, [onDirtyChange, dirty]);

    const { baseline, setRows } = rowsState;
    const discard = useCallback(() => setRows(baseline), [setRows, baseline]);
    const guardedDraft = useMemo(
        () =>
            !disabled && draftId !== undefined && draftLabel !== undefined
                ? { id: draftId, label: draftLabel, dirty, discard }
                : null,
        [disabled, draftId, draftLabel, dirty, discard]
    );
    useGuardedDraft(guardedDraft);

    const requestClose = () => {
        if (saveState.saving) return;
        if (dirty) setConfirmOpen(true);
        else onClose();
    };

    const save = async () => {
        saveState.setSaving(true);
        saveState.setSaveError(null);
        const result = await onSave(envPayload(rowsState.rows));
        if (result.error) {
            saveState.setSaveError(result.error);
            saveState.setSaving(false);
            return;
        }
        onClose();
    };

    const showList = () => {
        if (!textMode.showList()) textRef.current?.focus();
    };

    return (
        <Dialog open onClose={requestClose} className="dialog-layer">
            <DialogBackdrop className="dialog-backdrop" />
            <div className="dialog-position">
                <DialogPanel className="dialog env-dialog">
                    <div className="env-dialog-head">
                        {/* The page's one h1 is the header's; a dialog title is an h2. */}
                        <DialogTitle as="h2">{title}</DialogTitle>
                        <fieldset aria-label="Edit as" className="env-dialog-modes">
                            <button
                                type="button"
                                aria-pressed={textMode.mode === 'list'}
                                aria-disabled={textBroken}
                                onClick={showList}
                            >
                                List
                            </button>
                            <button
                                type="button"
                                aria-pressed={textMode.mode === 'env'}
                                disabled={locked}
                                onClick={textMode.mode === 'env' ? undefined : textMode.showText}
                            >
                                .env
                            </button>
                        </fieldset>
                    </div>

                    <div className="env-dialog-body">
                        <ConfigurationScope {...scope} />
                        {textMode.mode === 'list' ? (
                            <EnvListEditor
                                rows={rowsState.rows}
                                errors={errors}
                                locked={locked}
                                rowsState={rowsState}
                            />
                        ) : (
                            <EnvTextEditor
                                uid={uid}
                                text={textMode.text}
                                errors={textMode.errors}
                                secretCount={countActive(rowsState.rows, true)}
                                locked={locked}
                                onChange={textMode.editText}
                                textRef={textRef}
                            />
                        )}
                    </div>

                    <div className="env-dialog-footer">
                        {scopeMsg ? (
                            <p className="status env-errors error" role="alert">
                                {scopeMsg}
                            </p>
                        ) : null}
                        {saveState.saveError ? (
                            <p
                                ref={saveState.saveErrorRef}
                                tabIndex={-1}
                                className="status env-errors error"
                                role="alert"
                            >
                                {saveState.saveError}
                            </p>
                        ) : null}
                        {invalid && !scopeMsg && textMode.mode === 'list' ? (
                            <p className="env-errors error">Fix the highlighted rows to save.</p>
                        ) : null}
                        <div className="env-dialog-actions">
                            {dirty ? <span className="settings-dirty">{UNSAVED_CHANGES_LABEL}</span> : null}
                            <button type="button" onClick={requestClose} disabled={saveState.saving}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="primary"
                                onClick={() => {
                                    if (canSave) void save();
                                }}
                                disabled={!canSave}
                            >
                                {saveState.saving ? 'Saving changes…' : 'Save changes'}
                            </button>
                        </div>
                    </div>

                    {confirmOpen ? (
                        <UnsavedChangesDialog
                            labels={[draftLabel ?? title]}
                            onClose={() => setConfirmOpen(false)}
                            onConfirm={onClose}
                        />
                    ) : null}
                </DialogPanel>
            </div>
        </Dialog>
    );
}
