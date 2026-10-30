import type {
    ArtifactSegment,
    ArtifactStream,
    BatchThreadClosed,
    BoardJobRecord,
    BoardTaskPage,
    ConnectionView,
    JobActivity,
    JobDone,
    JobEdited,
    JobRemoved,
    JobReopened,
    JobStopped,
    QuestionRecord,
    SkillView,
} from './board.js';
import { isTerminal } from './board.js';
import type { TaskUsage, Tokens, UsageBlock } from './usage-types.js';
import type { ConfigSummary, Preflight } from './diagnostics.js';
import type { ExecutorRow, RepoDiscovery } from './discovery.js';

/**
 * Human renderers for the lifecycle commands. Pure text in, text out — no board access, no console:
 * `run.ts` routes every string through the writers it was handed, so tests can read what would
 * have been printed. `--json` bypasses all of this and prints the payloads as JSON instead.
 */

/** Where a list row cuts the command off — a preview, not the record. */
const COMMAND_PREVIEW_LIMIT = 80;
/** How many trailing lines of a run's output tail one block prints. */
const OUTPUT_TAIL_LINES = 40;
/** What every absent field renders as — null is "not there", and that is worth saying. */
const DASH = '-';
/** The gate verdict whose own output tail is worth printing. */
const GATE_FAILED = 'failed';
const MS_PER_MINUTE = 60_000;
/** The column every detail field label is padded to, so the values line up. */
const LABEL_WIDTH = 10;

/** The one-line answer to a create: the 201 body is exactly these two fields. */
export function renderCreated(created: { id: string; status: string }): string {
    return `${created.status} ${created.id}`;
}

/**
 * The answer to a stop, and the two fates it has. A 202 leaves the run alive under its worker,
 * so "stopped" would be a lie: the stamp is what happened, and the settle lands moments later.
 */
export function renderStopped(stopped: JobStopped): string {
    if (stopped.cancelRequestedAt) {
        return `stop requested ${stopped.cancelRequestedAt} ${stopped.id} — the worker settles it at its next heartbeat`;
    }
    return `${stopped.status} ${stopped.id}`;
}

/** The answer to a done: the user's stamp, beside the run's own untouched verdict. */
export function renderDone(done: JobDone | BatchThreadClosed): string {
    if (!('batch' in done)) return `done ${done.doneAt ?? DASH} ${done.id} (run ${done.status})`;
    const closed = done.doneAt ? `done ${done.doneAt}` : 'stopping — done once the run settles';
    const pr = done.pr ? `; PR left open: ${done.pr}` : '';
    const fate = done.outcome === 'kept' ? 'kept its outcome' : 'cancelled';
    return `${closed} ${done.id}: batch ${done.batch} task ${done.task} ${fate}${pr}`;
}

/** The answer to a reopen: the task is open to a follow-up again. */
export function renderReopened(reopened: JobReopened): string {
    return `reopened ${reopened.id}`;
}

/** The answer to an edit: the run keeps its id and its place in the queue. */
export function renderEdited(edited: JobEdited): string {
    return `${edited.status} ${edited.id}`;
}

/** The answer to a remove. The thread is gone, so the id is all there is left to name. */
export function renderRemoved(removed: JobRemoved): string {
    return `removed ${removed.id}`;
}

function commandPreview(command: string): string {
    if (command.length <= COMMAND_PREVIEW_LIMIT) return command;
    return `${command.slice(0, COMMAND_PREVIEW_LIMIT)}…`;
}

/** One list row: id, status, created, repo, command preview — the board listing, one line each. */
export function renderJobLine(job: BoardJobRecord): string {
    return [job.id, job.status, job.createdAt, job.repo ?? DASH, commandPreview(job.command)].join('  ');
}

function field(label: string, value: string | number | null): string {
    return `${label.padEnd(LABEL_WIDTH)}${value ?? DASH}`;
}

function outputTail(output: string | null): string[] {
    if (!output) return [];
    return output.split('\n').slice(-OUTPUT_TAIL_LINES);
}

function outputBlock(output: string | null): string[] {
    const tail = outputTail(output);
    if (tail.length === 0) return [field('output:', DASH)];
    // A tail is the end of the stream, never the artifact: say so, and where the whole one is.
    return ['output: (tail only)', ...tail.map((line) => `  ${line}`)];
}

/** The gate rows: name, verdict and exit code, and a failed gate's own tail beneath it. */
function gateLines(job: BoardJobRecord): string[] {
    const gates = job.gates ?? [];
    if (gates.length === 0) return [field('gates:', DASH)];
    return gates.flatMap((gate) => {
        const exit = gate.exitCode === undefined || gate.exitCode === null ? '' : ` (exit ${gate.exitCode})`;
        // A gate that never started reads "not run" once the run is over, "pending" while it walks.
        const status = gate.status === 'pending' && isTerminal(job.status) ? 'not run' : gate.status;
        const row = field('gates:', `${gate.name} ${status}${exit}`);
        const tail = gate.status === GATE_FAILED ? outputTail(gate.output ?? null) : [];
        return [row, ...tail.map((line) => `  ${line}`)];
    });
}

/** The PR the thread published, and why it is waiting or what the agent is asking a person. */
function evidenceLines(job: BoardJobRecord): string[] {
    const lines: string[] = [];
    if (job.publication) {
        lines.push(
            field('pr:', `${job.publication.prUrl} (${job.publication.headBranch} → ${job.publication.baseBranch})`)
        );
    }
    if (job.waitReason) lines.push(field('waiting:', `${job.waitReason} since ${job.waitingSince ?? DASH}`));
    if (job.waitTerminalReason) lines.push(field('wait ended:', job.waitTerminalReason));
    for (const asked of job.questions ?? []) {
        for (const question of asked.questions) {
            const answer = asked.answers?.[question.question];
            const state = answer === undefined ? asked.status : `answered: ${answer}`;
            lines.push(field('question:', `${question.question} [${state}]`));
        }
    }
    return lines;
}

/** The detail read's block: status, command, authorship, timing, session, gates and the tail. */
export function renderJobDetail(job: BoardJobRecord): string {
    const lines = [
        field('id:', job.id),
        field('status:', job.status),
        field('command:', job.command),
        field('repo:', job.repo),
        field('executor:', job.executor),
        field('scope:', job.executorScope ?? null),
        field('mode:', job.mode),
        field('author:', job.author?.login ?? null),
        field('created:', job.createdAt),
        field('started:', job.startedAt),
        field('finished:', job.finishedAt),
        field('session:', job.sessionId),
        field('exit:', job.exitCode),
        // Why a FAILED run failed (issue #339) — the verdict's structured half.
        field('failure:', job.failureCause ? `${job.failureKind} (cause ${job.failureCause})` : job.failureKind),
        // The run's last words: what was done, beside the command that asked for it.
        field('summary:', job.summary),
    ];
    lines.push(...evidenceLines(job), ...gateLines(job), ...outputBlock(job.output));
    return lines.join('\n');
}

/** One thread member: the conversation's every command, verdict, session id and output tail. */
export function renderThreadMember(job: BoardJobRecord, index: number): string {
    return [
        `#${index + 1} ${job.id}`,
        field('status:', job.status),
        field('command:', job.command),
        field('session:', job.sessionId),
        field('summary:', job.summary),
        ...outputBlock(job.output),
    ].join('\n');
}

/** The thread read's block, oldest first — the order the board already answers with. */
export function renderThread(jobs: readonly BoardJobRecord[]): string {
    const lines = [`thread (${jobs.length}):`];
    for (const [index, job] of jobs.entries()) {
        if (index > 0) lines.push('');
        lines.push(renderThreadMember(job, index));
    }
    return lines.join('\n');
}

const TOKEN_LABELS = [
    ['input', 'input'],
    ['output', 'output'],
    ['cacheRead', 'cache-read'],
    ['cacheCreation', 'cache-creation'],
] as const;

/** The four types side by side, `-` for one that was never measured; there is no cross-type total. */
const tokenCells = (t: Tokens): string => TOKEN_LABELS.map(([type, label]) => `${label} ${t[type] ?? DASH}`).join('  ');

/** A block's types with a `~` before an estimated or mixed figure and `measured/contributors` after it. */
function usageCells(usage: UsageBlock): string {
    return TOKEN_LABELS.map(([type, label]) => {
        const value = usage.tokens[type];
        if (value === null) return `${label} ${DASH}`;
        const marker = usage.precision[type] === 'exact' ? '' : '~';
        const { measured, contributors } = usage.coverage[type];
        return `${label} ${marker}${value} (${measured}/${contributors})`;
    }).join('  ');
}

const unassignedLines = (usage: UsageBlock, indent: string): string[] =>
    usage.unassigned.map((u) => `${indent}unassigned (${u.reason}): ${tokenCells(u.tokens)}`);

/** One block as a line (state first when there is nothing to show) plus its unassigned amounts; provisional is named. */
export function renderUsageBlock(label: string, usage: UsageBlock, indent: string): string[] {
    const provisional = usage.provisional ? ' (provisional)' : '';
    if (usage.state === 'unavailable') return [`${indent}${label}: unavailable`];
    if (usage.state === 'unmeasured') return [`${indent}${label}: not measured${provisional}`];
    return [`${indent}${label}: ${usageCells(usage)}${provisional}`, ...unassignedLines(usage, `${indent}  `)];
}

function renderTaskUsage(task: TaskUsage): string[] {
    const lines = [`task ${task.taskId}${task.removed ? ' (removed)' : ''}: ${usageCells(task.usage)}`];
    for (const run of task.runs) {
        const of = run.reviewOf === null ? '' : ` of ${run.reviewOf}`;
        lines.push(`  ${run.kind}${of} ${run.jobId}: ${usageCells(run.usage)}`, ...unassignedLines(run.usage, '    '));
    }
    if (task.taskOwned) {
        lines.push(`  task-owned: ${usageCells(task.taskOwned)}`, ...unassignedLines(task.taskOwned, '    '));
    }
    return lines;
}

/** The activity read: the run's buckets and usage, then its task with every run, review runs included. */
export function renderActivity(activity: JobActivity): string {
    const lines: string[] = [];
    if (activity.buckets.length === 0) {
        lines.push('no activity: the run measured no usage');
    } else {
        lines.push(
            `activity ${activity.from ?? DASH} → ${activity.to ?? DASH} (${(activity.bucketMs ?? 0) / MS_PER_MINUTE} min buckets)`,
            ...activity.buckets.map((b) => `${b.start}  ${tokenCells(b.tokens)}  edits ${b.edits ?? DASH}`)
        );
    }
    if (activity.usage.state === 'measured') {
        lines.push(`run usage: ${usageCells(activity.usage)}`, ...unassignedLines(activity.usage, '  '));
    }
    if (activity.task) lines.push(...renderTaskUsage(activity.task));
    return lines.join('\n');
}

const streamLabel = (s: Pick<ArtifactStream, 'attempt' | 'executor' | 'session' | 'stream'>) =>
    `attempt ${s.attempt} ${s.executor} session ${s.session} stream ${s.stream}`;

/** The streams listing: one row each, the state first and the cause beside any state that is not complete. */
export function renderArtifactStreams(streams: readonly ArtifactStream[]): string {
    if (streams.length === 0) return 'no artifacts: the run has uploaded no streams';
    return streams
        .map((s) => {
            const cause = s.terminalCause === null ? '' : ` (${s.terminalCause})`;
            return `${s.state}${cause}  ${streamLabel(s)}  ${s.chunks} chunks  ${s.bytes} bytes`;
        })
        .join('\n');
}

/**
 * A read's text, with every condition the reader must not miss said inline as a `#` line: a stream
 * that is not complete, bytes missing before a chunk, a chunk whose object is deleted.
 */
export function renderArtifactSegments(
    streams: readonly ArtifactStream[],
    segments: readonly ArtifactSegment[]
): string {
    const lines: string[] = [];
    for (const s of streams) {
        if (s.state !== 'complete') lines.push(`# ${s.state} (${s.terminalCause ?? DASH}): ${streamLabel(s)}`);
    }
    for (const segment of segments) {
        if (segment.gapBefore > 0) lines.push(`# ${segment.gapBefore} bytes missing before offset ${segment.offset}`);
        if (segment.text === null)
            lines.push(`# deleted: ${segment.length} bytes at offset ${segment.offset} of ${streamLabel(segment)}`);
        else lines.push(segment.text.replace(/\n$/, ''));
    }
    return lines.join('\n');
}

/**
 * One task row: the TASK id first (what `task list` is keyed by), then the head run's status and
 * id — the run the status describes, never a historical one — and the task's own labels.
 */
export function renderTaskPage(page: BoardTaskPage): string {
    const lines = page.items.map((task) =>
        [
            task.id,
            task.status,
            `head:${task.headRunId}`,
            task.activityAt,
            task.repo ?? DASH,
            commandPreview(task.command),
        ].join('  ')
    );
    if (page.nextCursor !== null) lines.push(`next: --cursor ${page.nextCursor}`);
    return lines.length === 0 ? 'no tasks' : lines.join('\n');
}

/** Repo discovery: one row per tracked repo, a note when the list may be thin. */
export function renderRepos(discovery: RepoDiscovery): string {
    const lines = discovery.repos.map((row) =>
        [row.repo, row.private ? 'private' : 'public', row.defaultBranch ?? DASH].join('  ')
    );
    if (discovery.error) lines.push(`note: the repository list may be stale — ${discovery.error}`);
    return lines.length === 0 ? 'no repositories tracked' : lines.join('\n');
}

/** Executor discovery: scope, name, type, and the flags a selection cares about. */
export function renderExecutors(executors: readonly ExecutorRow[]): string {
    if (executors.length === 0) return 'no executors';
    return executors
        .map((row) =>
            [
                row.scope,
                row.name,
                row.type,
                row.suspended ? 'suspended' : 'active',
                ...(row.default ? ['default'] : []),
            ].join('  ')
        )
        .join('\n');
}

/** Installed skills with what each requires — env NAMES and managed-connection selectors only. */
export function renderSkills(skills: readonly SkillView[]): string {
    if (skills.length === 0) return 'no skills installed';
    return skills
        .map((skill) => {
            const needs = [
                ...skill.requires.tools.map((tool) => `tool:${tool}`),
                ...skill.requires.connections.map(
                    (connection) =>
                        `connection:${connection.name}${connection.selectedBy ? ` (select ${connection.selectedBy})` : ''}`
                ),
            ];
            return `${skill.name}  ${skill.description}${needs.length > 0 ? `  [requires ${needs.join(', ')}]` : ''}`;
        })
        .join('\n');
}

/** Short credential names for the list. */
const CREDENTIAL_LABEL: Record<string, string> = { oauth_grant: 'oauth' };

/** Selectable managed connections: the id is what `--connection` takes. */
export function renderConnections(connections: readonly ConnectionView[]): string {
    if (connections.length === 0) return 'no connections available';
    return connections
        .map((c) =>
            [
                c.id,
                c.provider,
                c.ownership,
                CREDENTIAL_LABEL[c.credential] ?? c.credential,
                c.access,
                c.site,
                c.account,
                c.createdAt,
            ].join('  ')
        )
        .join('\n');
}

/** One question call: id, state, asked time, then each prompt with its options and any recorded answer. */
export function renderQuestion(question: QuestionRecord): string {
    const answeredNote = question.answeredAt
        ? `  answered ${question.answeredAt} by ${question.answeredBy?.login ?? DASH}`
        : '';
    const lines = [`${question.id}  ${question.status}  asked ${question.askedAt}${answeredNote}`];
    for (const [index, asked] of question.questions.entries()) {
        lines.push(`  ${index + 1}. [${asked.header}] ${asked.question}`);
        lines.push(`     (${asked.multiSelect ? 'choose any, or free text' : 'choose one, or free text'})`);
        for (const option of asked.options) {
            lines.push(`     - ${option.label}${option.description ? `: ${option.description}` : ''}`);
        }
        const answer = question.answers?.[asked.question];
        if (answer !== undefined) lines.push(`     answer: ${answer}`);
    }
    return lines.join('\n');
}

/** The question list of a task, oldest first. */
export function renderQuestions(questions: readonly QuestionRecord[]): string {
    return questions.length === 0 ? 'no questions' : questions.map(renderQuestion).join('\n\n');
}

/** The answer's acknowledgement: the state the board left the question in, and its id. */
export function renderAnswered(question: QuestionRecord): string {
    return `${question.status} ${question.id}`;
}

/** `auth status`: where the CLI points, whether a token is set (never its value), and who it acts as. */
export function renderAuthStatus(status: {
    config: ConfigSummary;
    board: { version: string };
    identity: { login: string; organization: { name: string }; role: string; authMode: string };
}): string {
    const { config, board, identity } = status;
    const { sources } = config;
    return [
        `board    ${config.url} (version ${board.version}) [${sources.url}]`,
        `token    ${config.token.set ? `set (${config.token.kind})` : 'not set'} [${sources.token}]`,
        `requests ${config.requestTimeoutSeconds}s deadline [${sources.requestTimeoutS}], ${config.readRetries} read retries [${sources.readRetries}]`,
        `identity ${identity.login} in ${identity.organization.name} (${identity.role}), board auth ${identity.authMode}`,
    ].join('\n');
}

const PREFLIGHT_STATUS_WIDTH = 11;

/** One line per preflight check: its verdict, what it is about, and why. */
export function renderPreflight(preflight: Preflight): string {
    return preflight.checks
        .map((check) => {
            const subject = check.name === null ? check.subject : `${check.subject} ${check.name}`;
            return `${check.status.padEnd(PREFLIGHT_STATUS_WIDTH)} ${subject}  ${check.detail}`;
        })
        .join('\n');
}
