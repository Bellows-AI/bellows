import { useModelSetup } from '../api/useModelSetup.js';
import { useSession } from '../api/useSession.js';
import { useWorkspace } from '../api/useWorkspace.js';
import { showNoModel } from '../onboarding/no-model.js';
import { ReadyStep } from '../onboarding/ReadyStep.js';
import { SetupFrame } from '../onboarding/SetupFrame.js';

/** The walk's closing page: "Almost set" only when `showNoModel` confirms a task could not run. */
export function OnboardingReadyPage() {
    const setup = useModelSetup();
    const workspace = useWorkspace();
    const { session } = useSession();
    const noModel = showNoModel({ mode: session?.deploymentMode ?? null, modelSetup: setup, workspace });
    return (
        <SetupFrame
            place="ready"
            title={noModel ? 'Almost set' : "You're set"}
            purpose="Describe a change and an agent opens a pull request."
        >
            <ReadyStep setup={setup} workspace={workspace} noModel={noModel} />
        </SetupFrame>
    );
}
