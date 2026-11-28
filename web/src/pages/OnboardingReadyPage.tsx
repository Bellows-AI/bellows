import { useProviderConnections } from '../api/useProviderConnections.js';
import { useWorkspace } from '../api/useWorkspace.js';
import { ReadyStep } from '../onboarding/ReadyStep.js';
import { SetupFrame } from '../onboarding/SetupFrame.js';
import { useDefaultExecutor } from '../providers/default-executor.js';

/** The walk's closing page. A skipped provider step is no warning here: the composer refuses a task with no executor. */
export function OnboardingReadyPage() {
    const workspace = useWorkspace();
    const provider = useDefaultExecutor(workspace, useProviderConnections());
    return (
        <SetupFrame place="ready" title="You're set" purpose="Describe a change and an agent opens a pull request.">
            <ReadyStep provider={provider} workspace={workspace} />
        </SetupFrame>
    );
}
