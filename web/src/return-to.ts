const CAPABILITY_MARK = 'fcu_';

/**
 * The path a sign-in comes back to. A fragment that carries an upload capability (BEL-248) is never forwarded: this
 * value ends up in a `returnTo` query string, and a capability must not reach access logs or OAuth state.
 */
export function returnToOf(pathname: string, hash: string): string {
    return hash.includes(CAPABILITY_MARK) ? pathname : `${pathname}${hash}`;
}
