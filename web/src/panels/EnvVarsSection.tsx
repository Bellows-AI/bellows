import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { EnvSaveResult } from '../api/useEnv.js';
import { Icon } from '../components/Icon.js';
import { UNSAVED_CHANGES_LABEL } from '../components/SettingsSaveActions.js';
import { useGuardedDraft } from '../components/UnsavedChangesDialog.js';
import {
    countActive,
    envPayload,
    hasErrors,
    isKindDirty,
    rowChange,
    rowFieldErrors,
    scopeError,
    secretsNote,
    seedRows,
} from './env-draft.js';
import type { EnvPayloadRow, EnvRowState, EnvStoredRow } from './env-draft.js';
import { useEnvRows, useEnvSaveState, useEnvTextMode } from './env-editor-hooks.js';
import { EnvRowList } from './env-vars-panel-parts.js';

type EnvTab = 'variables' | 'secrets';
const TABS: readonly EnvTab[] = ['variables', 'secrets'];
const TAB_LABEL: Record<EnvTab, string> = { variables: 'Variables', secrets: 'Secrets' };

export interface EnvVarsSectionProps {
    title: string;
    /** The title is an identifier (a repository's owner/name) and sets in the mono face. */
    monoTitle?: boolean;
    /** The scope's stored rows. A secret's value is null (write-only) and is never rendered. */
    vars: readonly EnvStoredRow[];
    /** The whole-list PUT; its echo becomes the new baseline. */
    onSave: (vars: EnvPayloadRow[]) => Promise<EnvSaveResult>;
    /** The scope's stable id in the settings area's unsaved-change guard. */
    draftId: string;
    /** The scope's label in the guard dialog's body sentence. */
    draftLabel: string;
}

/** Variables | Secrets as the shared `.tabs` strip: count, an unsaved marker, arrow keys move. */
function EnvTabs({
    uid,
    tab,
    counts,
    dirty,
    onSelect,
}: {
    uid: string;
    tab: EnvTab;
    counts: Record<EnvTab, number>;
    dirty: Record<EnvTab, boolean>;
    onSelect: (next: EnvTab) => void;
}) {
    const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const next = TABS[(TABS.indexOf(tab) + 1) % TABS.length]!;
        onSelect(next);
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-tab="${next}"]`)?.focus();
    };
    return (
        <div className="tabs env-tabs" role="tablist" aria-label="Kind">
            {TABS.map((value) => (
                <button
                    key={value}
                    type="button"
                    role="tab"
                    id={`${uid}-tab-${value}`}
                    data-tab={value}
                    aria-selected={value === tab}
                    aria-controls={`${uid}-panel`}
                    tabIndex={value === tab ? 0 : -1}
                    onClick={() => onSelect(value)}
                    onKeyDown={onKeyDown}
                >
                    {TAB_LABEL[value]}
                    <span className="env-tab-count">{counts[value]}</span>
                    {dirty[value] ? (
                        <span className="env-mark env-mark-changed" role="img" aria-label="Unsaved changes" />
                    ) : null}
                </button>
            ))}
        </div>
    );
}

/** The raw mode: the `.env` textarea, its live errors and the count of the secrets it omits. */
function EnvRawEditor({
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
                className="env-raw-text"
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

/** The rows of the selected tab after the name filter; the row being edited always stays. New
 * rows come last so an addition opens where the eye expects it. */
function visibleRows(rows: readonly EnvRowState[], isSecret: boolean, filter: string, editingId: string | null) {
    const needle = filter.trim().toLowerCase();
    return rows
        .filter((row) => row.isSecret === isSecret)
        .filter((row) => !needle || row.id === editingId || row.name.toLowerCase().includes(needle))
        .sort((a, b) => (a.isNew === b.isNew ? a.name.localeCompare(b.name) : a.isNew ? 1 : -1));
}

/** The editor's controller: the draft, the open row, the tab and filter, and every action the
 * head, body and save bar call. Split out of `EnvVarsSection` so the markup stays flat. */
function useEnvEditor({ vars, onSave, draftId, draftLabel }: EnvVarsSectionProps) {
    const saveState = useEnvSaveState();
    const rowsState = useEnvRows(vars, saveState.clearConfirmation);
    const textMode = useEnvTextMode({
        rows: rowsState.rows,
        setRows: rowsState.setRows,
        nextId: rowsState.nextId,
        clearConfirmation: saveState.clearConfirmation,
    });
    const textRef = useRef<HTMLTextAreaElement | null>(null);
    const [tab, setTab] = useState<EnvTab>('variables');
    const [filter, setFilter] = useState('');

    const { rows, baseline, editing, reset } = rowsState;
    const errors = useMemo(() => rowFieldErrors(rows), [rows]);
    const scopeMsg = useMemo(() => scopeError(rows), [rows]);
    const rawMode = textMode.mode === 'env';
    const textBroken = rawMode && textMode.errors.length > 0;
    const dirty = rowsState.dirty || textBroken;

    const resetText = textMode.reset;
    const discard = useCallback(() => {
        reset(baseline);
        resetText();
    }, [reset, resetText, baseline]);
    useGuardedDraft(
        useMemo(() => ({ id: draftId, label: draftLabel, dirty, discard }), [draftId, draftLabel, dirty, discard])
    );

    /** Closes the open row first; false (and its errors shown) when it is not legal yet. */
    const closeEditing = () => rowsState.finishEdit(!editing || !errors.has(editing.id));
    /** Leaves raw mode first; false (focus kept on the text) while the text does not parse. */
    const leaveRaw = () => {
        if (!rawMode || textMode.showList()) return true;
        textRef.current?.focus();
        return false;
    };

    const selectTab = (next: EnvTab) => {
        if (next === tab || !leaveRaw() || !closeEditing()) return;
        setFilter('');
        setTab(next);
    };
    const toggleRaw = () => {
        if (rawMode) leaveRaw();
        else if (closeEditing()) textMode.showText();
    };
    const addRow = () => {
        if (!closeEditing()) return;
        setFilter('');
        rowsState.addRow(tab === 'secrets');
    };
    const editRow = (row: EnvRowState) => {
        if (closeEditing()) rowsState.startEdit(row);
    };
    const save = async () => {
        if (!closeEditing() || hasErrors(errors, scopeMsg) || textBroken) return;
        saveState.setSaving(true);
        saveState.setSaveError(null);
        const result = await onSave(envPayload(rows));
        saveState.setSaving(false);
        if (result.error) {
            saveState.setSaveError(result.error);
            return;
        }
        reset(seedRows(result.vars));
        saveState.setSaved(true);
    };

    return {
        rowsState,
        saveState,
        textMode,
        textRef,
        tab,
        filter,
        setFilter,
        errors,
        scopeMsg,
        rawMode,
        textBroken,
        dirty,
        locked: saveState.saving,
        canSave:
            !saveState.saving && dirty && !textBroken && scopeMsg === null && (errors.size === 0 || editing !== null),
        discard,
        closeEditing,
        selectTab,
        toggleRaw,
        addRow,
        editRow,
        save,
    };
}

type EnvEditor = ReturnType<typeof useEnvEditor>;

/** The box head: the tab's title, the name filter, the raw toggle (variables only) and New. */
function EnvBoxHead({ editor }: { editor: EnvEditor }) {
    const { tab, rawMode, locked } = editor;
    const word = TAB_LABEL[tab].toLowerCase();
    return (
        <div className="env-box-head">
            <h3>{TAB_LABEL[tab]}</h3>
            {rawMode ? null : (
                <label className="search-field env-search">
                    <Icon name="search" />
                    <input
                        type="search"
                        className="field"
                        aria-label={`Filter ${word} by name`}
                        placeholder={`Filter ${word}`}
                        value={editor.filter}
                        onChange={(event) => editor.setFilter(event.target.value)}
                    />
                </label>
            )}
            {tab === 'secrets' ? null : (
                <button
                    type="button"
                    className="env-quiet"
                    aria-pressed={rawMode}
                    aria-disabled={editor.textBroken}
                    disabled={locked}
                    onClick={editor.toggleRaw}
                >
                    <Icon name={rawMode ? 'list' : 'braces'} />
                    {rawMode ? 'List view' : 'Raw editor'}
                </button>
            )}
            {rawMode ? null : (
                <button
                    type="button"
                    className="primary env-new"
                    onClick={editor.addRow}
                    disabled={locked}
                    ref={(el) => {
                        editor.rowsState.refs.addRef.current = el;
                    }}
                >
                    <Icon name="plus" />
                    New {tab === 'secrets' ? 'secret' : 'variable'}
                </button>
            )}
        </div>
    );
}

/** The box body: the raw text, an empty or no-match line, or the tab's rows. */
function EnvBoxBody({ uid, editor }: { uid: string; editor: EnvEditor }) {
    const { rowsState, textMode, tab, filter, errors, locked } = editor;
    const { rows, baseline, editing } = rowsState;
    if (editor.rawMode) {
        return (
            <EnvRawEditor
                uid={uid}
                text={textMode.text}
                errors={textMode.errors}
                secretCount={countActive(rows, true)}
                locked={locked}
                onChange={textMode.editText}
                textRef={editor.textRef}
            />
        );
    }
    const isSecret = tab === 'secrets';
    const shown = visibleRows(rows, isSecret, filter, editing?.id ?? null);
    if (shown.length === 0) {
        const empty = rows.every((row) => row.isSecret !== isSecret);
        const line = empty
            ? isSecret
                ? 'No secrets yet. A saved secret’s value is never shown again.'
                : 'No variables yet.'
            : `No ${tab} match “${filter.trim()}”.`;
        return <p className="env-empty muted">{line}</p>;
    }
    return (
        <EnvRowList
            rows={shown}
            kind={isSecret ? 'secret' : 'variable'}
            editingId={editing?.id ?? null}
            editingErrors={editing?.touched ? (errors.get(editing.id) ?? null) : null}
            changeOf={(row) => rowChange(row, baseline)}
            locked={locked}
            refs={rowsState.refs}
            onUpdate={rowsState.updateRow}
            onEdit={editor.editRow}
            onRemove={rowsState.removeRow}
            onUndoRemove={rowsState.undoRemove}
            onCancelEdit={rowsState.cancelEdit}
            onDoneEdit={editor.closeEditing}
        />
    );
}

/** Shown only while there is something to save (or a save failed): the errors, Discard, Save. */
function EnvSaveBar({ editor }: { editor: EnvEditor }) {
    const { saveState, scopeMsg, locked } = editor;
    if (!editor.dirty && !saveState.saveError) return null;
    return (
        <div className="env-savebar">
            {scopeMsg ? (
                <p className="status env-errors error" role="alert">
                    {scopeMsg}
                </p>
            ) : null}
            {saveState.saveError ? (
                <p ref={saveState.saveErrorRef} tabIndex={-1} className="status env-errors error" role="alert">
                    {saveState.saveError}
                </p>
            ) : null}
            <div className="env-savebar-actions">
                {editor.dirty ? <span className="settings-dirty">{UNSAVED_CHANGES_LABEL}</span> : null}
                <button type="button" onClick={editor.discard} disabled={locked}>
                    Discard
                </button>
                <button type="button" className="primary" onClick={() => void editor.save()} disabled={!editor.canSave}>
                    {saveState.saving ? 'Saving changes…' : 'Save changes'}
                </button>
            </div>
        </div>
    );
}

/**
 * One environment scope on a settings page (BEL-262): the editor itself, inline — no dialog.
 * Variables and Secrets are tabs over ONE draft; rows read as text and open one at a time for
 * editing; the raw `.env` text (variables only) edits the same draft. Nothing is persisted until
 * Save, which sends the whole list; the save bar shows only while there is something to save.
 * The draft rides the settings area's unsaved-change guard, so leaving the page with edits asks.
 * Secrets stay write-only: no value is ever rendered, and the raw text never carries them.
 *
 * No `<form>`: the CSP sends `form-action 'none'`.
 */
export function EnvVarsSection(props: EnvVarsSectionProps) {
    const uid = useId();
    const editor = useEnvEditor(props);
    const { rows, baseline } = editor.rowsState;
    return (
        <section className="env-editor" aria-labelledby={`${uid}-title`}>
            <h2 id={`${uid}-title`} className={props.monoTitle ? 'env-editor-title mono' : 'env-editor-title'}>
                {props.title}
            </h2>
            <EnvTabs
                uid={uid}
                tab={editor.tab}
                counts={{ variables: countActive(rows, false), secrets: countActive(rows, true) }}
                dirty={{ variables: isKindDirty(baseline, rows, false), secrets: isKindDirty(baseline, rows, true) }}
                onSelect={editor.selectTab}
            />
            <div className="env-box" role="tabpanel" id={`${uid}-panel`} aria-labelledby={`${uid}-tab-${editor.tab}`}>
                <EnvBoxHead editor={editor} />
                <EnvBoxBody uid={uid} editor={editor} />
            </div>
            <EnvSaveBar editor={editor} />
            <p className="muted env-saved" role="status">
                {editor.saveState.saved ? 'Changes saved.' : ''}
            </p>
        </section>
    );
}
