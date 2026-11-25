import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { createServer, type Server } from 'node:http';
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
