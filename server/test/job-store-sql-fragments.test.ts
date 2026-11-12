import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = new URL('../src/db/jobs/', import.meta.url);
const FRAGMENTS = 'job-store-sql-fragments.ts';

// Comment lines (`//`, JSDoc, SQL `--`) may describe the rule; only code and SQL text may not repeat it.
const codeLines = (file: string): string[] =>
    readFileSync(new URL(file, dir), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\*|\/\*|--)/.test(line));

const jobFiles = readdirSync(dir).filter((name) => name.endsWith('.ts') && name !== FRAGMENTS);

const offenders = (pattern: RegExp): string[] =>
    jobFiles.flatMap((file) =>
        codeLines(file)
            .filter((line) => pattern.test(line))
            .map((line) => `${file}: ${line.trim()}`)
    );

describe('job store SQL fragments', () => {
    it('keeps the terminal-status rule in the fragment module', () => {
        expect(offenders(/'succeeded'\s*,\s*'failed'|TERMINAL_STATUSES/)).toEqual([]);
    });

    it('keeps the Done stamp rule in the fragment module', () => {
        expect(offenders(/done_at is not null/i)).toEqual([]);
    });
});
