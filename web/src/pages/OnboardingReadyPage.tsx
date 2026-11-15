import { SetupActions } from '../onboarding/SetupActions.js';
import { SetupFrame } from '../onboarding/SetupFrame.js';
import { useSetupWalk } from '../onboarding/useSetupWalk.js';

/** The walk's closing page: a placeholder that marks setup complete, then returns to the carried path. */
export function OnboardingReadyPage() {
    const walk = useSetupWalk();
    return (
        <SetupFrame place="ready" title="You're set" purpose="Describe a change and an agent opens a pull request.">
            <SetupActions primary="Go to the dashboard" busy={walk.busy} error={walk.error} onPrimary={walk.complete} />
        </SetupFrame>
    );
}
