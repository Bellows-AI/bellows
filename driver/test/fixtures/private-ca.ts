import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';
import { hasOpenssl } from './scripts-support.js';

/**
 * A self-managed forge behind a private CA, for the forge CA suites: a CA freshly minted with `openssl`, a server
 * certificate it signed for 127.0.0.1, and an https smart-HTTP git remote serving one bare repository with the real
 * `git upload-pack` / `git receive-pack`. A git that does not trust the CA fails its TLS verify; one pointed at the
 * CA's file clones, fetches and pushes.
 */

/** The certificate chain a connection's CA bundle holds, and the server's key and certificate signed by it. */
export interface PrivateCa {
    caPem: string;
    key: string;
    cert: string;
}

/** Mints the CA and the server certificate under `dir`; a missing openssl fails the suite with its name. */
export function mintPrivateCa(dir: string): PrivateCa {
    if (!hasOpenssl()) throw new Error('the forge CA suites need openssl on PATH: they mint a private CA');
    mkdirSync(dir, { recursive: true });
    const at = (name: string) => join(dir, name);
    const ssl = (...args: string[]) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
    ssl(
        'req',
        '-x509',
        ...ec,
        '-keyout',
        at('ca.key'),
        '-out',
        at('ca.pem'),
        '-days',
        '2',
        '-subj',
        '/CN=Example Private Root CA',
        '-addext',
        'basicConstraints=critical,CA:TRUE',
        '-addext',
        'keyUsage=critical,keyCertSign,cRLSign'
    );
    ssl('req', ...ec, '-keyout', at('server.key'), '-out', at('server.csr'), '-subj', '/CN=127.0.0.1');
    writeFileSync(
        at('server.ext'),
        'subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n'
    );
    ssl(
        'x509',
        '-req',
        '-in',
        at('server.csr'),
        '-CA',
        at('ca.pem'),
        '-CAkey',
        at('ca.key'),
        '-CAcreateserial',
        '-out',
        at('server.pem'),
        '-days',
        '2',
        '-extfile',
        at('server.ext')
    );
    return {
        caPem: readFileSync(at('ca.pem'), 'utf8'),
        key: readFileSync(at('server.key'), 'utf8'),
        cert: readFileSync(at('server.pem'), 'utf8'),
    };
}

/** A pkt-line of `text`. */
const pkt = (text: string): string => `${(text.length + 4).toString(16).padStart(4, '0')}${text}`;

const SERVICES = ['git-upload-pack', 'git-receive-pack'];

/** The https remote: `https://<host>/<any path>.git` serves `bare`. Every request's path is recorded. */
export interface GitHttpsRemote {
    host: string;
    url: string;
    requests: string[];
    /** When set, a request without `oauth2:<token>` basic auth is answered 401, as a forge does for a private repo. */
    requireToken: string | null;
    /** The tokens' basic-auth requests that were accepted, in order. */
    accepted: string[];
    /**
     * Parks the next `git-upload-pack` or `git-receive-pack` POST (a fetch's or a push's data exchange) until the
     * returned `release` is called; `reached` settles once the request is parked: the operation is in flight.
     */
    holdNext(service: 'git-upload-pack' | 'git-receive-pack'): { reached: Promise<void>; release: () => void };
    close(): Promise<void>;
}

export async function startGitHttpsRemote(ca: PrivateCa, bare: string): Promise<GitHttpsRemote> {
    const requests: string[] = [];
    const accepted: string[] = [];
    const holds = new Map<string, { reached: () => void; released: Promise<void> }>();
    let requireToken: string | null = null;
    const server: Server = createServer({ key: ca.key, cert: ca.cert }, (req, res) => {
        const url = new URL(req.url ?? '/', 'https://remote');
        requests.push(`${req.method} ${url.pathname}${url.search}`);
        if (requireToken !== null) {
            const want = `Basic ${Buffer.from(`oauth2:${requireToken}`).toString('base64')}`;
            if (req.headers.authorization !== want) {
                res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="forge"' });
                res.end();
                return;
            }
            accepted.push(requireToken);
        }
        const advertised = url.searchParams.get('service') ?? '';
        if (req.method === 'GET' && url.pathname.endsWith('/info/refs') && SERVICES.includes(advertised)) {
            const service = advertised.replace(/^git-/, '');
            const child = spawn('git', [service, '--stateless-rpc', '--advertise-refs', bare]);
            res.writeHead(200, { 'Content-Type': `application/x-${advertised}-advertisement` });
            res.write(`${pkt(`# service=${advertised}\n`)}0000`);
            child.stdout.pipe(res);
            return;
        }
        const posted = SERVICES.find((service) => url.pathname.endsWith(`/${service}`));
        if (req.method !== 'POST' || !posted) {
            res.writeHead(404);
            res.end();
            return;
        }
        const serve = () => {
            if (res.destroyed) return;
            const child = spawn('git', [posted.replace(/^git-/, ''), '--stateless-rpc', bare]);
            res.writeHead(200, { 'Content-Type': `application/x-${posted}-result` });
            (req.headers['content-encoding'] === 'gzip' ? req.pipe(createGunzip()) : req).pipe(child.stdin);
            child.stdout.pipe(res);
        };
        const held = holds.get(posted);
        if (!held) return serve();
        holds.delete(posted);
        held.reached();
        void held.released.then(serve);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
    return {
        host,
        url: `https://${host}/group/project.git`,
        requests,
        get requireToken() {
            return requireToken;
        },
        set requireToken(token: string | null) {
            requireToken = token;
        },
        accepted,
        holdNext: (service) => {
            let reached!: () => void;
            let release!: () => void;
            const reachedP = new Promise<void>((resolve) => (reached = resolve));
            const released = new Promise<void>((resolve) => (release = resolve));
            holds.set(service, { reached, released });
            return { reached: reachedP, release };
        },
        close: async () => {
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

/** A hermetic env for a real git: no system or global config but what `home` holds, no prompt. */
export const hermeticGitEnv = (home: string): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
});

/** A bare repository under `dir` with one commit on `main`. */
export function bareRepo(dir: string): string {
    const work = join(dir, 'work');
    const bare = join(dir, 'origin.git');
    const env = hermeticGitEnv(dir);
    const git = (...args: string[]) => execFileSync('git', args, { env, stdio: 'ignore' });
    mkdirSync(work, { recursive: true });
    git('-C', work, 'init', '-q', '-b', 'main');
    writeFileSync(join(work, 'README.md'), '# project\n');
    git('-C', work, 'add', 'README.md');
    git('-C', work, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'init');
    git('clone', '-q', '--bare', work, bare);
    git('-C', bare, 'config', 'http.receivepack', 'true');
    return bare;
}
