import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitlabApi } from '../src/gitlab/gitlab-api.js';

/** The unauthenticated reachability probe: a bounded, CA-aware GET of the instance's `/api/v4/version`. */

const listen = (server: Server) =>
    new Promise<string>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(`127.0.0.1:${(server.address() as AddressInfo).port}`))
    );

let tls: { host: string; ca: string; close: () => void };
const plain: Server[] = [];

beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitlab-ca-'));
    execFileSync(
        'openssl',
        [
            ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=gitlab.test'],
            ...['-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')],
        ],
        { stdio: 'ignore' }
    );
    const cert = readFileSync(join(dir, 'c.pem'), 'utf8');
    const server = createHttpsServer({ key: readFileSync(join(dir, 'k.pem')), cert }, (_req, res) => {
        res.writeHead(401, { 'content-type': 'application/json' }).end('{"message":"401 Unauthorized"}');
    });
    tls = { host: await listen(server), ca: cert, close: () => server.close() };
});
afterAll(() => {
    tls.close();
    for (const server of plain) server.close();
});

const httpApi = () => createGitlabApi({ baseUrl: (host) => `http://${host}`, probeTimeoutMs: 300 });
const serve = async (handler: Parameters<typeof createServer>[1]) => {
    const server = createServer(handler);
    plain.push(server);
    return listen(server);
};

describe('createGitlabApi.probe', () => {
    it('trusts the CA bundle it is given and refuses a certificate it was not', async () => {
        const api = createGitlabApi({ probeTimeoutMs: 2000 });
        expect(await api.probe({ host: tls.host, caBundle: tls.ca })).toEqual({ reachable: true, version: null });
        expect(await api.probe({ host: tls.host })).toEqual({ reachable: false, reason: 'tls' });
    });

    it('reads the version off a 200 and a 401 JSON answer as reachable', async () => {
        const open = await serve((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"17.4.0"}');
        });
        expect(await httpApi().probe({ host: open })).toEqual({ reachable: true, version: '17.4.0' });
    });

    it('classifies a 5xx, a malformed answer, a hang and a refused connection, each with its reason', async () => {
        const api = httpApi();
        const five = await serve((_req, res) => void res.writeHead(502).end('bad gateway'));
        const html = await serve((_req, res) => void res.writeHead(200).end('<html>login</html>'));
        const hang = await serve(() => {});
        expect(await api.probe({ host: five })).toEqual({ reachable: false, reason: 'server-error' });
        expect(await api.probe({ host: html })).toEqual({ reachable: false, reason: 'malformed' });
        expect(await api.probe({ host: hang })).toEqual({ reachable: false, reason: 'timeout' });
        const closed = await serve(() => {});
        plain.at(-1)?.close();
        expect(await api.probe({ host: closed })).toEqual({ reachable: false, reason: 'unreachable' });
    });

    it.each(['example.test:65536', 'example.test:0', 'example.test:99999999'])(
        'answers unreachable, never throws, for a host no URL can name (%s)',
        async (host) => {
            expect(await createGitlabApi().probe({ host })).toEqual({ reachable: false, reason: 'unreachable' });
        }
    );
});

describe('createGitlabApi.checkVersion', () => {
    const answer = (status: number, body: string) => async () =>
        serve((_req, res) => void res.writeHead(status, { 'content-type': 'application/json' }).end(body));
    const check = async (host: string) => httpApi().checkVersion({ host, token: 'tok' });

    it('presents the token and accepts the minimum version and above, however the build is suffixed', async () => {
        let seen = '';
        const host = await serve((req, res) => {
            seen = String(req.headers.authorization);
            res.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"17.0.0-ee"}');
        });
        expect(await check(host)).toEqual({ ok: true, version: '17.0.0-ee' });
        expect(seen).toBe('Bearer tok');
        expect(await check(await answer(200, '{"version":"18.2.1"}')())).toMatchObject({ ok: true });
    });

    it('refuses a version below the minimum with its verdict', async () => {
        expect(await check(await answer(200, '{"version":"16.11.9"}')())).toEqual({
            ok: false,
            reason: 'too-old',
            version: '16.11.9',
        });
    });

    it.each([
        ['a refused token', 401, '{"message":"401 Unauthorized"}'],
        ['a 5xx', 503, '{"message":"down"}'],
        ['a body that is not JSON', 200, '<html>'],
        ['a version that is not one', 200, '{"version":"next"}'],
    ])('is inconclusive on %s, never a verdict', async (_name, status, body) => {
        expect(await check(await answer(status, body)())).toEqual({ ok: false, reason: 'inconclusive' });
    });

    it('is inconclusive when nothing answers or the caller gives up', async () => {
        const hang = await serve(() => undefined);
        expect(await check(hang)).toEqual({ ok: false, reason: 'inconclusive' });
        const aborted = AbortSignal.abort();
        expect(await httpApi().checkVersion({ host: hang, token: 'tok', signal: aborted })).toEqual({
            ok: false,
            reason: 'inconclusive',
        });
    });
});

describe('createGitlabApi.request: whether the request was sent', () => {
    it('says a refused connection never sent, and a hang or a cut answer did', async () => {
        const api = httpApi();
        const refused = await api.request({ host: '127.0.0.1:1', path: '/oauth/token', method: 'POST', body: '{}' });
        expect(refused).toEqual({ ok: false, reason: 'unreachable', sent: false });
        const hang = await serve(() => undefined);
        expect(await api.request({ host: hang, path: '/oauth/token', method: 'POST', body: '{}' })).toEqual({
            ok: false,
            reason: 'timeout',
            sent: true,
        });
        const cut = await serve((req) => void req.socket.destroy());
        expect(await api.request({ host: cut, path: '/oauth/token', method: 'POST', body: '{}' })).toMatchObject({
            ok: false,
            sent: true,
        });
    });
});

describe('createGitlabApi.request: no connection is reused', () => {
    it('sends every request on its own connection, so a deadline after a warm-up still counts as sent', async () => {
        const sockets = new Set<unknown>();
        const received: string[] = [];
        const host = await serve((req, res) => {
            sockets.add(req.socket);
            received.push(`${req.method} ${req.url}`);
            // The warm-up is answered; the refresh is processed and never answered.
            if (req.method === 'GET') res.writeHead(200, { connection: 'keep-alive' }).end('{}');
        });
        const api = httpApi();
        expect(await api.request({ host, path: '/warm' })).toMatchObject({ ok: true });
        const lost = await api.request({ host, path: '/oauth/token', method: 'POST', body: '{}' });
        expect(lost).toEqual({ ok: false, reason: 'timeout', sent: true });
        expect(received).toEqual(['GET /warm', 'POST /oauth/token']);
        expect(sockets.size).toBe(2);
    });
});

/** The group project listing the admin picks tracked repos from, and the member's project access check. */
const json = (res: ServerResponse, status: number, body: unknown) =>
    void res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
const listed = (path: string, branch: string | null = 'main') => ({
    path_with_namespace: path,
    default_branch: branch,
});

describe('createGitlabApi.listGroupProjects', () => {
    it('reads every page until a short one, subgroups included, with the token as a bearer and no repeats', async () => {
        const seen: string[] = [];
        const host = await serve((req, res) => {
            const url = new URL(req.url ?? '', 'http://x');
            seen.push(`${url.pathname}?${url.searchParams.get('page')}&${req.headers.authorization}`);
            const page = Number(url.searchParams.get('page'));
            const pages = [[listed('g/a'), listed('g/b')], [listed('g/b'), listed('g/sub/c')], [listed('g/d', null)]];
            json(res, 200, pages[page - 1] ?? []);
        });
        const api = createGitlabApi({ baseUrl: (h) => `http://${h}`, probeTimeoutMs: 1000, pageSize: 2 });
        const result = await api.listGroupProjects({ host, token: 'tok', group: 'g' });
        expect(result).toEqual({
            ok: true,
            projects: [
                { path: 'g/a', defaultBranch: 'main' },
                { path: 'g/b', defaultBranch: 'main' },
                { path: 'g/sub/c', defaultBranch: 'main' },
                { path: 'g/d', defaultBranch: null },
            ],
        });
        expect(seen).toEqual([
            '/api/v4/groups/g/projects?1&Bearer tok',
            '/api/v4/groups/g/projects?2&Bearer tok',
            '/api/v4/groups/g/projects?3&Bearer tok',
        ]);
    });

    it('lists nothing for a group the user cannot see, and no listing at all for any answer that is not a page', async () => {
        const answer = (status: number, body: unknown) => serve((_req, res) => json(res, status, body));
        const api = httpApi();
        expect(
            await api.listGroupProjects({
                host: await answer(404, { message: '404 Group Not Found' }),
                token: 't',
                group: 'g',
            })
        ).toEqual({ ok: true, projects: [] });
        for (const status of [401, 403, 500, 502]) {
            expect(await api.listGroupProjects({ host: await answer(status, {}), token: 't', group: 'g' })).toEqual({
                ok: false,
            });
        }
        for (const body of [
            { not: 'a list' },
            [listed('no-slash')],
            [{ default_branch: 'main' }],
            [listed('g/a', 5 as never)],
        ]) {
            expect(await api.listGroupProjects({ host: await answer(200, body), token: 't', group: 'g' })).toEqual({
                ok: false,
            });
        }
        const lost = await serve((req) => void req.socket.destroy());
        expect(await api.listGroupProjects({ host: lost, token: 't', group: 'g' })).toEqual({ ok: false });
    });

    it('is not complete after a failed later page, and never past its page cap', async () => {
        const failing = await serve((req, res) => {
            const page = Number(new URL(req.url ?? '', 'http://x').searchParams.get('page'));
            if (page === 1) json(res, 200, [listed('g/a'), listed('g/b')]);
            else json(res, 502, {});
        });
        const api = createGitlabApi({ baseUrl: (h) => `http://${h}`, probeTimeoutMs: 1000, pageSize: 2 });
        expect(await api.listGroupProjects({ host: failing, token: 't', group: 'g' })).toEqual({ ok: false });
        const endless = await serve((_req, res) => json(res, 200, [listed('g/a'), listed('g/b')]));
        expect(await api.listGroupProjects({ host: endless, token: 't', group: 'g' })).toEqual({ ok: false });
    });

    it('encodes the group path', async () => {
        const seen: string[] = [];
        const host = await serve((req, res) => {
            seen.push(req.url ?? '');
            json(res, 200, []);
        });
        await httpApi().listGroupProjects({ host, token: 't', group: 'a b/c' });
        expect(seen[0]).toContain('/api/v4/groups/a%20b%2Fc/projects?');
    });
});

describe('createGitlabApi.projectAccess', () => {
    const project = (permissions: unknown) => ({ id: 1, permissions });
    const ask = async (status: number, body: unknown) => {
        const host = await serve((_req, res) => json(res, status, body));
        return httpApi().projectAccess({ host, token: 't', project: 'g/sub/p' });
    };

    it('is the most of the project and group levels, and none when the user holds neither', async () => {
        expect(await ask(200, project({ project_access: { access_level: 30 }, group_access: null }))).toEqual({
            ok: true,
            level: 30,
        });
        expect(
            await ask(200, project({ project_access: { access_level: 20 }, group_access: { access_level: 40 } }))
        ).toEqual({ ok: true, level: 40 });
        expect(await ask(200, project({ project_access: null, group_access: null }))).toEqual({ ok: true, level: 0 });
    });

    it('reads a 403 or a 404 as no access, and encodes the project path', async () => {
        expect(await ask(404, { message: '404 Project Not Found' })).toEqual({ ok: true, level: 0 });
        expect(await ask(403, { message: '403 Forbidden' })).toEqual({ ok: true, level: 0 });
        const seen: string[] = [];
        const host = await serve((req, res) => {
            seen.push(req.url ?? '');
            json(res, 404, {});
        });
        await httpApi().projectAccess({ host, token: 't', project: 'g/sub/p' });
        expect(seen).toEqual(['/api/v4/projects/g%2Fsub%2Fp']);
    });

    it('is inconclusive for a 401, a 5xx, a malformed body, a missing permission, and no answer', async () => {
        const inconclusive = { ok: false, reason: 'inconclusive' };
        expect(await ask(401, { message: '401 Unauthorized' })).toEqual(inconclusive);
        expect(await ask(500, {})).toEqual(inconclusive);
        expect(await ask(503, {})).toEqual(inconclusive);
        expect(await ask(200, [])).toEqual(inconclusive);
        expect(await ask(200, { id: 1 })).toEqual(inconclusive);
        expect(await ask(200, project({ project_access: { access_level: 'x' }, group_access: null }))).toEqual(
            inconclusive
        );
        expect(await ask(200, project({ project_access: null }))).toEqual(inconclusive);
        const lost = await serve((req) => void req.socket.destroy());
        expect(await httpApi().projectAccess({ host: lost, token: 't', project: 'g/p' })).toEqual(inconclusive);
    });
});
