import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * scripts/test-jobs.sh's whole text, in run order: each `. "$REPO/scripts/lanes/jobs/<phase>.sh"` line is
 * replaced by that phase file, so a pin on the lane reads the text it read before the phases were split.
 * (driver/test/fixtures/repo-files.ts has the same reader; a package's tests import nothing from another.)
 */
export const readLaneScript = (rel: string): string =>
    readFileSync(join(ROOT, rel), 'utf8').replace(
        /^\. "\$REPO\/(scripts\/lanes\/[^"]+\.sh)"$/gm,
        (_line, file: string) => readFileSync(join(ROOT, file), 'utf8').replace(/\n$/, '')
    );
