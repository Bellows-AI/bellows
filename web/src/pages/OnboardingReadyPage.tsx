import { useModelSetup } from '../api/useModelSetup.js';
import { ReadyStep } from '../onboarding/ReadyStep.js';
import { SetupFrame } from '../onboarding/SetupFrame.js';

/** The walk's closing page: "Almost set" only once the model read confirms there is none. */
export function OnboardingReadyPage() {
    const setup = useModelSetup();
    const noModel = setup.error === null && setup.data?.effective === null;
    return (
        <SetupFrame
            place="ready"
            title={noModel ? 'Almost set' : "You're set"}
            purpose="Describe a change and an agent opens a pull request."
        >
            <ReadyStep setup={setup} />
        </SetupFrame>
    );
}
