/**
 * The redirect-URI rule of the authorization endpoint (docs/auth.md): exact string match against a registered URI,
 * except an RFC 8252 section 7.3 loopback URI (`http` on `127.0.0.1`, `[::1]` or `localhost`) where only the port may
 * differ, so a native client may pick a free port per run. The loopback host is never interchangeable with another
 * (`localhost` is not `127.0.0.1`). A fragment, userinfo or an unparseable URI never matches.
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const SCRIPT_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:']);

const parse = (uri: string): URL | null => {
    if (uri === '' || uri.includes('#')) return null;
    try {
        const url = new URL(uri);
        return url.username === '' && url.password === '' ? url : null;
    } catch {
        return null;
    }
};

const isLoopback = (url: URL): boolean => url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);

/** Whether a client may register this URI (DCR) or list it (a client metadata document). */
export const isValidRedirectUri = (uri: string): boolean => {
    const url = parse(uri);
    if (!url || SCRIPT_SCHEMES.has(url.protocol)) return false;
    if (url.protocol === 'http:') return isLoopback(url);
    if (url.protocol === 'https:') return url.hostname !== '';
    return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) && !uri.startsWith('//');
};

export const redirectUriMatches = (requested: string, registered: readonly string[]): boolean => {
    const asked = parse(requested);
    if (!asked) return false;
    return registered.some((entry) => {
        if (entry === requested) return true;
        const known = parse(entry);
        if (!known || !isLoopback(asked) || !isLoopback(known)) return false;
        return asked.hostname === known.hostname && asked.pathname === known.pathname && asked.search === known.search;
    });
};
