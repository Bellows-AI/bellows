import { describe, expect, it } from 'vitest';
import { failureExcerpt } from '../src/gate-excerpt.js';

const LIMIT = 4096;
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** A vitest log: the failure list, then many RPC-timeout stacks, then the summary. */
const suiteLog = (files: string[], stacks = 19): string =>
    [
        ...files.map((file) => ` FAIL  ${file} > suite > case`),
        ...files.map(() => ' × case 12ms'),
        ...Array.from(
            { length: stacks },
            (_, i) => `Error: Timeout calling "onTaskUpdate" ${i}\n${'    at frame\n'.repeat(40)}`
        ),
        ` Test Files  ${files.length} failed | 677 passed (717)`,
        '      Tests  4 failed | 9000 passed',
    ].join('\n');

describe('failureExcerpt', () => {
    it('leaves output that fits as it is', () => {
        expect(failureExcerpt('all good', LIMIT)).toBe('all good');
    });

    it('names every failing file ahead of a tail the error stacks fill', () => {
        const files = ['a/one.test.ts', 'b/two.test.ts', 'c/three.test.ts'];
        const log = suiteLog(files);
        expect(log.length).toBeGreaterThan(LIMIT * 2);
        const excerpt = failureExcerpt(log, LIMIT);
        expect(bytes(excerpt)).toBeLessThanOrEqual(LIMIT);
        for (const file of files) expect(excerpt).toContain(file);
        expect(excerpt).toContain('Test Files  3 failed | 677 passed (717)');
        expect(excerpt).toContain('Tests  4 failed');
        expect(excerpt.indexOf('one.test.ts')).toBeLessThan(excerpt.indexOf('[output tail]'));
    });

    it('is the plain tail when no line names a failure', () => {
        const log = `${'noise\n'.repeat(2000)}the end`;
        const excerpt = failureExcerpt(log, LIMIT);
        expect(excerpt.endsWith('the end')).toBe(true);
        expect(bytes(excerpt)).toBeLessThanOrEqual(LIMIT);
        expect(excerpt).not.toContain('[failure lines]');
    });

    it('stays inside the limit when failure lines outnumber the budget, keeping the summary', () => {
        const files = Array.from({ length: 400 }, (_, i) => `pkg/file-${i}.test.ts`);
        const excerpt = failureExcerpt(suiteLog(files, 2), 1024);
        expect(bytes(excerpt)).toBeLessThanOrEqual(1024);
        expect(excerpt).toContain('pkg/file-0.test.ts');
        expect(excerpt).toContain('Test Files  400 failed');
    });
});
