// The lanes' fake forge: one HTTP server a forge's REST routes plug into (github.mjs today).
// A host and lane tool, never a container script. What every forge shares lives here: a token table
// with expiry on an injectable clock, a record of which kind of token made each call, and the hold
// that lets a lane park a call until it says go.
//   <stateDir>/calls.jsonl   one `{method, path, tokenKind, tokenId, holder, status}` line per answered call;
//                            tokenId names the token (a hash, never the token) so a lane can tell a refreshed one from its predecessor
//   <stateDir>/hold          while it exists, a holdable call touches hold.ready and waits for hold.go
// The `/_control/*` routes (clock, calls, installation tokens) are the lane's own door; no forge uses them.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { join } from 'node:path';
import { registerGithub, USER_TOKEN_TTL_S } from './github.mjs';
import { GITLAB_CODE_TTL_S, GITLAB_TOKEN_TTL_S, registerGitlab } from './gitlab.mjs';

export { GITLAB_CODE_TTL_S, GITLAB_TOKEN_TTL_S, USER_TOKEN_TTL_S };
const HOLD_POLL_MS = 50;
const HOLD_DEADLINE_MS = 600_000;

/** A stable, non-reversible name for a token: what the call log records in its place. */
const tokenIdOf = (value) => `tok_${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;

/** The credential a request presents: Bearer or `token` (GitHub's), PRIVATE-TOKEN (GitLab's), or Basic `oauth2:<token>` (git). */
const credentialOf = (request) => {
    const authorization = request.headers.authorization ?? '';
    const bearer = /^(?:Bearer|token) (.+)$/i.exec(authorization)?.[1];
    if (bearer) return bearer;
    const privateToken = request.headers['private-token'];
    if (typeof privateToken === 'string' && privateToken) return privateToken;
    const basic = /^Basic (.+)$/i.exec(authorization)?.[1];
    if (!basic) return undefined;
    const [user, ...rest] = Buffer.from(basic, 'base64').toString().split(':');
    return user === 'oauth2' ? rest.join(':') || undefined : undefined;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ stateDir: string, now?: () => number, routes?: Array<(forge: object) => void>, tls?: { cert: string, key: string } }} options
 * `tls` serves https with that certificate (a GitLab's git and OAuth are https-only for the runner and the board).
 * `now` is the clock; `advance(ms)` moves it forward so a lane can expire a token without waiting.
 */
export const createFakeForge = ({ stateDir, now = Date.now, routes = [registerGithub, registerGitlab], tls = null }) => {
    mkdirSync(stateDir, { recursive: true });
    let offsetMs = 0;
    const clock = () => now() + offsetMs;
    /** token -> { kind: 'user' | 'installation', login, expiresAt (ms, or null) } */
    const tokens = new Map();
    const callLog = [];
    const table = [];
    const streams = [];
    let counter = 0;

    const forge = {
        stateDir,
        clock,
        tokens,
        nextId: () => ++counter,
        tokenId: tokenIdOf,
        /** Add a line to the call log that no plain HTTP answer made (a push the forge saw through). */
        record: (entry) => {
            callLog.push(entry);
            appendFileSync(join(stateDir, 'calls.jsonl'), `${JSON.stringify(entry)}\n`);
        },
        /**
         * Register `handler({ request, response, url, token, tokenKind, credential, match })` for the paths `pattern` matches,
         * whatever the method. It runs before the body is read, so it takes the raw request stream; the credential
         * check is its own (`token` is the holder, or null).
         */
        stream: (pattern, handler) => streams.push({ pattern, handler }),
        json: (response, status, body) => {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(body));
        },
        /**
         * Register `handler({ request, response, url, params, query, body, token })` for a method and a `:param` path.
         * `deny` is the 401 body a forge answers an unauthenticated call with. `before({ request, response, url })` runs
         * ahead of the credential check and answers the call itself (returning true) or lets it through.
         */
        route: (method, pattern, handler, { auth = true, holdable = false, deny = { message: 'Bad credentials' }, before = null } = {}) => {
            const keys = [];
            const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)'))}$`);
            table.push({ method, regex, keys, handler, auth, holdable, deny, before });
        },
        /** The token's holder, or null when it is unknown or past its expiry. */
        resolve: (value) => {
            const token = tokens.get(value);
            if (!token || (token.expiresAt !== null && token.expiresAt <= clock())) return null;
            return token;
        },
        /** Park the call while `hold` exists: touch hold.ready, wait for hold.go. */
        hold: async () => {
            if (!existsSync(join(stateDir, 'hold'))) return;
            appendFileSync(join(stateDir, 'hold.ready'), '');
            const deadline = Date.now() + HOLD_DEADLINE_MS;
            while (!existsSync(join(stateDir, 'hold.go'))) {
                if (Date.now() > deadline) return;
                await sleep(HOLD_POLL_MS);
            }
        },
    };
    for (const register of routes) register(forge);

    const mintInstallationToken = () => {
        const value = `ghs_fake${forge.nextId()}`;
        tokens.set(value, { kind: 'installation', login: 'app[bot]', expiresAt: null });
        return value;
    };

    forge.route('POST', '/_control/installation-token', (ctx) =>
        forge.json(ctx.response, 200, { token: mintInstallationToken() }), { auth: false });
    forge.route('POST', '/_control/clock', (ctx) => {
        offsetMs += Number(ctx.body.advanceMs ?? 0);
        forge.json(ctx.response, 200, { now: clock() });
    }, { auth: false });
    forge.route('GET', '/_control/calls', (ctx) => forge.json(ctx.response, 200, callLog), { auth: false });

    const readBody = (request) =>
        new Promise((resolve) => {
            let raw = '';
            request.on('data', (chunk) => (raw += chunk));
            request.on('end', () => {
                if (!raw) return resolve({});
                try {
                    resolve(
                        String(request.headers['content-type']).includes('json')
                            ? JSON.parse(raw)
                            : Object.fromEntries(new URLSearchParams(raw))
                    );
                } catch {
                    resolve({});
                }
            });
        });

    const onRequest = (request, response) => {
        // A handler that rejects answers 500 (when nothing was sent yet) and never takes the process down.
        dispatch(request, response).catch(() => {
            if (!response.headersSent) forge.json(response, 500, { message: '500 Internal Server Error' });
            else response.destroy();
        });
    };
    const server = tls ? createTlsServer(tls, onRequest) : createServer(onRequest);
    async function dispatch(request, response) {
        const url = new URL(request.url, 'http://fake-forge');
        const credential = credentialOf(request);
        const holder = credential ? forge.resolve(credential) : null;
        const tokenKind = holder ? holder.kind : 'none';
        let status = 404;
        response.on('finish', () => {
            status = response.statusCode;
            forge.record({
                method: request.method,
                path: url.pathname,
                tokenKind,
                tokenId: holder ? tokenIdOf(credential) : null,
                holder: holder ? holder.login : null,
                status,
            });
        });
        for (const { pattern, handler } of streams) {
            const match = pattern.exec(url.pathname);
            if (match) return handler({ request, response, url, token: holder, tokenKind, credential, match });
        }
        const body = await readBody(request);
        for (const { method, regex, keys, handler, auth, holdable, deny, before } of table) {
            const match = method === request.method ? regex.exec(url.pathname) : null;
            if (!match) continue;
            if (before?.({ request, response, url })) return;
            if (auth && !holder) return forge.json(response, 401, deny);
            const params = Object.fromEntries(keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
            if (holdable) await forge.hold();
            return handler({
                request,
                response,
                url,
                params,
                query: Object.fromEntries(url.searchParams),
                body,
                token: holder,
                tokenKind,
            });
        }
        return forge.json(response, 404, { message: 'Not Found' });
    }

    return {
        listen: (port, host = '127.0.0.1') =>
            new Promise((resolve) => server.listen(port, host, () => resolve(server.address().port))),
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve());
            }),
        calls: () => callLog.slice(),
        advance: (ms) => {
            offsetMs += ms;
        },
        mintInstallationToken,
    };
};

// `node server.mjs <state dir> [port]` serves the lane: the port is printed once it listens. FAKE_FORGE_TLS_CERT and
// FAKE_FORGE_TLS_KEY (PEM files) make it https.
if (import.meta.url === `file://${process.argv[1]}`) {
    const [stateDir, port = '0'] = process.argv.slice(2);
    const { FAKE_FORGE_TLS_CERT: cert, FAKE_FORGE_TLS_KEY: key } = process.env;
    const forge = createFakeForge({
        stateDir,
        ...(cert && key ? { tls: { cert: readFileSync(cert), key: readFileSync(key) } } : {}),
    });
    console.log(await forge.listen(Number(port), process.env.FAKE_FORGE_HOST ?? '127.0.0.1'));
}
