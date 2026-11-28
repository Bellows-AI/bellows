/**
 * The way to add an organization the GitHub App is not installed on yet. The selection screen and
 * the account page's Tracked organizations panel both carry it: the sign-in only lists accounts
 * where the App is installed, so a new organization can never appear until it is.
 *
 * An anchor to a server route, not a client-built github.com URL — the route signs the `state`
 * that brings the browser back to the selection screen with the new organization pre-selected.
 */
export function InstallAppLink({ returnTo }: { returnTo: string }) {
    return (
        <p className="muted">
            Only organizations with the App installed are listed.{' '}
            <a href={`/api/auth/github/install?returnTo=${encodeURIComponent(returnTo)}`}>
                Install the App on another organization
            </a>
        </p>
    );
}
