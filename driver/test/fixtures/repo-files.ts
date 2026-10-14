import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository root, for suites that pin files outside `driver/` (images, charts, docs, scripts). */
export const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** A repository file's text, by its root-relative path. */
export const readRepoFile = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');
