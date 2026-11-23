/**
 * The structured result a gate run records beside its output tail (the driver's `gate-result.ts` writes it,
 * the board stores it in `job.gates[].result`, the task page and a follow-up read it). The driver cannot
 * import this: its copy of the shape is the same by hand. `parseGateResult` is the board's door — each field is
 * checked and bounded, and a malformed one is dropped, never stored.
 */

export interface GateFailedTest {
    file: string;
    test: string;
    message: string;
}

export interface GateSelection {
    /** `changed`, or `all` when the test gate widened to everything. */
    mode: string;
    reason: string;
}

/** The guest around one run: shares of the window's CPU time in percent, cgroup throttling, load and memory. */
export interface GateResources {
    samples: number;
    seconds: number;
    cpu?: { user: number; system: number; iowait: number; steal: number; idle: number };
    throttledPeriods: number;
    throttledMs: number;
    load: { start: number; max: number; end: number };
    memAvailableMb: { min: number; end: number };
    memTotalMb: number;
}

export interface GateResult {
    failures?: GateFailedTest[];
    /** Test files started and not finished when the gate hit its deadline. */
    inFlight?: string[];
    selection?: GateSelection;
    slowest?: { file: string; ms: number }[];
    resources?: GateResources;
}

const MAX_FAILURES = 50;
const MAX_IN_FLIGHT = 50;
const MAX_SLOWEST = 10;
const MAX_NAME_CHARS = 300;
const MAX_MESSAGE_CHARS = 1000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v !== '';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const items = (raw: unknown, limit: number): unknown[] => (Array.isArray(raw) ? raw.slice(0, limit) : []);

function resourcesOf(raw: unknown): GateResources | undefined {
    if (!isObj(raw) || !isObj(raw.load) || !isObj(raw.memAvailableMb)) return undefined;
    const { samples, seconds, throttledPeriods, throttledMs, memTotalMb, load, memAvailableMb, cpu } = raw;
    const { start, max, end } = load;
    if (![samples, seconds, throttledPeriods, throttledMs, memTotalMb, start, max, end].every(isNum)) return undefined;
    if (!isNum(memAvailableMb.min) || !isNum(memAvailableMb.end)) return undefined;
    const shares =
        isObj(cpu) && [cpu.user, cpu.system, cpu.iowait, cpu.steal, cpu.idle].every(isNum)
            ? { cpu: { user: cpu.user, system: cpu.system, iowait: cpu.iowait, steal: cpu.steal, idle: cpu.idle } }
            : {};
    return {
        samples: samples as number,
        seconds: seconds as number,
        ...(shares as Pick<GateResources, 'cpu'>),
        throttledPeriods: throttledPeriods as number,
        throttledMs: throttledMs as number,
        load: { start: start as number, max: max as number, end: end as number },
        memAvailableMb: { min: memAvailableMb.min, end: memAvailableMb.end },
        memTotalMb: memTotalMb as number,
    };
}

function failuresOf(raw: unknown): GateFailedTest[] {
    const failures: GateFailedTest[] = [];
    for (const f of items(raw, MAX_FAILURES)) {
        if (!isObj(f) || !isText(f.file) || !isText(f.test) || typeof f.message !== 'string') continue;
        failures.push({
            file: f.file.slice(0, MAX_NAME_CHARS),
            test: f.test.slice(0, MAX_NAME_CHARS),
            message: f.message.slice(0, MAX_MESSAGE_CHARS),
        });
    }
    return failures;
}

function slowestOf(raw: unknown): { file: string; ms: number }[] {
    const slowest: { file: string; ms: number }[] = [];
    for (const f of items(raw, MAX_SLOWEST)) {
        if (isObj(f) && isText(f.file) && isNum(f.ms))
            slowest.push({ file: f.file.slice(0, MAX_NAME_CHARS), ms: f.ms });
    }
    return slowest;
}

function selectionOf(sel: unknown): GateSelection | undefined {
    if (!isObj(sel) || !isText(sel.mode) || typeof sel.reason !== 'string') return undefined;
    return { mode: sel.mode.slice(0, MAX_NAME_CHARS), reason: sel.reason.slice(0, MAX_MESSAGE_CHARS) };
}

/** A stored result from what a driver sent, or null when it is not an object or holds nothing usable. */
export function parseGateResult(raw: unknown): GateResult | null {
    if (!isObj(raw)) return null;
    const failures = failuresOf(raw.failures);
    const inFlight = items(raw.inFlight, MAX_IN_FLIGHT)
        .filter(isText)
        .map((f) => f.slice(0, MAX_NAME_CHARS));
    const slowest = slowestOf(raw.slowest);
    const selection = selectionOf(raw.selection);
    const resources = resourcesOf(raw.resources);
    const result: GateResult = {
        ...(failures.length > 0 ? { failures } : {}),
        ...(inFlight.length > 0 ? { inFlight } : {}),
        ...(selection ? { selection } : {}),
        ...(slowest.length > 0 ? { slowest } : {}),
        ...(resources ? { resources } : {}),
    };
    return Object.keys(result).length > 0 ? result : null;
}

/** The result as text for an agent: the failed tests, the files in flight at a deadline, and how the gate chose its files. */
export function describeGateResult(result: GateResult | undefined): string {
    if (!result) return '';
    const lines: string[] = [];
    if (result.failures?.length) {
        lines.push(`Failed tests (${result.failures.length}):`);
        for (const f of result.failures) lines.push(`- ${f.file} > ${f.test}: ${f.message.split('\n')[0]}`);
    }
    if (result.inFlight?.length) {
        lines.push(`Test files still running when the gate hit its deadline: ${result.inFlight.join(', ')}`);
    }
    if (result.selection) lines.push(`Selection: ${result.selection.mode}, ${result.selection.reason}`);
    return lines.join('\n');
}
