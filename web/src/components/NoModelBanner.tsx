import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { type UseModelSetup, useModelSetup } from '../api/useModelSetup.js';
import { useSession } from '../api/useSession.js';
import { useWorkspace } from '../api/useWorkspace.js';
import { showNoModel } from '../onboarding/no-model.js';
import { Icon } from './Icon.js';

/** No workspace read: it is asked for only where it decides the answer. */
const UNREAD = { data: null, error: null };

/** Re-reads on window focus (a key or profile saved in another tab), never on a timer. */
function useFocusRead(refresh: () => void) {
    useEffect(() => {
        window.addEventListener('focus', refresh);
        return () => window.removeEventListener('focus', refresh);
    }, [refresh]);
}

function Warning() {
    return (
        <div className="banner-warn no-model-banner" role="status">
            <Icon name="alert-triangle" size={24} />
            <p>
                No model yet — tasks will wait until one is connected. <Link to="/settings/model">Connect a model</Link>
            </p>
        </div>
    );
}

/** Self-hosted with no key the board can see: the workspace says whether a profile or agent default runs tasks anyway. */
function SelfHostedNoModel({ modelSetup }: { modelSetup: UseModelSetup }) {
    const workspace = useWorkspace();
    useFocusRead(workspace.refresh);
    return showNoModel({ mode: 'self-hosted', modelSetup, workspace }) ? <Warning /> : null;
}

/**
 * The shell's "No model yet" warning, above every app page while a task could not run (`showNoModel`:
 * cloud on a confirmed `effective: null`; self-hosted only when no profile or agent default exists
 * either). A read in flight or a failed one shows nothing, and a save through `useModelSetup` anywhere
 * re-reads it.
 */
export function NoModelBanner() {
    const modelSetup = useModelSetup();
    const { session } = useSession();
    useFocusRead(modelSetup.refresh);
    const mode = session?.deploymentMode ?? null;
    if (mode === 'self-hosted' && modelSetup.error === null && modelSetup.data?.effective === null) {
        return <SelfHostedNoModel modelSetup={modelSetup} />;
    }
    return showNoModel({ mode, modelSetup, workspace: UNREAD }) ? <Warning /> : null;
}
