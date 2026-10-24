import type { BoardJob, FailureCause } from '../board/board.js';
import type { DriverConfig } from '../config.js';
import { containerScript as script } from '../container-scripts.js';
import { TASK_MOUNT, UUID } from '../task-volume.js';
import { parseLastJsonLine } from '../json-parse.js';
import { stepLost } from '../step-control.js';
import { baseBranchOf, isBranchName } from './publish-base.js';
import { headSha, publicationOp, recordOperation } from './publish-reconcile.js';
import { publishedResult, pushRecorded, reconcileAgentPr, resolveOrCreatePr, resumePublication } from './publish-pr.js';

// The values that stand alone live below this file and are named here, where every caller finds them.
export {
    baseBranchOf,
    CREDENTIAL_HELPER,
    isBranchName,
    type PrSummary,
    parsePrSummary,
    prNumberFromUrl,
    prSummaryScript,
} from './publish-base.js';

/**
 * Publishing the work a run produced. The policy lives in the loop — a successful run, gates
 * passed, nothing asks — and the mechanics here: what the branch and commit message should be,
 * and the exact `docker run` argv of every step. Pure and exported for the same pinning as
 * dockerArgs: everything security-relevant about publishing (which values interpolate where, and
 * how the push credential travels) is decided in these arrays.
 *
 * The publisher is a BACKSTOP, not the primary author: the executor's AGENTS.md tells the agent
 * to work on a task branch and commit as it goes, and the board's gates run the declared checks
 * again after the agent finishes. This path exists because instructions are not enforcement — a
 * run that "succeeded" while leaving its work uncommitted in a local checkout did not land
 * anywhere, and nobody was asked.
 */

/** The probe's node script: see scripts/git-probe.cjs. */
export const gitProbeScript = script('git-probe.cjs');

/** The startup sync's node script: see scripts/task-checkout.cjs. */
export const taskCheckoutScript = script('task-checkout.cjs');

/** What the board intends to publish for one job. */
export interface PublishPlan {
    /** The task branch: `fix/<issue>` when the command names an issue, `task/<date>` otherwise. */
    branch: string;
    /**
     * The commit message — and the PR title's FALLBACK, for a branch the summarizer cannot
     * read (issue #82): the command's first line, with the issue reference appended.
     */
    title: string;
    /** The issue the thread's root command (else the job's own) names — the PR body closes it. */
    issueNumber: number | null;
}

/**
 * The issue a command names, in `publishPlan`'s precedence order: a full `issues/\d+` URL, then
 * a `/fix <n>` command, then a bare `#\d+` mention. A match counts only when the digits end the
 * token — a trailing word character means they were a prefix (`44oops` is prose, not #44, while
 * `#44.` ends a sentence and still counts) — and the number is one GitHub could have issued:
 * positive, within the safe-integer range (`#0` is no issue, and past 2^53-1 `Number` stops
 * being a number at all).
 */
const commandIssue = (command: string): number | null => {
    for (const pattern of [/issues\/(\d+)/, /\/fix\s+#?(\d+)/, /#(\d+)/]) {
        const match = pattern.exec(command);
        if (!match || /[\w]/.test(command[match.index + match[0].length] ?? '')) continue;
        const issue = Number(match[1]);
        if (Number.isSafeInteger(issue) && issue > 0) return issue;
    }
    return null;
};

/**
 * The plan for one job. The command is the author's own prompt — an audit record, not
 * attacker-controlled content, but it still only ever becomes a `-m`/`--title` VALUE in direct
 * argv (execFile, no shell), never a fragment of one.
 */
/** The commit title / PR-title-fallback's cap: the command's first line, held to one line's worth. */
const COMMIT_TITLE_MAX_CHARS = 144;

export function publishPlan(job: BoardJob, now: Date = new Date()): PublishPlan {
    // The task's issue is the one its FIRST command names: the publishing run is often a
    // follow-up whose own command ("both OK") names nothing, and its PR must still close it.
    const issue = commandIssue(job.rootCommand) ?? commandIssue(job.command);
    const firstLine = (job.command.trim().split('\n')[0] ?? '').trim().slice(0, COMMIT_TITLE_MAX_CHARS);
    const title = issue ? `${firstLine} (#${issue})` : firstLine;
    const branch = issue ? `fix/${issue}` : `task/${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
    return { branch, title, issueNumber: issue };
}

/** What a probe of the checkout found, and what every later step branches on. */
export interface GitState {
    /** False when the directory is not a git checkout at all — a just-connected repository. */
    cloned: boolean;
    /** The current branch, or '' when HEAD is detached. */
    branch: string;
    /** The base: the claim's base branch, else the origin default — the one a task branch must not commit to. */
    defaultBranch: string;
    /** Uncommitted changes exist. */
    dirty: boolean;
    /** Commits on this branch that origin does not have. */
    unpushed: number;
    /** The checkout has a committer identity configured; the fallback is only applied when not. */
    hasIdentity: boolean;
    /** The tree fingerprint (`HEAD:hash` of the uncommitted state); null when the probe measured none. */
    fingerprint: string | null;
    /** Unmerged paths the tree still holds (issue #661); empty when none. */
    conflicts: string[];
    /** A rebase is stopped in the tree, conflicted or resolved but not continued. */
    rebasing: boolean;
}

/** Why a publish refused a tree that still holds a conflict; the cause is `conflict`, so a batch repairs it. */
export const unresolvedConflictReason = (state: Pick<GitState, 'conflicts' | 'rebasing'>): string =>
    'the checkout still has an unresolved merge conflict' +
    (state.conflicts.length ? ` in ${state.conflicts.join(', ')}` : '') +
    (state.rebasing ? ' and a stopped rebase (run `git rebase --continue`)' : '') +
    ' — nothing was pushed; resolve it and publish again';

/** What the publish attempt answers to the loop. */
export interface PublishResult {
    /** False means the verdict must not be success: the work did not land and the reason says why. */
    ok: boolean;
    /** True when a branch was pushed (a PR url is then expected beside it). */
    published: boolean;
    branch: string | null;
    prUrl: string | null;
    reason: string | null;
    /**
     * What the publish actually landed, when it did: the repository the PR lives in, the branch
     * it pushed, and its base. Null on a no-op or a failed publish — the board records the
     * identity ONLY for work that reached GitHub, and a summary session's no-op must not spew a
     * phantom publication into a thread that never shipped one.
     */
    repository: string | null;
    /** The branch the PR targets — the origin default the task branched from. */
    baseBranch: string | null;
    prNumber: number | null;
    /**
     * True when the publish was refused because the checkout is no longer the revision the required
     * evidence assessed (`PublishOptions.revision`). Nothing was pushed; the loop reports it as a
     * `policy` failure rather than a `publish` one.
     */
    stale?: true;
    /** What lies under a failed publish (`publishCauseOf` or the transport's own); null when it did not fail. */
    cause: FailureCause | null;
}

/** How one publish differs from the board's end-of-run one. */
export interface PublishOptions {
    /**
     * The tree fingerprint the required evidence assessed. When set, the publish pushes only a
     * checkout whose own probe still reports it, and refuses `stale` otherwise — the check sits
     * here, in the one function both executors publish through, so docker and kubernetes cannot drift.
     */
    revision?: string;
    /** Open a NEW pull request as a draft — the agent's mid-run publish. An existing PR is reused as it is. */
    draft?: boolean;
}

/**
 * The failure kinds the sync script (scripts/task-checkout.cjs) names for a refusal no retry can
 * fix; the loop reports each as `config` (loop-run.ts, `syncCheckoutStep`). The literals live in
 * the script too, which driver/test/docker/ pins.
 */
export const SYNC_FAILURE_KINDS = ['branch_unrestorable', 'missing_base_branch'] as const;
/** What a refused sync names: a config kind above, or the thread's lost checkpoint (`task-restore.ts`), which is its own failure kind. */
export type SyncFailureKind = (typeof SYNC_FAILURE_KINDS)[number] | 'checkpoint_unrestorable';

/**
 * The turn context a conflict handed over by the sync adds (issue #661): the paths, and what the
 * agent does about them. Appended to the board's own context, which it never replaces.
 */
export const withConflictContext = (turnContext: string | undefined, paths: readonly string[]): string =>
    [
        ...(turnContext ? [turnContext] : []),
        'Merge conflict left in the worktree',
        'The startup sync rebased this task branch onto the moved target and it conflicts, or an earlier attempt left the tree conflicted. ' +
            'Resolve it before anything else: edit the conflict markers out of these paths, `git add` them, ' +
            'and run `git rebase --continue` if a rebase is stopped (never `git rebase --abort`). ' +
            'The publish refuses a tree that still has unresolved conflicts or a stopped rebase.',
        `Conflicting paths:\n${paths.map((p) => `- ${p}`).join('\n')}`,
    ].join('\n\n');

/** What the startup sync answers: ok, or the reason the run should not start from a stale tree. */
export interface SyncResult {
    ok: boolean;
    reason: string | null;
    /** Set on an ok sync that left a conflict in the tree for the agent: the unmerged paths. */
    conflicts?: string[];
    /** Set by the script on a deterministic refusal; absent for anything unrecognised. */
    kind?: SyncFailureKind;
    /**
     * The task tree's fingerprint after the sync (scripts/task-checkout.cjs), compared with the
     * post-gate probe's to tell a round that changed nothing. Absent or null is unknown.
     */
    fingerprint?: string | null;
}

/**
 * The startup sync's own bound, on both executors: the timeout of the supervised sync step.
 */
export const SYNC_DEADLINE_MS = 600_000;

/** What the terminal reclaim answers: ok, whether anything was removed, or the reason it did not. */
export interface ReclaimResult {
    ok: boolean;
    /**
     * True when the task tree no longer exists after the call: it was removed, or it was already
     * gone. False when the reclaim refused (the tree stays) or there was nothing to reclaim because
     * the thread never touched the volume.
     */
    removed: boolean;
    reason: string | null;
}

/** What an unparseable worktree sync verdict means — both executors' fallback for the same shape. */
export const syncUnreadable: SyncResult = { ok: false, reason: 'the worktree sync answered nothing readable' };

/** Nothing to publish: no checkout, or a clean tree with nothing unpushed. Not an error. */
export const publishNothing = (reason: string): PublishResult => ({
    ok: true,
    published: false,
    branch: null,
    prUrl: null,
    reason,
    repository: null,
    baseBranch: null,
    prNumber: null,
    cause: null,
});

/** Why a publish bound to a revision pushed nothing: the tree moved after the evidence was taken. */
export const STALE_REVISION_REASON =
    'the checkout changed after the required evidence was taken — nothing was pushed; re-run the gates (and review) over the current work';

/** Why a bound publish pushed nothing: its own git steps' hooks moved the content (issue #825). */
export const PUBLISH_MOVED_REASON =
    "the publish's own git steps changed the content after the required evidence was taken (a repository hook) — nothing was pushed; re-run the gates (and review) over the current work";

export const publishFailed = (reason: string, cause: FailureCause | null): PublishResult => ({
    ok: false,
    published: false,
    branch: null,
    prUrl: null,
    reason,
    repository: null,
    baseBranch: null,
    prNumber: null,
    cause,
});

/** A bound publish refused: the content is no longer what the evidence assessed; nothing was pushed. */
const staleRefusal = (reason: string): PublishResult => ({ ...publishFailed(reason, null), stale: true });

/**
 * The cause a publish step's own git/gh stderr names, checked in this order so a refusal that also
 * prints `[rejected]` stays a refusal; anything unrecognised is `unknown`, never a guess.
 */
const PUBLISH_CAUSES: readonly [FailureCause, RegExp][] = [
    // GitHub answers a rate limit with a 403 too; it passes, so it is transport, read before `denied`.
    ['transport', /rate limit exceeded|secondary rate limit|HTTP 429|returned error: 429/i],
    // The task supervisor's channel (issue #771): a step whose answer never came, or an attempt gone.
    ['transport', /supervisor channel closed|was not answered in time/],
    [
        'denied',
        /Permission to .* denied|returned error: 403|HTTP 403|Authentication failed|could not read Username|Resource not accessible by integration|protected branch hook declined/,
    ],
    [
        'conflict',
        /\[rejected\]|non-fast-forward|stale info|fetch first|CONFLICT|merge conflict|HEAD does not contain it/i,
    ],
    [
        'transport',
        /Could not resolve host|Connection (timed out|reset|refused)|RPC failed|early EOF|returned error: 5\d\d|HTTP 5\d\d|TLS/,
    ],
];

export const publishCauseOf = (message: string): FailureCause =>
    PUBLISH_CAUSES.find(([, pattern]) => pattern.test(message))?.[0] ?? 'unknown';

export { UUID };

/**
 * The workspace half: `<org>/<user id>`, the org-id shape server/src/auth/github.ts documents.
 * The value becomes the agent's working directory, and a validator narrower than the input
 * domain would fail every job on a legally-named workspace.
 */
export const WORKSPACE_PATH =
    /^[a-z0-9][a-z0-9_-]{0,38}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The checkout key a gated run's environment is filed under, and the declared image: the key is
 * `<thread root id>/<repo segment>` (`checkoutKey`), and its segment is interpolated into a working
 * directory every gate command runs in, and the image is repo content naming what executes. Shared
 * by the docker and kubernetes gate managers, which assert the same shapes before the same
 * interpolation.
 */
export const GATE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?!\.{1,2}$)[A-Za-z0-9._-]+$/i;

/** Same shape the board's `.bellows.yaml` parser enforces; re-asserted here, before argv. */
export const GATE_IMAGE = /^[A-Za-z0-9_][A-Za-z0-9_./:-]*$/;

/**
 * The repo segment of the job's `owner/name`, asserted: a segment starting with '.' is refused —
 * '.' and '..' are the traversal itself, and any other dot-name is the task volume's own (`.factory`,
 * the `.<name>.sync` the checkout is built in).
 */
const repoSegmentOf = (job: Pick<BoardJob, 'repo'>): string | null => {
    const segment = job.repo?.split('/')[1];
    return segment && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(segment) ? segment : null;
};

/**
 * The key the task's checkout is filed under (its gate environment's): `<thread root id>/<repo
 * segment>` — or null when the job names no repository (a command-only job runs at the task
 * volume's root) or either half fails its assertion. One task thread = one volume = one checkout
 * (issue #775): every attempt of the job, and every follow-up resuming its session, lands in the
 * same tree.
 */
export function checkoutKey(job: BoardJob): string | null {
    const segment = repoSegmentOf(job);
    const root = job.rootJobId ?? job.id;
    return segment && UUID.test(root) ? `${root}/${segment}` : null;
}

/** The checkout's directory inside the task volume — `/task/<repo segment>` — or null when the job has none. */
export function checkoutDir(job: BoardJob): string | null {
    const segment = repoSegmentOf(job);
    return segment && UUID.test(job.rootJobId ?? job.id) ? `${TASK_MOUNT}/${segment}` : null;
}

/** Where the task's checkout is cloned from (issue #775): `<cloneBase>/<owner>/<name>.git`, or null for a repo label with another shape. */
export function remoteUrl(config: Pick<DriverConfig, 'cloneBase'>, job: BoardJob): string | null {
    const [owner, name, ...rest] = job.repo?.split('/') ?? [];
    const part = /^[A-Za-z0-9._-]+$/;
    if (
        !owner ||
        !name ||
        rest.length > 0 ||
        !part.test(owner) ||
        !part.test(name) ||
        owner === '.' ||
        owner === '..'
    ) {
        return null;
    }
    return repoSegmentOf(job) ? `${config.cloneBase}/${owner}/${name}.git` : null;
}

/** The directory of the task volume that holds every review root of the thread (issue #774). */
export const REVIEW_ROOTS_DIR = `${TASK_MOUNT}/.factory/reviews`;

/** One review's worktree: `/task/.factory/reviews/<review root id>`, or null when it has no place on the volume. */
export function reviewWorktreeDir(review: BoardJob): string | null {
    const root = review.rootJobId ?? review.id;
    return UUID.test(root) ? `${REVIEW_ROOTS_DIR}/${root}` : null;
}

/**
 * The branch the task worktree runs on: `factory/<thread root id>`. Created at
 * `origin/<default>` on the first sync; rebased onto it on every later one. A branch per thread,
 * never per attempt — a re-claimed attempt continues the same branch its predecessor edited.
 */
export function worktreeBranch(job: BoardJob): string {
    return `factory/${job.rootJobId ?? job.id}`;
}

/** Pulls the probe's answer out of its stdout, tolerating anything else. */
export function parseGitState(stdout: string): GitState {
    const p = parseLastJsonLine<Partial<GitState> | null>(stdout, () => null);
    if (p === null) {
        return {
            cloned: false,
            branch: '',
            defaultBranch: 'main',
            dirty: false,
            unpushed: 0,
            hasIdentity: false,
            fingerprint: null,
            conflicts: [],
            rebasing: false,
        };
    }
    return {
        cloned: p.cloned === true,
        branch: typeof p.branch === 'string' ? p.branch : '',
        defaultBranch: typeof p.defaultBranch === 'string' && p.defaultBranch ? p.defaultBranch : 'main',
        dirty: p.dirty === true,
        unpushed: typeof p.unpushed === 'number' && Number.isFinite(p.unpushed) && p.unpushed >= 0 ? p.unpushed : 0,
        hasIdentity: p.hasIdentity === true,
        fingerprint: typeof p.fingerprint === 'string' && p.fingerprint ? p.fingerprint : null,
        conflicts: Array.isArray(p.conflicts) ? p.conflicts.filter((c) => typeof c === 'string') : [],
        rebasing: p.rebasing === true,
    };
}

/**
 * One publish step, as the platform-agnostic workflow hands it to a platform transport. The
 * decisions the two executors must never let drift — branch reuse, the fallback identity,
 * `--force-with-lease`, PR reuse — live in `publishCheckout` below; this is only WHAT to run,
 * and the transport decides where a container running it comes from (`docker run --rm` with a
 * swapped entrypoint on one platform, a batch Job whose `command` is the same argv on the other).
 */
export interface PublishStep {
    /** The step's name in failure messages — "git push", the tool's own words. */
    label: string;
    /** The executable the container runs: docker's `--entrypoint`, the k8s command head. */
    entrypoint: 'git' | 'gh' | 'node';
    /** The full argv after the entrypoint, exactly what the docker runner passes after the image. */
    args: string[];
    /** Whether the step needs the claim env — the token the push and the PR calls read. */
    env: boolean;
    /** Literal env values, always paths or code and never credentials: the `REPO` the probe reads. */
    envLiterals?: Record<string, string>;
    /** Whether the step runs inside the task worktree (a working directory). */
    inRepo: boolean;
    /**
     * The publication operation (`<branch>@<commit sha>`) a step with a remote effect belongs to.
     * The transport derives the step's identity from it, so the same step asked twice — a retry
     * after a lost answer — is answered from the supervisor's ledger and never runs twice.
     */
    op?: string;
}

/**
 * Runs one publish step and answers its stdout. Rejects on a nonzero exit with the tool's own
 * output — the same extraction the docker runner performs on execFile's stderr — because the
 * workflow wraps it with the step's name, and a failure must name its step and carry the one
 * line a human can act on ("remote: Permission to ..." lives in git's stderr).
 */
export type RunPublishStep = (step: PublishStep) => Promise<{ stdout: string }>;

/** The step wrapper's error-message cap — a stray tool trace must not blow out the failure reason. */
const STEP_ERROR_MAX_CHARS = 300;
/** The final failure reason's cap — reported to the board, not a log; kept to one glance. */
const PUBLISH_FAILURE_MAX_CHARS = 400;
/**
 * Stages the whole tree except the `.factory/` state namespace, in two steps. The sync's
 * `info/exclude` keeps it untracked, so the add never picks up a new state file; the reset then
 * unstages a copy an older commit already tracks. Not one `add` with an exclude pathspec: a
 * pathspec naming an ignored path makes `git add` exit 1 even after it staged the rest.
 * git-probe.cjs spells the same exclusion, so a tree dirty only there reads clean.
 */
export const GIT_STAGE_STEPS: readonly (readonly string[])[] = [
    ['add', '-A', '--', ':/'],
    ['reset', '-q', '--', '.factory'],
];

/**
 * The read-only probe step over one checkout — the publish's first step, and the post-gate tree
 * read. The claim's base rides as BASE_BRANCH, the branch the probe compares against; probeCheckout
 * pins it as the state's base, so the PR summary, the PR and the recorded base all follow it.
 */
const probeStep = (repo: string, base: string | null = null): PublishStep => ({
    label: 'probe',
    entrypoint: 'node',
    args: ['-e', gitProbeScript],
    env: false,
    envLiterals: { REPO: repo, ...(base ? { BASE_BRANCH: base } : {}) },
    inRepo: false,
});

/**
 * Probes the checkout. A probe that cannot run reads as no state at all — the caller's
 * no-op-with-reason path, never a crash.
 */
async function probeCheckout(runStep: RunPublishStep, repo: string, base: string | null): Promise<GitState> {
    const probe = await runStep(probeStep(repo, base)).catch(() => null);
    return { ...parseGitState(probe?.stdout ?? ''), ...(base ? { defaultBranch: base } : {}) };
}

/**
 * The task tree's fingerprint now, over either executor's transport — the after-half of the
 * no-progress read whose before-half is the sync's `SyncResult.fingerprint`. Null when the job has
 * no worktree, or the probe failed or answered none: unknown, never a guess.
 */
export async function probeTreeFingerprint(job: BoardJob, runStep: RunPublishStep): Promise<string | null> {
    const repo = checkoutDir(job);
    if (!repo) return null;
    const probe = await runStep(probeStep(repo)).catch(() => null);
    const fingerprint = parseLastJsonLine<{ fingerprint?: unknown }>(probe?.stdout ?? '', () => ({})).fingerprint;
    return typeof fingerprint === 'string' && fingerprint ? fingerprint : null;
}

/**
 * Resolves the branch to publish on, switching (or creating) it when the checkout is still on
 * the default branch. A task never lands on the default branch, and an existing task branch is
 * reused — `switch -c` only when the branch is not there yet, so earlier attempts' commits
 * survive. `switched`: a switch ran, and with it the repository's post-checkout hook.
 */
async function ensureTaskBranch(
    runStep: RunPublishStep,
    step: RunPublishStep,
    state: GitState,
    plan: PublishPlan
): Promise<{ branch: string; switched: boolean }> {
    const onDefault = !state.branch || state.branch === state.defaultBranch;
    const branch = onDefault ? plan.branch : state.branch;
    if (!isBranchName(branch)) {
        throw new Error(`refusing to publish a branch named "${branch}"`);
    }
    if (onDefault) {
        const switched = await runStep({
            label: 'git switch',
            entrypoint: 'git',
            args: ['switch', branch],
            env: false,
            inRepo: true,
        }).catch(() => null);
        if (!switched) {
            await step({
                label: 'git switch',
                entrypoint: 'git',
                args: ['switch', '-c', branch],
                env: false,
                inRepo: true,
            });
        }
    }
    return { branch, switched: onDefault };
}

/** Runs a git step that answers one line: an object name. */
const gitRead = async (step: RunPublishStep, label: string, args: string[]): Promise<string> =>
    (await step({ label, entrypoint: 'git', args, env: false, inRepo: true })).stdout.trim();

/**
 * Stages and commits the checkout's dirty tree. The checkout usually has no committer identity
 * (the agent does not need one to edit); a fallback is applied only when the probe found none,
 * so a member-configured identity is never overridden. A `bound` publish (issue #825) stages
 * hook-free — `post-index-change` is the one hook an index write fires — so the staged tree is the
 * verified content, and answers whether the commit, its own hooks run, still holds exactly that
 * tree; an unbound one answers true.
 */
async function commitDirtyTree(step: RunPublishStep, state: GitState, title: string, bound: boolean): Promise<boolean> {
    const hookless = bound ? ['-c', 'core.hooksPath=/dev/null'] : [];
    for (const args of GIT_STAGE_STEPS) {
        await step({
            label: `git ${args[0]}`,
            entrypoint: 'git',
            args: [...hookless, ...args],
            env: false,
            inRepo: true,
        });
    }
    const staged = bound ? await gitRead(step, 'git write-tree', [...hookless, 'write-tree']) : null;
    const identity = state.hasIdentity
        ? []
        : ['-c', 'user.name=factory-ai', '-c', 'user.email=factory-ai@users.noreply.github.com'];
    await step({
        label: 'git commit',
        entrypoint: 'git',
        args: [...identity, 'commit', '-m', title],
        env: false,
        inRepo: true,
    });
    if (staged === null) return true;
    return staged !== '' && staged === (await gitRead(step, 'git rev-parse HEAD^{tree}', ['rev-parse', 'HEAD^{tree}']));
}

/**
 * Puts the work on its task branch and commits it. A bound publish (`revision`) ships only the
 * content its evidence assessed (issue #825): the switch's and the commit's hooks run, and one that
 * moved the content answers null — refused like any other move — never a branch to push.
 */
async function branchAndCommit(
    runStep: RunPublishStep,
    step: RunPublishStep,
    work: { job: BoardJob; repo: string; state: GitState; plan: PublishPlan; revision: string | undefined }
): Promise<string | null> {
    const { job, repo, state, plan, revision } = work;
    const { branch, switched } = await ensureTaskBranch(runStep, step, state, plan);
    if (revision !== undefined && switched) {
        const after = await probeCheckout(runStep, repo, baseBranchOf(job));
        if (after.fingerprint !== revision) return null;
    }
    if (state.dirty && !(await commitDirtyTree(step, state, plan.title, revision !== undefined))) return null;
    return branch;
}

/**
 * The publish workflow both executors run: probe the checkout, branch, commit, push, open (or
 * reuse) the PR — every decision that must not drift between platforms, over an injected
 * transport. The docker runner's transport is one `docker run` per step; the kubernetes
 * runner's is one aux Job per step. Same steps, same order, same failure messages, so a
 * publish that fails reads identically wherever it ran.
 */
export async function publishCheckout(
    job: BoardJob,
    options: PublishOptions | undefined,
    runStep: RunPublishStep
): Promise<PublishResult> {
    const repo = checkoutDir(job);
    // Null here means a COMMAND-ONLY job — the loop refuses a repo job whose worktree cannot
    // resolve before anything runs — and a command-only job has nothing to publish by
    // construction. That is the ordinary no-op, not a failure: reporting it as publishFailed
    // failed every exit-0 command-only run, the main phase of the e2e suite included.
    if (!repo) return publishNothing('the job names no checkout — nothing to publish');

    /** Wraps the transport's rejection with the step's name — docker's own runStep shape. */
    const step = async (publish: PublishStep): Promise<{ stdout: string }> => {
        try {
            return await runStep(publish);
        } catch (e) {
            // A lost supervisor keeps its class: it is the attempt's interruption, not a step's failure (#925).
            if (stepLost(e)) throw e;
            throw new Error(`${publish.label}: ${(e as Error).message.slice(0, STEP_ERROR_MAX_CHARS)}`);
        }
    };

    try {
        const plan = publishPlan(job);

        // What is there to publish? A checkout that was never cloned and a clean, fully-pushed
        // tree are the two ordinary no-ops; everything else flows.
        const state = await probeCheckout(runStep, repo, baseBranchOf(job));
        if (!state.cloned) return publishNothing('the checkout has not been cloned yet');
        if (state.conflicts.length > 0 || state.rebasing) {
            return publishFailed(unresolvedConflictReason(state), 'conflict');
        }
        const revision = options?.revision;
        if (revision !== undefined && state.fingerprint !== revision) return staleRefusal(STALE_REVISION_REASON);
        const draft = options?.draft === true;
        if (!state.dirty && state.unpushed === 0) {
            return (
                (await reconcileAgentPr(runStep, step, job, state)) ??
                (await resumePublication(runStep, step, { job, repo, state, plan, draft })) ??
                publishNothing('no uncommitted changes and nothing unpushed')
            );
        }

        const branch = await branchAndCommit(runStep, step, { job, repo, state, plan, revision });
        if (branch === null) return staleRefusal(PUBLISH_MOVED_REASON);

        // The operation is the branch at the exact commit it pushes: recorded before the push and
        // after each effect, so a retry reads what a lost attempt did instead of repeating it.
        const sha = await headSha(runStep);
        if (sha === null) throw new Error('git rev-parse HEAD: the checkout has no readable HEAD');
        const op = publicationOp(branch, sha);
        await pushRecorded(runStep, step, { repo, branch, op, sha });

        // Reuse the branch's PR when one exists, or open one — see resolveOrCreatePr.
        const prUrl = await resolveOrCreatePr(runStep, step, { job, branch, plan, state, draft, op });
        await recordOperation(step, repo, op, { state: 'opened', ...(prUrl ? { prUrl } : {}) });

        return publishedResult(job, branch, state.defaultBranch, prUrl);
    } catch (e) {
        if (stepLost(e)) throw e;
        const message = `${(e as Error).message}`;
        return publishFailed(message.slice(0, PUBLISH_FAILURE_MAX_CHARS), publishCauseOf(message));
    }
}
