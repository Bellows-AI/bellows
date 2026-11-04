import type { ServerResponse } from 'node:http';

/**
 * Streams a WHATWG `Response` (a JSON body or an SSE stream) to a hijacked Node response. A client that goes away
 * cancels the reader, so the SDK's stream settles instead of dangling.
 */
export async function pipeResponse(response: Response, raw: ServerResponse): Promise<void> {
    const headers = Object.fromEntries(response.headers);
    raw.writeHead(response.status, { 'x-content-type-options': 'nosniff', 'cache-control': 'no-store', ...headers });
    if (!response.body) {
        raw.end();
        return;
    }
    const reader = response.body.getReader();
    // Built before anything is awaited: a client that left during the fetch has already fired 'close'.
    const gone =
        raw.destroyed || raw.closed ? Promise.resolve() : new Promise<void>((resolve) => raw.once('close', resolve));
    let onDrain: (() => void) | undefined;
    try {
        while (!raw.destroyed) {
            const chunk = await Promise.race([reader.read(), gone.then(() => null)]);
            if (chunk === null || chunk.done || raw.destroyed) break;
            if (!raw.write(chunk.value)) {
                await Promise.race([
                    new Promise<void>((resolve) => {
                        onDrain = resolve;
                        raw.once('drain', resolve);
                    }),
                    gone,
                ]);
            }
        }
    } finally {
        if (onDrain) raw.off('drain', onDrain);
        await reader.cancel().catch(() => undefined);
        if (!raw.destroyed) raw.end();
    }
}
