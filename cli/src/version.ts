import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Plain SemVer core — copied from `server/src/version.ts`, since the CLI imports nothing of the board's. */
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/**
 * This CLI's release version: its own `package.json`, at a depth that resolves the same from `src/` and
 * `dist/` and that ships inside the published tarball. The checked-in value is `0.0.0`; the release
 * workflow stamps the root `VERSION` over it before `npm publish`. Read locally, so `--version` answers
 * with no board configured. Missing or malformed throws rather than printing a plausible version this
 * build does not have.
 */
export function readCliVersion(file: string | URL = new URL('../package.json', import.meta.url)): string {
    const path = file instanceof URL ? fileURLToPath(file) : file;
    const { version } = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    if (typeof version !== 'string' || !VERSION_PATTERN.test(version)) {
        throw new Error(`${path} holds version ${JSON.stringify(version)}, not X.Y.Z`);
    }
    return version;
}
