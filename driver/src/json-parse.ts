/**
 * The tail line of a container's stdout, parsed as JSON, or the fallback when it does not —
 * shared by both executors' sync/reclaim readouts (and the docker runner's close-read scrapes),
 * which all print one JSON line as their verdict.
 */
export function parseLastJsonLine<T>(stdout: string, onUnparseable: () => T): T {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
        return JSON.parse(line) as T;
    } catch {
        return onUnparseable();
    }
}

/** A control-channel request body parsed as a JSON object; null for invalid JSON, an array, null or a primitive. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}
