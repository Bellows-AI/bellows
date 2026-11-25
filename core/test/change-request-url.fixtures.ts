/** Cases shared with `server/test/change-request-url-parity.test.ts`, which pins the driver and CLI copies. */
export const gh = (path: string, number: number, host = 'github.com') => ({
    ref: { forge: 'github', host, path },
    number,
});
export const gl = (path: string, number: number, host: string) => ({ ref: { forge: 'gitlab', host, path }, number });

export const ACCEPTED: Array<[string, ReturnType<typeof gh>]> = [
    ['https://github.com/acme/web/pull/7', gh('acme/web', 7)],
    ['https://github.com/acme/web/pull/7/', gh('acme/web', 7)],
    ['https://GitHub.com/acme/Web.js/pull/12', gh('acme/Web.js', 12)],
    ['https://ghe.example/acme/web/pull/7', gh('acme/web', 7, 'ghe.example')],
    ['https://github.com/acme/web/pull/2147483647', gh('acme/web', 2147483647)],
    ['https://gitlab.com/g/p/-/merge_requests/2147483647', gl('g/p', 2147483647, 'gitlab.com')],
    ['https://github.com/acme/-/pull/7', gh('acme/-', 7)],
    ['https://gitlab.com/g/pull/p/-/merge_requests/7', gl('g/pull/p', 7, 'gitlab.com')],
    ['https://gitlab.com/g/p/-/merge_requests/3', gl('g/p', 3, 'gitlab.com')],
    ['https://gitlab.com/g/p/-/merge_requests/3/', gl('g/p', 3, 'gitlab.com')],
    ['https://gitlab.com/g/sub/deep/p/-/merge_requests/41', gl('g/sub/deep/p', 41, 'gitlab.com')],
    ['https://gl.example:8443/g/sub/p/-/merge_requests/5', gl('g/sub/p', 5, 'gl.example:8443')],
    ['https://GL.Example/g/p/-/merge_requests/5', gl('g/p', 5, 'gl.example')],
];

export const REJECTED = [
    '',
    'not a url',
    'http://github.com/acme/web/pull/7',
    'ssh://github.com/acme/web/pull/7',
    'https://user@github.com/acme/web/pull/7',
    'https://user:pw@github.com/acme/web/pull/7',
    'https://github.com/acme/web/pull/0',
    'https://github.com/acme/web/pull/-1',
    'https://github.com/acme/web/pull/007',
    'https://github.com/acme/web/pull/1.5',
    'https://github.com/acme/web/pull/2147483648',
    'https://github.com/acme/web/pull/9007199254740991',
    'https://github.com/acme/web/pull/9007199254740992',
    'https://gitlab.com/g/p/-/merge_requests/2147483648',
    'https://github.com/acme/web/pull/',
    'https://github.com/acme/web/pull/7//',
    'https://github.com/acme/web/pull/7/files',
    'https://github.com/acme/web/pull/7?x=1',
    'https://github.com/acme/web/pull/7#c1',
    'https://github.com/acme/web/issues/7',
    'https://github.com/acme/pull/7',
    'https://github.com/a/b/c/pull/7',
    'https://github.com/../web/pull/7',
    'https://github.com/acme/./pull/7',
    'https://github.com/acme/%2e%2e/pull/7',
    'https://github.com/acme/web/pull/7 ',
    ' https://github.com/acme/web/pull/7',
    'https://gitlab.com/g/p/-/merge_requests/0',
    'https://gitlab.com/g/p/-/merge_requests/3/diffs',
    'https://gitlab.com/g/p/-/merge_requests/new',
    'https://gitlab.com/p/-/merge_requests/3',
    'https://gitlab.com/g/p/merge_requests/3',
    'https://gitlab.com/g/../p/-/merge_requests/3',
    'https://../g/p/-/merge_requests/3',
    'https://gitlab.com/-/merge_requests/3',
    'https://gitlab.com/g/p/-/-/merge_requests/3',
    'https://gitlab.com/g/-/p/-/merge_requests/7',
    'https://gitlab.com/g/p/-/pull/3',
    'https://gl.example:abc/g/p/-/merge_requests/3',
];

/** Numbers every formatter refuses: not positive, not an integer, or above INT4. */
export const INVALID_NUMBERS = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2147483648, Number.MAX_SAFE_INTEGER];
