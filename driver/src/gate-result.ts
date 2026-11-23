import type { GateReportFiles } from './supervisor-contract.js';

/**
 * The structured result of one gate run, recorded beside its output tail: what a tail cannot say. The gate command
 * writes `$FACTORY_GATE_RUN/report/<section>.json` files (scripts/gate-reporter.mjs, scripts/test-changed.mjs), the
 * gate loop samples the guest (`scripts/gate-loop.sh`), the supervisor carries both in the step answer, and this
 * module reads them — field by field, bounded, a malformed one dropped — into the shape the board stores.
 */

/** One failed test, as the gate's reporter wrote it. */
export interface FailedTest {
    file: string;
    test: string;
    message: string;
}

/** How the test gate chose its files: `changed`, or `all` when it widened to everything, and why. */
export interface GateSelection {
    mode: string;
    reason: string;
}

/** The guest around one gate run: the window's CPU split in percent, the cgroup's throttling, load and memory. */
export interface GateResources {
    samples: number;
    seconds: number;
    /** Shares of the window's CPU time; absent with fewer than two samples. */
    cpu?: { user: number; system: number; iowait: number; steal: number; idle: number };
    throttledPeriods: number;
    throttledMs: number;
    load: { start: number; max: number; end: number };
    memAvailableMb: { min: number; end: number };
    memTotalMb: number;
}

export interface GateResult {
    failures?: FailedTest[];
    /** Test files started and not finished when the gate was killed at its deadline. */
    inFlight?: string[];
    selection?: GateSelection;
    slowest?: { file: string; ms: number }[];
    resources?: GateResources;
}

export const MAX_FAILURES = 50;
export const MAX_IN_FLIGHT = 50;
export const MAX_SLOWEST = 10;
const MAX_NAME_CHARS = 300;
const MAX_MESSAGE_CHARS = 1000;
const MAX_REASON_CHARS = 500;
const KB_PER_MB = 1024;
const MS_PER_SECOND = 1000;
const TENTH = 10;
const PERCENT = 100;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const round1 = (value: number): number => Math.round(value * TENTH) / TENTH;

function failuresOf(raw: unknown): FailedTest[] {
    if (!Array.isArray(raw)) return [];
    const failures: FailedTest[] = [];
    for (const entry of raw) {
        if (!isRecord(entry) || !isText(entry.file) || !isText(entry.test) || typeof entry.message !== 'string')
            continue;
        failures.push({
            file: entry.file.slice(0, MAX_NAME_CHARS),
            test: entry.test.slice(0, MAX_NAME_CHARS),
            message: entry.message.slice(0, MAX_MESSAGE_CHARS),
        });
        if (failures.length === MAX_FAILURES) break;
    }
    return failures;
}

function slowestOf(raw: unknown): { file: string; ms: number }[] {
    if (!Array.isArray(raw)) return [];
    const files: { file: string; ms: number }[] = [];
    for (const entry of raw) {
        if (!isRecord(entry) || !isText(entry.file) || typeof entry.ms !== 'number' || !Number.isFinite(entry.ms))
            continue;
        files.push({ file: entry.file.slice(0, MAX_NAME_CHARS), ms: Math.round(entry.ms) });
    }
    return files.sort((a, b) => b.ms - a.ms).slice(0, MAX_SLOWEST);
}

const inFlightOf = (raw: unknown): string[] =>
    Array.isArray(raw)
        ? raw
              .filter(isText)
              .slice(0, MAX_IN_FLIGHT)
              .map((f) => f.slice(0, MAX_NAME_CHARS))
        : [];

function selectionOf(raw: unknown): GateSelection | undefined {
    if (!isRecord(raw) || !isText(raw.mode) || typeof raw.reason !== 'string') return undefined;
    return { mode: raw.mode.slice(0, MAX_NAME_CHARS), reason: raw.reason.slice(0, MAX_REASON_CHARS) };
}

/** One parsed `resources` line. */
interface Sample {
    t: number;
    cpu: number[];
    load: number;
    memAvailableKb: number;
    memTotalKb: number;
    throttledPeriods: number;
    throttledUsec: number;
}

const SAMPLE_LINE = /^t=([\d.]+) cpu=([\d,]+) load=([\d.]+) mem=(\d+)\/(\d+) throttled=(\d+),(\d+)$/;
/** The /proc/stat counters, in the order `gate-loop.sh` writes them. */
const CPU_ORDER = ['user', 'nice', 'system', 'idle', 'iowait', 'irq', 'softirq', 'steal'] as const;
const CPU_FIELDS = CPU_ORDER.length;

function sampleOf(line: string): Sample | undefined {
    const m = SAMPLE_LINE.exec(line);
    if (!m) return undefined;
    const cpu = (m[2] as string).split(',').map(Number);
    if (cpu.length !== CPU_FIELDS) return undefined;
    return {
        t: Number(m[1]),
        cpu,
        load: Number(m[3]),
        memAvailableKb: Number(m[4]),
        memTotalKb: Number(m[5]),
        throttledPeriods: Number(m[6]),
        throttledUsec: Number(m[7]),
    };
}

const toMb = (kb: number): number => Math.round(kb / KB_PER_MB);

/** The window's CPU split as shares, or undefined when no time passed. */
function cpuShares(first: Sample, last: Sample): GateResources['cpu'] {
    const delta = Object.fromEntries(
        CPU_ORDER.map((name, i) => [name, (last.cpu[i] ?? 0) - (first.cpu[i] ?? 0)])
    ) as Record<(typeof CPU_ORDER)[number], number>;
    const total = Object.values(delta).reduce((sum, v) => sum + Math.max(v, 0), 0);
    if (total <= 0) return undefined;
    const share = (...names: (typeof CPU_ORDER)[number][]): number =>
        round1(
            (Math.max(
                names.reduce((sum, name) => sum + delta[name], 0),
                0
            ) /
                total) *
                PERCENT
        );
    return {
        user: share('user', 'nice'),
        system: share('system', 'irq', 'softirq'),
        iowait: share('iowait'),
        steal: share('steal'),
        idle: share('idle'),
    };
}

/** The guest's samples (`gate-loop.sh`'s `resources` lines) as one summary; a line that does not parse is skipped. */
export function resourcesOf(text: string): GateResources | undefined {
    const samples = text
        .split('\n')
        .map(sampleOf)
        .filter((s): s is Sample => s !== undefined);
    const first = samples[0];
    const last = samples[samples.length - 1];
    if (!first || !last) return undefined;
    const cpu = samples.length > 1 ? cpuShares(first, last) : undefined;
    return {
        samples: samples.length,
        seconds: Math.round(last.t - first.t),
        ...(cpu ? { cpu } : {}),
        throttledPeriods: Math.max(last.throttledPeriods - first.throttledPeriods, 0),
        throttledMs: Math.round(Math.max(last.throttledUsec - first.throttledUsec, 0) / MS_PER_SECOND),
        load: { start: first.load, max: Math.max(...samples.map((s) => s.load)), end: last.load },
        memAvailableMb: {
            min: toMb(Math.min(...samples.map((s) => s.memAvailableKb))),
            end: toMb(last.memAvailableKb),
        },
        memTotalMb: toMb(last.memTotalKb),
    };
}

/**
 * A run's structured result from the report its gate left, or undefined when there is nothing to say. The files
 * still in flight are the evidence of a gate killed at its deadline (`timedOut`) and mean nothing otherwise.
 */
export function gateResultOf(report: GateReportFiles | undefined, timedOut: boolean): GateResult | undefined {
    if (!report) return undefined;
    const tests = isRecord(report.sections.tests) ? report.sections.tests : {};
    const failures = failuresOf(tests.failures);
    const inFlight = timedOut ? inFlightOf(tests.inFlight) : [];
    const slowest = slowestOf(tests.files);
    const selection = selectionOf(report.sections.selection);
    const resources = resourcesOf(report.resources);
    const result: GateResult = {
        ...(failures.length > 0 ? { failures } : {}),
        ...(inFlight.length > 0 ? { inFlight } : {}),
        ...(selection ? { selection } : {}),
        ...(slowest.length > 0 ? { slowest } : {}),
        ...(resources ? { resources } : {}),
    };
    return Object.keys(result).length > 0 ? result : undefined;
}

/** What the board's gate report keeps of a result: its report shares one 128 KiB body with every gate's output. */
const REPORT_FAILURES = 10;
const REPORT_IN_FLIGHT = 10;
const REPORT_NAME_CHARS = 160;
const REPORT_MESSAGE_CHARS = 240;

/** The result in the size the board's gate report stores; the agent's own answer keeps the larger bounds. */
export function compactResult(result: GateResult): GateResult {
    return {
        ...result,
        ...(result.failures
            ? {
                  failures: result.failures.slice(0, REPORT_FAILURES).map((f) => ({
                      file: f.file.slice(0, REPORT_NAME_CHARS),
                      test: f.test.slice(0, REPORT_NAME_CHARS),
                      message: f.message.slice(0, REPORT_MESSAGE_CHARS),
                  })),
              }
            : {}),
        ...(result.inFlight
            ? { inFlight: result.inFlight.slice(0, REPORT_IN_FLIGHT).map((f) => f.slice(0, REPORT_NAME_CHARS)) }
            : {}),
    };
}

/** The result as text for an agent: the failed tests, the files in flight at a deadline, and how the gate chose its files. */
export function describeResult(result: GateResult | undefined): string {
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
