// A vitest reporter for the gates: records the failed tests, each finished file's duration and the files still
// running into the gate's `tests` report section (scripts/gate-report.mjs), as the run goes. `--reporter=json` only
// writes at the end, and a gate killed at its deadline never reaches the end. Several vitest runs in one gate
// (scripts/test-changed.mjs runs one per step) accumulate into the same section.
import { relative } from 'node:path';
import { readSection, writeSection } from './gate-report.mjs';

/** The shortest time between two writes of an unfinished run's section. */
const WRITE_EVERY_MS = 1000;
/** How often the section is rewritten while a run is going. */
const BEAT_MS = 2000;
/** Failures kept: the driver keeps fifty and the board ten; `failureCount` says how many there were. */
const MAX_FAILURES = 50;
/** Test files kept in `files`: the slowest, since the driver reads ten. */
const MAX_FILES = 50;
const MAX_IN_FLIGHT = 100;
/** One failure message, and the floor the shrinking below stops at. */
const MESSAGE_CHARS = 1000;
const MIN_MESSAGE_CHARS = 100;
/** The section always serializes under the supervisor's 65,536-byte section limit, with room to spare. */
const SECTION_BUDGET = 60_000;

const sizeOf = (section) => JSON.stringify(section).length;

/**
 * The section as it is written: failure messages cut, the files cut to the slowest, in-flight cut, and, while
 * it is still over the budget, the messages halved and then the failures dropped from the end. What goes is
 * the detail of the tail; the failures that remain, and the in-flight files, never go with it.
 */
export function boundSection({ failures, failureCount, files, inFlight }) {
    let chars = MESSAGE_CHARS;
    let kept = failures.slice(0, MAX_FAILURES);
    const build = () => ({
        failures: kept.map((f) => ({ ...f, message: String(f.message).slice(0, chars) })),
        failureCount,
        files: [...files].sort((a, b) => b.ms - a.ms).slice(0, MAX_FILES),
        inFlight: inFlight.slice(0, MAX_IN_FLIGHT),
    });
    let section = build();
    while (sizeOf(section) > SECTION_BUDGET && chars > MIN_MESSAGE_CHARS) {
        chars = Math.max(MIN_MESSAGE_CHARS, Math.floor(chars / 2));
        section = build();
    }
    while (sizeOf(section) > SECTION_BUDGET && kept.length > 1) {
        kept = kept.slice(0, Math.ceil(kept.length / 2));
        section = build();
    }
    return section;
}

/** The section's state, apart from vitest: `started`/`finished`/`failed` as events come, `flush` to write. */
export class TestsSection {
    constructor({ write = writeSection, read = readSection, now = Date.now } = {}) {
        this.write = write;
        const earlier = read('tests') ?? {};
        this.files = Array.isArray(earlier.files) ? earlier.files : [];
        this.failures = Array.isArray(earlier.failures) ? earlier.failures : [];
        this.failureCount = Number.isInteger(earlier.failureCount) ? earlier.failureCount : this.failures.length;
        this.running = new Set();
        this.now = now;
        this.lastWrite = Number.NEGATIVE_INFINITY;
    }

    started(file) {
        this.running.add(file);
        this.flush(false);
    }

    finished(file, ms) {
        this.running.delete(file);
        this.files.push({ file, ms: Math.round(ms) });
        // Only the slowest are ever read: the list stays small however many files a run has.
        if (this.files.length > 2 * MAX_FILES) this.files = [...this.files].sort((a, b) => b.ms - a.ms).slice(0, MAX_FILES);
        this.flush(false);
    }

    failed(file, test, message) {
        this.failureCount += 1;
        if (this.failures.length < MAX_FAILURES) {
            this.failures.push({ file, test, message: String(message).slice(0, MESSAGE_CHARS) });
        }
        this.flush(true);
    }

    /** Writes the section; an unfinished run's writes are spaced, `force` and the end's are not. */
    flush(force) {
        if (!force && this.now() - this.lastWrite < WRITE_EVERY_MS) return;
        this.lastWrite = this.now();
        this.write(
            'tests',
            boundSection({
                failures: this.failures,
                failureCount: this.failureCount,
                files: this.files,
                inFlight: [...this.running],
            })
        );
    }
}

export default class GateReporter {
    constructor(options) {
        this.section = new TestsSection(options);
        this.root = process.cwd();
        // The list of files in flight is what a deadline kill leaves behind: keep it at most a beat stale.
        this.beat = setInterval(() => this.section.flush(true), BEAT_MS);
        this.beat.unref();
    }

    onInit(ctx) {
        this.root = ctx?.config?.root ?? this.root;
    }

    name(module) {
        return relative(this.root, module.moduleId);
    }

    onTestModuleStart(module) {
        this.section.started(this.name(module));
    }

    onTestModuleEnd(module) {
        this.section.finished(this.name(module), module.diagnostic().duration);
    }

    onTestCaseResult(testCase) {
        const result = testCase.result();
        if (result.state !== 'failed') return;
        const message = result.errors?.[0]?.message ?? 'failed';
        this.section.failed(this.name(testCase.module), testCase.fullName, message);
    }

    onTestRunEnd() {
        clearInterval(this.beat);
        this.section.flush(true);
    }
}
