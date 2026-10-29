/**
 * A stand-in for github.com's OAuth endpoints (and Atlassian's, below), so the browser check can drive a real sign-in.
 *
 * There is no way to complete a genuine GitHub round trip offline, and the alternative — seeding a
 * session cookie straight into the browser context — would need a test-only login route, i.e. a back
 * door living in production code. A stub the server is pointed at through three environment
 * variables keeps the whole flow real on this side of the wire while nothing leaves the machine.
 *
 * The server logs loudly at boot when these overrides are in use, because a configurable authorize
 * URL that reached a real deployment would be a phishing vector.
 */
import { createServer } from 'node:http';

// playwright.config.ts passes STUB_IDP_PORT; the fallback is the same E2E_PORT_BASE + 2 it derives.
const port = Number(process.env.STUB_IDP_PORT ?? Number(process.env.E2E_PORT_BASE ?? 8123) + 2);
const login = process.env.STUB_IDP_LOGIN ?? 'e2e-user';
const userId = Number(process.env.STUB_IDP_USER_ID ?? 424242);
// The installations the account can see (#99) — the membership decision. Comma-separated ids;
// each becomes an organization named after `stub-org-<id>` at sign-in.
const installations = (process.env.STUB_IDP_INSTALLATIONS ?? '999999')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id));

const json = (response, body, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
};

// ── Atlassian (Jira 3LO), BEL-61 ──
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

createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);

    if (url.pathname.startsWith('/atlassian/') && (await atlassianRoute(url, request, response))) return;

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

    if (url.pathname === '/login/oauth/access_token') {
        json(response, { access_token: 'stub-access-token', token_type: 'bearer' });
        return;
    }

    if (url.pathname === '/user') {
        // The numeric id is the identity; the login is only a label. Both are pinned here so the
        // seeded data and the account that signs in are the same person.
        json(response, { id: userId, login, name: 'E2E User', avatar_url: null });
        return;
    }

    // The membership decision itself: what the callback asks with the exchanged token (#99).
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
    console.log(`[stub-idp] listening on 127.0.0.1:${port} as ${login} (#${userId})`);
});
