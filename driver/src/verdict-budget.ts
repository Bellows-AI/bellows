/**
 * The verdict's request budget (issue #820). Each tail the runner hands over is bounded, but the
 * agent tail, a failed gate's output and the driver's notes together — once JSON escapes a control
 * character into six bytes — can pass the board's body limit, and a 413 is a refusal no retry
 * changes. So the serialized complete body is measured and its output, oldest text first, gives way.
 */

const BODY_LIMIT_KIB = 128;
const BYTES_PER_KIB = 1024;
/** The board's `BODY_LIMIT` (server/src/routes/job-limits.ts), copied: the driver imports nothing. */
export const COMPLETE_BODY_LIMIT_BYTES = BODY_LIMIT_KIB * BYTES_PER_KIB;
/** The board's `SUMMARY_LIMIT` in code points: it keeps no more, so a longer summary only costs bytes. */
const SUMMARY_LIMIT = 512;

const bytesOf = (body: Record<string, unknown>): number => Buffer.byteLength(JSON.stringify(body));

const droppedNote = (bytes: number): string =>
    `[driver] ${bytes} bytes of the oldest output were dropped to fit the board's request limit\n`;

/**
 * `body` unchanged when it fits; otherwise with its summary cut to what the board keeps and the
 * longest tail of its output that fits behind a note of what was dropped. Every structured field
 * rides untouched. A body whose other fields alone pass the limit is sent as it is, to be refused.
 */
export function fitCompleteBody(body: Record<string, unknown>): Record<string, unknown> {
    if (bytesOf(body) <= COMPLETE_BODY_LIMIT_BYTES || typeof body.output !== 'string') return body;
    const summary = typeof body.summary === 'string' ? [...body.summary].slice(0, SUMMARY_LIMIT).join('') : undefined;
    const base = summary === undefined ? body : { ...body, summary };
    const points = [...body.output];
    const totalBytes = Buffer.byteLength(body.output);
    const withTail = (keep: number) => {
        const tail = points.slice(points.length - keep).join('');
        return { ...base, output: `${droppedNote(totalBytes - Buffer.byteLength(tail))}${tail}` };
    };
    // The body's size grows with the tail kept, so the longest tail that fits is a binary search.
    let low = 0;
    let high = points.length;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (bytesOf(withTail(mid)) <= COMPLETE_BODY_LIMIT_BYTES) low = mid;
        else high = mid - 1;
    }
    return withTail(low);
}
