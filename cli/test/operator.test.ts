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

it('escapes the organization id into the path', async () => {
    const { sent, io } = recordingBoard(() =>
        json({ changed: true, org: { id: 'a/b', name: 'x', status: 'refused' } })
    );
    await run(['operator', 'refuse', 'a/b'], io);
    expect(sent[0]!.path).toBe('/api/operator/orgs/a%2Fb/refuse');
});
