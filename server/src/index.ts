import { otel } from './otel-register.js';
import { beforeDeadline, closeOnSignal } from './shutdown.js';
import { start } from './main.js';
import { logger } from './log.js';

/*
 * The env entry: the App is the only configuration the environment can produce, so reading
 * `process.env` and passing no override can only ever yield `github.mode === 'app'` — see
 * start()'s doc comment in main.ts for the shape of the pair with offline.ts.
 *
 * `otel-register.js` stays the first import: the SDK must start before the modules it instruments load.
 */
const OTEL_FLUSH_MS = 3000;

const { close } = await start();
closeOnSignal(async () => {
    try {
        await close();
    } finally {
        if (otel) {
            await beforeDeadline(otel.shutdown(), Date.now() + OTEL_FLUSH_MS, 'flushing telemetry').catch((e: Error) =>
                logger('shutdown').error(e.message)
            );
        }
    }
});
