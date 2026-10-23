import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * SemVer core with an optional pre-release (`0.0.9-rc`), no `v`, no leading zeros. No `+build`:
 * the version is also an image tag, and a tag cannot hold `+`. `scripts/release.sh` cuts only the core.
 */
const IDENT = String.raw`(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)`;
export const VERSION_PATTERN = new RegExp(
    String.raw`^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-${IDENT}(?:\.${IDENT})*)?$`
);

/**
 * The release version packaged with this server: the root `VERSION`, at a depth that resolves the
 * same from `src/` and `dist/` — the checkout's committed file locally, `/app/VERSION` in the
 * image. Missing or malformed throws, so a server never reports a plausible version it does not have.
 */
export function readVersion(file: string | URL = new URL('../../VERSION', import.meta.url)): string {
    const path = file instanceof URL ? fileURLToPath(file) : file;
    let contents: string;
    try {
        contents = readFileSync(path, 'utf8');
    } catch (error) {
        throw new Error(`cannot read the release version at ${path}`, { cause: error });
    }
    const version = contents.trim();
    if (!VERSION_PATTERN.test(version)) throw new Error(`${path} holds ${JSON.stringify(version)}, not SemVer`);
    return version;
}
