import postgres from 'postgres';
import { resolveConfig } from '../config.js';
import { conversionExitCode, convertPlaintextEnvSecrets } from '../db/env-secret-conversion.js';
import { createSecretStore, loadSecretBackend } from './secret-backend.js';
import type { SecretBackendConfig } from './secret-backend.js';
import type { SecretDiagnostic } from './secret-store.js';

/*
 * The one-shot conversion of old-format environment secrets (docs/env.md). It reads the same key environment
 * as the dashboard, so it runs where that environment already is: `npm run secrets:convert-env` on a checkout,
 * `kubectl exec deploy/<release>-factory -c dashboard -- node server/dist/secrets/convert-env-cli.js` on
 * Kubernetes. Exit 0: no plaintext secret remains. Exit 1: rows remain, the run was interrupted or a read failed
 * (a rerun resumes). Exit 2: usage or configuration.
 */
const USAGE = 'usage: convert-env-cli (takes no arguments)';

async function main(): Promise<number> {
    if (process.argv.length > 2) {
        console.error(USAGE);
        return 2;
    }
    let backend: SecretBackendConfig;
    let databaseUrl: string;
    try {
        backend = loadSecretBackend(process.env);
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
        const secretLog = (d: SecretDiagnostic) => console.log(`[secrets] ${JSON.stringify(d)}`);
        const secrets = createSecretStore({ sql, backend, log: secretLog });
        const summary = await convertPlaintextEnvSecrets({ sql, secrets, signal: abort.signal, secretLog });
        console.log(
            `[secrets] converted ${summary.converted}, skipped ${summary.skipped}, failed ${summary.failed}, ` +
                `oversized ${summary.oversized.length}, orphaned ${summary.orphans.length}, remaining ${summary.remaining}` +
                (summary.aborted ? ', interrupted' : '')
        );
        for (const row of summary.oversized) {
            console.log(`[secrets] oversized ${row.org} ${row.scopeKind} ${row.scopeKey || '-'} ${row.name}`);
        }
        return conversionExitCode(summary);
    } catch (e) {
        console.error(`[secrets] conversion failed: ${(e as Error).name}`);
        return 1;
    } finally {
        process.off('SIGINT', onInterrupt);
        await sql.end();
    }
}

process.exitCode = await main();
