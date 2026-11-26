// The e2e stub GitLab: the lanes' fake GitLab (scripts/fake-forge) behind a TLS front, because the board reaches a
// GitLab host over https only. It serves a throwaway self-signed certificate for 127.0.0.1 and writes it to
// STUB_GITLAB_CA, which a spec hands the board as the connection's CA bundle: the field a private instance needs.
//   STUB_GITLAB_PORT          the https port the board and the browser use
//   STUB_GITLAB_CONTROL_PORT  the plain-http port of the fake itself, whose `/_control/gitlab/*` door a spec drives
//   STUB_GITLAB_CA            where the certificate (PEM) is written
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// A computed specifier, like the test harness: the import-extension lint rule rewrites a literal `.mjs` one to `.js`.
const FAKE_FORGE = new URL('../scripts/fake-forge/server.mjs', import.meta.url).href;
const { createFakeForge } = await import(FAKE_FORGE);

const LOOPBACK = '127.0.0.1';
const { STUB_GITLAB_PORT, STUB_GITLAB_CONTROL_PORT, STUB_GITLAB_CA } = process.env;
if (!STUB_GITLAB_PORT || !STUB_GITLAB_CONTROL_PORT || !STUB_GITLAB_CA) {
    throw new Error('STUB_GITLAB_PORT, STUB_GITLAB_CONTROL_PORT and STUB_GITLAB_CA are required');
}

const dir = mkdtempSync(join(tmpdir(), 'stub-gitlab-'));
execFileSync(
    'openssl',
    [
        ...['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=gitlab.test'],
        ...['-addext', `subjectAltName=IP:${LOOPBACK}`, '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem')],
    ],
    { stdio: 'ignore' }
);
const cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
mkdirSync(dirname(STUB_GITLAB_CA), { recursive: true });
writeFileSync(STUB_GITLAB_CA, cert);

const forge = createFakeForge({ stateDir: join(dir, 'state') });
await forge.listen(Number(STUB_GITLAB_CONTROL_PORT), LOOPBACK);

// The fake builds its pagination links with `http://`; behind this front they are `https://`.
const secure = (value) => (typeof value === 'string' ? value.replaceAll('http://', 'https://') : value);

createServer({ key: readFileSync(join(dir, 'key.pem')), cert }, (request, response) => {
    const upstream = httpRequest(
        {
            host: LOOPBACK,
            port: Number(STUB_GITLAB_CONTROL_PORT),
            method: request.method,
            path: request.url,
            headers: request.headers,
        },
        (answer) => {
            const headers = {
                ...answer.headers,
                ...(answer.headers.link ? { link: secure(answer.headers.link) } : {}),
            };
            response.writeHead(answer.statusCode ?? 502, headers);
            answer.pipe(response);
        }
    );
    upstream.on('error', () => response.writeHead(502).end());
    request.pipe(upstream);
}).listen(Number(STUB_GITLAB_PORT), LOOPBACK);
