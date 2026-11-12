import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import allowlist from './no-ticket-keys.allowlist.json' with { type: 'json' };

/**
 * Ticket keys and issue/PR numbers are history, and history lives in git and the tracker. A
 * migration is applied once and never edited again, so its comments carry none at all; every
 * other tree is ratcheted down by `no-ticket-keys.allowlist.json`: a per-file count that may only
 * shrink, and that is lowered in the same change that removes a hit.
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIGRATIONS = 'server/migrations/';
const SELF = new Set(['core/test/no-ticket-keys.test.ts', 'core/test/no-ticket-keys.allowlist.json']);
const PATTERNS = [/\bBEL-\d+\b/g, /(^|[\s(])#\d+\b/gm, /\bissues? #?\d+/gi, /\bPR #?\d+/gi];

const count = (text: string): number => PATTERNS.reduce((sum, re) => sum + (text.match(re)?.length ?? 0), 0);

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString()
    .split('\0')
    .filter((path) => path !== '' && !SELF.has(path));

const counts = new Map<string, number>();
for (const path of tracked) {
    let text: string;
    try {
        text = readFileSync(join(ROOT, path), 'utf8');
    } catch {
        continue;
    }
    if (text.includes('\0')) continue;
    const n = count(text);
    if (n > 0) counts.set(path, n);
}

describe('ticket keys and issue numbers in comments', () => {
    it('scans the real tree, so an empty sweep cannot pass for a clean one', () => {
        expect(tracked.length).toBeGreaterThan(500);
        expect(tracked.filter((path) => path.startsWith(MIGRATIONS)).length).toBeGreaterThan(100);
    });

    it('keeps every migration free of ticket keys and issue/PR narrative', () => {
        const hits = [...counts].filter(([path]) => path.startsWith(MIGRATIONS));
        expect(hits).toEqual([]);
    });

    it('never lets another file exceed its allowlisted count', () => {
        const over = [...counts]
            .filter(([path]) => !path.startsWith(MIGRATIONS))
            .filter(([path, n]) => n > ((allowlist as Record<string, number>)[path] ?? 0))
            .map(([path, n]) => `${path}: ${n} > ${(allowlist as Record<string, number>)[path] ?? 0}`);
        expect(over).toEqual([]);
    });

    it('ratchets: an allowlist entry above the real count is lowered or deleted', () => {
        const slack = Object.entries(allowlist as Record<string, number>)
            .filter(([path, n]) => (counts.get(path) ?? 0) < n)
            .map(([path, n]) => `${path}: allowlisted ${n}, found ${counts.get(path) ?? 0}`);
        expect(slack).toEqual([]);
    });
});
