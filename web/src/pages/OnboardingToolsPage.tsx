import { Link } from 'react-router-dom';
import { SetupActions } from '../onboarding/SetupActions.js';
import { SetupFrame } from '../onboarding/SetupFrame.js';
import { setupPath } from '../onboarding/steps.js';
import { useSetupWalk } from '../onboarding/useSetupWalk.js';

/** Setup step 3: a placeholder until the issue-tracker step lands — the heading, Skip for now and Back to Model. */
export function OnboardingToolsPage() {
    const walk = useSetupWalk();
    return (
        <SetupFrame
            place="tools"
            title="Connect your issue tracker"
            purpose="Optional. Agents read the ticket a task links to, and can comment back on it."
        >
            <SetupActions
                back={
                    <Link className="setup-back" to={setupPath('model', walk.returnTo)}>
                        Back
                    </Link>
                }
                primary="Skip for now"
                busy={walk.busy}
                error={walk.error}
                onPrimary={() => walk.skip('tools')}
            />
        </SetupFrame>
    );
}
