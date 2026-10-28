// Writes secrets.env (gitignored) with fresh secret-store keys unless it already exists, and adds the
// SECRETS_BACKEND line to an existing file that predates it, leaving every key in it as it was.
// Only the dashboard's launchers load it (docs/secrets.md); never copy these into .env.
// Usage: node scripts/secrets-init.mjs [path]   (default: secrets.env at the repo root)
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const key = () => randomBytes(32).toString('base64');
const path = process.argv[2] ?? new URL('../secrets.env', import.meta.url);
const body = [
    'SECRETS_BACKEND=database',
    `SECRETS_DATA_KEYS=k1:${key()}`,
    'SECRETS_ACTIVE_KEY_ID=k1',
    `SECRETS_OPERATION_KEY=${key()}`,
    `SECRETS_FINGERPRINT_KEY=${key()}`,
    '',
].join('\n');
try {
    writeFileSync(path, body, { flag: 'wx', mode: 0o600 });
    console.log('wrote secrets.env');
} catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const existing = readFileSync(path, 'utf8');
    if (/^\s*SECRETS_BACKEND\s*=/m.test(existing)) {
        console.log('secrets.env already exists; left unchanged');
    } else {
        // An append never rewrites the keys above it, and keeps the file's permissions.
        appendFileSync(path, `${existing === '' || existing.endsWith('\n') ? '' : '\n'}SECRETS_BACKEND=database\n`);
        console.log('secrets.env already exists; added SECRETS_BACKEND=database, keys unchanged');
    }
}
