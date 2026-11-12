import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, for suites that pin files outside `driver/` (images, charts, docs, scripts). */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** A repository file's text, by its root-relative path. */
export const readRepoFile = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/**
 * A lane script's whole text, in run order: each `. "$REPO/scripts/lanes/<lane>/<phase>.sh"` line of
 * scripts/test-jobs.sh and scripts/test-k8s.sh is replaced by that phase file, so a pin on the lane
 * reads the same text it read before the phases were split into files.
 */
export const readLaneScript = (rel: string): string =>
    readRepoFile(rel).replace(/^\. "\$REPO\/(scripts\/lanes\/[^"]+\.sh)"$/gm, (_line, file: string) =>
        readRepoFile(file).replace(/\n$/, '')
    );
