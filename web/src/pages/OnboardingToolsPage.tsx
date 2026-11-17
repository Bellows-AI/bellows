import { SetupFrame } from '../onboarding/SetupFrame.js';
import { ToolsStep } from '../onboarding/ToolsStep.js';

/** Setup step 3, Connect your issue tracker: the frame and its one `h1` around the step (`ToolsStep`). */
export function OnboardingToolsPage() {
    return (
        <SetupFrame
            place="tools"
            title="Connect your issue tracker"
            purpose="Optional. Agents read the ticket a task links to, and can comment back on it. Each connection is yours — tasks act as you."
        >
            <ToolsStep />
        </SetupFrame>
    );
}
