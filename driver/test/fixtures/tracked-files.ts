import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The tracked text files under `root` that contain `needle`. A tracked file the running user cannot open (a state
 * file another uid wrote into a task checkout, such as gh's `device-id`) is skipped, the way `git grep` skips it:
 * it cannot hold a command the suite is looking for, and reading it would fail every test that scans the tree.
 */
export function trackedFilesContaining(root: string, needle: string): string[] {
    const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
    if (listed.status !== 0) throw new Error(`git ls-files failed in ${root}: ${listed.stderr}`);
    return listed.stdout.split('\0').filter((file) => {
        if (!file || !existsSync(join(root, file))) return false;
        try {
            return readFileSync(join(root, file), 'utf8').includes(needle);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EACCES') return false;
            throw error;
        }
    });
}
