import { Icon } from '../components/Icon.js';
import { SECRET_STATE_LABEL, secretState } from './env-draft.js';
import type { EnvRowState, RowFieldErrors } from './env-draft.js';

/**
 * The row and table rendering of the variables dialog (`EnvVarsDialog.tsx`) — every piece that
 * only takes props and renders markup. These carry no state of their own and no fetching.
 */

export type EnvRowKind = 'variable' | 'secret';

/**
 * The rows of one kind (variable or secret), each paired with its 1-based ordinal — assigned
 * only to active rows, so a pending-removed row keeps its position without occupying a number
 * "the N variables" would otherwise count it among.
 */
export function rowsWithOrdinal(
    rows: readonly EnvRowState[],
    kind: EnvRowKind
): { row: EnvRowState; ordinal: number }[] {
    const isSecret = kind === 'secret';
    let ordinal = 0;
    const entries: { row: EnvRowState; ordinal: number }[] = [];
    for (const row of rows) {
        if (row.isSecret !== isSecret) continue;
        if (!row.pendingRemove) ordinal += 1;
        entries.push({ row, ordinal });
    }
    return entries;
}

/** The pending-removal strip: a row's name plus Undo, spanning every column. Split out so the
 * table's map callback stays trivial. */
export function PendingRemoveRow({
    row,
    locked,
    onUndo,
    undoRef,
}: {
    row: EnvRowState;
    locked: boolean;
    onUndo: () => void;
    undoRef: (el: HTMLButtonElement | null) => void;
}) {
    return (
        <tr>
            <td colSpan={3}>
                <div className="env-pending">
                    <span>{row.name.trim() || 'Row'} will be removed when you save.</span>
                    <button type="button" onClick={onUndo} disabled={locked} ref={undoRef}>
                        Undo
                    </button>
                </div>
            </td>
        </tr>
    );
}

/**
 * One editable variable or secret row: name, value (a secret's is masked, defaults to the
 * keep-what-is-stored placeholder, and carries its State line), and Remove. Split out of
 * `EnvTable` so the table's map callback stays under the complexity limit.
 */
export function EnvEditableRow({
    row,
    kind,
    ordinal,
    fieldErrors,
    locked,
    onUpdate,
    onRemove,
    nameRef,
}: {
    row: EnvRowState;
    kind: EnvRowKind;
    ordinal: number;
    fieldErrors: RowFieldErrors;
    locked: boolean;
    onUpdate: (id: string, patch: Partial<EnvRowState>) => void;
    onRemove: () => void;
    nameRef: (el: HTMLInputElement | null) => void;
}) {
    const nameInvalid = fieldErrors.name.length > 0;
    const valueInvalid = fieldErrors.value.length > 0;
    const nameErrorsId = `${row.id}-name-errors`;
    const valueErrorsId = `${row.id}-value-errors`;
    const label = kind === 'variable' ? 'Variable' : 'Secret';
    return (
        <tr>
            <td data-label="Name">
                <input
                    aria-label={`${label} ${ordinal} name`}
                    value={row.name}
                    disabled={locked}
                    aria-invalid={nameInvalid}
                    aria-describedby={nameInvalid ? nameErrorsId : undefined}
                    ref={nameRef}
                    onChange={(event) => onUpdate(row.id, { name: event.target.value })}
                />
                {nameInvalid ? (
                    <p id={nameErrorsId} className="env-errors error">
                        {fieldErrors.name.join(' ')}
                    </p>
                ) : null}
            </td>
            <td data-label={kind === 'variable' ? 'Value' : 'State / new value'}>
                <input
                    aria-label={`${label} ${ordinal} ${kind === 'variable' ? 'value' : 'new value'}`}
                    type={kind === 'variable' ? 'text' : 'password'}
                    autoComplete={kind === 'secret' ? 'off' : undefined}
                    value={row.value ?? ''}
                    placeholder={kind === 'secret' ? 'Leave blank to keep the current secret' : undefined}
                    disabled={locked}
                    aria-invalid={valueInvalid}
                    aria-describedby={valueInvalid ? valueErrorsId : undefined}
                    onChange={(event) => onUpdate(row.id, { value: event.target.value })}
                />
                {kind === 'secret' ? <p className="muted">{SECRET_STATE_LABEL[secretState(row)]}</p> : null}
                {valueInvalid ? (
                    <p id={valueErrorsId} className="env-errors error">
                        {fieldErrors.value.join(' ')}
                    </p>
                ) : null}
            </td>
            <td data-label="Actions">
                <button
                    type="button"
                    className="env-row-remove"
                    onClick={onRemove}
                    disabled={locked}
                    aria-label={`Remove ${row.name.trim() || kind}`}
                >
                    <Icon name="x" />
                </button>
            </td>
        </tr>
    );
}

/**
 * One kind's whole table: the "nothing configured" line while there are no rows of it (pending
 * removals included — their strip is still a row), or the table with one row per entry. Split
 * out of `EnvTable` for the same reason as `EnvEditableRow`.
 */
const NO_FIELD_ERRORS: RowFieldErrors = { name: [], value: [] };

export function EnvTable({
    rows,
    kind,
    errors,
    locked,
    onUpdate,
    onRemove,
    onUndoRemove,
    nameRefs,
    undoRefs,
}: {
    rows: readonly EnvRowState[];
    kind: EnvRowKind;
    errors: Map<string, RowFieldErrors>;
    locked: boolean;
    onUpdate: (id: string, patch: Partial<EnvRowState>) => void;
    onRemove: (row: EnvRowState) => void;
    onUndoRemove: (row: EnvRowState) => void;
    nameRefs: { current: Map<string, HTMLInputElement | null> };
    undoRefs: { current: Map<string, HTMLButtonElement | null> };
}) {
    const entries = rowsWithOrdinal(rows, kind);
    if (entries.length === 0) {
        return <p className="muted">No {kind === 'variable' ? 'variables' : 'secrets'} configured.</p>;
    }
    return (
        <table className="env-vars">
            <thead>
                <tr>
                    <th scope="col">Name</th>
                    <th scope="col">{kind === 'variable' ? 'Value' : 'State / new value'}</th>
                    <th scope="col">Actions</th>
                </tr>
            </thead>
            <tbody>
                {entries.map(({ row, ordinal }) =>
                    row.pendingRemove ? (
                        <PendingRemoveRow
                            key={row.id}
                            row={row}
                            locked={locked}
                            onUndo={() => onUndoRemove(row)}
                            undoRef={(el) => undoRefs.current.set(row.id, el)}
                        />
                    ) : (
                        <EnvEditableRow
                            key={row.id}
                            row={row}
                            kind={kind}
                            ordinal={ordinal}
                            fieldErrors={errors.get(row.id) ?? NO_FIELD_ERRORS}
                            locked={locked}
                            onUpdate={onUpdate}
                            onRemove={() => onRemove(row)}
                            nameRef={(el) => nameRefs.current.set(row.id, el)}
                        />
                    )
                )}
            </tbody>
        </table>
    );
}
