import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

/**
 * Shared support for the container-script suites (split out of `scripts.test.ts` for its
 * line-count cap): the driver-availability probes every suite skips on, and the path helper into
 * `driver/src/scripts/`, the directory the driver build copies into the runtime image verbatim.
 */
export const SCRIPTS_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..', 'src', 'scripts');

export const pathOf = (name: string): string => join(SCRIPTS_DIR, name);

export { hasGit } from './git-worktree-support.js';

export function hasOpenssl(): boolean {
    try {
        execFileSync('openssl', ['version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** node:sqlite is flagged experimental and its landing version varies; the suite skips, not breaks. */
export function hasNodeSqlite(): boolean {
    try {
        new DatabaseSync(':memory:').close();
        return true;
    } catch {
        return false;
    }
}

/**
 * Writes a claude-code session transcript the way the CLI lays it out: `lines` joined by newlines
 * into `<sessionId>.jsonl` under the munged project directory below `dir`'s `projects` segment.
 * Answers that project directory.
 */
export function writeSessionJsonl(dir: string, sessionId: string, lines: string[]): string {
    const project = join(dir, 'projects', '-workspaces-org-member-.worktrees-mine');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${sessionId}.jsonl`), lines.join('\n'));
    return project;
}
