import { describe, expect, it } from 'vitest';
import { type VaultOp, classifyAnswer } from '../src/secrets/vault-answer.js';
import { createVaultObjectClient } from '../src/secrets/vault-kv.js';

/** The Vault KV v2 adapter over a scripted fetch: the wire shape and what each answer means. */
const SENTINEL = 'sentinel-provider-body';
const TOKEN = 'hvs.example-client-token';
const JWT = 'eyJ.example-service-account-jwt';
const VERSION_ID = '7f1f0c4e-0000-4000-8000-000000000001';
const NAME = `pfx/sec_1/${VERSION_ID}`;
const ADDR = 'http://vault.test:8200';
const utf8 = (value: string) => new TextEncoder().encode(value);
const b64 = (value: string) => Buffer.from(value).toString('base64');

interface Seen {
    url: URL;
    method: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
    at: number;
}

type Script = (seen: Seen, signal: AbortSignal | undefined) => Response | Promise<Response>;

function fakeFetch(script: Script) {
    const calls: Seen[] = [];
    const fn = (async (url: string | URL, init?: RequestInit) => {
        const seen: Seen = {
            url: new URL(String(url)),
            method: init?.method ?? 'GET',
            headers: (init?.headers ?? {}) as Record<string, string>,
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
            at: Date.now(),
        };
        calls.push(seen);
        return script(seen, init?.signal ?? undefined);
    }) as typeof fetch;
    return { fn, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const hang = (signal: AbortSignal | undefined, ms = 10_000) =>
    new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(json(200, {})), ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
    });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const written = (version = 1) => json(200, { data: { version, created_time: '2026-01-01T00:00:00Z' } });
const readOk = (value = 'payload', over: Record<string, unknown> = {}) =>
    json(200, {
        data: {
            data: { name: NAME, version_id: VERSION_ID, payload: b64(value), ...over },
            metadata: { version: 1, destroyed: false, deletion_time: '' },
        },
    });
const loginOk = (lease = 3600, token = TOKEN) => json(200, { auth: { client_token: token, lease_duration: lease } });
const denied = () => json(403, { errors: ['permission denied'] });
const casMismatch = () => json(400, { errors: ['check-and-set parameter did not match the current version'] });
const missing = () => json(404, { errors: [] });
const noContent = () => new Response(null, { status: 204 });

function tokenClient(fetchFn: typeof fetch, extra: Record<string, unknown> = {}) {
    return createVaultObjectClient({
        addr: ADDR,
        mount: 'secret',
        prefix: 'pfx',
        auth: { kind: 'token', token: TOKEN },
        fetch: fetchFn,
        ...extra,
    });
}

function k8sClient(fetchFn: typeof fetch, files: { read: () => Promise<string> }, extra: Record<string, unknown> = {}) {
    return createVaultObjectClient({
        addr: ADDR,
        mount: 'secret',
        prefix: 'pfx',
        auth: { kind: 'kubernetes', role: 'factory', tokenFile: '/var/run/vault/token' },
        fetch: fetchFn,
        readFile: files.read,
        ...extra,
    });
}

const object = { name: NAME, versionId: VERSION_ID, payload: utf8('payload') };
const put = (client: ReturnType<typeof tokenClient>, budget = 2000) => client.put(object, budget, undefined);
const get = (client: ReturnType<typeof tokenClient>, budget = 2000) => client.get(NAME, VERSION_ID, budget, undefined);
const remove = (client: ReturnType<typeof tokenClient>, budget = 2000) => client.remove(NAME, budget, undefined);

const verdict = async (promise: Promise<unknown>) => {
    try {
        await promise;
    } catch (error) {
        return (error as { verdict?: string }).verdict ?? `not-a-fault: ${String(error)}`;
    }
    return 'resolved';
};

describe('classifyAnswer: the one classifier of a Vault answer', () => {
    const text = (value: unknown) => JSON.stringify(value);
    const readBody = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) =>
        text({
            data: {
                data: { name: NAME, version_id: VERSION_ID, payload: b64('x'), ...over },
                metadata: { version: 1, ...meta },
            },
        });

    it('is ok for a write only as 200 naming version 1', () => {
        expect(classifyAnswer('write', 200, text({ data: { version: 1 } })).kind).toBe('ok');
        for (const body of [text({ data: { version: 2 } }), text({ data: {} }), text({}), 'null', '', 'x']) {
            expect(classifyAnswer('write', 200, body).kind).toBe('unrecognized');
        }
        expect(classifyAnswer('write', 201, text({ data: { version: 1 } })).kind).toBe('unrecognized');
    });

    it('is exists for a write refused by check-and-set, and for nothing else on a 400', () => {
        expect(classifyAnswer('write', 400, text({ errors: ['check-and-set parameter did not match'] })).kind).toBe(
            'exists'
        );
        for (const body of [text({ errors: ['invalid request'] }), text({ errors: [] }), '', 'cas', text({})]) {
            expect(classifyAnswer('write', 400, body).kind).toBe('unrecognized');
        }
        expect(classifyAnswer('write', 409, text({ errors: ['check-and-set parameter did not match'] })).kind).toBe(
            'unrecognized'
        );
        expect(classifyAnswer('read', 400, text({ errors: ['check-and-set parameter did not match'] })).kind).toBe(
            'unrecognized'
        );
    });

    it('is ok for a read only as 200 with version 1, a canonical base64 payload, a name and a version id', () => {
        const ok = classifyAnswer('read', 200, readBody());
        expect(ok.kind).toBe('ok');
        if (ok.kind === 'ok') {
            expect(ok.value).toMatchObject({ name: NAME, versionId: VERSION_ID });
        }
        expect(classifyAnswer('read', 200, readBody({ payload: '' })).kind).toBe('ok');
        for (const body of [
            readBody({}, { version: 2 }),
            readBody({ payload: '***' }),
            readBody({ payload: 'YQ' }),
            readBody({ payload: 7 }),
            readBody({ name: 7 }),
            readBody({ version_id: undefined }),
            readBody({}, { destroyed: true }),
            readBody({}, { deletion_time: '2026-01-01T00:00:00Z' }),
            text({ data: { data: null, metadata: { version: 1 } } }),
            text({ data: { data: {} } }),
            text({}),
            'null',
            '',
        ]) {
            expect(classifyAnswer('read', 200, body).kind).toBe('unrecognized');
        }
    });

    it('is absent only for a 404 naming errors and no metadata; metadata is a tombstone', () => {
        expect(classifyAnswer('read', 404, text({ errors: [] })).kind).toBe('absent');
        expect(classifyAnswer('read', 404, text({ errors: ['x'] })).kind).toBe('absent');
        expect(
            classifyAnswer('read', 404, text({ data: { data: null, metadata: { deletion_time: 't' } }, errors: [] }))
                .kind
        ).toBe('tombstoned');
        expect(classifyAnswer('read', 404, text({ data: { metadata: { destroyed: true } } })).kind).toBe('tombstoned');
        for (const body of [
            '',
            '<html>not found</html>',
            'null',
            '[]',
            text({}),
            text({ errors: 'x' }),
            text({ errors: [1] }),
        ]) {
            expect(classifyAnswer('read', 404, body).kind).toBe('unrecognized');
        }
        expect(classifyAnswer('write', 404, text({ errors: [] })).kind).toBe('unrecognized');
    });

    it('is ok for a delete only as an empty 204, and absent for a 404 without metadata', () => {
        expect(classifyAnswer('delete', 204, '').kind).toBe('ok');
        expect(classifyAnswer('delete', 204, text({ errors: [] })).kind).toBe('unrecognized');
        expect(classifyAnswer('delete', 200, '').kind).toBe('unrecognized');
        expect(classifyAnswer('delete', 200, text({})).kind).toBe('unrecognized');
        expect(classifyAnswer('delete', 404, text({ errors: [] })).kind).toBe('absent');
        expect(classifyAnswer('delete', 404, text({ data: { metadata: {} }, errors: [] })).kind).toBe('unrecognized');
        expect(classifyAnswer('delete', 404, '').kind).toBe('unrecognized');
    });

    it('is ok for a login only with a token and a lease, and denied for a refused one', () => {
        const ok = classifyAnswer('login', 200, text({ auth: { client_token: TOKEN, lease_duration: 60 } }));
        expect(ok.kind).toBe('ok');
        if (ok.kind === 'ok') {
            expect(ok.value).toEqual({ token: TOKEN, leaseSeconds: 60 });
        }
        for (const body of [
            text({ auth: { client_token: '', lease_duration: 60 } }),
            text({ auth: { client_token: TOKEN, lease_duration: -1 } }),
            text({ auth: { client_token: TOKEN, lease_duration: '60' } }),
            text({ auth: { client_token: TOKEN } }),
            text({ auth: null }),
            text({}),
            '',
        ]) {
            expect(classifyAnswer('login', 200, body).kind).toBe('unrecognized');
        }
        expect(classifyAnswer('login', 403, text({ errors: ['permission denied'] })).kind).toBe('denied');
        expect(classifyAnswer('login', 400, text({ errors: ['invalid role name'] })).kind).toBe('denied');
        expect(classifyAnswer('login', 400, '').kind).toBe('unrecognized');
    });

    it.each<VaultOp>(['write', 'read', 'delete', 'login'])('is denied for a 403 naming errors on %s', (op) => {
        expect(classifyAnswer(op, 403, JSON.stringify({ errors: ['permission denied'] })).kind).toBe('denied');
        for (const body of ['', 'forbidden', '{}', '{"errors":"x"}', 'null']) {
            expect(classifyAnswer(op, 403, body).kind).toBe('unrecognized');
        }
    });

    it.each<VaultOp>(['write', 'read', 'delete', 'login'])('is unmounted for a missing route on %s', (op) => {
        const body = JSON.stringify({ errors: ["no handler for route 'secret/data/x'. route entry not found."] });
        expect(classifyAnswer(op, 404, body).kind).toBe('unmounted');
        expect(classifyAnswer(op, 200, body).kind).not.toBe('unmounted');
    });

    it.each<VaultOp>(['write', 'read', 'delete', 'login'])(
        'is retry for 429 and any 5xx on %s, whatever the body',
        (op) => {
            for (const status of [429, 500, 502, 503, 504, 599]) {
                expect(classifyAnswer(op, status, '').kind).toBe('retry');
                expect(classifyAnswer(op, status, SENTINEL).kind).toBe('retry');
            }
        }
    );

    it.each<VaultOp>(['write', 'read', 'delete', 'login'])(
        'is unrecognized for a status nobody documents on %s',
        (op) => {
            for (const status of [100, 101, 202, 203, 205, 301, 302, 304, 401, 402, 405, 409, 410, 418, 600, 999]) {
                expect(classifyAnswer(op, status, JSON.stringify({ errors: [] })).kind).toBe('unrecognized');
            }
        }
    );
});

describe('the Vault adapter: a write', () => {
    it('posts the payload to the data path with check-and-set 0 and the token, and reports written', async () => {
        const { fn, calls } = fakeFetch(() => written());
        expect(await put(tokenClient(fn))).toBe('written');
        const [call] = calls;
        expect(call?.method).toBe('POST');
        expect(call?.url.pathname).toBe(`/v1/secret/data/${NAME}`);
        expect(call?.headers['X-Vault-Token']).toBe(TOKEN);
        expect(call?.body).toEqual({
            options: { cas: 0 },
            data: { name: NAME, version_id: VERSION_ID, payload: b64('payload') },
        });
    });

    it('names the object <prefix>/<ref>/<versionId>', () => {
        expect(tokenClient(fakeFetch(() => written()).fn).nameOf('sec_1', VERSION_ID)).toBe(NAME);
    });

    it('reports exists when check-and-set says the object is taken', async () => {
        expect(await put(tokenClient(fakeFetch(casMismatch).fn))).toBe('exists');
    });

    it.each([
        ['null', () => json(200, null)],
        ['an empty object', () => json(200, {})],
        ['another version', () => written(2)],
        ['a non-JSON body', () => new Response('ok', { status: 200 })],
        ['a 400 without a reason', () => new Response('', { status: 400 })],
        ['a 400 with an unknown reason', () => json(400, { errors: [SENTINEL] })],
        ['a 404', () => missing()],
        ['a 302', () => new Response(null, { status: 302 })],
    ])('leaves a write answered with %s ambiguous', async (_label, answer) => {
        expect(await verdict(put(tokenClient(fakeFetch(answer).fn)))).toBe('ambiguous');
    });

    it('is misconfigured for a refused token and a missing mount, after exactly one request', async () => {
        const refused = fakeFetch(denied);
        expect(await verdict(put(tokenClient(refused.fn)))).toBe('misconfigured');
        expect(refused.calls).toHaveLength(1);
        const unmounted = fakeFetch(() => json(404, { errors: ["no handler for route 'secret/data/x'"] }));
        expect(await verdict(put(tokenClient(unmounted.fn)))).toBe('misconfigured');
    });

    it.each([429, 500, 503])('is retry for a %i', async (status) => {
        expect(await verdict(put(tokenClient(fakeFetch(() => new Response(SENTINEL, { status })).fn)))).toBe('retry');
    });

    it('is ambiguous when the answer to a write is larger than the cap, and cancels it', async () => {
        let cancelled = false;
        const big = new Response(
            new ReadableStream({
                pull(controller) {
                    controller.enqueue(new Uint8Array(64));
                },
                cancel() {
                    cancelled = true;
                },
            }),
            { status: 200 }
        );
        expect(await verdict(put(tokenClient(fakeFetch(() => big).fn, { maxBodyBytes: 256 })))).toBe('ambiguous');
        expect(cancelled).toBe(true);
    });
});

describe('the Vault adapter: a read', () => {
    it('gets version 1 of the data path and returns what the object says', async () => {
        const { fn, calls } = fakeFetch(() => readOk());
        const read = await get(tokenClient(fn));
        expect(read).toEqual({ name: NAME, versionId: VERSION_ID, payload: utf8('payload') });
        expect(calls[0]?.method).toBe('GET');
        expect(calls[0]?.url.pathname).toBe(`/v1/secret/data/${NAME}`);
        expect(calls[0]?.url.searchParams.get('version')).toBe('1');
        expect(calls[0]?.headers['X-Vault-Token']).toBe(TOKEN);
    });

    it('reads an empty payload', async () => {
        const read = await get(tokenClient(fakeFetch(() => readOk('')).fn));
        expect(read).toMatchObject({ payload: new Uint8Array(0) });
    });

    it('is absent only for a 404 that names errors and carries no metadata', async () => {
        expect(await get(tokenClient(fakeFetch(missing).fn))).toBe('absent');
    });

    it.each([
        [
            'a soft-deleted version',
            () => json(404, { data: { data: null, metadata: { deletion_time: 't' } }, errors: [] }),
        ],
        ['a destroyed version', () => json(404, { data: { metadata: { destroyed: true } } })],
        ['a malformed 200', () => json(200, { data: {} })],
        [
            'a 200 for another version',
            () =>
                json(200, {
                    data: { data: { name: NAME, version_id: VERSION_ID, payload: '' }, metadata: { version: 3 } },
                }),
        ],
    ])('is malformed for %s, never absent', async (_label, answer) => {
        expect(await get(tokenClient(fakeFetch(answer).fn))).toBe('malformed');
    });

    it.each([
        ['an HTML 404', () => new Response('<html>not found</html>', { status: 404 })],
        ['a 404 without a body', () => new Response(null, { status: 404 })],
        ['a 404 that is JSON but names no errors', () => json(404, {})],
        ['a 400', () => json(400, { errors: [SENTINEL] })],
        ['a 503', () => new Response(SENTINEL, { status: 503 })],
    ])('is a retry, never absent, for %s', async (_label, answer) => {
        expect(await verdict(get(tokenClient(fakeFetch(answer).fn)))).toBe('retry');
    });

    it('is misconfigured when permission is denied', async () => {
        expect(await verdict(get(tokenClient(fakeFetch(denied).fn)))).toBe('misconfigured');
    });

    it('rejects a body that errors mid-stream, never reading it as absent', async () => {
        const broken = new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(utf8('{"data"'));
                    controller.error(new Error(SENTINEL));
                },
            }),
            { status: 404 }
        );
        const outcome = await verdict(get(tokenClient(fakeFetch(() => broken).fn)));
        expect(outcome).not.toBe('resolved');
        expect(outcome).not.toContain(SENTINEL);
    });
});

describe('the Vault adapter: a delete', () => {
    it('deletes the metadata path, which removes every version, and resolves on a 204', async () => {
        const { fn, calls } = fakeFetch(noContent);
        await remove(tokenClient(fn));
        expect(calls[0]?.method).toBe('DELETE');
        expect(calls[0]?.url.pathname).toBe(`/v1/secret/metadata/${NAME}`);
    });

    it('resolves on a validated 404, the object being gone', async () => {
        await remove(tokenClient(fakeFetch(missing).fn));
    });

    it.each([
        ['a 200 with no body', () => new Response('', { status: 200 })],
        ['a 200 with null', () => json(200, null)],
        ['a 204 that carries a body', () => new Response('{}', { status: 200 })],
        ['a 404 that carries metadata', () => json(404, { data: { metadata: {} }, errors: [] })],
        ['an HTML 404', () => new Response('<html>', { status: 404 })],
        ['a 400', () => json(400, { errors: [] })],
    ])('never confirms a delete answered with %s', async (_label, answer) => {
        expect(await verdict(remove(tokenClient(fakeFetch(answer).fn)))).toBe('ambiguous');
    });

    it('is a retry for a 5xx and misconfigured for a refusal', async () => {
        expect(await verdict(remove(tokenClient(fakeFetch(() => new Response(SENTINEL, { status: 500 })).fn)))).toBe(
            'retry'
        );
        expect(await verdict(remove(tokenClient(fakeFetch(denied).fn)))).toBe('misconfigured');
    });
});

describe('the Vault adapter: Kubernetes login', () => {
    const jwtFile = (value = JWT) => ({ read: async () => value });
    const router =
        (login: Script, data: Script = () => readOk()): Script =>
        (seen, signal) =>
            seen.url.pathname === '/v1/auth/kubernetes/login' ? login(seen, signal) : data(seen, signal);
    const loginsOf = (calls: Seen[]) => calls.filter((call) => call.url.pathname.endsWith('/login'));
    const dataOf = (calls: Seen[]) => calls.filter((call) => !call.url.pathname.endsWith('/login'));

    it('logs in with the role and the projected token, then reads with the client token', async () => {
        const { fn, calls } = fakeFetch(router(() => loginOk()));
        await get(k8sClient(fn, jwtFile()));
        expect(loginsOf(calls)).toHaveLength(1);
        expect(loginsOf(calls)[0]?.body).toEqual({ role: 'factory', jwt: JWT });
        expect(dataOf(calls)[0]?.headers['X-Vault-Token']).toBe(TOKEN);
    });

    it('reuses the client token until 80% of its lease has passed, then logs in again', async () => {
        let now = 1_000_000;
        const { fn, calls } = fakeFetch(router(() => loginOk(100)));
        const client = k8sClient(fn, jwtFile(), { clock: () => now });
        await get(client);
        now += 79_000;
        await get(client);
        expect(loginsOf(calls)).toHaveLength(1);
        now += 2_000;
        await get(client);
        expect(loginsOf(calls)).toHaveLength(2);
    });

    it('re-reads the token file on every login', async () => {
        let now = 0;
        let content = 'jwt-one';
        const { fn, calls } = fakeFetch(router(() => loginOk(10)));
        const client = k8sClient(fn, { read: async () => content }, { clock: () => now });
        await get(client);
        content = 'jwt-two';
        now += 60_000;
        await get(client);
        expect(loginsOf(calls).map((call) => call.body.jwt)).toEqual(['jwt-one', 'jwt-two']);
    });

    it('runs one login at a time for concurrent calls', async () => {
        const { fn, calls } = fakeFetch(
            router(async () => {
                await sleep(40);
                return loginOk();
            })
        );
        const client = k8sClient(fn, jwtFile());
        await Promise.all([get(client), get(client), get(client)]);
        expect(loginsOf(calls)).toHaveLength(1);
        expect(dataOf(calls)).toHaveLength(3);
    });

    it('logs in again once and repeats the request when the token is refused', async () => {
        let tokens = 0;
        let refusals = 0;
        const { fn, calls } = fakeFetch(
            router(
                () => loginOk(3600, `${TOKEN}-${++tokens}`),
                (seen) => {
                    if (seen.headers['X-Vault-Token'] === `${TOKEN}-1`) {
                        refusals += 1;
                        return denied();
                    }
                    return readOk();
                }
            )
        );
        expect(await get(k8sClient(fn, jwtFile()))).toMatchObject({ name: NAME });
        expect(refusals).toBe(1);
        expect(loginsOf(calls)).toHaveLength(2);
        expect(dataOf(calls)).toHaveLength(2);
    });

    it('is misconfigured when the second request in one call is refused too, after exactly two logins', async () => {
        const { fn, calls } = fakeFetch(router(() => loginOk(), denied));
        expect(await verdict(put(k8sClient(fn, jwtFile())))).toBe('misconfigured');
        expect(loginsOf(calls)).toHaveLength(2);
        expect(dataOf(calls)).toHaveLength(2);
    });

    it('does not log in again for a refusal in token mode', async () => {
        const { fn, calls } = fakeFetch(denied);
        expect(await verdict(get(tokenClient(fn)))).toBe('misconfigured');
        expect(calls).toHaveLength(1);
    });

    it.each(['ENOENT', 'ENOTDIR', 'EACCES'])('is misconfigured when the token file fails with %s', async (code) => {
        const { fn, calls } = fakeFetch(router(() => loginOk()));
        const client = k8sClient(fn, {
            read: async () => {
                throw Object.assign(new Error(`${code} ${SENTINEL}`), { code });
            },
        });
        expect(await verdict(get(client))).toBe('misconfigured');
        expect(calls).toHaveLength(0);
    });

    it('is a retry when the token file fails with another errno, and misconfigured when it is empty', async () => {
        const fails = k8sClient(fakeFetch(router(() => loginOk())).fn, {
            read: async () => {
                throw Object.assign(new Error('io'), { code: 'EIO' });
            },
        });
        expect(await verdict(get(fails))).toBe('retry');
        expect(await verdict(get(k8sClient(fakeFetch(router(() => loginOk())).fn, jwtFile('  \n'))))).toBe(
            'misconfigured'
        );
    });

    it.each([
        ['a refused login', () => json(403, { errors: ['permission denied'] }), 'misconfigured'],
        ['an unknown role', () => json(400, { errors: ['invalid role name'] }), 'misconfigured'],
        [
            'a missing auth mount',
            () => json(404, { errors: ["no handler for route 'auth/kubernetes/login'"] }),
            'misconfigured',
        ],
        ['a 503', () => new Response(SENTINEL, { status: 503 }), 'retry'],
        ['a 200 with no token', () => json(200, { auth: {} }), 'retry'],
        ['a non-JSON 200', () => new Response('ok', { status: 200 }), 'retry'],
    ])('maps %s to %s and never dispatches the request', async (_label, answer, expected) => {
        const { fn, calls } = fakeFetch(router(answer));
        expect(await verdict(get(k8sClient(fn, jwtFile())))).toBe(expected);
        expect(dataOf(calls)).toHaveLength(0);
    });

    it('treats a login failure before a write as never started, not ambiguous', async () => {
        const { fn } = fakeFetch(router(() => new Response(SENTINEL, { status: 503 })));
        expect(await verdict(put(k8sClient(fn, jwtFile())))).toBe('retry');
    });

    it('leaks neither the token, the projected token nor any body into a fault', async () => {
        const answers = [
            () => new Response(`${SENTINEL} ${TOKEN} ${JWT}`, { status: 503 }),
            () => json(403, { errors: [`${SENTINEL} ${TOKEN}`] }),
            () => json(200, { errors: [SENTINEL], data: SENTINEL }),
            () => json(400, { errors: [SENTINEL, TOKEN] }),
        ];
        for (const answer of answers) {
            for (const run of [put, get, remove]) {
                const client = k8sClient(fakeFetch(router(() => loginOk(), answer)).fn, jwtFile());
                try {
                    await run(client as never);
                } catch (error) {
                    const seen = `${String(error)} ${(error as Error).stack ?? ''} ${JSON.stringify(error)}`;
                    expect(seen).not.toContain(SENTINEL);
                    expect(seen).not.toContain(TOKEN);
                    expect(seen).not.toContain(JWT);
                }
            }
        }
    });
});

describe('the Vault adapter: one absolute deadline', () => {
    const jwtFile = { read: async () => JWT };
    const isLogin = (seen: Seen) => seen.url.pathname.endsWith('/login');

    it('returns by its deadline when the login is slower, and dispatches nothing afterwards', async () => {
        const { fn, calls } = fakeFetch((seen, signal) => (isLogin(seen) ? hang(signal, 90) : written()));
        const started = Date.now();
        const outcome = await verdict(put(k8sClient(fn, jwtFile), 40));
        expect(Date.now() - started).toBeLessThan(80);
        expect(outcome).toBe('retry');
        await sleep(150);
        expect(calls.filter((call) => !isLogin(call))).toHaveLength(0);
    });

    it('stops a waiter at its own deadline while another call owns the login', async () => {
        const { fn, calls } = fakeFetch((seen) =>
            isLogin(seen) ? new Promise<Response>((resolve) => setTimeout(() => resolve(loginOk()), 120)) : readOk()
        );
        const client = k8sClient(fn, jwtFile);
        const owner = get(client, 1000);
        await sleep(10);
        const started = Date.now();
        expect(await verdict(get(client, 50))).toBe('retry');
        expect(Date.now() - started).toBeLessThan(100);
        await owner;
        expect(calls.filter(isLogin)).toHaveLength(1);
    });

    it('dispatches no second request when the re-login after a refusal outlasts the deadline', async () => {
        let logins = 0;
        const { fn, calls } = fakeFetch((seen, signal) => {
            if (isLogin(seen)) {
                logins += 1;
                return logins === 1 ? loginOk() : hang(signal, 200);
            }
            return denied();
        });
        const started = Date.now();
        const outcome = await verdict(get(k8sClient(fn, jwtFile), 80));
        expect(Date.now() - started).toBeLessThan(140);
        expect(outcome).toBe('retry');
        await sleep(250);
        expect(calls.filter((call) => !isLogin(call))).toHaveLength(1);
    });

    it('dispatches nothing once the deadline has passed', async () => {
        const { fn, calls } = fakeFetch(() => written());
        expect(await verdict(put(tokenClient(fn), 5))).toBe('retry');
        expect(calls).toHaveLength(0);
    });

    it('bounds a hung login by its own timeout, and the next call logs in again', async () => {
        let logins = 0;
        const { fn } = fakeFetch((seen, signal) => {
            if (isLogin(seen)) {
                logins += 1;
                return logins === 1 ? hang(signal) : loginOk();
            }
            return readOk();
        });
        const client = k8sClient(fn, jwtFile, { requestMs: 60 });
        expect(await verdict(get(client, 30))).toBe('retry');
        await sleep(100);
        expect(await get(client, 1000)).toMatchObject({ name: NAME });
        expect(logins).toBe(2);
    });

    it('aborts with the caller: an aborted call dispatches nothing', async () => {
        const { fn, calls } = fakeFetch(() => written());
        const controller = new AbortController();
        controller.abort();
        expect(await verdict(tokenClient(fn).put(object, 1000, controller.signal))).toBe('retry');
        expect(calls).toHaveLength(0);
    });
});

describe('the Vault adapter: only a 2xx is ever read as a provider body', () => {
    const REDIRECTS = [301, 302, 307, 308];
    const redirect = (status: number, located: boolean, body: string | null = null) =>
        new Response(body, { status, ...(located ? { headers: { location: 'http://elsewhere.test/x' } } : {}) });
    const cases = REDIRECTS.flatMap((status) => [
        [status, true],
        [status, false],
    ]) as Array<[number, boolean]>;

    it.each(cases)(
        'is a retry for a read answered %i (location: %s), never malformed or absent',
        async (status, located) => {
            expect(await verdict(get(tokenClient(fakeFetch(() => redirect(status, located)).fn)))).toBe('retry');
        }
    );

    it.each(cases)('does not parse the body of a %i (location: %s) as a secret', async (status, located) => {
        const body = JSON.stringify({
            data: {
                data: { name: NAME, version_id: VERSION_ID, payload: b64('x') },
                metadata: { version: 1, destroyed: false, deletion_time: '' },
            },
        });
        expect(await verdict(get(tokenClient(fakeFetch(() => redirect(status, located, body)).fn)))).toBe('retry');
    });

    it.each(cases)('leaves a write answered %i (location: %s) ambiguous', async (status, located) => {
        expect(await verdict(put(tokenClient(fakeFetch(() => redirect(status, located)).fn)))).toBe('ambiguous');
    });

    it.each(cases)('does not confirm a delete answered %i (location: %s)', async (status, located) => {
        expect(await verdict(remove(tokenClient(fakeFetch(() => redirect(status, located)).fn)))).toBe('ambiguous');
    });

    it('classifies a 1xx and every 3xx as unrecognized for every operation', () => {
        const ops: VaultOp[] = ['write', 'read', 'delete', 'login'];
        for (const op of ops) {
            for (const status of [100, 199, 300, 301, 302, 304, 307, 308]) {
                expect(classifyAnswer(op, status, '{"errors":[]}')).toEqual({ kind: 'unrecognized' });
            }
        }
    });

    it('still reads a 2xx that is no secret as malformed', async () => {
        expect(await get(tokenClient(fakeFetch(() => json(200, { data: {} })).fn))).toBe('malformed');
    });
});

describe('the Vault adapter: a stalled token-file read is bounded and recoverable', () => {
    const isLogin = (seen: Seen) => seen.url.pathname.endsWith('/login');
    const stalled = () => new Promise<string>(() => undefined);

    it('returns retry by its own deadline, then a later call logs in once the file is readable', async () => {
        let reads = 0;
        const { fn } = fakeFetch((seen) => (isLogin(seen) ? loginOk() : readOk()));
        const client = k8sClient(
            fn,
            {
                read: () => {
                    reads += 1;
                    return reads === 1 ? stalled() : Promise.resolve(JWT);
                },
            },
            { requestMs: 60 }
        );
        const started = Date.now();
        expect(await verdict(get(client, 1000))).toBe('retry');
        expect(Date.now() - started).toBeLessThan(500);
        await sleep(120);
        expect(await get(client, 1000)).toMatchObject({ name: NAME });
        expect(reads).toBe(2);
    });

    it('drops the stale attempt when its read resolves late: no login, no overwritten token', async () => {
        let release: (value: string) => void = () => undefined;
        let reads = 0;
        let logins = 0;
        const { fn, calls } = fakeFetch((seen) => {
            if (isLogin(seen)) {
                logins += 1;
                return loginOk(3600, `${TOKEN}-${logins}`);
            }
            return readOk();
        });
        const client = k8sClient(
            fn,
            {
                read: () => {
                    reads += 1;
                    return reads === 1 ? new Promise<string>((resolve) => (release = resolve)) : Promise.resolve(JWT);
                },
            },
            { requestMs: 60 }
        );
        expect(await verdict(get(client, 1000))).toBe('retry');
        await sleep(120);
        await get(client, 1000);
        expect(logins).toBe(1);
        release(JWT);
        await sleep(50);
        await get(client, 1000);
        expect(logins).toBe(1);
        const dataCalls = calls.filter((call) => !isLogin(call));
        expect(dataCalls.at(-1)?.headers['X-Vault-Token']).toBe(`${TOKEN}-1`);
    });
});
