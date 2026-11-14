import { ADMIN_ROLE, type DeploymentMode, type Role } from '@factory-ai/core';
import { useCallback, useEffect, useRef, useState } from 'react';
import { request } from './request.js';
import { reportUnauthenticated, subscribeUnauthenticated } from './unauthenticated.js';

export interface Session {
    /** The `/api/auth/me` union's signed-in arm; the anonymous answer is `{ authenticated: false }`. */
    authenticated: true;
    user: {
        id: string;
        login: string;
        name: string | null;
        /** GitHub's numeric id — 0 for the AUTH_MODE=none stand-in, a value GitHub never issues. */
        githubUserId: number;
        avatarUrl: string | null;
    };
    role: Role;
    membership: { invitedAt: string | null; claimedAt: string | null };
    account: { createdAt: string | null; lastLoginAt: string | null };
    organization: { id: string; name: string };
    /** Every org the account could switch to — the installations GitHub reported at sign-in. */
    organizations: { id: string; name: string }[];
    /** 'none' means the server is running open, so there is no session to end and no button. */
    mode: 'github' | 'none';
    /** Whether this board serves MCP, and so has connected apps to show. */
    mcp: boolean;
    /** Whether this board has Batches turned on (`BATCHES_ENABLED`). Anything but `true` means off. */
    batches: boolean;
    /** Where this board runs (`DEPLOYMENT_MODE`); cloud refuses a Claude subscription OAuth token in settings. */
    deploymentMode: DeploymentMode;
}

/** The role as the settings pages print it. */
export const roleLabel = (role: Role): string => (role === ADMIN_ROLE ? 'Admin' : 'Member');

/**
 * Signs the caller out: POSTs the logout route — never GET, which the server refuses as CSRF-able —
 * then fires the same broadcast a 401 does, so every mounted `useSession` re-checks `/api/auth/me`,
 * hears "nobody", and the gate returns. Fired even when the POST itself fails: the re-check is what
 * decides what the screen shows, and a dead network re-checks into an error, not a stale session.
 */
export async function signOut(): Promise<void> {
    const result = await request('/api/auth/logout', { method: 'POST', empty: true });
    // The POST only fails when the network itself is down (or the session is already gone, which
    // `request` has already broadcast); the re-check reports that as an error, not as a rejection.
    if (!result.ok && result.unauthenticated) return;
    reportUnauthenticated();
}

export interface UseSession {
    session: Session | null;
    /** True only before the first answer; a re-check does not blank the screen. */
    loading: boolean;
    /** The server was unreachable — distinct from a clean "you are not signed in". */
    error: string | null;
}

/** What `/api/auth/me` answers: the session, or an explicit "nobody". Both are 200s — a 401 here
 * would be logged as a console error by the browser of everybody who has not signed in yet. */
type MeResponse = Session | { authenticated: false };

export function useSession(): UseSession {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // One check at a time: a newer check aborts the one in flight, so an older answer (a slow
    // re-check landing after a sign-out's) can never overwrite the newer one, and an unmounted
    // hook never sets state.
    const inFlight = useRef<AbortController | null>(null);
    const check = useCallback(async () => {
        inFlight.current?.abort();
        const own = new AbortController();
        inFlight.current = own;
        // No `credentials: 'include'`: the default `same-origin` already sends the cookie, and
        // 'include' would drag CORS into a same-origin app for nothing. `ungated`: this IS the
        // gate's probe, so a 401 here is a refusal to show, not news that would re-run the probe.
        const result = await request<MeResponse>('/api/auth/me', {
            signal: own.signal,
            ungated: true,
            verb: 'Could not check the session',
        });
        if (own.signal.aborted) return;
        if (result.ok) {
            setSession(result.value.authenticated ? result.value : null);
            setError(null);
        } else {
            setError(result.error);
        }
        setLoading(false);
    }, []);

    useEffect(() => {
        void check();
        const off = subscribeUnauthenticated(() => void check());
        return () => {
            off();
            inFlight.current?.abort();
        };
    }, [check]);

    return { session, loading, error };
}
