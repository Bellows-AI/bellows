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
/** Failures kept: the driver keeps fifty and the board ten. */
const MAX_FAILURES = 50;

/** The section's state, apart from vitest: `started`/`finished`/`failed` as events come, `flush` to write. */
export class TestsSection {
    constructor({ write = writeSection, read = readSection, now = Date.now } = {}) {
        this.write = write;
        const earlier = read('tests') ?? {};
        this.files = Array.isArray(earlier.files) ? earlier.files : [];
        this.failures = Array.isArray(earlier.failures) ? earlier.failures : [];
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
        this.flush(false);
    }

    failed(file, test, message) {
        if (this.failures.length < MAX_FAILURES) this.failures.push({ file, test, message });
        this.flush(true);
    }

    /** Writes the section; an unfinished run's writes are spaced, `force` and the end's are not. */
    flush(force) {
        if (!force && this.now() - this.lastWrite < WRITE_EVERY_MS) return;
        this.lastWrite = this.now();
        this.write('tests', { failures: this.failures, files: this.files, inFlight: [...this.running] });
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
