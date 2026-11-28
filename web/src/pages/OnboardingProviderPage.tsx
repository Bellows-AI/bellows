import { ADMIN_ROLE, type ProviderConnectionMeta } from '@factory-ai/core';
import { type ReactNode, useId, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useProviderConnections } from '../api/useProviderConnections.js';
import { type Session, useSession } from '../api/useSession.js';
import { useWorkspace } from '../api/useWorkspace.js';
import { Icon } from '../components/Icon.js';
import { StateNote } from '../components/StateNote.js';
import { SetupActions } from '../onboarding/SetupActions.js';
import { SetupFrame } from '../onboarding/SetupFrame.js';
import { SetupPart } from '../onboarding/SetupPart.js';
import { reselectHref } from '../onboarding/steps.js';
import { type SetupWalk, useSetupWalk } from '../onboarding/useSetupWalk.js';
import {
    canReplaceKey,
    type DefaultExecutor,
    type DefaultExecutorRead,
    type ExecutorDetail,
    useDefaultExecutor,
} from '../providers/default-executor.js';
import { type ExecutorDraft, ExecutorCard, executorWait, useExecutorDraft } from '../providers/ExecutorCard.js';
import {
    type ProviderConnectionDraft,
    ProviderConnectionPart,
    useProviderConnection,
} from '../providers/ProviderConnectionPart.js';
import { ReplaceKey, type ReplaceKeyDraft, useReplaceKey } from '../providers/ReplaceKey.js';
import { useSetupSubmit } from '../providers/useSetupSubmit.js';
import { executorTypeLabel } from '../workspace/executors.js';

/** The view the step shows: the set-up banner, the form for a new connection and executor, or the key replacement. */
type Mode = 'banner' | 'form' | 'rotate';

const TITLE = 'Connect a provider';
const FORM_PURPOSE =
    'Agents run on your own provider key. Bellows saves it as a connection and creates your default executor on it.';

/** The banner of what is already set up: the executor, then the connection it runs on. */
function SetUpBanner({
    executor,
    detail,
    orgName,
    onAdd,
    onReplace,
}: {
    executor: DefaultExecutor;
    detail: ExecutorDetail | null;
    orgName: string;
    onAdd: () => void;
    onReplace: (() => void) | null;
}) {
    const { connection } = executor;
    const runs = [executorTypeLabel(executor.agentType), detail?.model].filter(Boolean).join(' · ');
    return (
        <div className="banner-info">
            <Icon name="info" size={24} />
            <div className="model-banner-body">
                <p className="banner-title">
                    {executor.scope === 'org'
                        ? `${orgName} runs tasks on ${executor.name}.`
                        : `Your tasks run on ${executor.name}.`}
                </p>
                <p>
                    {runs}
                    {connection ? (
                        <>
                            {' '}
                            — on the <b>{connection.name}</b> connection (
                            {connection.scope === 'org' ? 'organization' : 'personal'})
                        </>
                    ) : null}
                    .{' '}
                    {executor.suspended
                        ? 'It is suspended, so tasks cannot run on it until it is resumed in Settings.'
                        : 'You can start right away.'}
                </p>
                <p className="muted">
                    <button type="button" className="tertiary" onClick={onAdd}>
                        Add another provider
                    </button>
                    {onReplace ? (
                        <>
                            {' · '}
                            <button type="button" className="tertiary" onClick={onReplace}>
                                Replace the key
                            </button>
                        </>
                    ) : null}
                </p>
            </div>
        </div>
    );
}

type Actions = Parameters<typeof SetupActions>[0];
type Action = Pick<Actions, 'primary' | 'reason' | 'ready' | 'onPrimary'>;

/** What one view of the step is: the sentence under the title, its body, and the primary action. */
interface View {
    purpose: string;
    body: ReactNode;
    action: Action;
}

/** Everything a view reads: the drafts, the setup command and the walk. */
interface Context {
    ids: string;
    session: Session | null;
    walk: SetupWalk;
    setup: ReturnType<typeof useSetupSubmit>;
    connection: ProviderConnectionDraft;
    executor: ExecutorDraft;
    replace: ReplaceKeyDraft;
    setMode: (mode: Mode) => void;
}

/** The reads have not answered, or one failed: a message with Retry, never the banner and never the empty form. */
function pendingView(read: DefaultExecutorRead): View {
    const failed = read.state === 'error';
    return {
        purpose: FORM_PURPOSE,
        body: failed ? (
            <>
                <StateNote state="error">{read.error}</StateNote>
                <button type="button" className="tertiary" onClick={read.retry}>
                    Retry
                </button>
            </>
        ) : (
            <StateNote state="loading">Loading the provider setup…</StateNote>
        ),
        action: {
            primary: 'Continue',
            reason: failed ? 'The provider setup could not be read.' : 'Waiting for the provider setup.',
            onPrimary: () => undefined,
        },
    };
}

/** The form: a new connection, then the executor that runs on it, saved by one setup command. */
function formView({ session, walk, setup, connection, executor }: Context): View {
    const reason =
        connection.reason ??
        (executor.name.trim() === '' ? 'Give the executor a name.' : null) ??
        (executor.model.trim() === '' ? 'Choose a model to continue.' : null);
    const create = async () => {
        const saved = await setup.submit({
            scope: connection.scope,
            connection: connection.create(),
            executor: { name: executor.name.trim(), agentType: executor.agent, model: executor.model },
            makeDefault: true,
        });
        if (saved) walk.done('provider');
    };
    return {
        purpose: FORM_PURPOSE,
        body: (
            <>
                <SetupPart number={1} title="Provider connection">
                    <ProviderConnectionPart draft={connection} orgName={session?.organization.name ?? ''} />
                </SetupPart>
                <SetupPart number={2} title="Default executor">
                    <ExecutorCard
                        draft={executor}
                        scope={connection.scope}
                        wait={executorWait(connection.check.kind)}
                    />
                </SetupPart>
            </>
        ),
        action: {
            primary: 'Create and continue',
            reason,
            ready: `Creates the ${connection.name.trim()} connection and makes ${executor.name.trim()} your default executor.`,
            onPrimary: () => void create(),
        },
    };
}

/** Replacing the key of the default executor's own connection, under the executor's id and the revision read. */
function rotateView(
    { ids, walk, setup, replace, setMode }: Context,
    current: DefaultExecutor,
    target: ProviderConnectionMeta,
    detail: ExecutorDetail & { model: string }
): Omit<View, 'purpose'> {
    const rotate = async () => {
        const saved = await setup.submit({
            scope: current.scope,
            connection: { intent: 'rotate', id: target.id, key: replace.key.trim() },
            executor: {
                id: current.id,
                agentType: current.agentType,
                model: detail.model,
                ...(detail.updatedAt ? { expectedUpdatedAt: detail.updatedAt } : {}),
            },
        });
        if (saved) walk.done('provider');
    };
    return {
        body: <ReplaceKey ids={ids} connection={target} draft={replace} onCancel={() => setMode('banner')} />,
        action: { primary: 'Replace key', reason: replace.reason, onPrimary: () => void rotate() },
    };
}

/** An org that is already set up: the banner and Continue, or the key replacement when asked for. */
function setUpView(
    ctx: Context,
    picked: Mode,
    { executor: current, detail }: Extract<DefaultExecutorRead, { state: 'set' }>
): View {
    const orgName = ctx.session?.organization.name ?? 'The organization';
    const purpose = `Your tasks run on an executor: an agent on a provider connection. ${
        current.scope === 'org' ? `${orgName} already has one.` : 'You already have one.'
    }`;
    const target = current.connection;
    const model = detail?.model ?? null;
    const replaceable = target !== null && model !== null && canReplaceKey(current, ctx.session?.role === ADMIN_ROLE);
    if (picked === 'rotate' && replaceable && detail) {
        return { purpose, ...rotateView(ctx, current, target, { ...detail, model }) };
    }
    return {
        purpose,
        body: (
            <SetUpBanner
                executor={current}
                detail={detail}
                orgName={orgName}
                onAdd={() => ctx.setMode('form')}
                onReplace={replaceable ? () => ctx.setMode('rotate') : null}
            />
        ),
        action: { primary: 'Continue', onPrimary: () => ctx.walk.done('provider') },
    };
}

/**
 * Setup step 2, Connect a provider: the provider connection and the default executor on it, saved by one setup command
 * (Create and continue), then the step is recorded done; Skip for now records a skip — either re-reads `/api/auth/me`
 * before moving on. An org that already has a default executor sees it named instead, with "Add another provider" and
 * "Replace the key". The reads come first: a failed one is an error with Retry, never the banner and never the empty
 * form. Back is the reselect round trip (a plain anchor: the server answers with a redirect), which returns here.
 */
export function OnboardingProviderPage() {
    const { pathname, search } = useLocation();
    const walk = useSetupWalk();
    const { session, error: sessionError } = useSession();
    const workspace = useWorkspace();
    const connections = useProviderConnections();
    const read = useDefaultExecutor(workspace, connections);
    const setup = useSetupSubmit();
    const connection = useProviderConnection(session);
    const executor = useExecutorDraft(connection.provider, connection.check.models);
    const replace = useReplaceKey(session, read.state === 'set' ? read.executor.connection : null);
    const [picked, setMode] = useState<Mode>('banner');
    const ids = useId();
    const ctx: Context = { ids, session, walk, setup, connection, executor, replace, setMode };

    let view: View;
    if (read.state === 'loading' || read.state === 'error' || !session) view = pendingView(read);
    else if (read.state === 'none' || picked === 'form') view = formView(ctx);
    else view = setUpView(ctx, picked, read);

    return (
        <SetupFrame place="provider" title={TITLE} purpose={view.purpose}>
            {sessionError && !session ? <StateNote state="error">{sessionError}</StateNote> : null}
            {view.body}
            <SetupActions
                back={
                    <a className="setup-back" href={reselectHref(`${pathname}${search}`)}>
                        Back
                    </a>
                }
                onSkip={() => walk.skip('provider')}
                busy={walk.busy || setup.busy}
                error={setup.error ?? walk.error}
                {...view.action}
            />
        </SetupFrame>
    );
}
