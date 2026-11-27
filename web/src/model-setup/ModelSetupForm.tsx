import { type ReactNode, useId, useState } from 'react';
import { useModelSetup } from '../api/useModelSetup.js';
import type { Session } from '../api/useSession.js';
import { StateNote } from '../components/StateNote.js';
import { ADMIN_ROLE } from '@factory-ai/core';
import { bannerOf, canRotate, ConfiguredView, useConfigured } from './ConfiguredBanner.js';
import { KeyFormView, useKeyForm } from './KeyForm.js';
import { RotateView, useRotate } from './RotateKey.js';
import { SavePrimary } from './SavePrimary.js';

/** The primary's words: on the key form, and on a configured banner. */
export interface ModelSetupLabels {
    form: string;
    banner: string;
}

/** Which view the setup shows: the configured banner, the key form (a new connection), or the key replacement. */
type Mode = 'banner' | 'form' | 'rotate';

/**
 * Connect a model — the onboarding step and Settings → Model render this one component. It reads the setup first: a
 * failed read is an error with Retry, never the empty form; a default executor already there shows its banner
 * (`ConfiguredView`) with "Connect another provider" (the key form, a new connection and executor) and "Replace the key"
 * (explicit rotation). A save creates or selects the connection and the executor and makes it the default in one call.
 * The page's action row (`footer`) stays mounted at one place through every state, so a press never lands on a row that
 * was just replaced.
 */
export function ModelSetup({
    session,
    labels,
    onSaved,
    footer,
    saveExisting = false,
}: {
    /** Null while the session is read. */
    session: Session | null;
    labels: ModelSetupLabels;
    onSaved: () => void | Promise<void>;
    /** Wraps the view's one primary in the page's action row. */
    footer: (primary: ReactNode) => ReactNode;
    /** Whether Continue on the org's key saves the default even when one is saved (Settings: yes; onboarding: no). */
    saveExisting?: boolean;
}) {
    const setup = useModelSetup();
    const ids = useId();
    const [mode, setMode] = useState<Mode>('banner');
    // A save of a new connection or a new key is done: the banner of what is now saved comes back.
    const savedToBanner = async () => {
        setMode('banner');
        await onSaved();
    };
    const form = useKeyForm(session, setup, savedToBanner);
    const configured = useConfigured({ session, view: setup.data, setup, onSaved, saveExisting });
    const view = setup.data;
    const rotate = useRotate(session, setup, savedToBanner, view?.selected);
    const banner = mode !== 'banner' || !view ? null : bannerOf(view);

    let body: ReactNode;
    let primary: { label: string; reason: string | null; busy: boolean; press: () => void } = {
        label: labels.form,
        reason: form.reason,
        busy: form.save.busy,
        press: form.press,
    };
    if (!session || !view) {
        const failed = Boolean(session && setup.error);
        primary = {
            ...primary,
            reason: failed ? 'The model setup could not be read.' : 'Waiting for the model setup.',
        };
        body = failed ? (
            <>
                <StateNote state="error">{setup.error}</StateNote>
                <button type="button" className="tertiary" onClick={setup.refresh}>
                    Retry
                </button>
            </>
        ) : (
            <StateNote state="loading">Loading the model setup…</StateNote>
        );
    } else if (banner) {
        const { reason, save, press } = configured;
        primary = { label: labels.banner, reason, busy: save.busy, press };
        const admin = session.role === ADMIN_ROLE;
        const openForm = () => {
            // Only an admin inherits the organization's scope: a member's save there is refused.
            form.setScope(admin ? (view.selected?.scope ?? 'personal') : 'personal');
            setMode('form');
        };
        const allowed = canRotate(view.selected, admin);
        body = (
            <ConfiguredView
                ids={ids}
                kind={banner}
                view={view}
                state={configured}
                orgName={session.organization.name}
                onOwnKey={openForm}
                onRotate={allowed ? () => setMode('rotate') : null}
            />
        );
    } else if (mode === 'rotate' && view) {
        primary = { label: 'Replace key', reason: rotate.reason, busy: rotate.save.busy, press: rotate.press };
        body = <RotateView ids={ids} state={rotate} onCancel={() => setMode('banner')} />;
    } else {
        body = <KeyFormView ids={ids} form={form} orgName={session.organization.name} />;
    }
    return (
        <>
            {body}
            {footer(
                <SavePrimary
                    ids={ids}
                    label={primary.label}
                    reason={primary.reason}
                    busy={primary.busy}
                    onPress={primary.press}
                />
            )}
        </>
    );
}
