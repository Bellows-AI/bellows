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
    const gone = new Promise<void>((resolve) => raw.once('close', resolve));
    try {
        for (;;) {
            const chunk = await Promise.race([reader.read(), gone.then(() => null)]);
            if (chunk === null || chunk.done) break;
            if (!raw.write(chunk.value)) {
                await Promise.race([new Promise<void>((resolve) => raw.once('drain', resolve)), gone]);
            }
            if (raw.destroyed) break;
        }
    } finally {
        await reader.cancel().catch(() => undefined);
        if (!raw.destroyed) raw.end();
    }
}
