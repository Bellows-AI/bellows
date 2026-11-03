import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CimdFetchError, createCimdFetcher } from '../src/oauth/cimd-fetch.js';
import { isSpecialUseAddress } from '../src/oauth/special-use-address.js';

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
const servers: Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((done) => server.close(done));
    }
});

const serve = async (handler: Handler): Promise<{ port: number; seen: IncomingMessage[] }> => {
    const seen: IncomingMessage[] = [];
    const server = createServer((request, response) => {
        seen.push(request);
        handler(request, response);
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    return { port: (server.address() as AddressInfo).port, seen };
};
const json =
    (body: unknown): Handler =>
    (_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
    };
const codeOf = async (run: Promise<unknown>): Promise<string> => {
    try {
        await run;
    } catch (e) {
        if (e instanceof CimdFetchError) return e.code;
        throw e;
    }
    return 'resolved';
};
const never = async (): Promise<string[]> => {
    throw new Error('the resolver must not be asked');
};

describe('isSpecialUseAddress', () => {
    it.each([
        '0.0.0.0',
        '10.1.2.3',
        '100.64.0.1',
        '127.0.0.1',
        '169.254.169.254',
        '172.16.0.1',
        '172.31.255.255',
        '192.168.1.1',
        '198.18.0.1',
        '224.0.0.1',
        '255.255.255.255',
        '::',
        '::1',
        'fe80::1',
        'fc00::1',
        'fd12:3456::1',
        'ff02::1',
        '::ffff:127.0.0.1',
        '::ffff:7f00:1',
        '::ffff:a00:1',
        '::ffff:169.254.169.254',
        '64:ff9b::7f00:1',
        '2002:7f00:1::',
        '2002:a00::1',
        '2002:a9fe:a9fe::',
        '64:ff9b:1::1',
        '64:ff9b:1:abcd::8.8.8.8',
        '::ffff:0:10.0.0.1',
        '::ffff:0:a9fe:a9fe',
        '64:ff9b::a00:1',
        '::127.0.0.1',
        '2001:db8::1',
    ])('refuses %s', (address) => {
        expect(isSpecialUseAddress(address)).toBe(true);
    });

    it.each([
        '8.8.8.8',
        '1.1.1.1',
        '172.32.0.1',
        '100.63.255.255',
        '2606:4700:4700::1111',
        '::ffff:8.8.8.8',
        '2002:808:808::1',
        '::ffff:0:8.8.8.8',
        '64:ff9b::808:808',
    ])('allows the public address %s', (address) => {
        expect(isSpecialUseAddress(address)).toBe(false);
    });
});

describe('the CIMD fetcher: where it will not connect', () => {
    const policy = { allowLoopback: false } as const;

    it.each([
        'http://example.test/client.json',
        'ftp://example.test/client.json',
        'https://user:pw@example.test/client.json',
        'https://example.test/client.json#frag',
        'https://example.test',
        'https://example.test/a/../client.json',
        'not a url',
    ])('refuses the client_id %s before any lookup', async (url) => {
        const fetcher = createCimdFetcher({ ...policy, resolve: never });
        expect(await codeOf(fetcher(url))).toBe('policy');
    });

    it.each([
        'https://10.0.0.1/c.json',
        'https://127.0.0.1/c.json',
        'https://169.254.169.254/latest/meta-data',
        'https://100.64.0.9/c.json',
        'https://[::1]/c.json',
        'https://[::ffff:127.0.0.1]/c.json',
        'https://[::ffff:a9fe:a9fe]/c.json',
        'https://[fe80::1]/c.json',
        'https://[fd00::1]/c.json',
    ])('refuses the address literal %s without resolving', async (url) => {
        const fetcher = createCimdFetcher({ ...policy, resolve: never });
        expect(await codeOf(fetcher(url))).toBe('address');
    });

    it.each([
        ['a private IPv4', ['10.0.0.5']],
        ['loopback', ['127.0.0.1']],
        ['the metadata address', ['169.254.169.254']],
        ['CGNAT', ['100.100.100.200']],
        ['IPv4-mapped IPv6', ['::ffff:10.0.0.5']],
        ['link-local IPv6', ['fe80::1']],
        ['one private answer among public ones', ['8.8.8.8', '10.0.0.5']],
        ['no answer at all', []],
    ])('refuses a name that resolves to %s', async (_name, answers) => {
        const fetcher = createCimdFetcher({ ...policy, resolve: async () => answers });
        expect(await codeOf(fetcher('https://client.example.test/c.json'))).toBe('address');
    });

    it('refuses a name whose lookup fails, as unconfirmed rather than as a verdict', async () => {
        const fetcher = createCimdFetcher({
            ...policy,
            resolve: async () => {
                throw new Error('ENOTFOUND');
            },
        });
        expect(await codeOf(fetcher('https://client.example.test/c.json'))).toBe('network');
    });

    it('keeps loopback closed unless the dev policy opens it, and keeps private ranges closed even then', async () => {
        const { port } = await serve(json({ ok: true }));
        const closed = createCimdFetcher({ allowLoopback: false, resolve: async () => ['127.0.0.1'] });
        expect(await codeOf(closed(`http://localhost:${port}/c.json`))).toBe('policy');
        const open = createCimdFetcher({ allowLoopback: true, resolve: async () => ['127.0.0.1'] });
        expect(await open(`http://localhost:${port}/c.json`)).toEqual({ ok: true });
        expect(await codeOf(open('http://10.0.0.1/c.json'))).toBe('policy');
        const privateName = createCimdFetcher({ allowLoopback: true, resolve: async () => ['10.0.0.1'] });
        expect(await codeOf(privateName(`http://localhost:${port}/c.json`))).toBe('address');
    });
});

describe('the CIMD fetcher: the connection', () => {
    const open = { allowLoopback: true } as const;
    const resolveLocal = async () => ['127.0.0.1'];

    it('pins the validated address: a DNS rebind between resolve and connect changes nothing', async () => {
        const { port, seen } = await serve(json({ client_id: 'x' }));
        const answers = [['127.0.0.1'], ['10.0.0.1']];
        let asked = 0;
        const fetcher = createCimdFetcher({
            ...open,
            resolve: async () => answers[Math.min(asked++, answers.length - 1)] ?? [],
        });
        expect(await fetcher(`http://localhost:${port}/c.json`)).toEqual({ client_id: 'x' });
        expect(asked).toBe(1);
        expect(seen[0]?.headers.host).toBe(`localhost:${port}`);
    });

    it('does not follow a redirect, not even to a harmless place', async () => {
        const target = await serve(json({ reached: true }));
        const { port } = await serve((_request, response) => {
            response.writeHead(302, { location: `http://127.0.0.1:${target.port}/c.json` });
            response.end();
        });
        const fetcher = createCimdFetcher({ ...open, resolve: resolveLocal });
        expect(await codeOf(fetcher(`http://localhost:${port}/c.json`))).toBe('redirect');
        expect(target.seen).toHaveLength(0);
    });

    it('refuses a non-200 answer and a body that is not a JSON object', async () => {
        const missing = await serve((_request, response) => {
            response.writeHead(404);
            response.end('nope');
        });
        const html = await serve((_request, response) => {
            response.writeHead(200, { 'content-type': 'text/html' });
            response.end('<html></html>');
        });
        const broken = await serve((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{"client_id":');
        });
        const array = await serve(json([1, 2]));
        const fetcher = createCimdFetcher({ ...open, resolve: resolveLocal });
        expect(await codeOf(fetcher(`http://localhost:${missing.port}/c.json`))).toBe('status');
        expect(await codeOf(fetcher(`http://localhost:${html.port}/c.json`))).toBe('malformed');
        expect(await codeOf(fetcher(`http://localhost:${broken.port}/c.json`))).toBe('malformed');
        expect(await codeOf(fetcher(`http://localhost:${array.port}/c.json`))).toBe('malformed');
    });

    it('stops at the size cap, declared or streamed, and tears the connection down', async () => {
        const declared = await serve((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json', 'content-length': '999999' });
            response.write('{');
        });
        let closed = false;
        const streamed = await serve((request, response) => {
            request.socket.once('close', () => (closed = true));
            response.writeHead(200, { 'content-type': 'application/json' });
            const timer = setInterval(() => response.write(' '.repeat(512)), 5);
            response.once('close', () => clearInterval(timer));
        });
        const fetcher = createCimdFetcher({ ...open, resolve: resolveLocal, maxBytes: 2048 });
        expect(await codeOf(fetcher(`http://localhost:${declared.port}/c.json`))).toBe('too_large');
        expect(await codeOf(fetcher(`http://localhost:${streamed.port}/c.json`))).toBe('too_large');
        await expect.poll(() => closed).toBe(true);
    });

    it('settles when the peer closes mid-body', async () => {
        const { port } = await serve((request, response) => {
            response.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
            response.write('{"a":');
            setTimeout(() => request.socket.destroy(), 10);
        });
        const fetcher = createCimdFetcher({ ...open, resolve: resolveLocal });
        expect(await codeOf(fetcher(`http://localhost:${port}/c.json`))).toBe('network');
    });

    it('settles when nothing is listening', async () => {
        const { port } = await serve(json({}));
        const [server] = servers.splice(0);
        await new Promise((done) => server?.close(done));
        const fetcher = createCimdFetcher({ ...open, resolve: resolveLocal });
        expect(await codeOf(fetcher(`http://localhost:${port}/c.json`))).toBe('network');
    });

    it('times out a slow body, and a slow lookup, on one deadline', async () => {
        const { port } = await serve((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.write('{');
        });
        const slowBody = createCimdFetcher({ ...open, resolve: resolveLocal, timeoutMs: 100 });
        expect(await codeOf(slowBody(`http://localhost:${port}/c.json`))).toBe('timeout');
        const slowLookup = createCimdFetcher({
            ...open,
            resolve: () => new Promise<string[]>(() => undefined),
            timeoutMs: 100,
        });
        expect(await codeOf(slowLookup(`http://localhost:${port}/c.json`))).toBe('timeout');
    });

    it('cancels an in-flight fetch when the caller aborts', async () => {
        let closed = false;
        const { port } = await serve((request, response) => {
            request.socket.once('close', () => (closed = true));
            response.writeHead(200, { 'content-type': 'application/json' });
            response.write('{');
        });
        const fetcher = createCimdFetcher({ ...open, resolve: resolveLocal });
        const controller = new AbortController();
        const run = codeOf(fetcher(`http://localhost:${port}/c.json`, controller.signal));
        setTimeout(() => controller.abort(), 50);
        expect(await run).toBe('aborted');
        await expect.poll(() => closed).toBe(true);
        expect(await codeOf(fetcher(`http://localhost:${port}/c.json`, AbortSignal.abort()))).toBe('aborted');
    });
});

describe('the CIMD fetcher: caps', () => {
    const open = { allowLoopback: true, resolve: async () => ['127.0.0.1'] } as const;

    it('allows maxConcurrent fetches at once and frees the slot on every exit path', async () => {
        const { port } = await serve((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.write('{');
        });
        const fetcher = createCimdFetcher({
            ...open,
            maxConcurrent: 1,
            timeoutMs: 100,
            perHost: { burst: 100, perSecond: 100 },
        });
        const first = codeOf(fetcher(`http://localhost:${port}/a.json`));
        expect(await codeOf(fetcher(`http://localhost:${port}/b.json`))).toBe('busy');
        expect(await first).toBe('timeout');
        // The slot came back after the timeout, and after a policy refusal that threw before connecting.
        expect(await codeOf(fetcher('http://10.0.0.1/c.json'))).toBe('policy');
        const ok = await serve(json({ fine: true }));
        expect(await fetcher(`http://localhost:${ok.port}/c.json`)).toEqual({ fine: true });
    });

    it('rate-limits per host and refills over time, other hosts unaffected', async () => {
        const { port } = await serve(json({ fine: true }));
        let now = 1_000_000;
        const fetcher = createCimdFetcher({ ...open, perHost: { burst: 2, perSecond: 1 }, now: () => now });
        const url = `http://localhost:${port}/c.json`;
        await fetcher(url);
        await fetcher(url);
        expect(await codeOf(fetcher(url))).toBe('rate_limited');
        expect(await fetcher(`http://127.0.0.1:${port}/c.json`)).toEqual({ fine: true });
        now += 1000;
        expect(await fetcher(url)).toEqual({ fine: true });
    });
});
