import type { MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import { StateNote } from './StateNote.js';
import { EXECUTOR_TYPES, type ExecutorType, type ProviderConnectionMeta } from '@factory-ai/core';
import {
    ADD_LABEL,
    ADVANCED_LABEL,
    AGENT_HELP,
    CLOUD_OAUTH_NOTE,
    CONFIG_JSON_LABEL,
    CONFIG_TESTED_NOTE,
    CREDENTIALS_NOTE,
    EXECUTOR_TYPE_META,
    executorTypeLabel,
    FORMAT_JSON_LABEL,
    GATE_FIX_ROUNDS_HELP,
    MODEL_BLOCKED_NOTE,
    MODEL_CUSTOM_LABEL,
    MODEL_DEFAULT_LABEL,
    MODEL_NOT_TEXT,
    NAME_HELP,
    RUNNER_CLASS_DEFAULT_LABEL,
    RUNNER_CLASS_HELP,
    RUNNER_CLASS_LABEL,
    RUNNER_MANAGED_NOTE,
    runnerClassChoices,
    runnerClassOptionLabel,
    SAVE_LABEL,
} from '../workspace/executors.js';
import { JsonEditor } from './JsonEditor.js';
import { PROVIDER_META } from '../model-setup/providers.js';
import { catalogModels, catalogNote, type ModelCatalog } from '../workspace/model-catalog.js';

/**
 * The executor dialog's fields (issue 261), presentational only: ExecutorDialog.tsx owns the draft
 * and hands each part its value, its error and its callbacks. Every part mints its ids from the
 * dialog's one `useId` prefix, and every error is a described-by paragraph, never a live region.
 */

/** Joins the dialog-scoped ids a control is described by, skipping the absent ones. */
export function describedBy(ids: string, ...parts: (string | null | false)[]): string {
    return parts
        .filter(Boolean)
        .map((part) => `${ids}-${part}`)
        .join(' ');
}

/** A field's own error, below its help. Shared with the guided provider fields' module. */
export function FieldError({ id, error }: { id: string; error: string | null }) {
    return error ? (
        <StateNote state="error" id={id}>
            {error}
        </StateNote>
    ) : null;
}

export function NameField(props: {
    ids: string;
    value: string;
    error: string | null;
    onChange: (value: string) => void;
    onBlur: () => void;
}) {
    const { ids, value, error } = props;
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-name`}>Name</label>
            <input
                id={`${ids}-name`}
                className="field"
                type="text"
                value={value}
                placeholder="Code review"
                aria-invalid={error ? true : undefined}
                aria-describedby={describedBy(ids, 'name-help', error !== null && 'name-error')}
                onChange={(event) => props.onChange(event.target.value)}
                onBlur={props.onBlur}
            />
            <p className="picker-help" id={`${ids}-name-help`}>
                {NAME_HELP}
            </p>
            <FieldError id={`${ids}-name-error`} error={error} />
        </div>
    );
}

export function AgentField({
    ids,
    value,
    onChange,
}: {
    ids: string;
    value: ExecutorType;
    onChange: (value: ExecutorType) => void;
}) {
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-agent`}>Agent</label>
            <select
                id={`${ids}-agent`}
                className="field"
                value={value}
                aria-describedby={describedBy(ids, 'agent-help')}
                onChange={(event) => onChange(event.target.value as ExecutorType)}
            >
                {/* Rendered from the shared list, so a future type needs no JSX change. */}
                {EXECUTOR_TYPES.map((type) => (
                    <option key={type} value={type}>
                        {executorTypeLabel(type)}
                    </option>
                ))}
            </select>
            <p className="picker-help" id={`${ids}-agent-help`}>
                {AGENT_HELP}
            </p>
        </div>
    );
}

/**
 * The runner class (organization profiles only): the deployment's default, or one declared class.
 * Nothing renders without `declared` (a personal profile), nor when there is nothing to choose.
 */
export function RunnerClassField({
    ids,
    value,
    declared,
    onChange,
}: {
    ids: string;
    value: string;
    declared: readonly { name: string; docker: boolean }[] | undefined;
    onChange: (value: string) => void;
}) {
    const choices = declared ? runnerClassChoices(declared, value) : [];
    if (choices.length === 0) return null;
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-runner-class`}>{RUNNER_CLASS_LABEL}</label>
            <select
                id={`${ids}-runner-class`}
                className="field"
                value={value}
                aria-describedby={describedBy(ids, 'runner-class-help')}
                onChange={(event) => onChange(event.target.value)}
            >
                <option value="">{RUNNER_CLASS_DEFAULT_LABEL}</option>
                {choices.map((choice) => (
                    <option key={choice.name} value={choice.name}>
                        {runnerClassOptionLabel(choice)}
                    </option>
                ))}
            </select>
            <p className="picker-help" id={`${ids}-runner-class-help`}>
                {RUNNER_CLASS_HELP}
            </p>
        </div>
    );
}

/**
 * The Model choice: the runner's default, or a custom identifier written into the configuration's
 * `model`. `blocked` is the configuration not parsing (or holding a non-text model) — the control
 * waits, disabled, with the sentence that says where to fix it.
 */
export function ModelField(props: {
    ids: string;
    type: ExecutorType;
    custom: boolean;
    model: string;
    blocked: string | null;
    error: string | null;
    /** The selected connection's catalog; `none` without one, which keeps the control as it was. */
    catalog?: ModelCatalog;
    /** The model dropped because it belongs to another provider: said until the member chooses again. */
    reselect?: string | null;
    onRetryModels?: () => void;
    onDefault: () => void;
    onCustom: () => void;
    onModel: (value: string) => void;
}) {
    const { ids, custom, blocked, error } = props;
    const catalog: ModelCatalog = props.catalog ?? { kind: 'none' };
    const suggestions = catalogModels(catalog);
    const note = catalogNote(catalog);
    const meta = EXECUTOR_TYPE_META[props.type];
    return (
        <fieldset
            className="picker-field picker-model"
            aria-describedby={describedBy(
                ids,
                'model-help',
                blocked !== null && 'model-blocked',
                error !== null && 'model-error'
            )}
        >
            <legend>Model</legend>
            <label className="settings-toggle">
                <input
                    type="radio"
                    name={`${ids}-model`}
                    checked={!custom}
                    disabled={blocked !== null}
                    onChange={props.onDefault}
                />
                {MODEL_DEFAULT_LABEL}
            </label>
            <label className="settings-toggle">
                <input
                    type="radio"
                    name={`${ids}-model`}
                    checked={custom}
                    disabled={blocked !== null}
                    onChange={props.onCustom}
                />
                {MODEL_CUSTOM_LABEL}
            </label>
            {custom ? (
                <input
                    className="field"
                    type="text"
                    aria-label={MODEL_CUSTOM_LABEL}
                    value={props.model}
                    // A blocked control cannot read the model, and an example would pass for it.
                    placeholder={blocked === null ? meta.modelExample : undefined}
                    disabled={blocked !== null}
                    list={suggestions.length > 0 ? `${ids}-model-list` : undefined}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedBy(
                        ids,
                        'model-help',
                        note !== null && 'model-catalog',
                        error !== null && 'model-error'
                    )}
                    onChange={(event) => props.onModel(event.target.value)}
                />
            ) : null}
            {custom ? <ModelSuggestions id={`${ids}-model-list`} models={suggestions} /> : null}
            <p className="picker-help" id={`${ids}-model-help`}>
                {meta.modelHelp} For example: {meta.modelExample}
            </p>
            {blocked ? (
                <p className="picker-help" id={`${ids}-model-blocked`}>
                    {blocked}
                </p>
            ) : null}
            <ModelCatalogNote id={`${ids}-model-catalog`} catalog={catalog} onRetry={props.onRetryModels} />
            <ModelReselectNote id={`${ids}-model-reselect`} model={props.reselect ?? null} />
            <FieldError id={`${ids}-model-error`} error={error} />
        </fieldset>
    );
}

/** The models a catalog offers, as the typed identifier's suggestions; nothing when it offers none. */
function ModelSuggestions({ id, models }: { id: string; models: readonly string[] }) {
    if (models.length === 0) return null;
    return (
        <datalist id={id}>
            {models.map((model) => (
                <option key={model} value={model} />
            ))}
        </datalist>
    );
}

/** Said until the member chooses again: the model dropped because it belongs to another provider. */
function ModelReselectNote({ id, model }: { id: string; model: string | null }) {
    if (!model) return null;
    return (
        <p className="picker-help" id={id}>
            The model “{model}” belongs to another provider, so it was cleared. Choose a model for this connection, or
            use the runner default.
        </p>
    );
}

/** The line under the Model control for a connection's catalog: a failure is an error with its retry, anything else plain help. */
function ModelCatalogNote({
    id,
    catalog,
    onRetry,
}: {
    id: string;
    catalog: ModelCatalog;
    onRetry?: (() => void) | undefined;
}) {
    const note = catalogNote(catalog);
    if (note === null) return null;
    if (catalog.kind !== 'failed') {
        return (
            <p className="picker-help" id={id} role={catalog.kind === 'loading' ? 'status' : undefined}>
                {note}
            </p>
        );
    }
    return (
        <>
            <p className="state-note error" id={id}>
                {note}
            </p>
            {onRetry ? (
                <button type="button" onClick={onRetry}>
                    Retry listing models
                </button>
            ) : null}
        </>
    );
}

/** Why the Model control is disabled, or null while it can edit the configuration. */
export function modelBlockedNote(parsedOk: boolean, unsupported: boolean): string | null {
    if (!parsedOk) return MODEL_BLOCKED_NOTE;
    return unsupported ? `${MODEL_NOT_TEXT}. ${MODEL_BLOCKED_NOTE}` : null;
}

/**
 * Where credentials go instead of the configuration, with the composer's return forwarded; for a
 * Bellows Cloud org not allowed one, also that an OAuth token is refused and an API key is the way.
 */
export function CredentialsNote({
    href,
    onFollow,
    subscriptionRefused = false,
}: {
    href: string;
    onFollow: (event: MouseEvent<HTMLAnchorElement>) => void;
    subscriptionRefused?: boolean;
}) {
    return (
        <>
            <p className="picker-help">
                {CREDENTIALS_NOTE}{' '}
                <Link to={href} onClick={onFollow}>
                    Workspace settings
                </Link>
                .
            </p>
            {subscriptionRefused && <p className="picker-help">{CLOUD_OAUTH_NOTE}</p>}
        </>
    );
}

/** The settings in the configuration the runner will not honor, by key path — never by value. */
function RunnerManaged({ keys }: { keys: readonly string[] }) {
    if (keys.length === 0) return null;
    return (
        <div className="banner-warn picker-managed">
            <p>{RUNNER_MANAGED_NOTE}</p>
            <ul>
                {keys.map((key) => (
                    <li key={key}>
                        <code>{key}</code>
                    </li>
                ))}
            </ul>
        </div>
    );
}

export function AdvancedConfiguration(props: {
    ids: string;
    type: ExecutorType;
    json: string;
    jsonError: string | null;
    managed: readonly string[];
    rounds: string;
    roundsError: string | null;
    onJson: (value: string) => void;
    onFormat: () => void;
    onRounds: (value: string) => void;
}) {
    const { ids, jsonError, roundsError } = props;
    return (
        <details className="picker-advanced">
            <summary>{ADVANCED_LABEL}</summary>

            <div className="picker-field">
                <label htmlFor={`${ids}-config`}>{CONFIG_JSON_LABEL}</label>
                <JsonEditor
                    id={`${ids}-config`}
                    value={props.json}
                    onChange={props.onJson}
                    invalid={jsonError !== null}
                    describedBy={describedBy(ids, 'config-help', jsonError !== null && 'config-error')}
                />
                <p className="picker-help" id={`${ids}-config-help`}>
                    {EXECUTOR_TYPE_META[props.type].configHelp} {CONFIG_TESTED_NOTE}
                </p>
                <FieldError id={`${ids}-config-error`} error={jsonError} />
                <div className="picker-field-actions">
                    <button type="button" onClick={props.onFormat} disabled={jsonError !== null}>
                        {FORMAT_JSON_LABEL}
                    </button>
                </div>
            </div>

            <RunnerManaged keys={props.managed} />

            <div className="picker-field">
                <label htmlFor={`${ids}-rounds`}>Gate repair rounds</label>
                <input
                    id={`${ids}-rounds`}
                    className="field"
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    value={props.rounds}
                    placeholder="3"
                    aria-invalid={roundsError ? true : undefined}
                    aria-describedby={describedBy(ids, 'rounds-help', roundsError !== null && 'rounds-error')}
                    onChange={(event) => props.onRounds(event.target.value)}
                />
                <p className="picker-help" id={`${ids}-rounds-help`}>
                    {GATE_FIX_ROUNDS_HELP}
                </p>
                <FieldError id={`${ids}-rounds-error`} error={roundsError} />
            </div>
        </details>
    );
}

/**
 * A failed save's announcement, then Cancel and the save, with the reason a disabled save is
 * unavailable on the row's leading edge.
 */
export function ExecutorActions(props: {
    ids: string;
    failure: string | null;
    isEdit: boolean;
    saving: boolean;
    unavailable: string | null;
    onCancel: () => void;
    onSave: () => void;
}) {
    const { ids, saving } = props;
    const hint = saving ? null : props.unavailable;
    return (
        <>
            {props.failure ? (
                <p className="status" role="alert">
                    {props.failure}
                </p>
            ) : null}
            {/* type="button" throughout: a submitting form would be blocked by form-action 'none'. */}
            <div className="picker-actions">
                {hint ? (
                    <p className="picker-save-hint" id={`${ids}-save-hint`}>
                        {hint}
                    </p>
                ) : null}
                <button type="button" onClick={props.onCancel} disabled={saving}>
                    Cancel
                </button>
                <button
                    type="button"
                    className="primary"
                    onClick={props.onSave}
                    disabled={saving || hint !== null}
                    aria-describedby={hint ? `${ids}-save-hint` : undefined}
                >
                    {saving ? 'Saving…' : props.isEdit ? SAVE_LABEL : ADD_LABEL}
                </button>
            </div>
        </>
    );
}

/** A connection's line in the select and the notes: its name, its provider and whose it is. */
export function connectionLabel(connection: ProviderConnectionMeta): string {
    return `${connection.name} — ${PROVIDER_META[connection.provider].label} · ${
        connection.scope === 'org' ? 'Organization' : 'Personal'
    }`;
}

export const CONNECTION_FIELD_LABEL = 'Provider connection';
export const CONNECTION_HELP =
    'The key and endpoint this executor’s tasks use for their model. Executors can share a connection, and editing one here only changes which connection it uses.';

/**
 * The Provider connection select. It offers the connections this agent and scope may use (the shared selection rule's
 * answer, not a label match), and says why the others are not offered. This is the SHARED credential — the guided
 * "Connect a provider" setup below writes the executor's own configuration instead, and wins over it.
 */
export function ProviderConnectionField(props: {
    ids: string;
    value: string;
    offered: readonly ProviderConnectionMeta[];
    unavailable: readonly { connection: ProviderConnectionMeta; reason: string }[];
    /** The selected connection when the visible list holds it but this agent or scope cannot run it. */
    selectedRefusal: string | null;
    /** The visible list could not be read: the failure, never an empty list. */
    listError: string | null;
    onRetry: () => void;
    onChange: (id: string) => void;
}) {
    const { ids, value, offered, unavailable } = props;
    const selected = [...offered, ...unavailable.map((row) => row.connection)].find((row) => row.id === value);
    return (
        <div className="picker-field">
            <label htmlFor={`${ids}-connection`}>{CONNECTION_FIELD_LABEL}</label>
            <select
                id={`${ids}-connection`}
                className="field"
                value={value}
                aria-invalid={props.selectedRefusal ? true : undefined}
                aria-describedby={describedBy(
                    ids,
                    'connection-help',
                    props.listError !== null && 'connection-list-error',
                    props.selectedRefusal !== null && 'connection-error'
                )}
                onChange={(event) => props.onChange(event.target.value)}
            >
                <option value="" disabled>
                    Choose a connection
                </option>
                {offered.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                        {connectionLabel(connection)}
                    </option>
                ))}
                {value !== '' && !offered.some((row) => row.id === value) ? (
                    <option value={value}>
                        {selected
                            ? `${connectionLabel(selected)} — cannot be used here`
                            : 'Selected connection (not listed)'}
                    </option>
                ) : null}
            </select>
            <p className="picker-help" id={`${ids}-connection-help`}>
                {CONNECTION_HELP}
            </p>
            {props.listError ? (
                <>
                    {/* Said beside the field and tied to it, not announced: the dialog's own alert is the failed save. */}
                    <p className="state-note error" id={`${ids}-connection-list-error`}>
                        {props.listError}
                    </p>
                    <button type="button" onClick={props.onRetry}>
                        Retry loading connections
                    </button>
                </>
            ) : null}
            <FieldError id={`${ids}-connection-error`} error={props.selectedRefusal} />
            {unavailable.length > 0 ? (
                <ul className="picker-help" aria-label="Connections not offered">
                    {unavailable.map(({ connection, reason }) => (
                        <li key={connection.id}>
                            {connection.name} is not offered: {reason}
                        </li>
                    ))}
                </ul>
            ) : null}
        </div>
    );
}

/**
 * Said beside the select, before Save, when the pasted configuration sets its own credential or endpoint while a
 * connection is selected: the configuration wins at claim. A fixed sentence plus the connection's NAME — never a value
 * from the configuration.
 */
export function ConnectionOverrideNotice({ connection }: { connection: string }) {
    return (
        <div className="banner-warn picker-override" role="note">
            <p>
                This executor’s own configuration sets a credential or endpoint, and it takes precedence over{' '}
                {connection}. Remove it from the configuration to run on the connection’s key and endpoint.
            </p>
        </div>
    );
}
