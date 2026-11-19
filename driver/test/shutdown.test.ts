import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createFlushThenExit } from '../src/shutdown.js';

const never = new Promise<void>(() => undefined);
const options = { onSignal: () => undefined };

describe('the driver exit', () => {
    it('flushes the SDK before it exits, whatever the code', async () => {
        const order: string[] = [];
        const otel = { shutdown: async () => void order.push('flush') };
        await createFlushThenExit({ otel, exit: (code) => void order.push(`exit ${code}`), ...options })(0);
        expect(order).toEqual(['flush', 'exit 0']);
    });

    it('exits anyway when the flush is late', async () => {
        const exit = vi.fn();
        const waited: number[] = [];
        await createFlushThenExit({
            otel: { shutdown: () => never },
            exit,
            flushMs: 5,
            wait: async (ms) => void waited.push(ms),
            ...options,
        })(0);
        expect(waited).toEqual([5]);
        expect(exit).toHaveBeenCalledWith(0);
    });

    it('exits anyway when the flush rejects, and with no SDK at all', async () => {
        const exit = vi.fn();
        await createFlushThenExit({ otel: { shutdown: () => Promise.reject(new Error('down')) }, exit, ...options })(1);
        await createFlushThenExit({ otel: null, exit, ...options })(0);
        expect(exit.mock.calls).toEqual([[1], [0]]);
    });

    it('lets one more signal end it at once, under the code it was asked for', async () => {
        const exit = vi.fn();
        const handlers: (() => void)[] = [];
        const done = createFlushThenExit({
            otel: { shutdown: () => never },
            exit,
            flushMs: 1,
            wait: () => new Promise((resolve) => setTimeout(resolve, 20)),
            onSignal: (_signal, handler) => void handlers.push(handler),
        })(3);
        handlers[0]!();
        expect(exit).toHaveBeenCalledWith(3);
        await done;
    });
});

describe('the entry point', () => {
    const entry = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

    it('exits through the flush on a normal drain completion, not only on a handover', () => {
        expect(entry).toMatch(/^await flushThenExit\(0\);$/m);
        expect(entry).not.toMatch(/if \(drain\.handedOver\(\)\) (await )?(flushThenExit|process\.exit)/);
    });

    it('has no other process.exit than the flush path’s', () => {
        expect(entry.match(/process\.exit\(/g)).toHaveLength(1);
    });
});
