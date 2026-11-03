import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { useOAuthConsent, type ConsentRequest } from '../api/useOAuthConsent.js';
import { KeyValues } from '../components/KeyValues.js';
import { PublicPageHeader } from '../components/PublicPageHeader.js';
import { StateNote } from '../components/StateNote.js';
import { ThemeSelector } from '../components/ThemeSelector.js';
import { PRODUCT_NAME } from '../brand.js';
import { clientIdentity, redirectTarget, scopeLabel } from '../oauth-client.js';

/** The transaction the authorize redirect carried in the URL fragment; it never travels to a server as a URL. */
function transactionOf(hash: string): { id: string | null; csrf: string | null } {
    const params = new URLSearchParams(hash.replace(/^#/, ''));
    return { id: params.get('id'), csrf: params.get('csrf') };
}

const followRedirect = (url: string): void => window.location.assign(url);

function ConsentShell({ children }: { children: ReactNode }) {
    return (
        <>
            <PublicPageHeader context="Connect an app" actions={<ThemeSelector />} />
            <main className="onboarding">
                <h1>Connect an app to {PRODUCT_NAME}</h1>
                {children}
            </main>
        </>
    );
}

function ScopeList({ scopes }: { scopes: readonly string[] }) {
    return (
        <ul>
            {scopes.map((scope) => (
                <li key={scope}>
                    {scopeLabel(scope)} <code>{scope}</code>
                </li>
            ))}
        </ul>
    );
}

/** What is being asked, said plainly: who is asking, for what, and where the browser goes next. */
function RequestDetails({
    request,
    orgId,
    onOrg,
    disabled,
}: {
    request: ConsentRequest;
    orgId: string;
    onOrg: (id: string) => void;
    disabled: boolean;
}) {
    const identity = clientIdentity(request.client);
    return (
        <>
            <p>
                <strong>{identity.label}</strong> wants to act on your behalf on this board.
            </p>
            <KeyValues
                pairs={[
                    ['App', identity.label],
                    ['Where this comes from', identity.basis],
                    ...(identity.claimedName
                        ? ([['Name it gives', `It calls itself "${identity.claimedName}" (its own claim)`]] as [
                              string,
                              string,
                          ][])
                        : []),
                    ...(request.client.uri ? ([['Site it claims', request.client.uri]] as [string, string][]) : []),
                    ['Access requested', <ScopeList key="scopes" scopes={request.scopes} />],
                    ['You will return to', redirectTarget(request.redirectUri)],
                    ['Signed in as', request.user.login],
                    [
                        'Organization',
                        <select
                            key="org"
                            aria-label="Organization the app gets access to"
                            value={orgId}
                            disabled={disabled}
                            onChange={(event) => onOrg(event.target.value)}
                        >
                            {request.organizations.map((org) => (
                                <option key={org.id} value={org.id}>
                                    {org.name}
                                </option>
                            ))}
                        </select>,
                    ],
                ]}
            />
            <p className="muted">
                Only continue if you started this from the app named above. You can disconnect it at any time from your
                account page.
            </p>
        </>
    );
}

/**
 * The consent screen an MCP client's authorize request ends on (BEL-103; docs/auth.md). The transaction id and its
 * CSRF value arrive in the fragment. Allow and Deny are the same size and weight: declining is as easy as agreeing.
 * Each is a `fetch` that answers the redirect to follow, because the CSP keeps `form-action 'none'`.
 */
export function OAuthConsentPage({ navigate = followRedirect }: { navigate?: (url: string) => void }) {
    const { hash } = useLocation();
    // Read once: the fragment is dropped below, and a later render must not lose the transaction with it.
    const [{ id, csrf }] = useState(() => transactionOf(hash));
    const { state, decide } = useOAuthConsent(id, csrf);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [chosenOrg, setChosenOrg] = useState<string | null>(null);

    // The id and CSRF value live only in this page: once read, the address bar, history and any referrer lose them.
    useEffect(() => {
        if (hash !== '') {
            window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
        }
        // Once, on mount: the transaction was already taken from `hash` above.
    }, []);

    const answer = async (approve: boolean) => {
        setBusy(true);
        setFailure(null);
        const result = await decide(approve, orgId);
        if (result.ok) {
            navigate(result.redirect);
            return;
        }
        setFailure(result.error);
        setBusy(false);
    };

    const orgId = chosenOrg ?? (state.phase === 'ready' ? state.request.organization.id : '');

    if (state.phase === 'loading') {
        return (
            <ConsentShell>
                <StateNote state="loading">Loading the request…</StateNote>
            </ConsentShell>
        );
    }
    if (state.phase === 'failed') {
        return (
            <ConsentShell>
                <StateNote state="error">{state.error}</StateNote>
            </ConsentShell>
        );
    }
    if (state.phase === 'gone') {
        return (
            <ConsentShell>
                <StateNote state="error">
                    This authorization request is no longer valid. Start again from the app you were connecting.
                </StateNote>
            </ConsentShell>
        );
    }
    return (
        <ConsentShell>
            <RequestDetails request={state.request} orgId={orgId} onOrg={setChosenOrg} disabled={busy} />
            {failure ? <StateNote state="error">{failure}</StateNote> : null}
            <div className="onboarding-actions">
                <button type="button" disabled={busy} onClick={() => void answer(true)}>
                    Allow
                </button>
                <button type="button" disabled={busy} onClick={() => void answer(false)}>
                    Deny
                </button>
            </div>
        </ConsentShell>
    );
}
