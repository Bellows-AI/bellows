import { describe, expect, it } from 'vitest';
import type { BoardJob, DeclaredGate } from '../src/board/board.js';
import { gateIdentity } from '../src/gate-identity.js';
import { gateLedger } from '../src/loop/loop-gates.js';
import type { LoopRuntime } from '../src/loop/loop-types.js';
import { boardJob } from './fixtures/board-job.js';
import { config } from './fixtures/loop-stubs.js';

/**
 * The gate identity of the gate-run record: what a run's reuse must agree on besides the
 * tree — the command, its timeout, the image, setup, cache, services and the env — as one keyed hash,
 * so a changed env VALUE changes it and no raw value is ever stored.
 */
const gate: DeclaredGate = { name: 'test', command: 'npm test', timeoutMinutes: 5 };
const withGates = (patch: Partial<NonNullable<BoardJob['gates']>>): BoardJob => ({
    ...boardJob(),
    gates: { image: 'node:24', setup: 'npm ci', cache: ['node_modules'], gates: [gate], ...patch },
});
const base = withGates({});
const SECRET = 'board-token';
const ENV = 'A=1\nB=two\n';
const idOf = (over: { job?: BoardJob; gate?: DeclaredGate; secret?: string; env?: string } = {}) =>
    gateIdentity(over.secret ?? SECRET, over.job ?? base, over.gate ?? gate, over.env ?? ENV);

describe('the gate identity', () => {
    it('is a stable 64-hex keyed hash', () => {
        expect(idOf()).toMatch(/^[0-9a-f]{64}$/);
        expect(idOf()).toBe(idOf());
    });

    it('ignores what is not the gate’s own: its name, on_demand and filter flags, the order of the env', () => {
        const same = idOf({
            gate: { name: 'renamed', command: 'npm test', timeoutMinutes: 5, onDemand: true, filter: true },
            env: 'B=two\nA=1\n',
        });
        expect(same).toBe(idOf());
    });

    it.each<[string, Parameters<typeof idOf>[0]]>([
        ['the command', { gate: { ...gate, command: 'npm run test:fast' } }],
        ['the timeout', { gate: { ...gate, timeoutMinutes: 6 } }],
        ['no timeout', { gate: { name: 'test', command: 'npm test' } }],
        ['the image', { job: withGates({ image: 'node:22' }) }],
        ['the setup', { job: withGates({ setup: 'npm install' }) }],
        ['no setup', { job: withGates({ setup: undefined as never }) }],
        ['the cache', { job: withGates({ cache: ['.cache'] }) }],
        ['the services', { job: { ...withGates({}), services: [{ name: 'db', image: 'postgres:16' }] as never } }],
        ['an env value', { env: 'A=2\nB=two\n' }],
        ['an env name', { env: 'C=1\nB=two\n' }],
        ['an added env line', { env: `${ENV}C=3\n` }],
        ['the organization key', { secret: 'another-org-key' }],
    ])('differs when %s differs', (_what, over) => {
        expect(idOf(over)).not.toBe(idOf());
    });

    it('is keyed by the claim’s organization key, never the driver’s own credential (F17.1)', () => {
        const ledgerOf = (credential: string, job: BoardJob) =>
            gateLedger({ config: { ...config(), boardCredential: credential } } as unknown as LoopRuntime, job, 1);
        const claimed = { ...withGates({}), orgKey: 'org-a-key' };
        // Two drivers with their own credentials, and the adopting claim (a new sequence and lease) of the same row.
        const first = ledgerOf(`drv_${'01'.repeat(32)}`, claimed).identity(gate);
        const adopted = { ...claimed, claimSeq: claimed.claimSeq + 1, leaseToken: 'lease-of-the-next-claim' };
        expect(ledgerOf(`drv_${'02'.repeat(32)}`, adopted).identity(gate)).toBe(first);
        expect(ledgerOf(`drv_${'01'.repeat(32)}`, { ...claimed, orgKey: 'org-b-key' }).identity(gate)).not.toBe(first);
    });

    it('never carries a raw env value or the secret', () => {
        const id = idOf({ env: 'TOKEN=ghs_supersecretvalue\n', secret: 'hunter2hunter2' });
        expect(id).not.toContain('supersecret');
        expect(id).not.toContain('hunter2');
    });
});
