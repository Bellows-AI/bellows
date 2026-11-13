import { describe, expect, it } from 'vitest';
import { run } from '../src/run.js';
import { json, recordingBoard, refusal, routed } from './harness.js';

/** `bellows operator …`: the board operator's organization status surface, one HTTP call per command. */

const orgs = [
    { id: '101', name: 'acme', status: 'active' },
    { id: '202', name: 'globex', status: 'suspended' },
];

describe('bellows operator list', () => {
    it('lists every organization with its status', async () => {
        const { out, io } = recordingBoard(routed({ '/api/operator/orgs': () => json({ orgs }) }));
        expect(await run(['operator', 'list'], io)).toBe(0);
        expect(out.join('')).toBe('101  acme  active\n202  globex  suspended\n');
    });

    it('prints the organizations in the envelope', async () => {
        const { out, io } = recordingBoard(routed({ '/api/operator/orgs': () => json({ orgs }) }));
        await run(['operator', 'list', '--json'], io);
        expect(JSON.parse(out.join('')).data.orgs).toEqual(orgs);
    });

    it('reports the board’s 403 for a caller who is not the operator', async () => {
        const { err, io } = recordingBoard(() => refusal(403, 'FORBIDDEN', 'Only the board operator can do this'));
        expect(await run(['operator', 'list'], io)).not.toBe(0);
        expect(err.join('')).toBe('error: Only the board operator can do this [FORBIDDEN]\n');
    });
});

describe.each([
    ['suspend', 'suspended'],
    ['refuse', 'refused'],
    ['activate', 'active'],
])('bellows operator %s', (verb, status) => {
    it(`POSTs the ${verb} and says what changed`, async () => {
        const { out, sent, io } = recordingBoard(() =>
            json({ changed: true, org: { id: '101', name: 'acme', status } })
        );
        expect(await run(['operator', verb, '101'], io)).toBe(0);
        expect(sent.map((s) => [s.method, s.path])).toEqual([['POST', `/api/operator/orgs/101/${verb}`]]);
        expect(out.join('')).toBe(`organization 101 (acme) is now ${status}\n`);
    });

    it('says when the status already held', async () => {
        const { out, io } = recordingBoard(() => json({ changed: false, org: { id: '101', name: 'acme', status } }));
        expect(await run(['operator', verb, '101'], io)).toBe(0);
        expect(out.join('')).toBe(`organization 101 (acme) is already ${status}\n`);
    });

    it('needs exactly one organization id', async () => {
        const { err, sent, io } = recordingBoard(() => json({}));
        expect(await run(['operator', verb], io)).not.toBe(0);
        expect(await run(['operator', verb, '101', '202'], io)).not.toBe(0);
        expect(sent).toEqual([]);
        expect(err.join('')).toContain(`operator ${verb} needs exactly one organization id`);
    });
});

describe('bellows operator delete', () => {
    it('sends nothing without --yes, since a purge cannot be undone', async () => {
        const { err, sent, io } = recordingBoard(() => json({}));
        expect(await run(['operator', 'delete', '202'], io)).not.toBe(0);
        expect(sent).toEqual([]);
        expect(err.join('')).toContain('pass --yes to confirm');
    });

    it('POSTs the delete and says the purge is queued', async () => {
        const { out, sent, io } = recordingBoard(() =>
            json({ requested: true, org: { id: '202', name: 'globex', status: 'suspended' } })
        );
        expect(await run(['operator', 'delete', '202', '--yes'], io)).toBe(0);
        expect(sent.map((s) => [s.method, s.path])).toEqual([['POST', '/api/operator/orgs/202/delete']]);
        expect(out.join('')).toBe('organization 202 (globex) is queued for deletion\n');
    });

    it('says when the purge was already queued', async () => {
        const { out, io } = recordingBoard(() =>
            json({ requested: false, org: { id: '202', name: 'globex', status: 'refused' } })
        );
        expect(await run(['operator', 'delete', '202', '--yes'], io)).toBe(0);
        expect(out.join('')).toBe('organization 202 (globex) is already queued for deletion\n');
    });

    it('reports the board’s 409 for an org that is still active', async () => {
        const { err, io } = recordingBoard(() =>
            refusal(409, 'ORG_ACTIVE', 'Suspend or refuse the organization first')
        );
        expect(await run(['operator', 'delete', '101', '--yes'], io)).not.toBe(0);
        expect(err.join('')).toBe('error: Suspend or refuse the organization first [ORG_ACTIVE]\n');
    });

    it('needs exactly one organization id', async () => {
        const { err, sent, io } = recordingBoard(() => json({}));
        expect(await run(['operator', 'delete', '--yes'], io)).not.toBe(0);
        expect(sent).toEqual([]);
        expect(err.join('')).toContain('operator delete needs exactly one organization id');
    });
});

it('escapes the organization id into the path', async () => {
    const { sent, io } = recordingBoard(() =>
        json({ changed: true, org: { id: 'a/b', name: 'x', status: 'refused' } })
    );
    await run(['operator', 'refuse', 'a/b'], io);
    expect(sent[0]!.path).toBe('/api/operator/orgs/a%2Fb/refuse');
});

const credential = {
    id: 'c1',
    label: 'east',
    pool: false,
    orgs: ['101', '202'],
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'u1',
    revokedAt: null,
    expiresAt: null,
    rotatedFrom: null,
};
const TOKEN = 'drv_0123456789abcdef';

describe('bellows operator credentials', () => {
    it('lists every driver credential with its reach and state, never a token', async () => {
        const pool = { ...credential, id: 'c2', label: 'shared', pool: true, orgs: [] };
        const revoked = { ...credential, id: 'c3', revokedAt: '2026-01-02T00:00:00.000Z' };
        const rotated = { ...credential, id: 'c4', expiresAt: '2026-01-03T00:00:00.000Z' };
        const { out, sent, io } = recordingBoard(
            routed({
                '/api/operator/driver-credentials': () => json({ credentials: [credential, pool, revoked, rotated] }),
            })
        );
        expect(await run(['operator', 'credentials'], io)).toBe(0);
        expect(sent.map((s) => [s.method, s.path])).toEqual([['GET', '/api/operator/driver-credentials']]);
        expect(out.join('')).toBe(
            [
                'c1  east  orgs 101,202  active',
                'c2  shared  pool  active',
                'c3  east  orgs 101,202  revoked',
                'c4  east  orgs 101,202  expires 2026-01-03T00:00:00.000Z',
            ].join('\n') + '\n'
        );
    });
});

describe('bellows operator issue-credential', () => {
    it('POSTs the organizations and prints the token once', async () => {
        const { out, sent, io } = recordingBoard(() => json({ credential, token: TOKEN }, 201));
        expect(await run(['operator', 'issue-credential', '--label', 'east', '--org', '101', '--org', '202'], io)).toBe(
            0
        );
        expect(sent.map((s) => [s.method, s.path, s.body])).toEqual([
            ['POST', '/api/operator/driver-credentials', { label: 'east', orgs: ['101', '202'] }],
        ]);
        expect(out.join('')).toBe(
            `driver credential c1 (east) issued for orgs 101,202; the token is shown only this once:\n${TOKEN}\n`
        );
    });

    it('issues a pool credential', async () => {
        const { sent, io } = recordingBoard(() =>
            json({ credential: { ...credential, pool: true, orgs: [] }, token: TOKEN }, 201)
        );
        expect(await run(['operator', 'issue-credential', '--label', 'shared', '--pool'], io)).toBe(0);
        expect(sent[0]!.body).toEqual({ label: 'shared', pool: true });
    });

    it('needs a label and exactly one of --org or --pool', async () => {
        const { err, sent, io } = recordingBoard(() => json({}));
        expect(await run(['operator', 'issue-credential', '--org', '101'], io)).not.toBe(0);
        expect(await run(['operator', 'issue-credential', '--label', 'x'], io)).not.toBe(0);
        expect(await run(['operator', 'issue-credential', '--label', 'x', '--pool', '--org', '101'], io)).not.toBe(0);
        expect(sent).toEqual([]);
        expect(err.join('')).toContain('operator issue-credential needs --label and either --org <id> or --pool');
    });
});

describe('bellows operator revoke-credential', () => {
    it('POSTs the revoke and says what changed', async () => {
        const { out, sent, io } = recordingBoard(() =>
            json({ revoked: true, credential: { ...credential, revokedAt: '2026-01-02T00:00:00.000Z' } })
        );
        expect(await run(['operator', 'revoke-credential', 'c1'], io)).toBe(0);
        expect(sent.map((s) => [s.method, s.path])).toEqual([['POST', '/api/operator/driver-credentials/c1/revoke']]);
        expect(out.join('')).toBe('driver credential c1 (east) is now revoked\n');
    });

    it('needs exactly one credential id', async () => {
        const { err, sent, io } = recordingBoard(() => json({}));
        expect(await run(['operator', 'revoke-credential'], io)).not.toBe(0);
        expect(sent).toEqual([]);
        expect(err.join('')).toContain('operator revoke-credential needs exactly one credential id');
    });
});

describe('bellows operator rotate-credential', () => {
    const rotated = {
        credential: { ...credential, id: 'c9', rotatedFrom: 'c1' },
        previous: { ...credential, expiresAt: '2026-01-01T01:00:00.000Z' },
        token: TOKEN,
    };

    it('POSTs the rotation with its overlap and prints the new token once', async () => {
        const { out, sent, io } = recordingBoard(() => json(rotated, 201));
        expect(await run(['operator', 'rotate-credential', 'c1', '--overlap', '600'], io)).toBe(0);
        expect(sent.map((s) => [s.method, s.path, s.body])).toEqual([
            ['POST', '/api/operator/driver-credentials/c1/rotate', { overlapSeconds: 600 }],
        ]);
        expect(out.join('')).toBe(
            'driver credential c9 (east) replaces c1, which works until 2026-01-01T01:00:00.000Z; ' +
                `the token is shown only this once:\n${TOKEN}\n`
        );
    });

    it('leaves the overlap to the board when not given', async () => {
        const { sent, io } = recordingBoard(() => json(rotated, 201));
        expect(await run(['operator', 'rotate-credential', 'c1'], io)).toBe(0);
        expect(sent[0]!.body).toEqual({});
    });

    it('refuses an overlap that is not a whole number of seconds', async () => {
        const { err, sent, io } = recordingBoard(() => json({}));
        expect(await run(['operator', 'rotate-credential', 'c1', '--overlap', 'soon'], io)).not.toBe(0);
        expect(sent).toEqual([]);
        expect(err.join('')).toContain('--overlap must be a whole number of seconds');
    });

    it('reports the board’s 409 for a revoked or already rotated credential', async () => {
        const { err, io } = recordingBoard(() =>
            refusal(
                409,
                'DRIVER_CREDENTIAL_INACTIVE',
                'A revoked or already rotated driver credential cannot be rotated'
            )
        );
        expect(await run(['operator', 'rotate-credential', 'c1'], io)).not.toBe(0);
        expect(err.join('')).toContain('[DRIVER_CREDENTIAL_INACTIVE]');
    });
});
