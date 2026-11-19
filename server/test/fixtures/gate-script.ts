import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';

export interface GateRun {
    status: number | null;
    stdout: string;
    stderr: string;
    /** Every fake tool's argv, in call order: `<tool> <args…>`. */
    calls: string[];
}

/**
 * Runs `scripts/<script>` with fake tools on PATH: each tool logs its argv, then runs its body, so a case reads
 * what ran and in what order without a docker daemon, a database or a real suite. Registers its own cleanup.
 */
export function gateScript(
    script: string
): (tools: Record<string, string>, args: string[], env: Record<string, string>) => GateRun {
    const path = fileURLToPath(new URL(`../../../scripts/${script}`, import.meta.url));
    const dirs: string[] = [];
    afterEach(() => {
        for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    });
    return (tools, args, env) => {
        const dir = mkdtempSync(join(tmpdir(), 'gate-script-'));
        dirs.push(dir);
        const log = join(dir, 'calls.log');
        for (const [name, body] of Object.entries(tools)) {
            const tool = join(dir, name);
            writeFileSync(tool, `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
            chmodSync(tool, 0o755);
        }
        const out = spawnSync('sh', [path, ...args], {
            encoding: 'utf8',
            env: { PATH: `${dir}:/usr/bin:/bin`, ...env },
        });
        let calls: string[] = [];
        try {
            calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        } catch {
            // No tool ran at all.
        }
        return { status: out.status, stdout: out.stdout, stderr: out.stderr, calls };
    };
}

/** A fake `git`: `rev-parse` answers whether the base resolves ($FAKE_HAS_BASE=1), `fetch` exits $FAKE_FETCH_STATUS. */
export const FAKE_GIT =
    'case "$1" in rev-parse) [ "$FAKE_HAS_BASE" = 1 ] ;; fetch) exit "$FAKE_FETCH_STATUS" ;; *) exit 0 ;; esac';
