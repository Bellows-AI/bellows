import { useLocation } from 'react-router-dom';
import { SetupActions } from '../onboarding/SetupActions.js';
import { SetupFrame } from '../onboarding/SetupFrame.js';
import { reselectHref } from '../onboarding/steps.js';
import { useSetupWalk } from '../onboarding/useSetupWalk.js';

/**
 * Setup step 2: a placeholder until the model step lands — the heading, Skip for now
 * and Back. Back is the reselect round trip (a plain anchor: the server answers with a redirect),
 * which returns here.
 */
export function OnboardingModelPage() {
    const { pathname, search } = useLocation();
    const walk = useSetupWalk();
    return (
        <SetupFrame place="model" title="Connect a model" purpose="Agents run on your own provider key.">
            <SetupActions
                back={
                    <a className="setup-back" href={reselectHref(`${pathname}${search}`)}>
                        Back
                    </a>
                }
                primary="Skip for now"
                busy={walk.busy}
                error={walk.error}
                onPrimary={() => walk.skip('model')}
            />
        </SetupFrame>
    );
}
