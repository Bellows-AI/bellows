// The publish-member phase's member (scripts/lanes/jobs/publish-member.sh): signs a member in through the board's
// GitHub sign-in against the fake forge (a cookie jar, no browser), which stores the member's refreshable user grant
// on the board, then stores the task executors and mints a personal token the lane's shell calls the board with.
// Run again, it is the member signing in once more: the grant is replaced, and the lane's broken one is live again.
// With a <login> the member signs in as that identity registered at the fake (`POST /_control/github/members`):
// the client adds GitHub's own `login` hint to the authorize hop. FAKE_FORGE_REACH_URL is where this shell reaches the
// fake when the board's URL for it does not resolve here (the lane's port-forward). The client then checks the board
// kept the sign-in: /api/auth/me names the login and the GitHub grant stands `live`.
//   node scripts/publish-member-client.mjs <board url> [login]   -> the personal token on stdout; exit 1 and stderr on a failure
const [BOARD, LOGIN] = process.argv.slice(2);
const REACH = process.env.FAKE_FORGE_REACH_URL;
const AUTHORIZE_PATH = '/login/oauth/authorize';
const BOARD_CALLBACK_PATH = '/api/auth/github/callback';
const GITHUB_FORGE = 'github';
const STANDING_LIVE = 'live';
const MAX_HOPS = 10;
const TIMEOUT_MS = 15_000;
const DEADLINE_MS = 60_000;
const deadline = AbortSignal.timeout(DEADLINE_MS);
const fail = (message) => {
    console.error(`publish-member-client: ${message}`);
    process.exit(1);
};
if (!BOARD) fail('a board url is required');

const jar = new Map();
const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
function remember(response) {
    for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';');
        const at = pair.indexOf('=');
        const name = pair.slice(0, at).trim();
        const value = pair.slice(at + 1).trim();
        if (value === '' || /;\s*max-age=0/i.test(cookie)) jar.delete(name);
        else jar.set(name, value);
    }
}
async function hop(url, init = {}) {
    const response = await fetch(url, {
        ...init,
        redirect: 'manual',
        signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), deadline]),
        headers: { ...init.headers, cookie: cookieHeader() },
    });
    remember(response);
    return response;
}
/** The hops this shell must send elsewhere: the authorize hop carries the login and the reach host, the callback goes to the board. */
function rewrite(url) {
    if (url.pathname === AUTHORIZE_PATH) {
        if (REACH) {
            const reachable = new URL(REACH);
            url.protocol = reachable.protocol;
            url.host = reachable.host;
        }
        if (LOGIN) url.searchParams.set('login', LOGIN);
    } else if (url.pathname === BOARD_CALLBACK_PATH) {
        const board = new URL(BOARD);
        url.protocol = board.protocol;
        url.host = board.host;
    }
    return url;
}
/** Follows redirects across the board and the fake forge until a page answers. */
async function follow(url) {
    let current = url;
    for (let i = 0; i < MAX_HOPS; i += 1) {
        const response = await hop(current);
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) return response;
        current = rewrite(new URL(location, current)).toString();
    }
    return fail('too many redirects signing in');
}
const json = { 'content-type': 'application/json', origin: BOARD };

// Every read below is confirmed or the mint fails: a status, a timeout or a body that does not say so is no sign-in.
async function read(path) {
    const response = await hop(`${BOARD}${path}`);
    const text = await response.text();
    if (response.status !== 200) fail(`${path} answered ${response.status}: ${text.slice(0, 300)}`);
    try {
        return JSON.parse(text);
    } catch {
        return fail(`${path} answered a body that is not JSON: ${text.slice(0, 300)}`);
    }
}
try {
    await follow(`${BOARD}/api/auth/github?returnTo=${encodeURIComponent('/')}`);
    const who = await read('/api/auth/me');
    if (!who?.user?.id) fail('the sign-in left no session (/api/auth/me named no user)');
    if (LOGIN && who.user.login !== LOGIN) fail(`the sign-in is ${who.user.login}, not ${LOGIN}`);
    const grants = await read('/api/forge-grants');
    const github = Array.isArray(grants?.grants) ? grants.grants.find((grant) => grant.forge === GITHUB_FORGE) : undefined;
    if (github?.standing !== STANDING_LIVE) {
        fail(`the board kept no live GitHub grant (/api/forge-grants: ${JSON.stringify(grants).slice(0, 300)})`);
    }
} catch (error) {
    fail(`signing in failed: ${error instanceof Error ? error.message : String(error)}`);
}

const executors = await hop(`${BOARD}/api/workspace/executors`, {
    method: 'PUT',
    headers: json,
    body: JSON.stringify({
        executors: [
            { name: 'claude', type: 'claude-code', config: {} },
            { name: 'opencode', type: 'opencode', config: {} },
        ],
    }),
});
// A second member of an org is no admin and the org's first member stored the executors already: a refusal is confirmed.
if (executors.status !== 200 && executors.status !== 403) fail(`storing the task executors answered ${executors.status}`);

const minted = await hop(`${BOARD}/api/tokens`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ label: 'publish-member' }),
});
const token = minted.status === 201 ? (await minted.json()).token : null;
if (typeof token !== 'string') fail(`minting a personal token answered ${minted.status}`);
process.stdout.write(token);
