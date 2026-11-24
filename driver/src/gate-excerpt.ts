import { tailBytes } from './runner.js';

/**
 * A gate's output cut to a byte budget so that what failed survives the cut. A suite prints its
 * failure list before the error stacks and the summary, so a plain tail of a log full of stacks
 * holds neither the failing names nor the verdict. The excerpt is the failure lines first (a
 * `FAIL` or `×` line names a test file or a test; `Test Files` / `Tests` is the summary), then
 * whatever the budget has left as the tail.
 */

/** A line that names a failure or sums a run up. */
const FAILURE_LINE = /^\s*(?:FAIL\b|[×✗✖]|❯ .*\bfailed\b)/;
const SUMMARY_LINE = /^\s*(?:Test Files|Tests)\s+\d/;

/** The most of one failure line kept: a name and its test path, never the message that follows. */
const LINE_MAX_BYTES = 300;
/** The failure lines' share of the budget; the rest is the tail, which says how the run ended. */
const FAILURE_SHARE = 0.75;
const FAILURES_HEADER = '[failure lines]\n';
const TAIL_HEADER = '\n[output tail]\n';

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Distinct lines of `text` matching `pattern`, in order, each cut to `LINE_MAX_BYTES`. */
function matching(text: string, pattern: RegExp): string[] {
    const seen = new Set<string>();
    for (const line of text.split('\n')) {
        if (pattern.test(line)) seen.add(tailBytes(line.trimEnd(), LINE_MAX_BYTES));
    }
    return [...seen];
}

/** The lines that fit in `budget` bytes, joined; each costs its newline. */
function fitting(lines: string[], budget: number): string[] {
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
        used += byteLength(line) + 1;
        if (used > budget) break;
        kept.push(line);
    }
    return kept;
}

/**
 * `text` within `limit` bytes: unchanged when it fits, else its failure lines then its tail. Output
 * with no failure line in it is its plain tail.
 */
export function failureExcerpt(text: string, limit: number): string {
    if (byteLength(text) <= limit) return text;
    const summary = matching(text, SUMMARY_LINE);
    const failures = matching(text, FAILURE_LINE);
    if (failures.length === 0 && summary.length === 0) return tailBytes(text, limit);
    const frame = byteLength(FAILURES_HEADER) + byteLength(TAIL_HEADER);
    const failureBudget = Math.floor((limit - frame) * FAILURE_SHARE);
    const summaryLines = fitting(summary, failureBudget);
    const summaryBytes = summaryLines.reduce((n, line) => n + byteLength(line) + 1, 0);
    const named = fitting(failures, failureBudget - summaryBytes);
    const head = `${FAILURES_HEADER}${[...named, ...summaryLines].join('\n')}`;
    return `${head}${TAIL_HEADER}${tailBytes(text, limit - byteLength(head) - byteLength(TAIL_HEADER))}`;
}
