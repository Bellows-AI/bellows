import { type ReactNode, useId, useState } from 'react';
import { useModelSetup } from '../api/useModelSetup.js';
import type { Session } from '../api/useSession.js';
import { StateNote } from '../components/StateNote.js';
import { bannerOf, ConfiguredView, useConfigured } from './ConfiguredBanner.js';
import { KeyFormView, useKeyForm } from './KeyForm.js';
import { SavePrimary } from './SavePrimary.js';

/** The primary's words: on the key form, and on a configured banner. */
export interface ModelSetupLabels {
    form: string;
    banner: string;
}

/**
 * Connect a model — the onboarding step and Settings → Model render this one component. It reads the setup first: a
 * failed read is an error with Retry, never the empty form; a model already there shows its banner
 * (`ConfiguredView`), and "Use a personal key" opens the key form at Only me. The page's action row (`footer`) stays
 * mounted at one place through every state, so a press never lands on a row that was just replaced.
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
    const [ownKey, setOwnKey] = useState(false);
    const form = useKeyForm(session, setup, onSaved);
    const configured = useConfigured({ session, view: setup.data, setup, onSaved, saveExisting });
    const view = setup.data;
    const banner = ownKey || !view ? null : bannerOf(view);

    let body: ReactNode;
    let primary = { label: labels.form, reason: form.reason, busy: form.save.busy, press: form.press };
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
        const openForm = () => {
            form.setScope('personal');
            setOwnKey(true);
        };
        body = (
            <ConfiguredView
                ids={ids}
                kind={banner}
                view={view}
                state={configured}
                orgName={session.organization.name}
                onOwnKey={openForm}
            />
        );
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
