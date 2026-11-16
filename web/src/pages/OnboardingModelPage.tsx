import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useSession } from '../api/useSession.js';
import { StateNote } from '../components/StateNote.js';
import { ModelSetup } from '../model-setup/ModelSetupForm.js';
import { SetupFrame } from '../onboarding/SetupFrame.js';
import { reselectHref } from '../onboarding/steps.js';
import { useSetupWalk } from '../onboarding/useSetupWalk.js';

/**
 * Setup step 2, Connect a model (`ModelSetup`, shared with Settings → Model). Save writes the setup, then records the
 * step done; Skip for now records a skip — either re-reads `/api/auth/me` before moving on. Back is the reselect round
 * trip (a plain anchor: the server answers with a redirect), which returns here.
 */
export function OnboardingModelPage() {
    const { pathname, search } = useLocation();
    const walk = useSetupWalk();
    const { session, error } = useSession();
    const row = (primary: ReactNode) => (
        <>
            {walk.error ? <StateNote state="error">{walk.error}</StateNote> : null}
            <div className="setup-actions">
                <a className="setup-back" href={reselectHref(`${pathname}${search}`)}>
                    Back
                </a>
                <button
                    type="button"
                    className="tertiary"
                    aria-disabled={walk.busy || undefined}
                    onClick={() => walk.skip('model')}
                >
                    Skip for now
                </button>
                {primary}
            </div>
        </>
    );
    return (
        <SetupFrame
            place="model"
            title="Connect a model"
            purpose="Agents run on your own provider key. Paste one and Bellows picks the right agent for it."
        >
            {error && !session ? <StateNote state="error">{error}</StateNote> : null}
            <ModelSetup
                session={session}
                labels={{ form: 'Save and continue', banner: 'Continue' }}
                onSaved={() => walk.done('model')}
                footer={row}
            />
        </SetupFrame>
    );
}
