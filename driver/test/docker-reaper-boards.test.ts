import { describe, expect, it } from 'vitest';
import { createDockerReaper } from '../src/docker/docker-reaper.js';
import type { ExecDocker } from '../src/docker/docker-runner-support.js';
import { createReaper } from '../src/reaper.js';
import { boardIdentity } from '../src/task-volume.js';

/**
 * Two boards on one docker daemon (issue #887): the reaper decides by asking ITS board about a
 * group's lease, so a group made for another board is a job its board does not know — and "gone".
 * The daemon here is a stateful stand-in that applies the `--filter label=` terms of the argv it is
 * given and removes what it is told to, so what survives is the daemon's answer, not an assertion on argv.
 */

const BOARD_A = boardIdentity({ boardUrl: 'http://127.0.0.1:8129' });
const BOARD_B = boardIdentity({ boardUrl: 'http://127.0.0.1:8229' });
const JOB_A = '11111111-1111-4111-8111-111111111111';
const LEASE_A = '22222222-2222-4222-8222-222222222222';
const JOB_B = '33333333-3333-4333-8333-333333333333';
const LEASE_B = '44444444-4444-4444-8444-444444444444';

const OLD = '2026-09-01 00:00:00 +0000 UTC';

interface Stored {
    kind: 'container' | 'volume';
    id: string;
    labels: Record<string, string>;
}

/** The label terms of every `--filter label=k[=v]` in the argv, as a predicate over a stored object's labels. */
const matches = (args: string[], labels: Record<string, string>): boolean =>
    args
        .flatMap((arg, i) => (args[i - 1] === '--filter' && arg.startsWith('label=') ? [arg.slice(6)] : []))
        .every((term) => {
            const eq = term.indexOf('=');
            return eq < 0 ? term in labels : labels[term.slice(0, eq)] === term.slice(eq + 1);
        });

const daemonOf = (objects: Stored[]): { execDocker: ExecDocker; left: () => string[] } => ({
    left: () => objects.map((object) => object.id),
    execDocker: async (args) => {
        const listed = (kind: Stored['kind']) => objects.filter((o) => o.kind === kind && matches(args, o.labels));
        const labelString = (o: Stored) =>
            Object.entries(o.labels)
                .map(([k, v]) => `${k}=${v}`)
                .join(',');
        if (args[0] === 'ps') {
            return {
                stdout: listed('container')
                    .map((o) =>
                        JSON.stringify({
                            ID: o.id,
                            Names: o.id,
                            Labels: labelString(o),
                            CreatedAt: OLD,
                            State: 'running',
                        })
                    )
                    .join('\n'),
            };
        }
        if (args[0] === 'volume' && args[1] === 'ls') {
            return {
                stdout: listed('volume')
                    .map((o) => JSON.stringify({ Name: o.id, Labels: labelString(o) }))
                    .join('\n'),
            };
        }
        if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: '2026-09-01T00:00:00Z' };
        const target = args[args.length - 1];
        const at = objects.findIndex((o) => o.id === target);
        if (at < 0)
            throw new Error(
                `Error response from daemon: No such ${args[0] === 'volume' ? 'volume' : 'container'}: ${target}`
            );
        objects.splice(at, 1);
        return { stdout: '' };
    },
});

const fleet = (board: string | null, job: string, lease: string, name: string): Stored[] => {
    const base = { 'factory.job': job, 'factory.lease': lease, ...(board === null ? {} : { 'factory.board': board }) };
    return [
        { kind: 'container', id: `${name.slice(0, 11)}0`, labels: { ...base, 'factory.service': 'db' } },
        { kind: 'container', id: `${name.slice(0, 11)}1`, labels: { ...base, 'factory.role': 'agent' } },
        { kind: 'volume', id: `factory-ctl-in-${name}`, labels: base },
    ];
};

/** A reaper for `board` whose board knows `live` (job → lease) and nothing else. */
const reaperFor = (execDocker: ExecDocker, board: string, live: Record<string, string>) =>
    createReaper({
        board: {
            leases: async (ids) =>
                ids.flatMap((id) =>
                    live[id] ? [{ id, leaseToken: live[id]!, status: 'running' as const }] : []
                ) as never,
        },
        arm: createDockerReaper(execDocker, board),
        intervalMs: 0,
        graceMs: 0,
        log: () => undefined,
    });

describe('the docker reaper over a daemon two boards share (#887)', () => {
    it('derives distinct, restart-stable identities from distinct board URLs', () => {
        expect(BOARD_A).not.toBe(BOARD_B);
        expect(boardIdentity({ boardUrl: 'http://127.0.0.1:8129' })).toBe(BOARD_A);
    });

    it("does not remove another board's live group, and still removes its own orphan", async () => {
        const a = fleet(BOARD_A, JOB_A, LEASE_A, 'aaaaaaaaaaaa');
        const b = fleet(BOARD_B, JOB_B, LEASE_B, 'bbbbbbbbbbbb');
        const { execDocker, left } = daemonOf([...a, ...b]);

        // Board B's reaper: its board knows no job at all, so board B's own group is an orphan.
        await reaperFor(execDocker, BOARD_B, {}).sweep();

        expect(left().sort()).toEqual(a.map((o) => o.id).sort());
    });

    it("keeps each board's live group when both reapers sweep the shared daemon", async () => {
        const a = fleet(BOARD_A, JOB_A, LEASE_A, 'aaaaaaaaaaaa');
        const b = fleet(BOARD_B, JOB_B, LEASE_B, 'bbbbbbbbbbbb');
        const { execDocker, left } = daemonOf([...a, ...b]);

        await reaperFor(execDocker, BOARD_A, { [JOB_A]: LEASE_A }).sweep();
        await reaperFor(execDocker, BOARD_B, { [JOB_B]: LEASE_B }).sweep();

        expect(left().sort()).toEqual([...a, ...b].map((o) => o.id).sort());
    });

    it("a restarted driver of the same board reaps its own predecessor's orphans", async () => {
        const a = fleet(BOARD_A, JOB_A, LEASE_A, 'aaaaaaaaaaaa');
        const { execDocker, left } = daemonOf(a);

        // A new reaper instance, the same board URL: the label is the board's, not the process's.
        await reaperFor(execDocker, boardIdentity({ boardUrl: 'http://127.0.0.1:8129' }), {}).sweep();

        expect(left()).toEqual([]);
    });

    it('leaves a group no board labelled alone', async () => {
        const unlabelled = fleet(null, JOB_A, LEASE_A, 'cccccccccccc');
        const { execDocker, left } = daemonOf([...unlabelled]);

        await reaperFor(execDocker, BOARD_A, {}).sweep();

        expect(left().sort()).toEqual(unlabelled.map((o) => o.id).sort());
    });
});
