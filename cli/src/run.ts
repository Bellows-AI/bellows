import { parseArgs } from 'node:util';
import { ATTACH_OPTION, attachedIds } from './attach.js';
import { batchCommands } from './batch-commands.js';
import { createBoardClient, HTTP_OK, QUESTION_ANSWERED_CODE } from './board.js';
import { TASK_LIST_OPTIONS, taskListFilters } from './tasks.js';
import type { BoardClient, JobWait, QuestionRecord } from './board.js';
import { activityCommand, readCommand, streamsCommand } from './artifacts.js';
import { CliConfigError, loadCliConfig, type SettingsFile, takeConfigFlag } from './config.js';
import { envelopeOf, OUTCOME } from './outcome.js';
import type { CommandResult, ErrorDetail } from './outcome.js';
import { authStatusCommand, preflightCommand } from './diagnose.js';
import { configSummary } from './diagnostics.js';
import { executorDiscovery, repoDiscovery } from './discovery.js';
import { INPUT_OPTIONS, parseOrUsage, resolveCommandInput, UsageError } from './input.js';
import type { InputIo } from './input.js';
import { BoardError, MALFORMED_RESPONSE_CODE, NO_RESPONSE_STATUS, realClock } from './transport.js';
import type { BoardClock } from './transport.js';
import { SELECTION_OPTIONS, selectionOf } from './selection.js';
import { USAGE } from './usage.js';
import { createdResult, recoverable } from './writes.js';
import { readCliVersion } from './version.js';
import {
    renderAnswered,
    renderConnections,
    renderDone,
    renderEdited,
    renderExecutors,
    renderJobDetail,
    renderJobLine,
    renderQuestions,
    renderRemoved,
    renderReopened,
    renderRepos,
    renderSkills,
    renderStopped,
    renderTaskPage,
    renderThread,
} from './render.js';

/**
 * The command surface: parse, load config, call the board, print, return an exit code. Every
 * effect is injected — config from `io.env` and `io.settings`, HTTP from `io.fetch`, output through
 * `io.stdout` / `io.stderr` — so tests run the whole CLI in-process against a recorded fetch and string
 * arrays, and `index.ts` stays a small shim.
 *
 * A command never prints: it returns a `CommandResult`, and `run` alone decides how that is shown.
 * That is what keeps `--json` clean — one envelope on stdout, nothing on stderr, for success,
 * refusal, network failure, interruption and a command line that never parsed alike — except `--attach`,
 * whose upload progress goes to stderr as it happens. The outcome
 * and exit-code vocabulary lives in `outcome.ts`.
 */

/** The list limit bounds the board itself enforces, mirrored so an obvious typo never round-trips. */
const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 200;

/** How long one wait holds for by default, and the longest single hold the board allows. */
const WAIT_TOTAL_DEFAULT_S = 300;
const WAIT_POLL_MAX_S = 60;
const MS_PER_SECOND = 1000;

const JSON_FLAG = '--json';
const HELP_FLAGS = ['--help', '-h'];
const VERSION_ARGS = ['--version', 'version'];
const END_OF_OPTIONS = '--';
const JSON_OPTION = { json: { type: 'boolean', default: false } } as const;

export interface RunIo extends InputIo {
    env: NodeJS.ProcessEnv;
    /** The settings file under the environment: the default path, or what `--config` named. */
    settings: SettingsFile;
    fetch?: typeof globalThis.fetch | undefined;
    /** The clock the wait's budget is measured on — injected so tests spend no real time. */
    now?: (() => number) | undefined;
    /** The pause between read retries — injected with `now` so tests spend no real time backing off. */
    sleep?: BoardClock['sleep'] | undefined;
    /** Aborted on a local interrupt: the command ends `interrupted`, the task is left alone. */
    signal?: AbortSignal | undefined;
    stdout(text: string): void;
    stderr(text: string): void;
}

function parseLimit(raw: string | undefined): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < LIST_LIMIT_MIN || value > LIST_LIMIT_MAX) {
        throw new UsageError(`--limit must be an integer ${LIST_LIMIT_MIN}..${LIST_LIMIT_MAX}, got "${raw}"`);
    }
    return value;
}

/** The wait's own budget, not the board's: how long to keep re-issuing, in seconds. */
function parseWaitTimeout(raw: string | undefined): number {
    if (raw === undefined) return WAIT_TOTAL_DEFAULT_S;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1) {
        throw new UsageError(`--timeout must be a positive integer number of seconds, got "${raw}"`);
    }
    return value;
}

/** Config and client in one step: every command needs both, and neither takes an argument. */
function boardFor(io: RunIo, deadlineAt?: number): BoardClient {
    const config = loadCliConfig(io.env, io.settings);
    return createBoardClient({
        url: config.url,
        token: config.token,
        fetch: io.fetch,
        signal: io.signal,
        requestTimeoutMs: config.requestTimeoutMs,
        readRetries: config.readRetries,
        deadlineAt,
        clock: { now: io.now ?? realClock.now, sleep: io.sleep ?? realClock.sleep },
    });
}

/** The one positional every action command takes, and nothing else. */
function onlyId(args: readonly string[], verb: string, options: Record<string, { type: 'boolean' }> = {}) {
    const parsed = parseOrUsage(() =>
        parseArgs({ args: [...args], allowPositionals: true, options: { ...JSON_OPTION, ...options } })
    );
    if (parsed.positionals.length !== 1) {
        throw new UsageError(`${verb} needs exactly one job id\n\n${USAGE}`);
    }
    return { id: parsed.positionals[0]!, values: parsed.values as { json?: boolean; yes?: boolean; force?: boolean } };
}

/** A command that did what it was asked: the board's payload, and its one-line rendering. */
function ok(data: unknown, text: string): CommandResult {
    return { outcome: OUTCOME.ok, data, stdout: `${text}\n` };
}

const IDEMPOTENCY_KEY_OPTION = { 'idempotency-key': { type: 'string' } } as const;

/** The prompt text of a create or follow-up: one resolver, its refusals carry the usage text. */
async function commandOf(
    positionals: readonly string[],
    values: { file?: string | undefined; stdin?: boolean | undefined },
    io: RunIo
): Promise<string> {
    try {
        return await resolveCommandInput({ positionals, file: values.file, stdin: values.stdin }, io);
    } catch (error) {
        if (error instanceof UsageError) throw new UsageError(`${error.message}\n\n${USAGE}`);
        throw error;
    }
}

async function runCreate(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: {
                ...JSON_OPTION,
                ...INPUT_OPTIONS,
                ...SELECTION_OPTIONS,
                ...IDEMPOTENCY_KEY_OPTION,
                ...ATTACH_OPTION,
            },
        })
    );
    const command = await commandOf(parsed.positionals, parsed.values, io);
    const selection = selectionOf(parsed.values);
    const key = parsed.values['idempotency-key'];
    const paths = parsed.values.attach ?? [];
    const attachments = await attachedIds(paths, key, boardFor(io), io.stderr);
    const created = await recoverable(
        () => boardFor(io).createJob({ ...selection, command, idempotencyKey: key, attachments }),
        key,
        paths.length > 0
    );
    return createdResult(created);
}

async function runList(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            options: {
                ...JSON_OPTION,
                status: { type: 'string' },
                limit: { type: 'string' },
                repo: { type: 'string' },
            },
        })
    );
    const limit = parseLimit(parsed.values.limit);
    const jobs = await boardFor(io).listJobs({
        status: parsed.values.status,
        limit,
        repo: parsed.values.repo,
    });
    return { outcome: OUTCOME.ok, data: { jobs }, stdout: jobs.map((job) => `${renderJobLine(job)}\n`).join('') };
}

async function runTaskList(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const { values } = parseOrUsage(() =>
        parseArgs({ args: [...args], options: { ...JSON_OPTION, ...TASK_LIST_OPTIONS } })
    );
    const page = await boardFor(io).listTasks(taskListFilters(values));
    return {
        outcome: OUTCOME.ok,
        data: { tasks: page.items, nextCursor: page.nextCursor },
        stdout: `${renderTaskPage(page)}\n`,
    };
}

async function runInvestigate(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const { id } = onlyId(args, 'investigate');
    const client = boardFor(io);
    const job = await client.getJob(id);
    const thread = await client.thread(id);
    return ok({ job, thread }, `${renderJobDetail(job)}\n\n${renderThread(thread)}`);
}

/** What a wait's `data` says: the result, and the task / requested run / head run identities. */
function waitData(id: string, wait: JobWait, budgetSeconds: number) {
    return {
        result: wait.result,
        taskId: wait.rootJobId,
        runId: id,
        headRunId: wait.headJobId,
        headStatus: wait.headStatus,
        waitReason: wait.waitReason,
        budgetSeconds,
        job: wait.job,
    };
}

/** How a terminal head's verdict ends the command — the run's own verdict, nothing downstream of it. */
function terminalOutcome(wait: JobWait): CommandResult['outcome'] {
    switch (wait.headStatus) {
        case 'succeeded':
            return OUTCOME.succeeded;
        case 'failed':
        case 'dead':
            return OUTCOME.failed;
        case 'stopped':
            return OUTCOME.cancelled;
        default:
            throw new BoardError(
                `the board settled a wait on a head in status "${wait.headStatus}"`,
                HTTP_OK,
                MALFORMED_RESPONSE_CODE
            );
    }
}

/**
 * The wait. Each poll is a settle long-poll the BOARD holds, and the board says why it returned:
 * `terminal` (the head's verdict is in), `parked` (an open workflow wait nothing here can move)
 * or `timeout` (the hold elapsed, thread still moving). Only a `timeout` is re-issued; nothing is
 * inferred from how long a poll took. No sleep anywhere — the holding happens server-side, and
 * the last poll asks only for what is left of the budget rather than the full cap.
 */
async function runWait(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: { ...JSON_OPTION, timeout: { type: 'string' } },
        })
    );
    if (parsed.positionals.length !== 1) {
        throw new UsageError('wait needs exactly one job id\n\n' + USAGE);
    }
    const id = parsed.positionals[0]!;
    const total = parseWaitTimeout(parsed.values.timeout);
    const now = io.now ?? Date.now;
    // The client shares the wait's deadline, so its attempts and backoff cannot outlive the budget.
    const deadline = now() + total * MS_PER_SECOND;
    const client = boardFor(io, deadline);
    let last: JobWait | null = null;
    for (;;) {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) break;
        const hold = Math.min(WAIT_POLL_MAX_S, Math.ceil(remainingMs / MS_PER_SECOND));
        last = await client.waitForJob(id, hold);
        if (last.result === 'terminal') {
            return {
                outcome: terminalOutcome(last),
                data: waitData(id, last, total),
                stdout: `${renderJobLine(last.job)}\n`,
            };
        }
        if (last.result === 'parked') {
            return {
                outcome: OUTCOME.needsAttention,
                data: waitData(id, last, total),
                stderr:
                    `${last.headStatus}, parked on a workflow wait (${last.waitReason ?? 'unnamed'}): ${id}\n` +
                    `the task's head run is ${last.headJobId}; nothing a wait does moves a parked thread\n`,
            };
        }
    }
    return {
        outcome: OUTCOME.timeout,
        data: last
            ? waitData(id, last, total)
            : { result: 'timeout', runId: id, budgetSeconds: total, taskId: null, headRunId: null },
        stderr: `still ${last?.headStatus ?? 'unsettled'} after ${total}s: ${id}\n`,
    };
}

async function runFollowUp(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: { ...JSON_OPTION, ...INPUT_OPTIONS, ...IDEMPOTENCY_KEY_OPTION, ...ATTACH_OPTION },
        })
    );
    const [id, ...rest] = parsed.positionals;
    if (!id) {
        throw new UsageError('a follow-up needs a job id\n\n' + USAGE);
    }
    const command = await commandOf(rest, parsed.values, io);
    // Only the command travels: the repo, the executor and the session come from the parent.
    const key = parsed.values['idempotency-key'];
    const paths = parsed.values.attach ?? [];
    const attachments = await attachedIds(paths, key, boardFor(io), io.stderr);
    const created = await recoverable(
        () => boardFor(io).followUp(id, command, key, attachments),
        key,
        paths.length > 0
    );
    return createdResult(created);
}

async function runRetry(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({ args: [...args], allowPositionals: true, options: { ...JSON_OPTION, ...IDEMPOTENCY_KEY_OPTION } })
    );
    if (parsed.positionals.length !== 1) {
        throw new UsageError(`retry needs exactly one job id\n\n${USAGE}`);
    }
    const key = parsed.values['idempotency-key'];
    const created = await recoverable(() => boardFor(io).retry(parsed.positionals[0]!, key), key);
    return createdResult(created);
}

async function runEdit(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({ args: [...args], allowPositionals: true, options: { ...JSON_OPTION, ...INPUT_OPTIONS } })
    );
    const [id, ...rest] = parsed.positionals;
    if (!id) {
        throw new UsageError('an edit needs a job id\n\n' + USAGE);
    }
    const command = await commandOf(rest, parsed.values, io);
    const edited = await boardFor(io).editJob(id, command);
    return ok(edited, renderEdited(edited));
}

async function runReopen(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const { id } = onlyId(args, 'reopen');
    const reopened = await boardFor(io).reopenJob(id);
    return ok(reopened, renderReopened(reopened));
}

/** Every question the task's runs asked, oldest first — each paired with the run that asked it. */
async function questionsOf(client: BoardClient, id: string) {
    const thread = await client.thread(id);
    return thread.flatMap((job) => (job.questions ?? []).map((question) => ({ jobId: job.id, question })));
}

async function runQuestions(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const { id } = onlyId(args, 'questions');
    const questions: QuestionRecord[] = (await questionsOf(boardFor(io), id)).map((entry) => entry.question);
    return ok({ questions }, renderQuestions(questions));
}

async function runAnswer(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const parsed = parseOrUsage(() =>
        parseArgs({
            args: [...args],
            allowPositionals: true,
            options: { ...JSON_OPTION, answer: { type: 'string', multiple: true } },
        })
    );
    const [id, questionId] = parsed.positionals;
    if (parsed.positionals.length !== 2 || !id || !questionId) {
        throw new UsageError(`answer needs a job id and a question id\n\n${USAGE}`);
    }
    const values = parsed.values.answer ?? [];
    const client = boardFor(io);
    const found = (await questionsOf(client, id)).find((entry) => entry.question.id === questionId);
    if (!found) throw new UsageError(`no question ${questionId} on the task of ${id}`);
    const prompts = found.question.questions;
    if (values.length !== prompts.length) {
        throw new UsageError(
            `question ${questionId} has ${prompts.length} prompt(s); give one --answer for each, in order (got ${values.length})`
        );
    }
    const answers = Object.fromEntries(prompts.map((prompt, index) => [prompt.question, values[index]!]));
    try {
        const answered = await client.answerQuestion(found.jobId, questionId, answers);
        return ok(answered, renderAnswered(answered));
    } catch (error) {
        if (error instanceof BoardError && error.code === QUESTION_ANSWERED_CODE) {
            throw new BoardError(
                `${error.message} — run \`bellows job questions ${id}\` to see the recorded answer`,
                error.status,
                error.code
            );
        }
        throw error;
    }
}

async function runStop(args: readonly string[], io: RunIo): Promise<CommandResult> {
    const { id } = onlyId(args, 'stop');
    const stopped = await boardFor(io).stopJob(id);
    return ok(stopped, renderStopped(stopped));
}

async function runDone(args: readonly string[], io: RunIo): Promise<CommandResult> {
    // --force also closes a live batch's thread: the batch stops it and cancels its task.
    const { id, values } = onlyId(args, 'done', { force: { type: 'boolean' } });
    const done = await boardFor(io).markDone(id, values.force === true);
    return ok(done, renderDone(done));
}

async function runRemove(args: readonly string[], io: RunIo): Promise<CommandResult> {
    // A remove deletes the whole thread and cannot be undone, and this CLI has no prompt to ask
    // through — so the command line is where the intent has to be said out loud.
    const { id, values } = onlyId(args, 'remove', { yes: { type: 'boolean' } });
    if (!values.yes) {
        throw new UsageError('remove deletes the whole task thread and cannot be undone — pass --yes to confirm');
    }
    const removed = await boardFor(io).removeJob(id);
    return ok(removed, renderRemoved(removed));
}

/** A discovery command takes no arguments beyond `--json`, and only reads. */
function noArguments(args: readonly string[], verb: string): void {
    const parsed = parseOrUsage(() => parseArgs({ args: [...args], allowPositionals: true, options: JSON_OPTION }));
    if (parsed.positionals.length > 0) throw new UsageError(`${verb} takes no arguments\n\n${USAGE}`);
}

async function runRepoList(args: readonly string[], io: RunIo): Promise<CommandResult> {
    noArguments(args, 'repo list');
    const client = boardFor(io);
    const discovery = repoDiscovery(await client.listRepos());
    return ok(discovery, renderRepos(discovery));
}

async function runExecutorList(args: readonly string[], io: RunIo): Promise<CommandResult> {
    noArguments(args, 'executor list');
    const discovery = executorDiscovery(await boardFor(io).workspace());
    return ok(discovery, renderExecutors(discovery.executors));
}

async function runSkillList(args: readonly string[], io: RunIo): Promise<CommandResult> {
    noArguments(args, 'skill list');
    const skills = await boardFor(io).listSkills();
    return ok({ skills }, renderSkills(skills));
}

async function runConnectionList(args: readonly string[], io: RunIo): Promise<CommandResult> {
    noArguments(args, 'connection list');
    const connections = await boardFor(io).listConnections();
    return ok({ connections }, renderConnections(connections));
}

async function runAuthStatus(args: readonly string[], io: RunIo): Promise<CommandResult> {
    noArguments(args, 'auth status');
    const config = configSummary(loadCliConfig(io.env, io.settings));
    return authStatusCommand(config, boardFor(io), (error) => failureOf(error, io));
}

const COMMANDS: Record<string, (args: readonly string[], io: RunIo) => Promise<CommandResult>> = {
    'job create': runCreate,
    'job preflight': (args, io) => preflightCommand(args, () => boardFor(io)),
    'job list': runList,
    'task list': runTaskList,
    'job investigate': runInvestigate,
    'job activity': (args, io) => activityCommand(args, boardFor(io), USAGE),
    'job streams': (args, io) => streamsCommand(args, boardFor(io), USAGE),
    'job read': (args, io) => readCommand(args, boardFor(io), USAGE),
    'job wait': runWait,
    'job follow-up': runFollowUp,
    'job retry': runRetry,
    'job edit': runEdit,
    'job questions': runQuestions,
    'job answer': runAnswer,
    'job stop': runStop,
    'job done': runDone,
    'job reopen': runReopen,
    'job remove': runRemove,
    'repo list': runRepoList,
    'executor list': runExecutorList,
    'skill list': runSkillList,
    'connection list': runConnectionList,
    'auth status': runAuthStatus,
    ...batchCommands(boardFor),
    help: async () => ok({ usage: USAGE }, USAGE),
    version: async () => {
        const version = readCliVersion();
        return ok({ version }, `bellows ${version}`);
    },
};

const INTERRUPTED_MESSAGE = 'interrupted — this process stopped; the task on the board was not touched';

/** A failure as a result: which outcome it is, what to tell a person, and what to tell a script. */
function failureOf(error: unknown, io: RunIo): CommandResult {
    // A local interrupt aborts the fetch, which looks like a network failure — the signal is the
    // only thing that tells the two apart, so it is asked first.
    if (io.signal?.aborted) {
        const detail: ErrorDetail = { message: INTERRUPTED_MESSAGE, code: null, status: null };
        return { outcome: OUTCOME.interrupted, error: detail, stderr: `${INTERRUPTED_MESSAGE}\n` };
    }
    if (error instanceof CliConfigError || error instanceof UsageError) {
        return {
            outcome: OUTCOME.usage,
            error: { message: error.message, code: null, status: null },
            stderr: `${error.message}\n`,
        };
    }
    if (error instanceof BoardError) {
        // The board's message is the useful one; the code rides beside it for scripting.
        const code = error.code ? ` [${error.code}]` : '';
        return {
            outcome: error.status === NO_RESPONSE_STATUS ? OUTCOME.unreachable : OUTCOME.refused,
            error: { message: error.message, code: error.code, status: error.status },
            stderr: `error: ${error.message}${code}\n`,
        };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
        outcome: OUTCOME.refused,
        error: { message, code: null, status: null },
        stderr: `error: ${message}\n`,
    };
}

/** The options part of a command line: everything before `--`, which belongs to the task's command. */
function optionsOf(args: readonly string[]): readonly string[] {
    const end = args.indexOf(END_OF_OPTIONS);
    return end === -1 ? args : args.slice(0, end);
}

/** Whether `--json` was asked for, read before any parsing so a parse failure can still honor it. */
function wantsJson(args: readonly string[]): boolean {
    return optionsOf(args).includes(JSON_FLAG);
}

/** `help`, or `--help`/`-h` anywhere among the options — answered before any configuration is read. */
function wantsHelp(args: readonly string[]): boolean {
    return args[0] === 'help' || optionsOf(args).some((arg) => HELP_FLAGS.includes(arg));
}

type Dispatched = { command: string | null; result: CommandResult };

async function dispatch(rawArgv: readonly string[], io: RunIo): Promise<Dispatched> {
    // A line that names no command reports none, so a parse failure never invents one.
    let name: string | null = null;
    try {
        const { argv, settings } = takeConfigFlag(rawArgv);
        const [topic, command] = argv;
        // Help and version are answered here, before any configuration is read.
        const key = wantsHelp(argv) ? 'help' : VERSION_ARGS.includes(topic ?? '') ? 'version' : `${topic} ${command}`;
        const handler = Object.hasOwn(COMMANDS, key) ? COMMANDS[key] : undefined;
        if (!handler) throw new UsageError(USAGE);
        name = key;
        return { command: name, result: await handler(argv.slice(2), { ...io, settings: settings ?? io.settings }) };
    } catch (error) {
        return { command: name, result: failureOf(error, io) };
    }
}

/** Runs one command line to completion. Returns the process exit code; never throws. */
export async function run(argv: readonly string[], io: RunIo): Promise<number> {
    const { command, result } = await dispatch(argv, io);
    const envelope = envelopeOf(command, result);
    if (wantsJson(argv)) {
        io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
        if (result.stdout) io.stdout(result.stdout);
        if (result.stderr) io.stderr(result.stderr);
    }
    return envelope.exitCode;
}
