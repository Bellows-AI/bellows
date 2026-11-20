import { otel } from './otel-register.js';
import { beforeDeadline, closeOnSignal } from './shutdown.js';
import { start } from './main.js';

/*
 * The offline entry: the same server, built with the code-only `none` arm of GitHubConfig — no
 * token provider, no App client, nothing fetched or cloned, the repo list falling back to the
 * rows the database already holds.
 *
 * This is how the env-booted harnesses — `npm run verify:ui` and `npm run test:jobs` — run a real
 * compiled server with no credential and no network. The no-fetch state is deliberately NOT
 * reachable from the environment: the only configuration there is the App, and an operator who
 * wants a deployment that fetches nothing is out of luck on purpose.
 *
 * `otel-register.js` stays the first import, as in index.ts: the kind lane boots this entry and
 * reads the board's spans from the ops collector.
 */
const OTEL_FLUSH_MS = 3000;

const { close } = await start({ github: { mode: 'none' } });
closeOnSignal(close, async () => {
    if (otel) await beforeDeadline(otel.shutdown(), Date.now() + OTEL_FLUSH_MS, 'flushing telemetry');
});
