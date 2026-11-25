import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createGitlabConnection,
    deleteGitlabConnection,
    listGitlabConnections,
    listGitlabProjects,
    saveGitlabTracked,
    startGitlabActivation,
    startGitlabLink,
    type GitlabConnectionView,
} from '../src/api/gitlab.js';
import { listGitlabGrants } from '../src/api/forgeGrants.js';

/** The GitLab settings page's client half: each route, its body, and the refusals the page words. Routes' answers are server/test-db's. */

const ID = '11111111-1111-4111-8111-111111111111';
const VIEW: GitlabConnectionView = {
    id: ID,
    host: 'gitlab.example.test',
    clientId: 'app-1',
    allowedGroups: ['acme'],
    hasCaBundle: false,
    active: false,
    version: null,
    activationRefusal: null,
    probe: { status: 'reachable', reason: null, at: '2026-09-01T00:00:00.000Z' },
    createdAt: '2026-09-01T00:00:00.000Z',
};

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const stub = (reply: () => Response) => {
    const fetchStub = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(reply()));
    vi.stubGlobal('fetch', fetchStub);
    return fetchStub;
};

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('the connection routes', () => {
    it('lists the connections and refuses a malformed row as an error, never an empty list', async () => {
        stub(() => json({ connections: [VIEW] }));
        expect(await listGitlabConnections()).toEqual({ ok: true, connections: [VIEW] });
        stub(() => json({ connections: [{ ...VIEW, allowedGroups: 'acme' }] }));
        expect((await listGitlabConnections()).ok).toBe(false);
        stub(() => json({}));
        expect((await listGitlabConnections()).ok).toBe(false);
    });

    it('creates with the typed fields and answers the stored connection; a refusal keeps its code', async () => {
        const input = { host: 'gitlab.example.test', clientId: 'app-1', clientSecret: 's', allowedGroups: ['acme'] };
        const fetchStub = stub(() => json(VIEW, 201));
        expect(await createGitlabConnection(input)).toEqual({ ok: true, connection: VIEW });
        const [url, init] = fetchStub.mock.calls[0]!;
        expect(url).toBe('/api/org/gitlab-connections');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(init?.body as string)).toEqual(input);

        stub(() => json({ error: 'already connected', code: 'GITLAB_CONNECTION_EXISTS' }, 409));
        expect(await createGitlabConnection(input)).toMatchObject({
            ok: false,
            error: 'already connected',
            code: 'GITLAB_CONNECTION_EXISTS',
        });
    });

    it('deletes by id: null on success, the sentence on a refusal', async () => {
        const fetchStub = stub(() => json({ ok: true }));
        expect(await deleteGitlabConnection(ID)).toBeNull();
        expect(fetchStub.mock.calls[0]![0]).toBe(`/api/org/gitlab-connections/${ID}`);
        stub(() => json({ error: 'No such GitLab connection' }, 404));
        expect(await deleteGitlabConnection(ID)).toBe('No such GitLab connection');
    });
});

describe('the OAuth starts', () => {
    it.each([
        ['activation', startGitlabActivation, `/api/org/gitlab-connections/${ID}/activation`],
        ['link', startGitlabLink, `/api/forge-grants/gitlab/${ID}/link`],
    ])('%s posts the return path and answers the authorize url', async (_name, start, path) => {
        const fetchStub = stub(() =>
            json({ authorizeUrl: 'https://gitlab.example.test/oauth/authorize?x=1', expiresAt: 't' }, 201)
        );
        expect(await start(ID)).toEqual({ ok: true, authorizeUrl: 'https://gitlab.example.test/oauth/authorize?x=1' });
        const [url, init] = fetchStub.mock.calls[0]!;
        expect(url).toBe(path);
        expect(JSON.parse(init?.body as string)).toEqual({ returnTo: '/settings/integrations/gitlab' });
    });

    it('a pending connection is the sentence the route sent', async () => {
        stub(() => json({ error: 'not active yet', code: 'GITLAB_CONNECTION_PENDING' }, 409));
        expect(await startGitlabLink(ID)).toMatchObject({ ok: false, error: 'not active yet' });
    });
});

describe('the member standings', () => {
    it('reads each active connection with the caller standing', async () => {
        const rows = [{ id: ID, host: 'gitlab.example.test', standing: 'broken' }];
        stub(() => json({ connections: rows }));
        expect(await listGitlabGrants()).toEqual({ ok: true, connections: rows });
        stub(() => json({ connections: [{ id: ID, host: 'h', standing: 'weird' }] }));
        expect((await listGitlabGrants()).ok).toBe(false);
    });
});

describe('tracking', () => {
    it('lists the projects of a connection, keeping an unlisted row', async () => {
        const projects = [
            { path: 'acme/api', defaultBranch: 'main', tracked: true, listed: true },
            { path: 'acme/old', defaultBranch: null, tracked: true, listed: false },
        ];
        const fetchStub = stub(() => json({ projects }));
        expect(await listGitlabProjects(ID)).toEqual({ ok: true, projects });
        expect(fetchStub.mock.calls[0]![0]).toBe(`/api/org/gitlab-connections/${ID}/projects`);
    });

    it('a 503 is a retry sentence, never an empty list', async () => {
        stub(() => json({ error: 'raw', code: 'UNAVAILABLE' }, 503));
        const listed = await listGitlabProjects(ID);
        expect(listed).toMatchObject({ ok: false, retry: true });
        expect(listed.ok ? '' : listed.error).toMatch(/could not list/i);
    });

    it('a grant refusal is not a retry', async () => {
        stub(() => json({ error: 'Your GitLab connection is missing', code: 'FORGE_GRANT_REQUIRED' }, 409));
        expect(await listGitlabProjects(ID)).toMatchObject({ ok: false, retry: false });
    });

    it('saves the picked paths and keeps the 409 code of a collision', async () => {
        const fetchStub = stub(() => json({ tracked: ['acme/api'] }));
        expect(await saveGitlabTracked(ID, ['acme/api'])).toEqual({ ok: true });
        const [url, init] = fetchStub.mock.calls[0]!;
        expect(url).toBe(`/api/org/gitlab-connections/${ID}/tracked-repos`);
        expect(init?.method).toBe('PUT');
        expect(JSON.parse(init?.body as string)).toEqual({ paths: ['acme/api'] });
        stub(() => json({ error: 'already tracked elsewhere', code: 'TRACKED_PATH_CONFLICT' }, 409));
        expect(await saveGitlabTracked(ID, ['acme/api'])).toMatchObject({
            ok: false,
            code: 'TRACKED_PATH_CONFLICT',
            error: 'already tracked elsewhere',
        });
    });
});
