import { afterEach, describe, expect, it } from 'vitest';
import { createMetricsServer, type MetricsServer } from '../src/metrics-server.js';

const servers: MetricsServer[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
});

async function serve(token: string, render = async () => 'x_total 1\n') {
    const server = createMetricsServer({ host: '127.0.0.1', port: 0, token, render });
    servers.push(server);
    return `http://127.0.0.1:${await server.listen()}`;
}

describe('the driver metrics listener', () => {
    it('serves the exposition to the board token', async () => {
        const base = await serve('secret');
        const response = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer secret' } });
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
        expect(await response.text()).toBe('x_total 1\n');
    });

    it.each([
        [{}],
        [{ authorization: 'Bearer wrong' }],
        [{ authorization: 'Bearer secre' }],
        [{ authorization: 'Basic secret' }],
        [{ authorization: 'secret' }],
    ])('401s %j', async (headers) => {
        const base = await serve('secret');
        expect((await fetch(`${base}/metrics`, { headers })).status).toBe(401);
    });

    it('is open when no token is configured (loopback only: config refuses the rest)', async () => {
        const base = await serve('');
        expect((await fetch(`${base}/metrics`)).status).toBe(200);
    });

    it('404s other paths and 405s other methods, before looking at credentials it does not need', async () => {
        const base = await serve('secret');
        const auth = { authorization: 'Bearer secret' };
        expect((await fetch(`${base}/other`, { headers: auth })).status).toBe(404);
        const post = await fetch(`${base}/metrics`, { method: 'POST', headers: auth });
        expect(post.status).toBe(405);
        expect(post.headers.get('allow')).toBe('GET');
    });

    it('answers 500 when the exposition cannot be rendered, never a partial body', async () => {
        const base = await serve('', async () => {
            throw new Error('boom');
        });
        expect((await fetch(`${base}/metrics`)).status).toBe(500);
    });

    it('stops accepting once closed', async () => {
        const server = createMetricsServer({ host: '127.0.0.1', port: 0, token: '', render: async () => '' });
        const port = await server.listen();
        await server.close();
        await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow();
    });
});
