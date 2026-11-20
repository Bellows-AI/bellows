import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(new URL(`../src/${rel}`, import.meta.url), 'utf8');

// Both board entries start the OTEL SDK before the modules it instruments load and flush it on
// shutdown: the kind lane boots the offline entry, so one that never exported would show no board span.
describe.each(['index.ts', 'offline.ts'])('the board entry %s', (entry) => {
    const source = read(entry);

    it('imports the SDK bootstrap first', () => {
        const firstImport = source.split('\n').find((line) => line.startsWith('import '));
        expect(firstImport).toMatch(/from '\.\/otel-register\.js'/);
    });

    it('flushes the SDK within a deadline on shutdown', () => {
        expect(source).toMatch(/beforeDeadline\(\s*otel\.shutdown\(\)/);
    });
});
