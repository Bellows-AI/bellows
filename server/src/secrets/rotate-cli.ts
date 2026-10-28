import postgres from 'postgres';
import { resolveConfig } from '../config.js';
import { parseRotateArgs } from './rotate-args.js';
import { createPostgresSecretStore } from './postgres-secret-store.js';
import { rotationKeys } from './secret-backend.js';
import type { SecretKeys } from './secret-keys.js';

/*
 * The key-rotation maintenance command (docs/secrets.md). It reads the same key environment as the
 * dashboard, so it runs where that environment already is: `npm run secrets:rotate` on a checkout,
 * `kubectl exec deploy/<release>-factory -c dashboard -- node server/dist/secrets/rotate-cli.js` on
 * Kubernetes. It applies to SECRETS_BACKEND=database only: an external backend has no data keys, so it exits 2
 * there. Exit 0: rotation finished, or the retired key names no stored version. Exit 1: rows remain or a write
 * failed (a rerun resumes). Exit 2: usage or configuration.
 */
const USAGE = 'usage: rotate-cli [--batch <n>] | --verify-retired <keyId>';

async function main(): Promise<number> {
    const args = parseRotateArgs(process.argv.slice(2));
    if (args.mode === 'usage') {
        console.error(`${args.message}\n${USAGE}`);
        return 2;
    }
    let keys: SecretKeys;
    let databaseUrl: string;
    try {
        keys = rotationKeys(process.env);
        databaseUrl = resolveConfig({ env: process.env, github: { mode: 'none' } }).config.databaseUrl;
    } catch (e) {
        console.error((e as Error).message);
        return 2;
    }
    const sql = postgres(databaseUrl, { max: 2 });
    const abort = new AbortController();
    const onInterrupt = () => abort.abort();
    process.once('SIGINT', onInterrupt);
    try {
        const store = createPostgresSecretStore({ sql, keys });
        if (args.mode === 'verify-retired') {
            const remaining = await store.verifyRetired(args.keyId);
            console.log(`[secrets] ${remaining} stored version(s) still name ${args.keyId}`);
            return remaining === 0 ? 0 : 1;
        }
        const summary = await store.rotate({
            ...(args.batchSize ? { batchSize: args.batchSize } : {}),
            signal: abort.signal,
        });
        console.log(`[secrets] rekeyed ${summary.rekeyed}, skipped ${summary.skipped}, failed ${summary.failed}`);
        return summary.failed === 0 && !abort.signal.aborted ? 0 : 1;
    } catch (e) {
        console.error(`[secrets] rotation failed: ${(e as Error).message}`);
        return 1;
    } finally {
        process.off('SIGINT', onInterrupt);
        await sql.end();
    }
}

process.exitCode = await main();
