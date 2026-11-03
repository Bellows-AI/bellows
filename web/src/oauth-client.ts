/**
 * How the SPA names an MCP client and its access (BEL-103), shared by the consent screen and the
 * connected-apps panel so both say the same thing about the same app.
 */

export type OAuthClientKind = 'cimd' | 'dcr';

/** The client as the consent and grants routes report it; `kind` is null when the client row is gone. */
export interface OAuthClientView {
    id: string;
    kind: OAuthClientKind | null;
    name: string | null;
}

export interface ClientIdentity {
    /** What to call the app: a metadata-URL host, or the name it registered itself under. */
    label: string;
    /** One sentence on where that label comes from, and how far to trust it. */
    basis: string;
    /** A metadata-document client's own `client_name`: its claim, shown as one beside the verified host. */
    claimedName: string | null;
}

const UNNAMED = 'An unnamed app';

/**
 * A CIMD client is identified by the HTTPS URL it serves its metadata from, so its host is the one
 * claim the app cannot make up; a DCR client registered itself, and its name is whatever it typed.
 */
export function clientIdentity(client: OAuthClientView): ClientIdentity {
    if (client.kind === 'cimd') {
        let host = client.id;
        try {
            host = new URL(client.id).host;
        } catch {
            // Not a URL: the id is shown whole rather than guessed at.
        }
        return { label: host, basis: `Identified by the metadata document at ${client.id}.`, claimedName: client.name };
    }
    return {
        label: client.name ?? UNNAMED,
        basis: 'Registered itself; this name is unverified and anyone can pick it.',
        claimedName: null,
    };
}

/** The place an approval sends the browser: the host of a web redirect, the whole address of an app's own scheme. */
export function redirectTarget(redirectUri: string): string {
    try {
        const url = new URL(redirectUri);
        if (url.protocol === 'https:' || url.protocol === 'http:') return url.host;
        // A custom scheme names an app on this device, and whatever follows it is that app's to read: shown whole.
        return `${redirectUri} (opens an app on this device)`;
    } catch {
        return redirectUri;
    }
}

const SCOPE_LABELS: Readonly<Record<string, string>> = {
    'factory:read': 'Read tasks, batches, repositories and settings',
    'factory:write': 'Create and change tasks and batches',
};

/** A scope as a sentence; an unknown one is shown as written, never hidden. */
export const scopeLabel = (scope: string): string => SCOPE_LABELS[scope] ?? scope;
