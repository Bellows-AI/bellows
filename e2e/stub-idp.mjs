/**
 * A stand-in for github.com's OAuth endpoints (and Atlassian's and Linear's, below), so the browser check can drive a real
 * sign-in.
 *
 * There is no way to complete a genuine GitHub round trip offline, and the alternative — seeding a
 * session cookie straight into the browser context — would need a test-only login route, i.e. a back
 * door living in production code. A stub the server is pointed at through two environment
 * variables (GITHUB_WEB_URL and GITHUB_API_URL) keeps the whole flow real on this side of the wire while nothing leaves the machine.
 *
 * The server logs loudly at boot when these overrides are in use, because a configurable authorize
 * URL that reached a real deployment would be a phishing vector.
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

// playwright.config.ts passes STUB_IDP_PORT; the fallback is the same E2E_PORT_BASE + 2 it derives.
const port = Number(process.env.STUB_IDP_PORT ?? Number(process.env.E2E_PORT_BASE ?? 8123) + 2);
const defaultIdentity = {
    login: process.env.STUB_IDP_LOGIN ?? 'e2e-user',
    id: Number(process.env.STUB_IDP_USER_ID ?? 424242),
};
// Who "consents" next. `POST /_control/identity` with `{ login, id }` signs the next round trip in as another
// account (members.spec.ts: an invited person); an empty body restores the default.
let identity = { ...defaultIdentity };
// The installations the account can see — the membership decision. Comma-separated ids;
// each becomes an organization named after `stub-org-<id>` at sign-in.
const installations = (process.env.STUB_IDP_INSTALLATIONS ?? '999999')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));

const json = (response, body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
};

// ── Atlassian (Jira 3LO) ──
// The same arrangement for the connection flow: the board's ATLASSIAN_*_URL overrides point at
// /atlassian/*. Nobody is here to consent either, so the consent screen redirects straight back as
// whichever account `POST /atlassian/_control` last selected (`a` or `b`), or with access_denied.
// The code and the tokens remember that account and the scope the board asked for, because the
// accessible-resources answer reports the granted scope and the board stores that, not the request.
const ATLASSIAN_SITE = 'e2e-site.atlassian.net';
const atlassian = { account: 'a', deny: false, counter: 0, codes: new Map(), tokens: new Map(), refresh: new Map() };

const readJson = (request) =>
    new Promise((resolve) => {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => resolve(raw ? JSON.parse(raw) : {}));
    });

const issueTokens = (grant) => {
    atlassian.counter += 1;
    const access = `stub-at-${atlassian.counter}`;
    const refresh = `stub-rt-${atlassian.counter}`;
    atlassian.tokens.set(access, grant);
    atlassian.refresh.set(refresh, grant);
    return { access_token: access, expires_in: 3600, refresh_token: refresh, scope: grant.scope };
};

async function atlassianRoute(url, request, response) {
    if (url.pathname === '/atlassian/_control' && request.method === 'POST') {
        const body = await readJson(request);
        if (body.account === 'a' || body.account === 'b') atlassian.account = body.account;
        atlassian.deny = body.deny === true;
        json(response, { account: atlassian.account, deny: atlassian.deny });
        return true;
    }
    if (url.pathname === '/atlassian/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        if (atlassian.deny) {
            back.searchParams.set('error', 'access_denied');
        } else {
            atlassian.counter += 1;
            const code = `stub-code-${atlassian.counter}`;
            atlassian.codes.set(code, { account: atlassian.account, scope: url.searchParams.get('scope') ?? '' });
            back.searchParams.set('code', code);
        }
        response.writeHead(302, { location: back.toString() });
        response.end();
        return true;
    }
    if (url.pathname === '/atlassian/oauth/token' && request.method === 'POST') {
        const body = await readJson(request);
        const grant =
            body.grant_type === 'refresh_token'
                ? atlassian.refresh.get(body.refresh_token)
                : atlassian.codes.get(body.code);
        if (!grant) json(response, { error: 'invalid_grant' }, 400);
        else json(response, issueTokens(grant));
        return true;
    }
    if (url.pathname.startsWith('/atlassian/api/')) {
        const grant = atlassian.tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
        if (!grant) json(response, { code: 401 }, 401);
        else if (url.pathname.endsWith('/oauth/token/accessible-resources')) {
            json(response, [
                {
                    id: 'cloud-e2e',
                    url: `https://${ATLASSIAN_SITE}`,
                    name: 'e2e-site',
                    scopes: grant.scope.split(' ').filter(Boolean),
                    avatarUrl: null,
                },
            ]);
        } else if (url.pathname.endsWith('/rest/api/3/myself')) {
            json(response, {
                accountId: `stub-account-${grant.account}`,
                displayName: `Stub Account ${grant.account.toUpperCase()}`,
                emailAddress: `stub-account-${grant.account}@example.com`,
            });
        } else json(response, {}, 404);
        return true;
    }
    return false;
}

// ── Linear (OAuth2, actor=user) ──
// The board's LINEAR_AUTHORIZE_URL points at /linear/authorize and LINEAR_API_URL at /linear, so the token,
// revoke and GraphQL endpoints are /linear/oauth/token, /linear/oauth/revoke and /linear/graphql. Consent
// redirects straight back as the account `POST /linear/_control` selected (`a` or `b`), or with access_denied.
// The token call is form-encoded and checks the S256 verifier; every refresh issues a NEW refresh token and
// spends the old one, as Linear does. `_control` answers what authorize and revoke recorded.
const LINEAR_WORKSPACE = 'e2e-workspace';
const linear = {
    account: 'a',
    deny: false,
    counter: 0,
    codes: new Map(),
    tokens: new Map(),
    refresh: new Map(),
    authorized: [],
    revoked: [],
};

const readForm = (request) =>
    new Promise((resolve) => {
        let raw = '';
        request.on('data', (chunk) => (raw += chunk));
        request.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
    });

const linearTokens = (grant) => {
    linear.counter += 1;
    const access = `stub-lin-at-${linear.counter}`;
    const refresh = `stub-lin-rt-${linear.counter}`;
    linear.tokens.set(access, grant);
    linear.refresh.set(refresh, grant);
    return {
        access_token: access,
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: refresh,
        scope: grant.scopes,
    };
};

const linearState = () => ({
    account: linear.account,
    deny: linear.deny,
    authorized: linear.authorized,
    revoked: linear.revoked,
});

async function linearRoute(url, request, response) {
    if (url.pathname === '/linear/_control') {
        if (request.method === 'POST') {
            const body = await readJson(request);
            if (body.account === 'a' || body.account === 'b') linear.account = body.account;
            linear.deny = body.deny === true;
        }
        json(response, linearState());
        return true;
    }
    if (url.pathname === '/linear/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        const scope = url.searchParams.get('scope') ?? '';
        const challenge = url.searchParams.get('code_challenge') ?? '';
        linear.authorized.push({ scope, codeChallenge: challenge });
        if (linear.deny) {
            back.searchParams.set('error', 'access_denied');
        } else {
            linear.counter += 1;
            const code = `stub-lin-code-${linear.counter}`;
            const scopes = scope.split(',').filter(Boolean);
            linear.codes.set(code, { account: linear.account, scopes, challenge });
            back.searchParams.set('code', code);
        }
        response.writeHead(302, { location: back.toString() });
        response.end();
        return true;
    }
    if (url.pathname === '/linear/oauth/token' && request.method === 'POST') {
        const form = await readForm(request);
        if (form.grant_type === 'refresh_token') {
            const grant = linear.refresh.get(form.refresh_token);
            linear.refresh.delete(form.refresh_token);
            if (!grant) json(response, { error: 'invalid_grant' }, 400);
            else json(response, linearTokens(grant));
            return true;
        }
        const grant = linear.codes.get(form.code);
        linear.codes.delete(form.code);
        const verified =
            grant &&
            createHash('sha256')
                .update(form.code_verifier ?? '')
                .digest('base64url') === grant.challenge;
        if (!verified) json(response, { error: 'invalid_grant' }, 400);
        else json(response, linearTokens({ account: grant.account, scopes: grant.scopes }));
        return true;
    }
    if (url.pathname === '/linear/oauth/revoke' && request.method === 'POST') {
        const form = await readForm(request);
        linear.revoked.push(form.token ?? '');
        linear.refresh.delete(form.token);
        linear.tokens.delete(form.token);
        response.writeHead(200);
        response.end();
        return true;
    }
    if (url.pathname === '/linear/graphql' && request.method === 'POST') {
        const grant = linear.tokens.get((request.headers.authorization ?? '').replace(/^Bearer /, ''));
        await readJson(request);
        if (!grant) {
            json(response, {
                errors: [{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } }],
            });
            return true;
        }
        json(response, {
            data: {
                viewer: {
                    id: `stub-linear-user-${grant.account}`,
                    name: `Stub Linear ${grant.account.toUpperCase()}`,
                    email: `stub-linear-${grant.account}@example.com`,
                    organization: { id: 'stub-linear-org', name: 'E2E Workspace', urlKey: LINEAR_WORKSPACE },
                },
            },
        });
        return true;
    }
    return false;
}

// ── GitHub App user authorization ──
// The App's code exchange answers an access token (8 h) AND a refresh token (6 months). A refresh answers a NEW pair
// and spends the old refresh token, as GitHub does; a spent or unknown one is `bad_refresh_token`, reported with a 200
// like every GitHub token error. `POST /_control/github` steers it: `{ refreshFailure: 'bad_refresh_token' | 'server_error' }`
// makes the next refreshes fail that way until `{}` clears it, `{ noRefreshToken: true }` answers an exchange without
// a refresh token (the App's expiry setting off), and `GET` reports every refresh call it saw.
const githubTokens = {
    counter: 0,
    refresh: new Map(),
    refreshFailure: null,
    noRefreshToken: false,
    refreshCalls: [],
};

const issueGithubPair = (account) => {
    githubTokens.counter += 1;
    const n = githubTokens.counter;
    githubTokens.refresh.set(`ghr_stub_${n}`, account);
    return {
        access_token: `ghu_stub_${n}`,
        expires_in: 28800,
        refresh_token: `ghr_stub_${n}`,
        refresh_token_expires_in: 15811200,
        token_type: 'bearer',
        scope: '',
    };
};

async function githubTokenRoute(response, body) {
    if (body.grant_type === 'refresh_token') {
        githubTokens.refreshCalls.push(body.refresh_token ?? '');
        if (githubTokens.refreshFailure === 'server_error') {
            json(response, { message: 'stub upstream failure' }, 502);
            return;
        }
        const account = githubTokens.refresh.get(body.refresh_token);
        if (githubTokens.refreshFailure === 'bad_refresh_token' || !account) {
            json(response, {
                error: 'bad_refresh_token',
                error_description: 'The refresh token passed is incorrect or expired.',
            });
            return;
        }
        githubTokens.refresh.delete(body.refresh_token);
        json(response, issueGithubPair(account));
        return;
    }
    if (githubTokens.noRefreshToken) {
        json(response, { access_token: 'ghu_stub_no_refresh', token_type: 'bearer' });
        return;
    }
    json(response, issueGithubPair(identity.id));
}

createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);

    if (url.pathname.startsWith('/atlassian/') && (await atlassianRoute(url, request, response))) return;
    if (url.pathname.startsWith('/linear/') && (await linearRoute(url, request, response))) return;

    if (url.pathname === '/_control/github') {
        if (request.method === 'POST') {
            const body = await readJson(request);
            githubTokens.refreshFailure = body.refreshFailure ?? null;
            githubTokens.noRefreshToken = body.noRefreshToken === true;
        }
        json(response, {
            refreshFailure: githubTokens.refreshFailure,
            noRefreshToken: githubTokens.noRefreshToken,
            refreshCalls: githubTokens.refreshCalls,
        });
        return;
    }

    if (url.pathname === '/_control/identity' && request.method === 'POST') {
        const body = await readJson(request);
        identity =
            typeof body.login === 'string' && Number.isInteger(body.id)
                ? { login: body.login, id: body.id }
                : { ...defaultIdentity };
        json(response, identity);
        return;
    }

    // GitHub's consent screen. Nobody is here to consent, so it redirects straight back — echoing
    // the state it was given, which is what the callback checks against the browser's cookie.
    if (url.pathname === '/login/oauth/authorize') {
        const back = new URL(url.searchParams.get('redirect_uri'));
        back.searchParams.set('code', 'stub-code');
        back.searchParams.set('state', url.searchParams.get('state') ?? '');
        response.writeHead(302, { location: back.toString() });
        response.end();
        return;
    }

    if (url.pathname === '/login/oauth/access_token' && request.method === 'POST') {
        await githubTokenRoute(response, await readJson(request));
        return;
    }

    if (url.pathname === '/user') {
        // The numeric id is the identity; the login is only a label. Both are pinned here so the
        // seeded data and the account that signs in are the same person.
        json(response, { id: identity.id, login: identity.login, name: 'E2E User', avatar_url: null });
        return;
    }

    // The membership decision itself: what the callback asks with the exchanged token.
    if (url.pathname === '/user/installations') {
        json(response, {
            installations: installations.map((id) => ({ id: Number(id), account: { login: `stub-org-${id}` } })),
        });
        return;
    }

    // The App slug, for building the install-page redirect. The offline board never asks (it has
    // no App client), but the seam keeps a future online check honest.
    if (url.pathname === '/app') {
        json(response, { slug: 'stub-app' });
        return;
    }

    response.writeHead(404);
    response.end();
}).listen(port, '127.0.0.1', () => {
    console.log(`[stub-idp] listening on 127.0.0.1:${port} as ${identity.login} (#${identity.id})`);
});
