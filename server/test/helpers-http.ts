import { afterEach } from 'vitest';

/** HTTP status codes the route tests assert, named once, and the app teardown every route test shares. */
export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_ACCEPTED = 202;
export const HTTP_NO_CONTENT = 204;
export const HTTP_FOUND = 302;
export const HTTP_BAD_REQUEST = 400;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_CONFLICT = 409;
export const HTTP_PAYLOAD_TOO_LARGE = 413;
export const HTTP_UNSUPPORTED_MEDIA_TYPE = 415;
export const HTTP_BAD_GATEWAY = 502;
export const HTTP_SERVICE_UNAVAILABLE = 503;
export const HTTP_UNAVAILABLE = HTTP_SERVICE_UNAVAILABLE;

/**
 * Closes every app a test boots once the test ends. Returns `track`, which registers an app and
 * hands it back, so a boot reads `const app = track(await buildApp(...))`.
 */
export function trackApps() {
    const apps: { close(): Promise<unknown> }[] = [];
    afterEach(async () => {
        for (const app of apps.splice(0)) await app.close();
    });
    return <T extends { close(): Promise<unknown> }>(app: T): T => {
        apps.push(app);
        return app;
    };
}
