import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import { recordingBoard, json, routed } from './harness.js';

/** Answers each path from `routes`; a path not listed fails the test by answering 404. */
function harness(routes: Record<string, () => Response>) {
    const { out, err, sent: calls, io } = recordingBoard(routed(routes));
    return { out, err, calls, io };
}

const visible = (overrides: Record<string, unknown> = {}) => ({
    repos: [
        { owner: 'acme', name: 'api', private: true, defaultBranch: 'main', pushedAt: null },
        { owner: 'acme', name: 'web', private: false, defaultBranch: 'trunk', pushedAt: null },
    ],
    installation: { account: 'acme' },
    meta: { fetchedAt: '2026-10-01T00:00:00.000Z', error: null },
    ...overrides,
});

const workspace = (overrides: Record<string, unknown> = {}) => ({
    executors: [{ id: 'e1', name: 'mine', type: 'claude', suspended: false }],
    orgExecutors: [{ name: 'team', type: 'claude', suspended: true }],
    defaultExecutor: { scope: 'user', name: 'mine' },
    ...overrides,
});

describe('bellows repo list', () => {
    it('lists the repositories the board tracks, and reads nothing else', async () => {
        const { out, calls, io } = harness({ '/api/repos': () => json(visible()) });

        const code = await run(['repo', 'list', '--json'], io);

        expect(code).toBe(0);
        const envelope = JSON.parse(out.join(''));
        expect(envelope.command).toBe('repo list');
        expect(envelope.data.repos).toEqual([
            { repo: 'acme/api', private: true, defaultBranch: 'main' },
            { repo: 'acme/web', private: false, defaultBranch: 'trunk' },
        ]);
        expect(Object.keys(envelope.data).sort()).toEqual(['error', 'fetchedAt', 'repos']);
        // Read-only, and the workspace read is not part of it: nothing here is synced.
        expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual(['GET /api/repos']);
    });

    it('prints one line per repo for a person', async () => {
        const { out, io } = harness({ '/api/repos': () => json(visible()) });

        expect(await run(['repo', 'list'], io)).toBe(0);

        const text = out.join('');
        expect(text).toContain('acme/api  private  main');
        expect(text).toContain('acme/web  public  trunk');
        for (const gone of ['visible', 'synced', 'workspace root']) expect(text).not.toContain(gone);
    });

    it('says so for an empty list, and carries the board error with the last good list', async () => {
        const empty = harness({ '/api/repos': () => json(visible({ repos: [] })) });
        expect(await run(['repo', 'list'], empty.io)).toBe(0);
        expect(empty.out.join('')).toContain('no repositories tracked');

        const stale = harness({
            '/api/repos': () => json(visible({ meta: { fetchedAt: null, error: 'GitHub is unreachable' } })),
        });
        expect(await run(['repo', 'list', '--json'], stale.io)).toBe(0);
        expect(JSON.parse(stale.out.join('')).data.error).toBe('GitHub is unreachable');
    });
});

describe('bellows executor list', () => {
    it('lists personal then org profiles with their scope, suspension and the default', async () => {
        const { out, io } = harness({ '/api/workspace': () => json(workspace()) });

        expect(await run(['executor', 'list', '--json'], io)).toBe(0);

        expect(JSON.parse(out.join('')).data.executors).toEqual([
            { scope: 'user', name: 'mine', type: 'claude', suspended: false, default: true },
            { scope: 'org', name: 'team', type: 'claude', suspended: true, default: false },
        ]);
    });

    it('renders the human form and an empty state', async () => {
        const some = harness({ '/api/workspace': () => json(workspace()) });
        expect(await run(['executor', 'list'], some.io)).toBe(0);
        expect(some.out.join('')).toBe('user  mine  claude  active  default\norg  team  claude  suspended\n');

        const none = harness({
            '/api/workspace': () => json(workspace({ executors: [], orgExecutors: [], defaultExecutor: null })),
        });
        expect(await run(['executor', 'list'], none.io)).toBe(0);
        expect(none.out.join('')).toBe('no executors\n');
    });

    it('never carries a profile config through', async () => {
        const { out, io } = harness({
            '/api/workspace': () =>
                json(workspace({ executors: [{ name: 'mine', type: 'claude', config: { apiKey: 'sk-secret' } }] })),
        });

        await run(['executor', 'list', '--json'], io);

        expect(out.join('')).not.toContain('sk-secret');
    });
});

describe('bellows skill list', () => {
    const skills = [
        {
            name: 'jira',
            description: 'Work Jira items',
            requires: { tools: ['curl'], connections: [{ name: 'jira', env: [], selectedBy: 'jiraConnection' }] },
        },
    ];

    it('lists skills with their requirements', async () => {
        const { out, io } = harness({ '/api/skills': () => json({ skills }) });

        expect(await run(['skill', 'list'], io)).toBe(0);

        expect(out.join('')).toBe(
            'jira  Work Jira items  [requires tool:curl, connection:jira (select jiraConnection)]\n'
        );
    });

    it('prints the skills in the envelope, and says so when none are installed', async () => {
        const some = harness({ '/api/skills': () => json({ skills }) });
        await run(['skill', 'list', '--json'], some.io);
        expect(JSON.parse(some.out.join('')).data.skills).toEqual(skills);

        const none = harness({ '/api/skills': () => json({ skills: [] }) });
        await run(['skill', 'list'], none.io);
        expect(none.out.join('')).toBe('no skills installed\n');
    });
});

describe('bellows connection list', () => {
    const connection = {
        id: '3f2b6c1e-0000-4000-8000-000000000001',
        kind: 'jira',
        site: 'acme.atlassian.net',
        email: 'a@acme.test',
        access: 'read',
        scope: 'org',
        createdAt: '2026-10-01T00:00:00.000Z',
    };

    it('lists the org and personal connections the caller may select, without a token', async () => {
        const { out, io } = harness({
            '/api/connections': () => json({ connections: [connection, { ...connection, scope: 'user', id: 'u' }] }),
        });

        expect(await run(['connection', 'list'], io)).toBe(0);

        const text = out.join('');
        expect(text).toContain(`${connection.id}  jira  org  read  acme.atlassian.net  a@acme.test`);
        expect(text).toContain('u  jira  user');
        expect(text).not.toMatch(/token/i);
    });

    it('is empty without error when the caller has none', async () => {
        const { out, io } = harness({ '/api/connections': () => json({ connections: [] }) });
        expect(await run(['connection', 'list'], io)).toBe(0);
        expect(out.join('')).toBe('no connections available\n');
    });
});

describe('bellows job create --jira-connection', () => {
    const ID = '3f2b6c1e-0000-4000-8000-000000000001';

    it('sends the selected connection id in the create body, and nothing when absent', async () => {
        const { calls, io } = harness({ '/api/jobs': () => json({ id: 'job-1', status: 'queued' }, 201) });

        expect(await run(['job', 'create', '--jira-connection', ID, '--', 'npm test'], io)).toBe(0);
        expect(await run(['job', 'create', '--', 'npm test'], io)).toBe(0);

        expect(calls[0]!.body).toEqual({ command: 'npm test', jiraConnection: ID });
        expect(calls[1]!.body).toEqual({ command: 'npm test' });
    });
});
