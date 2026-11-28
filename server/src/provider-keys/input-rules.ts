/** What a provider connection's key and endpoint must look like: the rules every writer of `provider_connection` shares. */
const KEY_MAX = 4096;
const URL_MAX = 2048;
/** Printable ASCII without spaces: what a provider key is, and all a header may carry. */
const KEY_SHAPE = /^[\x21-\x7e]+$/;
/** An http(s) URL with no credentials in it, within the length a base URL may have. */
export const validBase = (raw: string): boolean => {
    if (raw.length > URL_MAX) return false;
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return false;
    }
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
};

/** A provider key a header can carry: printable ASCII, no spaces, within the length a key may have. */
export const validKey = (key: unknown): key is string =>
    typeof key === 'string' && key.length <= KEY_MAX && KEY_SHAPE.test(key);
