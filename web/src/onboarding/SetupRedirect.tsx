import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useSession } from '../api/useSession.js';
import { returnToOf } from '../return-to.js';
import { nextSetupStep, setupPath } from './steps.js';

/**
 * Sends an unfinished member from any app route to the first open setup step, carrying the path
 * they were going to. It wraps the shell only, so the consent screen, the upload page
 * and the steps themselves are never redirected.
 *
 * Only an explicit `setup.completed === false` in the GitHub mode redirects: a read still in
 * flight, a failed one, a missing `setup` or the open board renders the app — an unconfirmed
 * answer never moves the member.
 */
export function SetupRedirect({ children }: { children: ReactNode }) {
    const { session } = useSession();
    const { pathname, search, hash } = useLocation();
    const setup = session?.mode === 'github' ? (session.setup as typeof session.setup | undefined) : undefined;
    const next = setup?.completed === false ? nextSetupStep(setup) : null;
    if (next) return <Navigate to={setupPath(next, returnToOf(`${pathname}${search}`, hash))} replace />;
    return <>{children}</>;
}
