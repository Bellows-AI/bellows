import type { KeyboardEvent } from 'react';
import { Icon } from '../components/Icon.js';
import { relativeTime } from '../format.js';
import { SECRET_STATE_LABEL, secretState } from './env-draft.js';
import type { EnvRowChange, EnvRowState, RowFieldErrors } from './env-draft.js';
import type { EnvFocusRefs } from './env-editor-hooks.js';

/**
 * The row rendering of the variables editor (`EnvVarsSection.tsx`) — every piece that only takes
 * props and renders markup. These carry no state of their own and no fetching.
 */

export type EnvRowKind = 'variable' | 'secret';

const CHANGE_LABEL: Record<EnvRowChange, string> = { new: 'New, not saved', changed: 'Changed, not saved' };

/** A read-only row: name, value (a secret's masked, with its state), last update, Edit and Remove. */
function EnvViewRow({
    row,
    kind,
    change,
    locked,
    readOnly,
    onEdit,
    onRemove,
    editRef,
}: {
    row: EnvRowState;
    kind: EnvRowKind;
    change: EnvRowChange | null;
    locked: boolean;
    readOnly: boolean;
    onEdit: () => void;
    onRemove: () => void;
    editRef: (el: HTMLButtonElement | null) => void;
}) {
    const name = row.name.trim() || kind;
    const state = secretState(row);
    return (
        <li className="env-row">
            <span className="env-name mono">
                {change ? (
                    <span className={`env-mark env-mark-${change}`} role="img" aria-label={CHANGE_LABEL[change]} />
                ) : null}
                <span className="env-name-text">{row.name}</span>
            </span>
            {kind === 'secret' ? (
                <span className="env-value env-value-masked">
                    <span className="mono" aria-hidden="true">
                        •••••••
                    </span>
                    <span className={state === 'replace' ? 'env-secret-state pending' : 'env-secret-state'}>
                        {SECRET_STATE_LABEL[state]}
                    </span>
                </span>
            ) : (
                <span className="env-value mono" title={row.value ?? ''}>
                    {row.value ? row.value : <span className="muted">empty</span>}
                </span>
            )}
            <span className="env-updated muted">
                {row.updatedAt ? `Updated ${relativeTime(row.updatedAt)}` : 'Not saved yet'}
            </span>
            <span className="env-row-actions">
                {readOnly ? null : (
                    <>
                        <button
                            type="button"
                            className="env-icon-button"
                            onClick={onEdit}
                            disabled={locked}
                            aria-label={`Edit ${name}`}
                            ref={editRef}
                        >
                            <Icon name="pencil" />
                        </button>
                        <button
                            type="button"
                            className="env-icon-button env-remove"
                            onClick={onRemove}
                            disabled={locked}
                            aria-label={`Remove ${name}`}
                        >
                            <Icon name="trash" />
                        </button>
                    </>
                )}
            </span>
        </li>
    );
}

/** The row open for editing: name and value inputs with their errors, Cancel and Done. */
function EnvEditRow({
    row,
    kind,
    fieldErrors,
    locked,
    onUpdate,
    onCancel,
    onDone,
    refs,
}: {
    row: EnvRowState;
    kind: EnvRowKind;
    fieldErrors: RowFieldErrors;
    locked: boolean;
    onUpdate: (id: string, patch: Partial<EnvRowState>) => void;
    onCancel: () => void;
    onDone: () => void;
    refs: EnvFocusRefs;
}) {
    const nameInvalid = fieldErrors.name.length > 0;
    const valueInvalid = fieldErrors.value.length > 0;
    const nameErrorsId = `${row.id}-name-errors`;
    const valueErrorsId = `${row.id}-value-errors`;
    const label = kind === 'variable' ? 'Variable' : 'Secret';
    const name = row.name.trim() || kind;
    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            onDone();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
        }
    };
    return (
        <li className="env-row env-row-editing">
            <span className="env-field">
                <input
                    className="field mono"
                    aria-label={`${label} name`}
                    placeholder="NAME"
                    value={row.name}
                    disabled={locked}
                    spellCheck={false}
                    autoCapitalize="off"
                    autoComplete="off"
                    aria-invalid={nameInvalid}
                    aria-describedby={nameInvalid ? nameErrorsId : undefined}
                    ref={(el) => {
                        refs.nameRefs.current.set(row.id, el);
                    }}
                    onKeyDown={onKeyDown}
                    onChange={(event) => onUpdate(row.id, { name: event.target.value })}
                />
                {nameInvalid ? (
                    <span id={nameErrorsId} className="env-errors error">
                        {fieldErrors.name.join(' ')}
                    </span>
                ) : null}
            </span>
            <span className="env-field">
                <input
                    className="field mono env-value-input"
                    aria-label={`${label} ${kind === 'variable' ? 'value' : 'new value'}`}
                    type={kind === 'variable' ? 'text' : 'password'}
                    autoComplete="off"
                    spellCheck={false}
                    value={row.value ?? ''}
                    placeholder={
                        kind === 'variable'
                            ? 'Value'
                            : row.isNew
                              ? 'Secret value'
                              : 'Leave blank to keep the current secret'
                    }
                    disabled={locked}
                    aria-invalid={valueInvalid}
                    aria-describedby={valueInvalid ? valueErrorsId : undefined}
                    ref={(el) => {
                        refs.valueRefs.current.set(row.id, el);
                    }}
                    onKeyDown={onKeyDown}
                    onChange={(event) => onUpdate(row.id, { value: event.target.value })}
                />
                {kind === 'secret' && !row.isNew ? (
                    <span className="muted env-hint">A saved secret is never shown again.</span>
                ) : null}
                {valueInvalid ? (
                    <span id={valueErrorsId} className="env-errors error">
                        {fieldErrors.value.join(' ')}
                    </span>
                ) : null}
            </span>
            <span className="env-row-actions">
                <button
                    type="button"
                    className="env-icon-button"
                    onClick={onCancel}
                    disabled={locked}
                    aria-label={`Cancel editing ${name}`}
                >
                    <Icon name="x" />
                </button>
                <button
                    type="button"
                    className="env-icon-button env-done"
                    onClick={onDone}
                    disabled={locked}
                    aria-label={`Done editing ${name}`}
                >
                    <Icon name="check" />
                </button>
            </span>
        </li>
    );
}

/** A pending removal: the row struck through until the save that deletes it, with Undo. */
function EnvRemovedRow({
    row,
    kind,
    locked,
    onUndo,
    undoRef,
}: {
    row: EnvRowState;
    kind: EnvRowKind;
    locked: boolean;
    onUndo: () => void;
    undoRef: (el: HTMLButtonElement | null) => void;
}) {
    return (
        <li className="env-row env-row-removed">
            <span className="env-name mono">
                <span className="env-name-text">{row.name}</span>
            </span>
            <span className="env-value mono">{kind === 'secret' ? '•••••••' : row.value}</span>
            <span className="env-updated">Removed when you save</span>
            <span className="env-row-actions">
                <button type="button" onClick={onUndo} disabled={locked} ref={undoRef}>
                    Undo
                </button>
            </span>
        </li>
    );
}

const NO_FIELD_ERRORS: RowFieldErrors = { name: [], value: [] };

export interface EnvRowListProps {
    rows: readonly EnvRowState[];
    kind: EnvRowKind;
    editingId: string | null;
    /** The editing row's errors, shown only once it is touched; never another row's. */
    editingErrors: RowFieldErrors | null;
    changeOf: (row: EnvRowState) => EnvRowChange | null;
    locked: boolean;
    /** No Edit or Remove on a row: the caller may not write this scope. */
    readOnly?: boolean;
    refs: EnvFocusRefs;
    onUpdate: (id: string, patch: Partial<EnvRowState>) => void;
    onEdit: (row: EnvRowState) => void;
    onRemove: (row: EnvRowState) => void;
    onUndoRemove: (row: EnvRowState) => void;
    onCancelEdit: () => void;
    onDoneEdit: () => void;
}

/** One tab's rows: view, editing or pending removal, in the order given. */
export function EnvRowList(props: EnvRowListProps) {
    const { rows, kind, editingId, locked, refs } = props;
    return (
        <ul className="env-rows">
            {rows.map((row) => {
                if (row.id === editingId) {
                    return (
                        <EnvEditRow
                            key={row.id}
                            row={row}
                            kind={kind}
                            fieldErrors={props.editingErrors ?? NO_FIELD_ERRORS}
                            locked={locked}
                            onUpdate={props.onUpdate}
                            onCancel={props.onCancelEdit}
                            onDone={props.onDoneEdit}
                            refs={refs}
                        />
                    );
                }
                if (row.pendingRemove) {
                    return (
                        <EnvRemovedRow
                            key={row.id}
                            row={row}
                            kind={kind}
                            locked={locked}
                            onUndo={() => props.onUndoRemove(row)}
                            undoRef={(el) => {
                                refs.undoRefs.current.set(row.id, el);
                            }}
                        />
                    );
                }
                return (
                    <EnvViewRow
                        key={row.id}
                        row={row}
                        kind={kind}
                        change={props.changeOf(row)}
                        locked={locked}
                        readOnly={props.readOnly ?? false}
                        onEdit={() => props.onEdit(row)}
                        onRemove={() => props.onRemove(row)}
                        editRef={(el) => {
                            refs.editRefs.current.set(row.id, el);
                        }}
                    />
                );
            })}
        </ul>
    );
}
