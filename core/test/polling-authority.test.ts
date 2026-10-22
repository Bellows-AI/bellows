import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Polling is the authority (docs/architecture.md): no wake path of the board or the driver depends
 * on a database notification or a Kubernetes watch, because either is lost with its connection.
 * A webhook or a kick may make convergence faster; every one has a periodic read behind it. This
 * scan pins the absence of the lossy primitives, so adding one is a decision, not an accident.
 */

const SOURCES = ['../../server/src', '../../driver/src'];
const EXTENSIONS = /\.(ts|cjs)$/;

const filesUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) return filesUnder(path);
        return EXTENSIONS.test(entry.name) ? [path] : [];
    });

const sources = SOURCES.flatMap((relative) => {
    const dir = fileURLToPath(new URL(relative, import.meta.url));
    // A moved or renamed directory must fail here, never read as "nothing found".
    if (!existsSync(dir)) throw new Error(`polling-authority scan: ${relative} does not exist`);
    return filesUnder(dir).map((path) => ({ path, text: readFileSync(path, 'utf8') }));
});

const offenders = (pattern: RegExp): string[] => sources.filter((file) => pattern.test(file.text)).map((f) => f.path);

describe('polling is the authority', () => {
    it('scans the real source trees', () => {
        expect(sources.length).toBeGreaterThan(50);
    });

    it('uses no database notification channel', () => {
        expect(offenders(/pg_notify\s*\(/i)).toEqual([]);
        expect(offenders(/\bLISTEN\s+["\w]/)).toEqual([]);
    });

    it('opens no Kubernetes watch stream', () => {
        expect(offenders(/[?&]watch=(true|1)\b/)).toEqual([]);
    });
});
