import { useEffect, useId, useState } from 'react';
import type { MouseEvent } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import { useNavigate } from 'react-router-dom';
import {
    ADD_LABEL,
    executorEditorView,
    executorSavedMessage,
    formatConfig,
    INHERITED_NOTE,
    initialExecutorDraft,
    parseExecutorConfig,
    readModel,
    withModel,
    type ExecutorDraft,
    type ExecutorRow,
    type ValidExecutor,
} from '../workspace/executors.js';
import {
    EXECUTOR_PROVIDER_META,
    GUIDED_COPY,
    guidedFromConfig,
    guidedProvidersFor,
} from '../workspace/executor-guided.js';
import { type ExecutorProvider, type ExecutorScope, USER_SCOPE } from '@factory-ai/core';
import { useDraftReturnHref } from './DraftReturnBanner.js';
import {
    AdvancedConfiguration,
    AgentField,
    ConnectionOverrideNotice,
    CredentialsNote,
    ExecutorActions,
    ModelField,
    modelBlockedNote,
    NameField,
    ProviderConnectionField,
    RunnerClassField,
} from './executor-dialog-parts.js';
import { GuidedProviderFields } from './executor-guided-fields.js';
import { type ConnectionStep, useConnectionStep } from './executor-connection-step.js';
import { useGuidedStep } from './executor-guided-step.js';
import { ProviderCards } from '../model-setup/ProviderCards.js';
import type { RunnerClassOption } from '../api/useWorkspace.js';
import { UnsavedChangesDialog } from './UnsavedChangesDialog.js';

/**
 * Add an executor, or edit an existing one (issue 261: guided first, JSON under Advanced).
 *
 * The Headless-UI bargain: the `Dialog` buys the top layer, focus trapping, focus restoration,
 * the backdrop and Escape without a hand-rolled trap; no `<form>` submits because CSP sends
 * `form-action 'none'`.
 *
 * The body reads Name, Agent, Model, then a collapsed Advanced configuration (the fields live in
 * executor-dialog-parts.tsx). A name and an agent save the inherited configuration, `{}`. The
 * guided Model control and the Advanced JSON edit ONE configuration text per agent
 * (`ExecutorDraft.configs`): the control writes `model` into that text with every other key kept,
 * and while the text does not parse the control is disabled with a sentence saying so — a guided
 * value never overwrites a raw draft. Switching agents switches which text is live; the other
 * agent's draft waits untouched.
 *
 * Every field's error sits beside the field, tied with `aria-describedby`, and none is a live
 * region — nothing is announced per keystroke. A disabled Save says why beside it. A failed save
 * keeps the dialog and every field and announces the failure; a successful one reports through
 * `onSaved` (the page's status region) and closes, and Headless restores focus to the trigger.
 *
 * Closing with unsaved work — Cancel, Escape, the backdrop, or the credentials link — raises the
 * settings area's discard confirmation, rendered INSIDE this panel: Headless nests a dialog only
 * when the child is in the parent's React tree, and a sibling would fight this panel's focus trap.
 *
 * The dialog validates the draft and hands the SAVE to its owner: `onSave` receives the one
 * validated row and the name it is editing (null to add), and the page decides the write — the
 * personal page folds it into the whole-list PUT (`mergeExecutors`), the organization page PUTs
 * the one row (issue 391). The list still comes in for the name-collision checks and the edit's
 * pre-fill.
 */

export interface ExecutorDialogProps {
    open: boolean;
    /** The whole executor list as the dialog opened it, configs included. */
    existing: readonly ExecutorRow[];
    /** The name of the row being edited, matched as it was when the dialog opened; null to add. */
    editing: string | null;
    onClose: () => void;
    /** The validated draft, and whether it edits (the row's original name) or adds (null). */
    onSave: (next: ValidExecutor, editing: string | null) => Promise<string | null>;
    /** Told the success sentence just before the dialog closes. */
    onSaved: (message: string) => void;
    saving: boolean;
    /**
     * The board's declared runner classes, given for an organization profile only: a personal
     * profile runs in the default class, so its dialog renders no class select. An org dialog with
     * nothing to offer — no declared class, and none on the row — renders none either.
     */
    runnerClasses?: readonly RunnerClassOption[];
    /** Bellows Cloud: the credentials note adds that an OAuth token is refused. */
    cloud?: boolean;
    /**
     * Whose profile this is: an organization profile may select an organization connection only, a personal one its
     * own or the organization's. Defaults to personal.
     */
    executorScope?: ExecutorScope;
}

/** What to do once the reader answers Discard changes. */
type PendingDiscard = { proceed: () => void };

export function ExecutorDialog({
    open,
    existing,
    editing,
    onClose,
    onSave,
    onSaved,
    saving,
    runnerClasses,
    cloud = false,
    executorScope = USER_SCOPE,
}: ExecutorDialogProps) {
    const [baseline, setBaseline] = useState<ExecutorDraft>(() => initialExecutorDraft(undefined));
    const [draft, setDraft] = useState<ExecutorDraft>(baseline);
    const [nameTouched, setNameTouched] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [pendingDiscard, setPendingDiscard] = useState<PendingDiscard | null>(null);
    const navigate = useNavigate();
    const envHref = useDraftReturnHref('/settings/workspace');
    // One instance-scoped prefix for every id this dialog hands out: a literal id would be the same
    // label/help/error relationship twice once a second dialog exists.
    const ids = useId();

    // Add opens blank; edit opens pre-filled from the row it is editing. Re-keyed off `editing`
    // too, so switching rows without closing still lands on the right one.
    useEffect(() => {
        if (open) {
            const row = editing === null ? undefined : existing.find((executor) => executor.name === editing);
            const initial = initialExecutorDraft(row);
            setBaseline(initial);
            setDraft(initial);
            setNameTouched(false);
            setFailure(null);
            setPendingDiscard(null);
        }
        // `existing` is deliberately not a dependency: it is captured at open time and stays put
        // while the dialog is up, and re-seeding the fields mid-edit would discard typing.
    }, [open, editing]);

    const isEdit = editing !== null;
    const { type } = draft;
    const step = useConnectionStep({ open, draft, setDraft, scope: executorScope });
    const view = executorEditorView({ draft, baseline, existing, editing, nameTouched, connections: step.choices });
    const { guided, check, suggestions, setGuided, pickProvider, removeGuided } = useGuidedStep(draft, setDraft, cloud);

    const setConfig = (text: string, customModel: boolean) =>
        setDraft((current) => ({
            ...current,
            configs: { ...current.configs, [current.type]: text },
            customModel: { ...current.customModel, [current.type]: customModel },
        }));

    // Guided writes re-serialize the parsed object: every other key survives, in its order.
    const writeModel = (next: string | null, customModel: boolean) => {
        if (guided === null && view.parsed.ok) {
            setConfig(JSON.stringify(withModel(view.parsed.value, next), null, 2), customModel);
        }
    };

    // A raw edit that parses re-reads the guided choice from it: the same generated shape keeps the
    // fields live, anything else hands the configuration back to the raw editor.
    const editJson = (text: string) => {
        const next = parseExecutorConfig(text);
        setDraft((current) => ({
            ...current,
            configs: { ...current.configs, [current.type]: text },
            customModel: {
                ...current.customModel,
                [current.type]: next.ok ? readModel(next.value).kind === 'custom' : current.customModel[current.type],
            },
            guided: {
                ...current.guided,
                [current.type]: next.ok ? guidedFromConfig(current.type, next.value) : null,
            },
        }));
    };

    const format = () => {
        const formatted = formatConfig(draft.configs[type]);
        if (formatted !== null) setConfig(formatted, view.custom);
    };

    const requestClose = (proceed: () => void = onClose) => {
        if (saving) return;
        if (view.changes.anyChanged) setPendingDiscard({ proceed });
        else proceed();
    };

    // The credentials link leaves the dialog like any other close: never mid-save, and asking first.
    const followEnvLink = (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        requestClose(() => navigate(envHref));
    };

    const save = async () => {
        if (!view.validation.ok) {
            setFailure(view.validation.error);
            return;
        }
        const message = await onSave(view.validation.value, editing);
        setFailure(message);
        if (!message) {
            onSaved(executorSavedMessage(view.validation.value.name, isEdit));
            onClose();
        }
    };

    return (
        <Dialog open={open} onClose={() => requestClose()} className="dialog-layer" aria-labelledby={`${ids}-title`}>
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="dialog picker">
                    <DialogTitle as="h2" id={`${ids}-title`}>
                        {isEdit ? 'Edit executor' : ADD_LABEL}
                    </DialogTitle>
                    <p className="muted">{INHERITED_NOTE}</p>

                    <DialogFields
                        ids={ids}
                        draft={draft}
                        view={view}
                        guidedStep={{ guided, check, suggestions, setGuided, pickProvider, removeGuided }}
                        isEdit={isEdit}
                        runnerClasses={runnerClasses}
                        envHref={envHref}
                        cloud={cloud}
                        failure={failure}
                        saving={saving}
                        onName={(name) => setDraft({ ...draft, name })}
                        onNameBlur={() => setNameTouched(true)}
                        onAgent={step.pickAgent}
                        connection={step.connection}
                        onModelDefault={() => {
                            step.clearReselect();
                            writeModel(null, false);
                        }}
                        onModelCustom={() => setConfig(draft.configs[type], true)}
                        onModel={(value) => {
                            step.clearReselect();
                            writeModel(value.trim() || null, true);
                        }}
                        onRunnerClass={(runnerClass) => setDraft({ ...draft, runnerClass })}
                        onJson={editJson}
                        onFormat={format}
                        onRounds={(gateFixRounds) => setDraft({ ...draft, gateFixRounds })}
                        onCancel={() => requestClose()}
                        onSave={() => void save()}
                        onFollowEnvLink={followEnvLink}
                    />

                    {pendingDiscard ? (
                        <UnsavedChangesDialog
                            labels={['this executor']}
                            onClose={() => setPendingDiscard(null)}
                            onConfirm={() => {
                                setPendingDiscard(null);
                                pendingDiscard.proceed();
                            }}
                        />
                    ) : null}
                </DialogPanel>
            </div>
        </Dialog>
    );
}

/** The dialog's fields, presentational: the state owner above hands each part its value, its
 * error and its callback, exactly as executor-dialog-parts does one field at a time. */
function DialogFields(props: {
    ids: string;
    draft: ExecutorDraft;
    view: ReturnType<typeof executorEditorView>;
    guidedStep: ReturnType<typeof useGuidedStep>;
    isEdit: boolean;
    runnerClasses?: readonly RunnerClassOption[] | undefined;
    envHref: string;
    cloud: boolean;
    failure: string | null;
    saving: boolean;
    onName: (name: string) => void;
    onNameBlur: () => void;
    onAgent: (type: ExecutorDraft['type']) => void;
    connection: ConnectionStep;
    onModelDefault: () => void;
    onModelCustom: () => void;
    onModel: (value: string) => void;
    onRunnerClass: (value: string) => void;
    onJson: (value: string) => void;
    onFormat: () => void;
    onRounds: (value: string) => void;
    onCancel: () => void;
    onSave: () => void;
    onFollowEnvLink: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
    const { ids, draft, view, guidedStep, isEdit } = props;
    const guided = guidedStep.guided;
    const { type } = draft;
    return (
        <>
            <NameField
                ids={ids}
                value={draft.name}
                error={view.nameError}
                onChange={props.onName}
                onBlur={props.onNameBlur}
            />
            <AgentField ids={ids} value={type} onChange={props.onAgent} />
            <ProviderConnectionField
                ids={ids}
                value={draft.providerConnectionId}
                offered={props.connection.offered}
                unavailable={props.connection.unavailable}
                selectedRefusal={
                    view.validation.ok === false && view.validation.field === 'connection'
                        ? view.validation.error
                        : null
                }
                listError={props.connection.listError}
                onRetry={props.connection.onRetry}
                onChange={props.connection.onChange}
            />
            {view.overridesConnection ? (
                <ConnectionOverrideNotice connection={props.connection.name ?? 'the selected connection'} />
            ) : null}
            {guided === null ? (
                <details className="picker-advanced">
                    <summary>{GUIDED_COPY.PROVIDER_STEP_LABEL}</summary>
                    <ProviderCards
                        ids={ids}
                        choices={guidedProvidersFor(type).map((id) => ({ id, ...EXECUTOR_PROVIDER_META[id] }))}
                        value=""
                        onChange={guidedStep.pickProvider}
                    />
                    <p className="picker-help">
                        Pick a provider to give this executor its own key, endpoint and model — the same guided setup
                        Connect a model runs. The configuration below is replaced by what you pick; without a provider
                        the key connected in Settings → Model runs the task.
                    </p>
                </details>
            ) : (
                <GuidedProviderFields
                    ids={ids}
                    agent={type}
                    choice={guided}
                    suggestions={guidedStep.suggestions}
                    check={guidedStep.check}
                    error={view.guidedError}
                    onProvider={(provider: ExecutorProvider) =>
                        guidedStep.setGuided({ provider, key: { kind: 'none' }, baseUrl: '', model: '' })
                    }
                    onKey={(value: string) => guidedStep.setGuided({ key: { kind: 'key', value } })}
                    onKeySource={(reference: boolean) =>
                        guidedStep.setGuided({ key: reference ? { kind: 'reference', name: '' } : { kind: 'none' } })
                    }
                    onReference={(name: string) => guidedStep.setGuided({ key: { kind: 'reference', name } })}
                    onBaseUrl={(baseUrl: string) => guidedStep.setGuided({ baseUrl })}
                    onModel={(model: string) => guidedStep.setGuided({ model })}
                    onRemove={guidedStep.removeGuided}
                />
            )}
            {guided === null ? (
                <ModelField
                    ids={ids}
                    type={type}
                    custom={view.custom}
                    model={view.model}
                    blocked={modelBlockedNote(view.parsed.ok, view.modelUnsupported)}
                    error={view.modelError}
                    catalog={props.connection.catalog}
                    reselect={props.connection.reselect}
                    onRetryModels={props.connection.onRetryModels}
                    onDefault={props.onModelDefault}
                    onCustom={props.onModelCustom}
                    onModel={props.onModel}
                />
            ) : null}
            <RunnerClassField
                ids={ids}
                value={draft.runnerClass}
                declared={props.runnerClasses}
                onChange={props.onRunnerClass}
            />
            <CredentialsNote href={props.envHref} onFollow={props.onFollowEnvLink} cloud={props.cloud} />

            <AdvancedConfiguration
                ids={ids}
                type={type}
                json={draft.configs[type]}
                jsonError={view.jsonError}
                managed={view.managed}
                rounds={draft.gateFixRounds}
                roundsError={view.roundsError}
                onJson={props.onJson}
                onFormat={props.onFormat}
                onRounds={props.onRounds}
            />

            <ExecutorActions
                ids={ids}
                failure={props.failure}
                isEdit={isEdit}
                saving={props.saving}
                unavailable={view.unavailable}
                onCancel={props.onCancel}
                onSave={props.onSave}
            />
        </>
    );
}
