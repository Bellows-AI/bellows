// The lanes' fake forge: one HTTP server a forge's REST routes plug into (github.mjs today).
// A host and lane tool, never a container script. What every forge shares lives here: a token table
// with expiry on an injectable clock, a record of which kind of token made each call, and the hold
// that lets a lane park a call until it says go.
//   <stateDir>/calls.jsonl   one `{method, path, tokenKind, status}` line per answered call
//   <stateDir>/hold          while it exists, a holdable call touches hold.ready and waits for hold.go
// The `/_control/*` routes (clock, calls, installation tokens) are the lane's own door; no forge uses them.
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { registerGithub, USER_TOKEN_TTL_S } from './github.mjs';

export { USER_TOKEN_TTL_S };
const HOLD_POLL_MS = 50;
const HOLD_DEADLINE_MS = 600_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ stateDir: string, now?: () => number, routes?: Array<(forge: object) => void> }} options
 * `now` is the clock; `advance(ms)` moves it forward so a lane can expire a token without waiting.
 */
export const createFakeForge = ({ stateDir, now = Date.now, routes = [registerGithub] }) => {
    mkdirSync(stateDir, { recursive: true });
    let offsetMs = 0;
    const clock = () => now() + offsetMs;
    /** token -> { kind: 'user' | 'installation', login, expiresAt (ms, or null) } */
    const tokens = new Map();
    const callLog = [];
    const table = [];
    let counter = 0;

    const forge = {
        stateDir,
        clock,
        tokens,
        nextId: () => ++counter,
        json: (response, status, body) => {
            response.writeHead(status, { 'content-type': 'application/json' });
            response.end(JSON.stringify(body));
        },
        /** Register `handler({ request, response, url, params, query, body, token })` for a method and a `:param` path. */
        route: (method, pattern, handler, { auth = true, holdable = false } = {}) => {
            const keys = [];
            const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => (keys.push(key), '([^/]+)'))}$`);
            table.push({ method, regex, keys, handler, auth, holdable });
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

    const server = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://fake-forge');
        const bearer = /^(?:Bearer|token) (.+)$/i.exec(request.headers.authorization ?? '')?.[1];
        const holder = bearer ? forge.resolve(bearer) : null;
        const tokenKind = holder ? holder.kind : 'none';
        let status = 404;
        response.on('finish', () => {
            status = response.statusCode;
            const entry = { method: request.method, path: url.pathname, tokenKind, status };
            callLog.push(entry);
            appendFileSync(join(stateDir, 'calls.jsonl'), `${JSON.stringify(entry)}\n`);
        });
        const body = await readBody(request);
        for (const { method, regex, keys, handler, auth, holdable } of table) {
            const match = method === request.method ? regex.exec(url.pathname) : null;
            if (!match) continue;
            if (auth && !holder) return forge.json(response, 401, { message: 'Bad credentials' });
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
    });

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

// `node server.mjs <state dir> [port]` serves the lane: the port is printed once it listens.
if (import.meta.url === `file://${process.argv[1]}`) {
    const [stateDir, port = '0'] = process.argv.slice(2);
    const forge = createFakeForge({ stateDir });
    console.log(await forge.listen(Number(port), process.env.FAKE_FORGE_HOST ?? '127.0.0.1'));
}
