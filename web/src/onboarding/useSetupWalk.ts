import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { request } from '../api/request.js';
import type { Session } from '../api/useSession.js';
import { nextSetupStep, safeReturnTo, setupPath, type RecordedStep, type SetupState } from './steps.js';

type MeResponse = Session | { authenticated: false };

/** The setup a just-written step left, re-read from `/api/auth/me`; null when the read did not answer. */
async function readSetup(): Promise<SetupState | null> {
    const me = await request<MeResponse>('/api/auth/me', { ungated: true, verb: 'Could not check the session' });
    return me.ok && me.value.authenticated ? me.value.setup : null;
}

const SAVE_FAILED = 'This step could not be saved. Try again.';

export interface SetupWalk {
    /** Where the walk returns once setup is complete: the carried `returnTo`, same-origin only. */
    returnTo: string;
    busy: boolean;
    error: string | null;
    skip: (step: RecordedStep) => void;
    complete: () => void;
}

/**
 * A step's way forward: write the answer, re-read `/api/auth/me`, and only then navigate
 * to the first open step — or to `returnTo` once setup is complete. Navigating on the stale
 * `completed: false` would bounce the member back into the walk, so a failed write or re-read
 * stays on the step and says so.
 */
export function useSetupWalk(): SetupWalk {
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const returnTo = safeReturnTo(params.get('returnTo'));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const advance = async (url: string, body?: unknown) => {
        if (busy) return;
        setBusy(true);
        setError(null);
        const written = await request(url, { method: 'POST', body, empty: true, verb: 'Could not save this step' });
        const setup = written.ok ? await readSetup() : null;
        setBusy(false);
        if (!setup) {
            setError(SAVE_FAILED);
            return;
        }
        const next = nextSetupStep(setup);
        void navigate(next ? setupPath(next, returnTo) : returnTo);
    };

    return {
        returnTo,
        busy,
        error,
        skip: (step) => void advance('/api/onboarding/setup', { step, action: 'skip' }),
        complete: () => void advance('/api/onboarding/setup/complete'),
    };
}
