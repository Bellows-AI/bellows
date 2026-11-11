/**
 * What a store double throws to model an unreachable database: a plain `Error` is a bug to the central
 * error handler (500), only a connection-shaped one is an outage (503). `server/src/routes/error-handler.ts`.
 */
export const storeOutage = (message = 'database is down'): Error =>
    Object.assign(new Error(message), { code: 'ECONNREFUSED' });
