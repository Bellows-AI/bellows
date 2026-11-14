import { describe, expect, it } from 'vitest';
import type { BoardJob } from '../src/board/board.js';
import { DOCKERD_RESTART_NOTE } from '../src/dockerd-loss.js';
import { createGateServer, type GateManager } from '../src/gates.js';
import type { Read } from '../src/runner.js';

/**
 * An ad-hoc `POST /run` while the docker daemon restarted: the answer carries a note beside its
 * verdict, and nothing interrupts the attempt — the agent decides what to do with a gate it asked for.
 */
const KEY = '11111111-1111-4111-8111-111111111111/repo';
const JOB = { id: 'job-1', leaseToken: 'lease-1' } as BoardJob;

const managerAnswering = (exitCode: number): GateManager => ({
    acquire: async () => {},
    runGate: async () => ({ exitCode, output: exitCode === 0 ? 'ok' : 'failed' }),
    runSetup: async () => null,
    release: () => {},
    stop: async () => {},
});

async function adHoc(exitCode: number, reads: Read<number>[]) {
    const server = createGateServer({ host: '127.0.0.1', manager: managerAnswering(exitCode) });
    const losses: string[] = [];
    const queue = [...reads];
    server.register('tok-d', {
        key: KEY,
        image: 'node:24',
        job: JOB,
        gates: [{ name: 'test', command: 'npm test' }],
        onInfraLoss: (reason) => losses.push(reason),
        dockerdRestarts: async () => queue.shift() ?? { kind: 'absent' },
    });
    const port = await server.listen();
    try {
        const response = await fetch(`http://127.0.0.1:${port}/run`, {
            method: 'POST',
            headers: { authorization: 'Bearer tok-d' },
            body: JSON.stringify({ gate: 'test' }),
        });
        return { status: response.status, body: (await response.json()) as Record<string, unknown>, losses };
    } finally {
        await server.close();
    }
}

const value = (count: number): Read<number> => ({ kind: 'value', value: count });

describe('an ad-hoc gate run during a dockerd restart', () => {
    it('answers the failed verdict with a dockerd note, and reports no loss', async () => {
        const { status, body, losses } = await adHoc(1, [value(0), value(1)]);

        expect(status).toBe(200);
        expect(body).toMatchObject({ exitCode: 1, dockerd: DOCKERD_RESTART_NOTE });
        expect(losses).toEqual([]);
    });

    it.each<[string, number, Read<number>[]]>([
        ['an unchanged count', 1, [value(1), value(1)]],
        ['an unread pod', 1, [value(0), { kind: 'inconclusive', reason: 'HTTP 503' }]],
        ['a passing gate', 0, [value(0), value(1)]],
        ['a class with no daemon', 1, []],
    ])('adds no note on %s', async (_name, exitCode, reads) => {
        const { status, body } = await adHoc(exitCode, reads);

        expect(status).toBe(200);
        expect(body).not.toHaveProperty('dockerd');
    });
});
