// Writes secrets.env (gitignored) with fresh secret-store keys unless it already exists.
// Only the dashboard's launchers load it (docs/secrets.md); never copy these into .env.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const key = () => randomBytes(32).toString('base64');
const path = new URL('../secrets.env', import.meta.url);
const body = [
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
    console.log('secrets.env already exists; left unchanged');
}
