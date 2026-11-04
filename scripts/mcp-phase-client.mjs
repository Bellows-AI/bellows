#!/usr/bin/env node
// The MCP client of `scripts/test-jobs.sh --phase mcp` (BEL-108): a real SDK client that signs a member in through the
// stub identity provider over plain HTTP (a cookie jar, no browser), is sent through the board's real authorization
// server (discovery, registration, PKCE, consent approved with the member's session), then drives a task to its end
// through the MCP tools while a real driver runs the stub runner. It adds no route to the board: the member is signed
// in the way e2e/mcp-connect.spec.ts signs one in, and consent is the same two calls the consent page makes.
//
//   MCP_BOARD=http://127.0.0.1:8130 MCP_RUN_ID=<id the task prints after `mcp-phase-`> node scripts/mcp-phase-client.mjs
//
// stdout: one `ok\t<check>` or `bad\t<check>\t<detail>` line per check, which test-jobs.sh turns into its own.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// The SDK is a dependency of the server workspace (server/package.json), not of the repository root: resolve it from there.
const fromServer = createRequire(new URL('../server/package.json', import.meta.url));
const { Client, StreamableHTTPClientTransport, UnauthorizedError } = await import(
    pathToFileURL(fromServer.resolve('@modelcontextprotocol/client')).href
);

const BOARD = process.env.MCP_BOARD ?? '';
const RUN_ID = process.env.MCP_RUN_ID ?? '';
// What the task prints is joined by printf, so the command text never contains it: finding it in the log proves the runner ran.
const PRINTED = `mcp-phase-${RUN_ID}`;
const SETTLE_SECONDS = Number(process.env.MCP_SETTLE_SECONDS ?? 120);
const WAIT_BUDGET_SECONDS = 20;
const MODERN = '2026-07-28';
const REDIRECT = 'http://127.0.0.1:59174/callback';
const CLIENT_NAME = 'test-jobs mcp phase';
const MAX_HOPS = 10;

const line = (kind, name, detail) =>
    console.log([kind, name, ...(detail === undefined ? [] : [String(detail).replace(/\s+/g, ' ')])].join('\t'));
let failed = false;
const check = (name, passed, detail) => {
    if (passed) line('ok', name);
    else {
        failed = true;
        line('bad', name, detail ?? '');
    }
    return passed;
};

/** A cookie jar over fetch: every hop's Set-Cookie is kept and sent back. */
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
        signal: AbortSignal.timeout(15_000),
        headers: { ...init.headers, cookie: cookieHeader() },
    });
    remember(response);
    return response;
}
/** Follows redirects across the board and the identity provider until a page answers. */
async function follow(url) {
    let current = url;
    for (let i = 0; i < MAX_HOPS; i += 1) {
        const response = await hop(current);
        const next = response.headers.get('location');
        if (response.status < 300 || response.status >= 400 || !next) return response;
        current = new URL(next, current).toString();
    }
    throw new Error(`more than ${MAX_HOPS} redirects from ${url}`);
}

/** An in-memory OAuth client: what the SDK needs for discovery, registration, PKCE and the token exchange. */
function memoryProvider() {
    let information;
    let tokens;
    let verifier = '';
    let discovery;
    const provider = {
        authorizationUrl: undefined,
        redirectUrl: REDIRECT,
        clientMetadata: {
            client_name: CLIENT_NAME,
            redirect_uris: [REDIRECT],
            grant_types: ['authorization_code', 'refresh_token'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            scope: 'factory:read factory:write',
        },
        state: () => 'test-jobs-mcp-state',
        clientInformation: () => information,
        saveClientInformation: (value) => {
            information = value;
        },
        tokens: () => tokens,
        saveTokens: (value) => {
            tokens = value;
        },
        redirectToAuthorization: (url) => {
            provider.authorizationUrl = url;
        },
        saveDiscoveryState: (value) => {
            discovery = value;
        },
        discoveryState: () => discovery,
        saveCodeVerifier: (value) => {
            verifier = value;
        },
        codeVerifier: () => verifier,
    };
    return provider;
}

const resource = new URL(`${BOARD}/api/mcp`);
const transportFor = (provider) => new StreamableHTTPClientTransport(resource, { authProvider: provider });
const newClient = () =>
    new Client({ name: 'test-jobs-mcp', version: '1' }, { versionNegotiation: { mode: { pin: MODERN } } });
const dataOf = (result) => result.structuredContent ?? {};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function signIn() {
    const landed = await follow(`${BOARD}/api/auth/github?returnTo=${encodeURIComponent('/')}`);
    const me = await hop(`${BOARD}/api/auth/me`);
    const who = me.status === 200 ? await me.json() : null;
    check('mcp: the member signs in through the identity provider', Boolean(who?.user?.id), `landed ${landed.status}, me ${me.status}`);
    // The task executors a claim resolves, stored by the member as the board fixture stores the stand-in member's.
    const stored = await hop(`${BOARD}/api/workspace/executors`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', origin: BOARD },
        body: JSON.stringify({
            executors: [
                { name: 'claude', type: 'claude-code', config: {} },
                { name: 'opencode', type: 'opencode', config: {} },
            ],
        }),
    });
    check('mcp: the member stores the task executors', stored.status === 200, `${stored.status}`);
    return who;
}

/** The consent page's two calls: read the transaction out of the redirect's fragment, then approve it as the session. */
async function consent(authorizationUrl) {
    const redirected = await hop(authorizationUrl.toString());
    const location = redirected.headers.get('location') ?? '';
    const fragment = new URLSearchParams(location.split('#')[1] ?? '');
    const id = fragment.get('id');
    const csrf = fragment.get('csrf');
    if (!check('mcp: the authorization endpoint opens a consent transaction for the session', Boolean(id && csrf), `${redirected.status} ${location}`)) return null;
    const approved = await hop(`${BOARD}/api/oauth/consent/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: BOARD },
        body: JSON.stringify({ id, csrf }),
    });
    const answer = approved.status === 200 ? await approved.json() : null;
    if (!check('mcp: the member allows the app', typeof answer?.redirect === 'string', `${approved.status}`)) return null;
    return new URL(answer.redirect).searchParams;
}

async function main() {
    if (!BOARD || !RUN_ID) throw new Error('MCP_BOARD and MCP_RUN_ID are required');

    const challenge = await fetch(resource, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    check(
        'mcp: an unauthenticated call is challenged with the resource metadata',
        challenge.status === 401 && /resource_metadata=/.test(challenge.headers.get('www-authenticate') ?? ''),
        `${challenge.status} ${challenge.headers.get('www-authenticate')}`
    );

    const who = await signIn();
    if (!who) return;

    const provider = memoryProvider();
    const refused = newClient();
    const refusedTransport = transportFor(provider);
    try {
        await refused.connect(refusedTransport);
        check('mcp: the SDK is sent to authorize', false, 'connect succeeded without a token');
        return;
    } catch (e) {
        if (!check('mcp: the SDK is sent to authorize', e instanceof UnauthorizedError && provider.authorizationUrl, String(e))) return;
    } finally {
        await refused.close().catch(() => undefined);
        await refusedTransport.close().catch(() => undefined);
    }

    const callback = await consent(provider.authorizationUrl);
    if (!callback) return;
    const exchange = transportFor(provider);
    try {
        await exchange.finishAuth(callback);
    } finally {
        await exchange.close().catch(() => undefined);
    }
    check('mcp: the SDK exchanges the code for an access token', Boolean(provider.tokens()?.access_token));

    const mcp = newClient();
    try {
        await mcp.connect(transportFor(provider));
        const call = (name, args) => mcp.callTool({ name, arguments: args });

        const repos = dataOf(await call('list_repos', {}));
        const repo = repos.repos?.[0]?.repo;
        if (!check('mcp: list_repos shows the tracked repository', Boolean(repo), JSON.stringify(repos))) return;

        const executors = dataOf(await call('list_executors', {})).executors ?? [];
        const executor = executors.find((e) => e.name === 'claude' && !e.suspended);
        if (!check('mcp: list_executors shows the stored claude executor', Boolean(executor), JSON.stringify(executors))) return;

        const created = await call('create_task', {
            command: `printf '%s-%s\\n' mcp-phase ${RUN_ID}`,
            repo,
            executor: executor.name,
            executorScope: executor.scope,
        });
        const taskId = dataOf(created).id;
        if (taskId) line('id', taskId);
        if (!check('mcp: create_task queues a task', !created.isError && Boolean(taskId), JSON.stringify(created.content))) return;

        // The driver claims it and a stub runner executes it; wait_task is bounded, so it is called until it settles.
        const until = Date.now() + SETTLE_SECONDS * 1000;
        let waited = {};
        let sawTimeout = false;
        while (Date.now() < until) {
            const result = await call('wait_task', { taskId, budgetSeconds: WAIT_BUDGET_SECONDS });
            waited = dataOf(result);
            if (result.isError) {
                check('mcp: wait_task answers', false, JSON.stringify(result.content));
                return;
            }
            if (waited.result !== 'timeout') break;
            sawTimeout = true;
            await sleep(500);
        }
        check('mcp: wait_task ends on the task settling', waited.result === 'succeeded', JSON.stringify(waited));
        check('mcp: the settled task succeeded', waited.status === 'succeeded' && waited.outcome === 'final', JSON.stringify(waited));
        if (sawTimeout) line('ok', 'mcp: wait_task reported its bounded budget while the task ran');

        const result = dataOf(await call('get_task_result', { taskId }));
        check(
            'mcp: get_task_result shows the verified outcome',
            result.taskId === taskId && result.status === 'succeeded' && result.outcome === 'final',
            JSON.stringify(result)
        );

        const log = await call('read_job_log', { jobId: taskId });
        const logged = dataOf(log);
        const text = (logged.segments ?? []).map((segment) => segment.text ?? '').join('');
        check('mcp: read_job_log returns the run log', !log.isError && text.includes(PRINTED), JSON.stringify(logged).slice(0, 400));
    } finally {
        await mcp.close().catch(() => undefined);
    }
}

try {
    await main();
} catch (e) {
    failed = true;
    line('bad', 'mcp: the client ran to its end', e instanceof Error ? e.stack : e);
}
process.exit(failed ? 1 : 0);
