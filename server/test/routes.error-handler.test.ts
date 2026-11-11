import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { errorHandler } from '../src/routes/error-handler.js';
import { githubAuth, harness, memoryAuthStore, memoryEnvVarStore, signedIn } from './helpers.js';
import { HTTP_BAD_REQUEST, HTTP_SERVICE_UNAVAILABLE, trackApps } from './helpers-http.js';

const HTTP_INTERNAL = 500;
const SQL = 'connect ECONNREFUSED 10.0.0.7:5432 while running select secret from users';

const track = trackApps();

const failure = (code: string, message = SQL) => Object.assign(new Error(message), { code });

async function putWorkspace(error: Error) {
    const auth = memoryAuthStore();
    const member = auth.seedMember('test-org', 'octocat');
    const envVars = memoryEnvVarStore();
    envVars.replaceWorkspace = async () => {
        throw error;
    };
    const h = await harness({ auth, envVars, config: { auth: githubAuth() } });
    track(h.app);
    return h.app.inject({
        method: 'PUT',
        url: '/api/env/workspace',
        headers: { cookie: await signedIn(auth, member) },
        payload: { vars: [{ name: 'X', value: '1', isSecret: false }] },
    });
}

describe('a guarded route whose store throws', () => {
    it.each([
        ['a refused connection', failure('ECONNREFUSED')],
        ['a postgres connection exception', failure('08006')],
        ['a postgres client that lost its connection', failure('CONNECTION_CLOSED')],
        ['an aggregate connect error', new AggregateError([failure('ECONNREFUSED')], 'connect failed')],
        ['a wrapped outage', new Error('wrapper', { cause: failure('57P01') })],
    ])('answers a generic 503 for %s, without the thrown text', async (_label, error) => {
        const response = await putWorkspace(error);

        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.json().code).toBe('UNAVAILABLE');
        expect(response.body).not.toContain('select');
        expect(response.body).not.toContain('10.0.0.7');
    });

    it('answers 500 INTERNAL with a request id for a programming error', async () => {
        const response = await putWorkspace(new TypeError("Cannot read properties of undefined (reading 'rows')"));

        expect(response.statusCode).toBe(HTTP_INTERNAL);
        const body = response.json();
        expect(body.code).toBe('INTERNAL');
        expect(body.requestId).toEqual(expect.any(String));
        expect(response.body).not.toContain('rows');
    });

    it('answers 500 for a constraint violation, which is a bug and not an outage', async () => {
        const response = await putWorkspace(failure('23505', 'duplicate key value violates unique constraint'));

        expect(response.statusCode).toBe(HTTP_INTERNAL);
        expect(response.body).not.toContain('duplicate key');
    });
});

describe('the auth hook with an unreachable credential store', () => {
    it('answers 503 without the SQL text', async () => {
        const auth = memoryAuthStore();
        const cookie = await signedIn(auth, auth.seedMember('test-org', 'octocat'));
        const down = new Proxy(auth, {
            get: () => async () => {
                throw failure('ECONNREFUSED');
            },
        });
        const h = await harness({ auth: down, config: { auth: githubAuth() } });
        track(h.app);

        const response = await h.app.inject({
            method: 'GET',
            url: '/api/env',
            headers: { cookie },
        });

        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.body).not.toContain('select');
    });
});

describe('the app-wide handler', () => {
    async function serve(lines: string[]) {
        const app = Fastify({ logger: { level: 'error', stream: { write: (line: string) => lines.push(line) } } });
        app.setErrorHandler(errorHandler);
        app.get('/boom', async () => {
            throw new TypeError(SQL);
        });
        app.get('/down', async () => {
            throw failure('ECONNREFUSED');
        });
        app.post('/json', async () => ({ ok: true }));
        return track(app);
    }

    it('catches a throw outside guard and logs the full error', async () => {
        const lines: string[] = [];
        const app = await serve(lines);

        const response = await app.inject({ method: 'GET', url: '/boom' });

        expect(response.statusCode).toBe(HTTP_INTERNAL);
        expect(response.body).not.toContain('select');
        expect(lines.join('')).toContain('select secret from users');
    });

    it('logs an outage in full and answers it generically', async () => {
        const lines: string[] = [];
        const app = await serve(lines);

        const response = await app.inject({ method: 'GET', url: '/down' });

        expect(response.statusCode).toBe(HTTP_SERVICE_UNAVAILABLE);
        expect(response.body).not.toContain('10.0.0.7');
        expect(lines.join('')).toContain('10.0.0.7');
    });

    it('leaves a client error with its own status', async () => {
        const app = await serve([]);

        const response = await app.inject({
            method: 'POST',
            url: '/json',
            headers: { 'content-type': 'application/json' },
            payload: '{not json',
        });

        expect(response.statusCode).toBe(HTTP_BAD_REQUEST);
    });
});
