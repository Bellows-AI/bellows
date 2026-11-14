import postgres from 'postgres';
import { resolveConfig } from '../config.js';
import { CROSS_ORG_ROLE } from '../db/org-sql.js';
import { runDriverCredentialCommand } from './driver-credential-command.js';
import { createDriverCredentialStore } from './driver-credentials.js';

/*
 * The driver-credential maintenance command (docs/auth.md): `npm run driver-credential -- <command>` on a checkout,
 * `kubectl exec deploy/<release>-factory -c dashboard -- node server/dist/auth/driver-credential-cli.js <command>`
 * on Kubernetes. It reads the dashboard's DATABASE_URL, so it runs where that environment already is.
 */
async function main(): Promise<number> {
    let databaseUrl: string;
    try {
        databaseUrl = resolveConfig({ env: process.env, github: { mode: 'none' } }).config.databaseUrl;
    } catch (e) {
        console.error((e as Error).message);
        return 2;
    }
    // A credential serves several orgs and the commands list across them: the cross-org role, as on the board.
    const sql = postgres(databaseUrl, { max: 1, connection: { role: CROSS_ORG_ROLE } });
    try {
        return await runDriverCredentialCommand(process.argv.slice(2), createDriverCredentialStore({ sql }), {
            out: (line) => console.log(line),
            err: (line) => console.error(line),
        });
    } catch (e) {
        console.error(`[driver-credential] failed: ${(e as Error).message}`);
        return 1;
    } finally {
        await sql.end();
    }
}

process.exitCode = await main();
