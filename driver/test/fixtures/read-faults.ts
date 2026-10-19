/**
 * The read-fault replay engine (issue #869, PR 0): a scenario's world is built once clean, every read
 * it makes is counted, and the scenario is then replayed in a fresh world once per read with that one
 * read answered by a fault. A faulted read is an unconfirmed one, and an unconfirmed read never
 * licenses a delete or a negative verdict: each replay's writes after the fault must be ones the
 * clean run also makes after the same read — in any order, each clean write accounting for one
 * faulted write (a sub-multiset). It stood down part way, it went on as if clean, or it made a
 * write of the clean sequence at another place in it.
 *
 * What a run is made of:
 * - A read is a kubernetes GET (not a pod `/log`, which streams), or a docker `ps`, `inspect`,
 *   `wait`, `logs`, `stats`, or `volume|network|container ls|inspect`.
 * - A write is a kubernetes POST/PUT/PATCH/DELETE, or a docker `rm`, `kill`, `stop`, `network
 *   rm|disconnect|create|connect`, `volume rm|create`, `create`, `run` or `start`. Bodies are never
 *   compared; keys are normalized: URI-decoded, a DELETE's query dropped, each id the world aliased
 *   (and each name derived from it) replaced by its role, any other uuid by `<id>` and 16-hex name by
 *   `<hash>`. Roles, not bare masks, so this run's own Secret never compares equal to an earlier
 *   lease's.
 * - A verdict is what the scenario's thunk reports from the Runner or reaper outcome.
 *
 * The violation lines, deduplicated across reads and sorted:
 * - `DELETE after <fault> at <read>: <call>` — the first write the clean writes cannot account for
 *   is destructive.
 * - `DIVERGED after <fault> at <read>: <call>` — it is anything else.
 * - `VERDICT after <fault> at <read>: <verdict>` — a verdict the clean run did not report.
 * - `CRASH after <fault> at <read>: <message>` — the run threw a TypeError out to its caller. Any
 *   other thrown error is a stand-down.
 * - `SETUP: …` — the world is wrong, never a finding: an unrouted call, an unhandled rejection, a run
 *   that never settled within CAP_MS, a faulted read never reached.
 *
 * Decisions this engine encodes:
 * - Skip table. A fault that is a CONFIRMED answer at a read is not replayed there: `empty` on a
 *   docker list verb and on the `network inspect` that lists attached containers (an empty listing
 *   is nothing there; a volume's `CreatedAt` inspect keeps `empty`, a volume always has one), `no-such` on a named docker `inspect` or a
 *   `wait` (the daemon's own confirmed absence), `timeout` on a docker `wait` (a bounded wait that
 *   times out is designed to read as not-ended, `docker-group.ts`).
 * - The stopAgent exception. Docker's stopAgent escalates to a hard kill of the group when the
 *   supervisor `wait` or the agent `ps` is unreadable (`docker-teardown.ts`): the stop was already
 *   decided, and that kill is the local safety enforcement #828 preserves. A scenario may name the
 *   real group members whose kill or rm is that escalation (`escalation`); those writes are dropped
 *   before the comparison. Nothing else is: a kill of a target a garbage read invented is a
 *   violation, and so is every verdict.
 * - Allowed writes. A scenario may allow a write the clean run does not make, only by its exact
 *   key, narrowed to the faulted reads and faults it follows, each with the file:line that
 *   authorizes it independently of the faulted read (`AllowedWrite`). Never by kind or wildcard: a
 *   write nothing authorizes on its own stays a line.
 */
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import type { BoardJob } from '../../src/board.js';
import type { ExecDocker } from '../../src/docker-runner-support.js';
import type { K8sRequest, K8sResponse } from '../../src/k8s-transport.js';
import type { StepSink } from '../../src/step-control.js';
import type { StepRequest, StepResult } from '../../src/supervisor-contract.js';

/** The wall-clock cap on one run: a scenario that has not settled by then is a setup failure. */
const CAP_MS = 5_000;
/** Reads a scenario may make before its world reads as non-converging. */
export const MAX_READS = 120;

export const K8S_FAULTS = ['503', 'transport', 'empty-object', 'null', 'status', 'truncated'] as const;
export const DOCKER_FAULTS = ['exit', 'timeout', 'empty', 'garbage', 'no-such'] as const;
export type K8sFault = (typeof K8S_FAULTS)[number];
export type DockerFault = (typeof DOCKER_FAULTS)[number];

/** Wraps a world's own transport in the engine's recorder; the scenario runs over what it answers. */
export type Tap<T> = (base: T) => T;
/**
 * Names one of a world's fresh ids (or a name derived from them) by its role, so a key compares
 * equal across worlds only when it names the same role's object: `<label>` replaces it everywhere.
 */
export type Alias = (raw: string, label: string) => void;
/**
 * Builds a fresh world over the engine's tap and does its setup (unrecorded, never faulted); answers
 * the scenario run, which reports the verdicts it observed.
 */
export type Build<T> = (tap: Tap<T>, alias: Alias) => Promise<() => Promise<string[]>>;

/** Whether `violations` is exactly the documented set: every line matched by one pin, every pin once. */
export const exactly = (violations: readonly string[], pins: readonly RegExp[]): boolean =>
    violations.length === pins.length &&
    pins.every((pin) => violations.filter((line) => pin.test(line)).length === 1) &&
    violations.every((line) => pins.some((pin) => pin.test(line)));

/** The message a world's fake rejects an unscripted call with. */
const UNROUTED = /fake has no answer for/;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const HASH = /\b[0-9a-f]{16}\b/g;

/** One world's normalizer: its aliased ids by role, then any other uuid or 16-hex name masked. */
function normalizerOf(aliases: Map<string, string>): (text: string) => string {
    return (text) => {
        let out = text;
        for (const [raw, label] of [...aliases].sort(([a], [b]) => b.length - a.length)) {
            out = out.split(raw).join(`<${label}>`);
        }
        return out.replace(UUID, '<id>').replace(HASH, '<hash>');
    };
}

/** One call of a run, classified. */
interface Entry {
    key: string;
    read: boolean;
    write: boolean;
    destructive: boolean;
    /** The fault the engine skips at this read, by the skip table. */
    skips: readonly string[];
}

/** What one run did. */
interface Observed {
    calls: Entry[];
    /** The call index of each read, in order. */
    reads: number[];
    verdicts: string[];
    /** The index of the faulted call; null when nothing was faulted. */
    faultedAt: number | null;
    crash: string | null;
    setup: string[];
}

/** A world's transport as the engine calls it: the k8s request function or the docker exec seam. */
type Transport = (...args: unknown[]) => Promise<unknown>;

/** Runs a scenario once over a fresh world, faulting the `at`-th read (by index) when `at` is set. */
async function runOnce<T extends (...args: never[]) => Promise<unknown>>(
    build: Build<T>,
    classify: (args: unknown[]) => Entry,
    fault: ((base: T, args: unknown[]) => Promise<unknown>) | null,
    at: number | null
): Promise<Observed> {
    const observed: Observed = { calls: [], reads: [], verdicts: [], faultedAt: null, crash: null, setup: [] };
    const aliases = new Map<string, string>();
    const normalized = normalizerOf(aliases);
    let armed = false;
    const unrouted = (e: unknown): never => {
        if (UNROUTED.test(String((e as Error | undefined)?.message))) {
            observed.setup.push(`unrouted: ${normalized((e as Error).message)}`);
        }
        throw e;
    };
    const tap: Tap<T> = (base) =>
        ((...args: unknown[]) => {
            const call = () => (base as unknown as Transport)(...args).catch(unrouted);
            if (!armed) return call();
            const entry = classify(args);
            entry.key = normalized(entry.key);
            observed.calls.push(entry);
            if (!entry.read) return call();
            observed.reads.push(observed.calls.length - 1);
            if (fault === null || observed.reads.length - 1 !== at) return call();
            observed.faultedAt = observed.calls.length - 1;
            return fault(base, args);
        }) as unknown as T;
    const onRejection = (reason: unknown) => observed.setup.push(`unhandled rejection: ${String(reason)}`);
    process.on('unhandledRejection', onRejection);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const scenario = await build(tap, (raw, label) => aliases.set(raw, label));
        armed = true;
        const capped = new Promise<'capped'>((resolve) => {
            timer = setTimeout(() => resolve('capped'), CAP_MS);
        });
        try {
            const answer = await Promise.race([scenario(), capped]);
            if (answer === 'capped') observed.setup.push('the run never settled');
            else observed.verdicts = answer.map(normalized);
        } catch (e) {
            if (e instanceof TypeError) observed.crash = normalized(e.message);
        }
        // A rejection nobody awaited surfaces a tick later: let it land before the listener goes.
        await new Promise((resolve) => setImmediate(resolve));
        if (at !== null && observed.faultedAt === null) observed.setup.push(`read ${at} never reached`);
        return observed;
    } catch (e) {
        observed.setup.push(`the world's setup threw: ${normalized(String(e))}`);
        return observed;
    } finally {
        clearTimeout(timer);
        process.off('unhandledRejection', onRejection);
    }
}

/** The writes of `run` after call index `from`, by key, less the ones `allowed` drops. */
const writesAfter = (run: Observed, from: number, allowed: (key: string) => boolean): Entry[] =>
    run.calls.slice(from + 1).filter((entry) => entry.write && !allowed(entry.key));

/** The first of `wf` the clean writes `wc` cannot account for, each clean write accounting for one; -1 when all are. */
function unaccounted(wc: readonly Entry[], wf: readonly Entry[]): number {
    const left = new Map<string, number>();
    for (const entry of wc) left.set(entry.key, (left.get(entry.key) ?? 0) + 1);
    return wf.findIndex((entry) => {
        const n = left.get(entry.key) ?? 0;
        left.set(entry.key, n - 1);
        return n <= 0;
    });
}

/** The violation lines of one replay against the clean run, faulted at clean read `i`. */
function violationsAt(
    clean: Observed,
    replay: Observed,
    { fault, i, options }: { fault: string; i: number; options: ReplayOptions }
): string[] {
    const v = replay.setup.map((line) => `SETUP: ${line}`);
    if (replay.faultedAt === null) return v;
    const read = replay.calls[replay.faultedAt]!.key;
    const where = `after ${fault} at ${read}`;
    const allowed = allowedOf(options, { fault, read });
    const wc = writesAfter(clean, clean.reads[i]!, allowed);
    const wf = writesAfter(replay, replay.faultedAt, allowed);
    const off = unaccounted(wc, wf);
    if (off >= 0) v.push(`${wf[off]!.destructive ? 'DELETE' : 'DIVERGED'} ${where}: ${wf[off]!.key}`);
    for (const verdict of replay.verdicts) {
        if (!clean.verdicts.includes(verdict)) v.push(`VERDICT ${where}: ${verdict}`);
    }
    if (replay.crash !== null) v.push(`CRASH ${where}: ${replay.crash}`);
    return v;
}

/** Everything a scenario's cells need from the engine for one transport. */
interface Engine<T, F extends string> {
    classify: (args: unknown[]) => Entry;
    fault: (fault: F) => (base: T, args: unknown[]) => Promise<unknown>;
}

/**
 * One write a scenario allows after a fault: safe because the code authorizes it on its own, never
 * on the faulted read. Exact normalized key; narrowed to the reads and faults it applies at.
 */
export interface AllowedWrite {
    write: string;
    /** The faulted reads (normalized keys) it applies after; any when absent. */
    at?: readonly string[];
    /** The faults it applies after; any when absent. */
    faults?: readonly string[];
    /** Why the write is safe, with its file:line. */
    why: string;
}

/** Options a scenario passes beyond its world. */
export interface ReplayOptions {
    /** The real group members whose kill or rm is the stopAgent escalation (see the header). */
    escalation?: readonly string[];
    allowed?: readonly AllowedWrite[];
}

const allowedOf =
    ({ escalation = [], allowed = [] }: ReplayOptions, { fault, read }: { fault: string; read: string }) =>
    (key: string): boolean =>
        escalation.some((member) => key === `kill ${member}` || key === `rm -f ${member}`) ||
        allowed.some(
            (entry) =>
                entry.write === key &&
                (entry.at === undefined || entry.at.includes(read)) &&
                (entry.faults === undefined || entry.faults.includes(fault))
        );

async function replay<T extends (...args: never[]) => Promise<unknown>, F extends string>(
    engine: Engine<T, F>,
    build: Build<T>,
    fault: F,
    options: ReplayOptions
): Promise<{ lines: string[]; reads: number; setup: string[] }> {
    const clean = await runOnce(build, engine.classify, null, null);
    const lines = new Set(clean.setup.map((line) => `SETUP: clean: ${line}`));
    for (let i = 0; i < Math.min(clean.reads.length, MAX_READS); i += 1) {
        if (clean.calls[clean.reads[i]!]!.skips.includes(fault)) continue;
        const run = await runOnce(build, engine.classify, engine.fault(fault), i);
        for (const line of violationsAt(clean, run, { fault, i, options })) lines.add(line);
    }
    const sorted = [...lines].sort();
    return { lines: sorted, reads: clean.reads.length, setup: sorted.filter((line) => line.startsWith('SETUP')) };
}

/** A scenario's clean run, as its guard checks it. */
export interface Clean {
    calls: string[];
    reads: number;
    writes: string[];
    verdicts: string[];
    setup: string[];
}

async function cleanOf<T extends (...args: never[]) => Promise<unknown>, F extends string>(
    engine: Engine<T, F>,
    build: Build<T>
): Promise<Clean> {
    const run = await runOnce(build, engine.classify, null, null);
    return {
        calls: run.calls.map((entry) => entry.key),
        reads: run.reads.length,
        writes: run.calls.filter((entry) => entry.write).map((entry) => entry.key),
        verdicts: run.verdicts,
        setup: [...run.setup, ...(run.crash === null ? [] : [`crash: ${run.crash}`])],
    };
}

// --- kubernetes ---

const K8S_STATUS_BODY = '{"kind":"Status","status":"Failure","reason":"InternalError","code":500}';

const K8S: Engine<K8sRequest, K8sFault> = {
    classify: ([method, path]) => {
        const m = method as string;
        const decoded = decodeURIComponent(path as string);
        return {
            key: `${m} ${m === 'DELETE' ? decoded.split('?')[0] : decoded}`,
            read: m === 'GET' && !decoded.split('?')[0]!.endsWith('/log'),
            write: m !== 'GET',
            destructive: m === 'DELETE',
            skips: [],
        };
    },
    fault: (fault) => async (base, args) => {
        const [method, path, body] = args as Parameters<K8sRequest>;
        switch (fault) {
            case '503':
                return { status: 503, body: 'Service Unavailable' } satisfies K8sResponse;
            case 'transport':
                throw new Error('the API server did not answer within 30000ms');
            case 'empty-object':
                return { status: 200, body: '{}' } satisfies K8sResponse;
            case 'null':
                return { status: 200, body: 'null' } satisfies K8sResponse;
            case 'status':
                return { status: 200, body: K8S_STATUS_BODY } satisfies K8sResponse;
            case 'truncated': {
                const answer = await base(method, path, body);
                return { ...answer, body: answer.body.slice(0, Math.floor(answer.body.length / 2)) };
            }
        }
    },
};

/** Replays a kubernetes scenario with `fault` at each of its reads in turn. */
export const replayK8s = (build: Build<K8sRequest>, fault: K8sFault, options: ReplayOptions = {}) =>
    replay(K8S, build, fault, options);
/** A kubernetes scenario's clean run. */
export const cleanK8s = (build: Build<K8sRequest>): Promise<Clean> => cleanOf(K8S, build);

// --- docker ---

const DOCKER_READS = new Set(['ps', 'inspect', 'wait', 'logs', 'stats']);
const DOCKER_OBJECT_READS = new Set(['ls', 'inspect']);
const DOCKER_OBJECTS = new Set(['volume', 'network', 'container']);
const DOCKER_WRITES = new Set(['rm', 'kill', 'stop', 'create', 'run', 'start']);
const DOCKER_OBJECT_WRITES: Record<string, readonly string[]> = {
    network: ['rm', 'disconnect', 'create', 'connect'],
    volume: ['rm', 'create'],
    container: ['rm', 'kill', 'stop', 'create', 'run', 'start'],
};
const DOCKER_DESTRUCTIVE = new Set(['rm', 'kill', 'stop', 'disconnect']);

/** The faults the skip table holds back at one docker read (see the header). */
function dockerSkips([verb = '', sub]: readonly string[], args: readonly string[]): DockerFault[] {
    // The attached-container listing of a network: empty output is its "nothing attached".
    const attached = verb === 'network' && sub === 'inspect' && args.includes(ATTACHED_FORMAT);
    const listing = verb === 'ps' || (DOCKER_OBJECTS.has(verb) && sub === 'ls') || attached;
    const named = verb === 'inspect' || (DOCKER_OBJECTS.has(verb) && sub === 'inspect');
    return [
        ...(listing ? (['empty'] as const) : []),
        ...(named || verb === 'wait' ? (['no-such'] as const) : []),
        ...(verb === 'wait' ? (['timeout'] as const) : []),
    ];
}

/** The `network inspect` format that lists the containers attached to a network, one name per line. */
const ATTACHED_FORMAT = '{{range .Containers}}{{println .Name}}{{end}}';

const daemonError = (args: readonly string[], extra: Record<string, unknown>): Error =>
    Object.assign(new Error(`Command failed: docker ${args.join(' ')}`), extra);

const DOCKER: Engine<ExecDocker, DockerFault> = {
    classify: ([argv]) => {
        const args = argv as string[];
        const [verb = '', sub] = args;
        const objectVerb = DOCKER_OBJECTS.has(verb) ? sub : undefined;
        const read = DOCKER_READS.has(verb) || (objectVerb !== undefined && DOCKER_OBJECT_READS.has(objectVerb));
        const write =
            DOCKER_WRITES.has(verb) ||
            (objectVerb !== undefined && (DOCKER_OBJECT_WRITES[verb] ?? []).includes(objectVerb));
        return {
            // A container script passed by content is the script, not its bytes: one token.
            key: args.map((arg) => (arg.includes('\n') ? '<script>' : arg)).join(' '),
            read,
            write,
            destructive: write && DOCKER_DESTRUCTIVE.has(objectVerb ?? verb),
            skips: read ? dockerSkips([verb, sub ?? ''], args) : [],
        };
    },
    fault:
        (fault) =>
        async (_base, [args]) => {
            const argv = args as string[];
            switch (fault) {
                case 'exit':
                    throw daemonError(argv, { code: 1, stderr: 'Error response from daemon: internal error' });
                case 'timeout':
                    throw daemonError(argv, { killed: true, signal: 'SIGTERM', stderr: '' });
                case 'empty':
                    return { stdout: '' };
                case 'garbage':
                    return { stdout: '<html><body>502 Bad Gateway</body></html>\n' };
                case 'no-such':
                    throw daemonError(argv, { code: 1, stderr: 'Error: No such container: x' });
            }
        },
};

/** Replays a docker scenario with `fault` at each of its reads in turn. */
export const replayDocker = (build: Build<ExecDocker>, fault: DockerFault, options: ReplayOptions = {}) =>
    replay(DOCKER, build, fault, options);
/** A docker scenario's clean run. */
export const cleanDocker = (build: Build<ExecDocker>): Promise<Clean> => cleanOf(DOCKER, build);

// --- worlds and cells ---

const MASTER_PROMPT =
    'Factory execution contract (factory-master-prompt/v1)\n\nFactory execution context\n- Mode: standalone';

/** A claim of a fresh job: every id minted for one world alone. */
export function freshJob(over: Partial<BoardJob> = {}): BoardJob {
    const user = randomUUID();
    return {
        id: randomUUID(),
        command: 'fix the failing build',
        rootCommand: 'fix the failing build',
        attempts: 2,
        maxAttempts: 3,
        lastAttempt: false,
        claimSeq: 2,
        leaseToken: randomUUID(),
        leaseExpiresAt: '2026-08-29T12:05:00.000Z',
        executorType: 'claude-code',
        executorRefusal: null,
        planRefusal: null,
        skillRefusal: null,
        masterPrompt: MASTER_PROMPT,
        resumeSessionId: null,
        followUp: false,
        ownSession: false,
        continuesInterrupted: false,
        userId: user,
        workspacePath: `bellows/${user}`,
        repo: 'acme/widgets',
        supervisorEnv: {
            SUPERVISOR_CONTROL_URL: 'http://driver:7000',
            SUPERVISOR_CONTROL_TOKEN: randomUUID(),
            SUPERVISOR_EXPORT_TOKEN: randomUUID(),
        },
        ...over,
    };
}

const stepOk = (stdout = ''): StepResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });

/** A step channel whose supervisor answers every step and never reports: a run ends by its group. */
export const quietSteps = (): StepSink => ({
    submit: async (_token, step: StepRequest) => stepOk(step.kind === 'sync' ? '{"ok":true,"reason":null}\n' : ''),
    awaitReport: () => new Promise(() => undefined),
    contacted: () => true,
    release: () => undefined,
    attach: () => undefined,
});

/** One documented violation line, matched whole and literally. */
export const pin = (line: string): RegExp => new RegExp(`^${line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);

/**
 * A scenario's guard: two clean worlds run the same calls, every call routed, its reads within
 * MAX_READS, and the world is "something there" — the writes and verdicts the clean run is about.
 */
export function guardScenario(clean: () => Promise<Clean>, expected: { writes: string[]; verdicts?: string[] }): void {
    it('replays a clean world the same way twice, every call routed, doing what the world is there for', async () => {
        const first = await clean();
        const second = await clean();
        expect(first.setup).toEqual([]);
        expect(second.calls).toEqual(first.calls);
        expect(first.reads).toBeGreaterThanOrEqual(1);
        expect(first.reads).toBeLessThanOrEqual(MAX_READS);
        expect(first.writes).toEqual(expected.writes);
        expect(first.verdicts).toEqual(expected.verdicts ?? []);
    });
}

/** One cell as a test: plain when it holds today, `it.fails` on its exact documented violation set. */
export function faultCell(name: string, cell: () => Promise<{ lines: string[] }>, pins: readonly RegExp[]): void {
    if (pins.length === 0) {
        it(name, async () => {
            expect((await cell()).lines).toEqual([]);
        });
        return;
    }
    const kinds = [...new Set(pins.map((pin) => pin.source.slice(1).split(' ')[0]))];
    it.fails(`${name} [pinned: ${kinds.join(', ')}]`, async () => {
        // Anything but the documented set — a harness throw, a setup error, another violation, a
        // fixed read — passes here, which `it.fails` reports as a failure.
        const lines = await cell().then(
            (replayed) => replayed.lines,
            () => null
        );
        if (lines === null || !exactly(lines, pins)) return;
        expect(lines).toEqual([]);
    });
}
