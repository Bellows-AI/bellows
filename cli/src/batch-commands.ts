import { parseArgs } from 'node:util';
import { BATCH_DRAFT, BATCH_UNSUPPORTED_CODE, batchVerdict, REPORT_CANCELLED, REPORT_EXPIRED } from './batch.js';
import type { BatchRecord } from './batch.js';
import {
    needsAction,
    renderBatch,
    renderBatchList,
    renderDraftWritten,
    renderReport,
    renderValidated,
    renderWaitEnd,
} from './batch-render.js';
import type { BoardClient } from './board.js';
import { FILE_OPTION, INPUT_OPTIONS, parseOrUsage, readSource, STDIN_OPTION, UsageError } from './input.js';
import type { InputIo } from './input.js';
import { OUTCOME } from './outcome.js';
import type { CommandResult } from './outcome.js';
import { BoardError, NO_RESPONSE_STATUS, MALFORMED_RESPONSE_CODE } from './transport.js';
import { USAGE } from './usage.js';

/**
 * `factory batch …`: an HTTP client of the board's batch routes (docs/batches.md). The board owns
 * orchestration — nothing here, a wait that ends or a process that dies included, cancels a batch.
 * Every command returns a `CommandResult` for `run` to print, exactly like the job commands.
 */

export interface BatchIo extends InputIo {
    now?: (() => number) | undefined;
    sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
    signal?: AbortSignal | undefined;
}

/** A client for one command; a wait passes the end of its budget so no retry outlives it. */
export type BoardFor = (deadlineAt?: number) => BoardClient;

const JSON_OPTION = { json: { type: 'boolean', default: false } } as const;
const KEY_OPTION = { 'idempotency-key': { type: 'string' } } as const;
const VERSION_OPTION = { version: { type: 'string' } } as const;

/** How long a wait runs by default, and how often it re-reads the batch while it does. */
const WAIT_TOTAL_DEFAULT_S = 300;
const WAIT_POLL_MS = 5000;
const MS_PER_SECOND = 1000;
/** The status from which a board failure says nothing about whether the write was applied. */
const SERVER_ERROR_STATUS = 500;

const ok = (data: unknown, text: string): CommandResult => ({ outcome: OUTCOME.ok, data, stdout: `${text}\n` });

/** The positionals a verb takes, exactly: anything else is usage, with the help text. */
function positionalsOf(
    args: readonly string[],
    verb: string,
    shape: string,
    options: Record<string, { type: 'string' | 'boolean'; default?: boolean }>
) {
    const parsed = parseOrUsage(() =>
        parseArgs({ args: [...args], allowPositionals: true, options: { ...JSON_OPTION, ...options } })
    );
    const wanted = shape.split(' ').filter(Boolean).length;
    if (parsed.positionals.length !== wanted) {
        throw new UsageError(`batch ${verb} needs ${shape || 'no arguments'}\n\n${USAGE}`);
    }
    return { positionals: parsed.positionals, values: parsed.values as Record<string, string | boolean | undefined> };
}

/** The draft version a write quotes: required, so a stale read is the board's refusal, not a guess. */
function versionOf(raw: string | boolean | undefined): number {
    const value = Number(raw);
    if (typeof raw !== 'string' || !Number.isInteger(value) || value < 1) {
        throw new UsageError('--version must be the draft version as last read (see `factory batch inspect`)');
    }
    return value;
}

/** The plan document from `--file` or `--stdin`: JSON, carried whole and never rebuilt. */
async function planOf(values: { file?: unknown; stdin?: unknown }, io: InputIo): Promise<unknown> {
    const file = typeof values.file === 'string' ? values.file : undefined;
    const stdin = values.stdin === true;
    if ((file === undefined) === !stdin) {
        throw new UsageError(`give the plan from exactly one of --${FILE_OPTION} or --${STDIN_OPTION}\n\n${USAGE}`);
    }
    const text = await readSource({ positionals: [], file, stdin }, io);
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new UsageError(`the plan is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** A write the board may or may not have applied: say so, and how to recover under the key. */
function uncertainWrite(error: unknown, key: string | undefined): unknown {
    const uncertain =
        error instanceof BoardError &&
        (error.status === NO_RESPONSE_STATUS ||
            error.status >= SERVER_ERROR_STATUS ||
            error.code === MALFORMED_RESPONSE_CODE);
    if (!uncertain) return error;
    const hint =
        key === undefined
            ? 'the write may have been applied — check `factory batch list` before repeating it; pass --idempotency-key so a repeat cannot make a second batch'
            : `the write may have been applied — repeat the same command with --idempotency-key ${key} to recover its result`;
    return new BoardError(`${error.message} (${hint})`, error.status, error.code);
}

/** The board's refusal of an unrunnable plan, with what the CLI knows that the board's line does not. */
function startRefusal(error: unknown): unknown {
    if (!(error instanceof BoardError) || error.code !== BATCH_UNSUPPORTED_CODE) return error;
    return new BoardError(
        `${error.message} — the draft is unchanged and keeps its whole plan; execution is limited to ` +
            'one repository target on its default branch for now, so edit the draft or wait for multi-repository execution',
        error.status,
        error.code
    );
}

async function runImport(args: readonly string[], io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { values } = positionalsOf(args, 'import', '', { ...INPUT_OPTIONS, ...KEY_OPTION });
    const plan = await planOf(values, io);
    const key = values['idempotency-key'] as string | undefined;
    try {
        const created = await boardFor().createBatch(plan, key);
        const result = ok(created, renderDraftWritten('draft', created));
        return created.replayed
            ? { ...result, stderr: 'replayed: the board already made this batch for this idempotency key\n' }
            : result;
    } catch (error) {
        throw uncertainWrite(error, key);
    }
}

async function runUpdate(args: readonly string[], io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { positionals, values } = positionalsOf(args, 'update', '<id>', { ...INPUT_OPTIONS, ...VERSION_OPTION });
    const version = versionOf(values.version);
    const plan = await planOf(values, io);
    const written = await boardFor().replaceBatch(positionals[0]!, version, plan);
    return ok(written, renderDraftWritten('draft', written));
}

async function runValidate(args: readonly string[], _io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { positionals } = positionalsOf(args, 'validate', '<id>', {});
    const id = positionals[0]!;
    try {
        const validated = await boardFor().validateBatch(id);
        return ok(validated, renderValidated(id, validated));
    } catch (error) {
        throw startRefusal(error);
    }
}

async function runStart(args: readonly string[], _io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { positionals, values } = positionalsOf(args, 'start', '<id>', { ...VERSION_OPTION, ...KEY_OPTION });
    const version = versionOf(values.version);
    const key = values['idempotency-key'] as string | undefined;
    const client = boardFor();
    // The version is the draft as last read: a stale one is the board's BATCH_STALE, never a start.
    try {
        const started = await client.startBatch(positionals[0]!, version, key);
        const result = ok(started, renderBatch(started));
        return started.replayed
            ? { ...result, stderr: 'replayed: the board already started this batch for this idempotency key\n' }
            : result;
    } catch (error) {
        throw uncertainWrite(startRefusal(error), key);
    }
}

async function runInspect(args: readonly string[], _io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { positionals } = positionalsOf(args, 'inspect', '<id>', {});
    const client = boardFor();
    const batch = await client.getBatch(positionals[0]!);
    const draft = batch.status === BATCH_DRAFT;
    const data = {
        batch,
        verdict: draft ? null : batchVerdict(batch),
        needsAction: actionOf(batch),
        // A draft has no report: the board refuses one until the batch starts.
        report: draft ? null : await client.getBatchReport(batch.id),
    };
    return ok(data, renderBatch(batch));
}

async function runReport(args: readonly string[], io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { positionals } = positionalsOf(args, 'report', '<id>', {});
    const report = await boardFor().getBatchReport(positionals[0]!);
    return ok(report, renderReport(report, (io.now ?? Date.now)()));
}

const actionOf = (batch: BatchRecord) => batch.tasks.filter(needsAction);

async function runList(args: readonly string[], _io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    positionalsOf(args, 'list', '', {});
    const batches = await boardFor().listBatches();
    return { outcome: OUTCOME.ok, data: { batches }, stdout: renderBatchList(batches) };
}

/** The wait's budget, the way `job wait` reads its own. */
function budgetOf(raw: string | boolean | undefined): number {
    if (raw === undefined) return WAIT_TOTAL_DEFAULT_S;
    const value = Number(raw);
    if (typeof raw !== 'string' || !Number.isInteger(value) || value < 1) {
        throw new UsageError(`--timeout must be a positive integer number of seconds, got "${String(raw)}"`);
    }
    return value;
}

/**
 * Re-reads the batch until it settles, needs a person, or the budget ends. The board owns the
 * orchestration: this only watches, so an exit here — timeout, interrupt, a closed terminal —
 * leaves the batch running.
 */
async function runWait(args: readonly string[], io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { positionals, values } = positionalsOf(args, 'wait', '<id>', { timeout: { type: 'string' } });
    const id = positionals[0]!;
    const total = budgetOf(values.timeout);
    const now = io.now ?? Date.now;
    const sleep = io.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const deadline = now() + total * MS_PER_SECOND;
    const client = boardFor(deadline);
    for (;;) {
        const batch = await client.getBatch(id);
        if (batch.status === BATCH_DRAFT) {
            throw new Error(
                `batch ${id} is a draft; start it first (factory batch start ${id} --version ${batch.version})`
            );
        }
        const remaining = deadline - now();
        const ended = await waitEnd(client, { batch, total, timedOut: remaining <= 0 });
        if (ended) return ended;
        await sleep(Math.min(WAIT_POLL_MS, remaining), io.signal);
    }
}

const FENCED: readonly string[] = [REPORT_CANCELLED, REPORT_EXPIRED];

/**
 * How a wait ends, with the report beside the batch; null while it keeps watching. A fenced batch
 * starts nothing new: it ends as cancelled, named for the fence (`cancelled` or `expired`).
 */
async function waitEnd(
    client: BoardClient,
    run: { batch: BatchRecord; total: number; timedOut: boolean }
): Promise<CommandResult | null> {
    const { batch, total, timedOut } = run;
    const verdict = batchVerdict(batch);
    const settled = SETTLED[verdict];
    const fenced = Boolean(batch.cancelledAt) || Boolean(batch.expiredAt);
    if (!fenced && !settled && !timedOut) return null;
    const report = await client.getBatchReport(batch.id);
    const data = { verdict, budgetSeconds: total, batch, needsAction: actionOf(batch), report };
    if (FENCED.includes(report.state)) {
        return { outcome: OUTCOME.cancelled, data, stdout: `${renderWaitEnd(batch, report.state)}\n` };
    }
    if (settled) return { outcome: settled, data, stdout: `${renderWaitEnd(batch)}\n` };
    return { outcome: OUTCOME.timeout, data, stderr: `still running after ${total}s: ${batch.id}\n` };
}

/** How each settled verdict ends the command; `running` is absent — it is the loop's. */
const SETTLED: Record<string, CommandResult['outcome'] | undefined> = {
    succeeded: OUTCOME.succeeded,
    failed: OUTCOME.failed,
    cancelled: OUTCOME.cancelled,
    needs_attention: OUTCOME.needsAttention,
};

async function runCancel(args: readonly string[], _io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { positionals } = positionalsOf(args, 'cancel', '<id>', {});
    const answered = await boardFor().cancelBatch(positionals[0]!);
    return ok(answered, `cancel requested ${positionals[0]}`);
}

async function runRetry(args: readonly string[], _io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { positionals } = positionalsOf(args, 'retry', '<id> <task>', {});
    const answered = await boardFor().retryBatchTask(positionals[0]!, positionals[1]!);
    return ok(answered, `retry requested ${positionals[0]} ${positionals[1]}`);
}

async function runAccept(args: readonly string[], _io: BatchIo, boardFor: BoardFor): Promise<CommandResult> {
    const { positionals } = positionalsOf(args, 'accept', '<id> <task>', {});
    const answered = await boardFor().acceptBatchTask(positionals[0]!, positionals[1]!);
    return ok(answered, `accepted ${positionals[0]} ${positionals[1]}`);
}

type BatchCommand = (args: readonly string[], io: BatchIo, boardFor: BoardFor) => Promise<CommandResult>;

const BATCH_HANDLERS: Record<string, BatchCommand> = {
    'batch import': runImport,
    'batch update': runUpdate,
    'batch validate': runValidate,
    'batch start': runStart,
    'batch inspect': runInspect,
    'batch report': runReport,
    'batch list': runList,
    'batch wait': runWait,
    'batch cancel': runCancel,
    'batch retry': runRetry,
    'batch accept': runAccept,
};

/** The `batch <verb>` handlers keyed by the full command name `run.ts` dispatches on, bound to its client factory. */
export function batchCommands<Io extends BatchIo>(boardFor: (io: Io, deadlineAt?: number) => BoardClient) {
    return Object.fromEntries(
        Object.entries(BATCH_HANDLERS).map(([name, command]) => [
            name,
            (args: readonly string[], io: Io) => command(args, io, (deadlineAt) => boardFor(io, deadlineAt)),
        ])
    ) as Record<string, (args: readonly string[], io: Io) => Promise<CommandResult>>;
}
