import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = new URL('../..', import.meta.url).pathname;

interface Call {
    method: string;
    path: string;
    tokenKind: 'user' | 'installation' | 'none';
    status: number;
}
interface FakeForge {
    listen: (port: number, host: string) => Promise<number>;
    close: () => Promise<void>;
    calls: () => Call[];
    advance: (ms: number) => void;
    mintInstallationToken: () => string;
}
const { createFakeForge, USER_TOKEN_TTL_S } = (await import(
    pathToFileURL(join(ROOT, 'scripts/fake-forge/server.mjs')).href
)) as {
    createFakeForge: (options: { stateDir: string; now?: () => number }) => FakeForge;
    USER_TOKEN_TTL_S: number;
};

let dir: string;
let forge: FakeForge;
let base: string;

const send = async (method: string, path: string, token?: string, body?: object) => {
    const form = body !== undefined && 'grant_type' in body;
    const response = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body ? { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json' } : {}),
            accept: 'application/json',
        },
        ...(body ? { body: form ? new URLSearchParams(body as Record<string, string>) : JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    return {
        status: response.status,
        location: response.headers.get('location'),
        body: text ? JSON.parse(text) : null,
    };
};

/** The sign-in round trip: authorize → code → token pair. */
const signIn = async () => {
    const authorize = await send('GET', '/login/oauth/authorize?redirect_uri=http://board.test/cb&state=s1');
    const code = new URL(authorize.location as string).searchParams.get('code') as string;
    const exchanged = await send('POST', '/login/oauth/access_token', undefined, {
        grant_type: 'authorization_code',
        code,
    });
    return exchanged.body as { access_token: string; refresh_token: string; expires_in: number };
};

const refresh = (token: string) =>
    send('POST', '/login/oauth/access_token', undefined, { grant_type: 'refresh_token', refresh_token: token });

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fake-forge-'));
    forge = createFakeForge({ stateDir: dir, now: () => 1_700_000_000_000 });
    base = `http://127.0.0.1:${await forge.listen(0, '127.0.0.1')}`;
});

afterEach(async () => {
    await forge.close();
    rmSync(dir, { recursive: true, force: true });
});

describe('fake GitHub: the user-token flow', () => {
    it('issues a ghu_/ghr_ pair that identifies the member', async () => {
        const pair = await signIn();
        expect(pair.access_token).toMatch(/^ghu_/);
        expect(pair.refresh_token).toMatch(/^ghr_/);
        expect(pair.expires_in).toBe(USER_TOKEN_TTL_S);
        expect(USER_TOKEN_TTL_S).toBe(8 * 3600);
        const me = await send('GET', '/user', pair.access_token);
        expect(me.status).toBe(200);
        expect(me.body.login).toBeTruthy();
        const installations = await send('GET', '/user/installations', pair.access_token);
        expect(installations.body.installations.length).toBeGreaterThan(0);
    });

    it('rotates on refresh: the old refresh and access tokens stop working', async () => {
        const first = await signIn();
        const rotated = (await refresh(first.refresh_token)).body;
        expect(rotated.access_token).not.toBe(first.access_token);
        expect(rotated.refresh_token).not.toBe(first.refresh_token);
        expect((await send('GET', '/user', first.access_token)).status).toBe(401);
        expect((await send('GET', '/user', rotated.access_token)).status).toBe(200);
        const replay = await refresh(first.refresh_token);
        expect(replay.body.error).toBe('bad_refresh_token');
        // the rotated refresh token is the live one
        expect((await refresh(rotated.refresh_token)).body.access_token).toMatch(/^ghu_/);
    });

    it('expires the access token after 8 h on the injected clock', async () => {
        const pair = await signIn();
        forge.advance((USER_TOKEN_TTL_S - 1) * 1000);
        expect((await send('GET', '/user', pair.access_token)).status).toBe(200);
        forge.advance(2000);
        expect((await send('GET', '/user', pair.access_token)).status).toBe(401);
        expect((await refresh(pair.refresh_token)).body.access_token).toMatch(/^ghu_/);
    });

    it('rejects an unknown code', async () => {
        const bad = await send('POST', '/login/oauth/access_token', undefined, {
            grant_type: 'authorization_code',
            code: 'nope',
        });
        expect(bad.body.error).toBe('bad_verification_code');
    });
});

describe('fake GitHub: pull requests', () => {
    const pulls = '/repos/acme/widgets/pulls';
    const open = (token: string, head = 'task/one') =>
        send('POST', pulls, token, { head, base: 'main', title: 'T', body: 'B', draft: false });

    it('creates, views, lists by head, edits, retargets and merges', async () => {
        const { access_token: user } = await signIn();
        const created = await open(user);
        expect(created.status).toBe(201);
        expect(created.body).toMatchObject({ number: 1, state: 'open', title: 'T', merged: false });
        expect(created.body.html_url).toBe('https://github.com/acme/widgets/pull/1');
        expect(created.body.head.ref).toBe('task/one');
        expect(created.body.base.ref).toBe('main');

        expect((await send('GET', `${pulls}/1`, user)).body.number).toBe(1);
        expect((await send('GET', `${pulls}?head=acme:task/one&state=open`, user)).body).toHaveLength(1);
        expect((await send('GET', `${pulls}?head=acme:other`, user)).body).toEqual([]);

        const edited = await send('PATCH', `${pulls}/1`, user, { title: 'T2', body: 'B2', base: 'dev' });
        expect(edited.body).toMatchObject({ title: 'T2', body: 'B2' });
        expect(edited.body.base.ref).toBe('dev');

        const merged = await send('PUT', `${pulls}/1/merge`, user, { merge_method: 'squash' });
        expect(merged.status).toBe(200);
        expect(merged.body.merged).toBe(true);
        const after = await send('GET', `${pulls}/1`, user);
        expect(after.body).toMatchObject({ state: 'closed', merged: true });
        expect((await send('PUT', `${pulls}/1/merge`, user, {})).status).toBe(405);
        expect((await send('GET', `${pulls}?head=acme:task/one&state=open`, user)).body).toEqual([]);
    });

    it('refuses a second open PR for the same head with 422, and an unknown number with 404', async () => {
        const { access_token: user } = await signIn();
        await open(user);
        expect((await open(user)).status).toBe(422);
        expect((await send('GET', `${pulls}/9`, user)).status).toBe(404);
    });

    it('records which kind of token made each call', async () => {
        const { access_token: user } = await signIn();
        const installation = forge.mintInstallationToken();
        await open(user, 'task/user');
        await open(installation, 'task/bot');
        await send('GET', `${pulls}/1`, installation);
        await send('GET', `${pulls}/1`);
        const prs = (await send('GET', '/_control/pulls')).body as { number: number; createdBy: string }[];
        expect(prs.map((pr) => pr.createdBy)).toEqual(['user', 'installation']);
        const calls = forge.calls().map((call) => `${call.method} ${call.tokenKind} ${call.status}`);
        expect(calls).toContain('POST user 201');
        expect(calls).toContain('POST installation 201');
        expect(calls).toContain('GET none 401');
    });

    it('answers 401 to an unauthenticated PR call', async () => {
        expect((await send('POST', pulls, undefined, { head: 'x', base: 'main', title: 't' })).status).toBe(401);
    });

    it('holds PR creation while the hold file exists, until the go file appears', async () => {
        const { access_token: user } = await signIn();
        writeFileSync(join(dir, 'hold'), '');
        const pending = open(user);
        for (let i = 0; i < 100 && !existsSync(join(dir, 'hold.ready')); i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(existsSync(join(dir, 'hold.ready'))).toBe(true);
        expect((await send('GET', `${pulls}?head=acme:task/one`, user)).body).toEqual([]);
        writeFileSync(join(dir, 'hold.go'), '');
        expect((await pending).status).toBe(201);
    });
});
