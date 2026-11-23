// The publish-member phase's member (scripts/lanes/jobs/publish-member.sh): signs a member in through the board's
// GitHub sign-in against the fake forge (a cookie jar, no browser), which stores the member's refreshable user grant
// on the board, then stores the task executors and mints a personal token the lane's shell calls the board with.
// Run again, it is the member signing in once more: the grant is replaced, and the lane's broken one is live again.
//   node scripts/publish-member-client.mjs <board url>   -> the personal token on stdout; exit 1 and stderr on a failure
const [BOARD] = process.argv.slice(2);
const MAX_HOPS = 10;
const TIMEOUT_MS = 15_000;
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
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { ...init.headers, cookie: cookieHeader() },
    });
    remember(response);
    return response;
}
/** Follows redirects across the board and the fake forge until a page answers. */
async function follow(url) {
    let current = url;
    for (let i = 0; i < MAX_HOPS; i += 1) {
        const response = await hop(current);
        const location = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !location) return response;
        current = new URL(location, current).toString();
    }
    return fail('too many redirects signing in');
}
const json = { 'content-type': 'application/json', origin: BOARD };

await follow(`${BOARD}/api/auth/github?returnTo=${encodeURIComponent('/')}`);
const me = await hop(`${BOARD}/api/auth/me`);
const who = me.status === 200 ? await me.json() : null;
if (!who?.user?.id) fail(`the sign-in left no session (/api/auth/me answered ${me.status})`);

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
if (executors.status !== 200) fail(`storing the task executors answered ${executors.status}`);

const minted = await hop(`${BOARD}/api/tokens`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ label: 'publish-member' }),
});
const token = minted.status === 201 ? (await minted.json()).token : null;
if (typeof token !== 'string') fail(`minting a personal token answered ${minted.status}`);
process.stdout.write(token);
