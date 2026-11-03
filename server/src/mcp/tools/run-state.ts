import { z } from 'zod';

/**
 * The one status vocabulary every task and run tool speaks, shared with `core/src/batch-standing.ts`. The board's
 * status is mapped here and nowhere else; `unreachable` and `inconclusive` are never produced by a mapping, they are
 * what a tool says when the board could not be reached or answered something untrustworthy.
 */
export const RUN_STATES = [
    'pending',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'needs_attention',
    'unreachable',
    'inconclusive',
] as const;
export type RunState = (typeof RUN_STATES)[number];
export const RunStateSchema = z.enum(RUN_STATES);

/** `JobStatus` of `db/jobs/job-store-types.ts`; a status outside it fails the board answer's schema. */
export const BOARD_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'dead', 'stopped'] as const;
export const BoardStatusSchema = z.enum(BOARD_STATUSES);
type BoardStatus = z.infer<typeof BoardStatusSchema>;

const OF_STATUS: Record<BoardStatus, RunState> = {
    queued: 'pending',
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    dead: 'failed',
    stopped: 'cancelled',
};

export interface RunFacts {
    status: BoardStatus;
    /** An `answerable` question is open on the run: a member is wanted. */
    questionOpen: boolean;
    /** A durable integration requirement (a connection the run needs) is open. */
    integrationOpen: boolean;
}

/**
 * A stopped run is `cancelled` whatever it was waiting on. Otherwise an open question or integration requirement is
 * `needs_attention`, even on a run the board already shows `failed`: the person is the next step, not a retry. The
 * board's `answerable` already says an answer would land now, so no status check repeats it here.
 */
export function stateOfRun({ status, questionOpen, integrationOpen }: RunFacts): RunState {
    if (status === 'stopped') return 'cancelled';
    if (integrationOpen) return 'needs_attention';
    if (questionOpen) return 'needs_attention';
    return OF_STATUS[status];
}

/** A task list row knows only the thread-wide `needsAnswer`; the head run's status is the rest. */
export const stateOfTask = (status: BoardStatus, needsAnswer: boolean): RunState =>
    stateOfRun({ status, questionOpen: needsAnswer, integrationOpen: false });

/** The characters of free text a row may carry; a longer text is cut and the row says so. */
export const MAX_TEXT_CHARS = 2000;
export const MAX_OUTPUT_CHARS = 8000;

export const cut = (text: string | null | undefined, max: number): { text: string | null; cut: boolean } => {
    if (text === null || text === undefined) return { text: null, cut: false };
    return text.length > max ? { text: text.slice(0, max), cut: true } : { text, cut: false };
};

const text = z
    .string()
    .nullish()
    .transform((v) => v ?? null);
const UserRef = z.object({ login: z.string() }).nullish();

const QuestionSchema = z.object({
    id: z.string(),
    attempt: z.number(),
    questions: z.array(
        z.object({
            question: z.string(),
            header: z.string(),
            multiSelect: z.boolean(),
            options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
        })
    ),
    status: z.enum(['pending', 'answered', 'expired', 'closed']),
    answerable: z.boolean(),
    answers: z.record(z.string(), z.string()).nullish(),
    answeredBy: UserRef,
    askedAt: z.string(),
    answeredAt: text,
});

const RequirementSchema = z.object({
    provider: z.string(),
    label: z.string(),
    reason: z.enum(['missing', 'ambiguous', 'reconnect']),
    source: z.enum(['create', 'runtime']),
});

/** The fields of a run (`GET /api/jobs`, `/api/jobs/:id`, `/api/jobs/:id/thread`) these tools read. */
export const BoardRunSchema = z.object({
    id: z.string(),
    rootJobId: z.string(),
    command: z.string(),
    status: BoardStatusSchema,
    repo: text,
    executor: text,
    baseBranch: text,
    mode: text,
    followUpTo: text,
    createdAt: z.string(),
    startedAt: text,
    finishedAt: text,
    exitCode: z
        .number()
        .nullish()
        .transform((v) => v ?? null),
    failureKind: text,
    failureCause: text,
    summary: text,
    output: text,
    waitReason: text,
    author: UserRef,
    gates: z.array(z.object({ name: z.string(), status: z.string(), exitCode: z.number().nullish() })).nullish(),
    publication: z.object({ prUrl: z.string(), prNumber: z.number() }).partial().nullish(),
    questions: z.array(QuestionSchema).optional(),
    integrationRequirements: z.array(RequirementSchema).optional(),
});
export type BoardRun = z.infer<typeof BoardRunSchema>;

export const questionsOpen = (run: BoardRun): boolean =>
    (run.questions ?? []).some((q) => q.status === 'pending' && q.answerable);

/** The run as an agent reads it: the board's facts under the shared state, free text bounded, no gate output. */
export function runView(run: BoardRun, detail: boolean) {
    const command = cut(run.command, MAX_TEXT_CHARS);
    const summary = cut(run.summary, MAX_TEXT_CHARS);
    const output = cut(run.output, MAX_OUTPUT_CHARS);
    const integrationRequirements = (run.integrationRequirements ?? []).map(({ provider, label, reason, source }) => ({
        provider,
        label,
        reason,
        source,
    }));
    return {
        id: run.id,
        rootJobId: run.rootJobId,
        followUpTo: run.followUpTo,
        status: run.status,
        state: stateOfRun({
            status: run.status,
            questionOpen: questionsOpen(run),
            integrationOpen: integrationRequirements.length > 0,
        }),
        command: command.text ?? '',
        commandTruncated: command.cut,
        repo: run.repo,
        executor: run.executor,
        baseBranch: run.baseBranch,
        mode: run.mode,
        author: run.author?.login ?? null,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        exitCode: run.exitCode,
        failureKind: run.failureKind,
        failureCause: run.failureCause,
        waitReason: run.waitReason,
        summary: summary.text,
        ...(detail
            ? {
                  output: output.text,
                  outputTruncated: output.cut,
                  gates: (run.gates ?? []).map(({ name, status, exitCode }) => ({
                      name,
                      status,
                      exitCode: exitCode ?? null,
                  })),
                  pullRequest: run.publication?.prUrl
                      ? { url: run.publication.prUrl, number: run.publication.prNumber ?? null }
                      : null,
                  integrationRequirements,
                  openQuestions: (run.questions ?? []).filter((q) => q.status === 'pending' && q.answerable).length,
              }
            : {}),
    };
}

/** Output schema of `runView` (detail fields optional: the list form omits them). */
export const RunViewSchema = z.object({
    id: z.string(),
    rootJobId: z.string(),
    followUpTo: z.string().nullable(),
    status: BoardStatusSchema,
    state: RunStateSchema,
    command: z.string(),
    commandTruncated: z.boolean(),
    repo: z.string().nullable(),
    executor: z.string().nullable(),
    baseBranch: z.string().nullable(),
    mode: z.string().nullable(),
    author: z.string().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    exitCode: z.number().nullable(),
    failureKind: z.string().nullable(),
    failureCause: z.string().nullable(),
    waitReason: z.string().nullable(),
    summary: z.string().nullable(),
    output: z.string().nullable().optional(),
    outputTruncated: z.boolean().optional(),
    gates: z.array(z.object({ name: z.string(), status: z.string(), exitCode: z.number().nullable() })).optional(),
    pullRequest: z.object({ url: z.string(), number: z.number().nullable() }).nullable().optional(),
    integrationRequirements: z
        .array(
            z.object({
                provider: z.string(),
                label: z.string(),
                reason: z.enum(['missing', 'ambiguous', 'reconnect']),
                source: z.enum(['create', 'runtime']),
            })
        )
        .optional(),
    openQuestions: z.number().optional(),
});
