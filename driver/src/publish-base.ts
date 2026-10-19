import type { BoardJob } from './board.js';
import { containerScript as script } from './container-scripts.js';

/**
 * The values of the publish workflow that stand alone — the PR summary's script and parse, the
 * branch-name check, the claim's base branch and the push's credential helper — below both
 * `publish.ts` (which re-exports them) and `publish-pr.ts`, so neither imports the other's values.
 */

/** The PR summary's node script: see scripts/pr-summary.cjs. */
export const prSummaryScript = script('pr-summary.cjs');
/** The PR number a url names, or null when it does not point at a pull request. */
export const prNumberFromUrl = (url: string): number | null => {
    const match = /\/pull\/(\d+)\/?$/.exec(url.trim());
    if (!match) return null;
    const number = Number(match[1]);
    return Number.isSafeInteger(number) && number > 0 ? number : null;
};
/**
 * The branch the claim bases its checkout and PR on, or null for the remote default: a value no
 * git branch can have is dropped here, before it becomes a sync env literal or a `gh --base`.
 */
export function baseBranchOf(job: BoardJob): string | null {
    return typeof job.baseBranch === 'string' && isBranchName(job.baseBranch) ? job.baseBranch : null;
}
/** What the PR summary script answered — either half is optional; nulls mean "fall back". */
export interface PrSummary {
    title: string | null;
    body: string | null;
}

/** Pulls the PR summary's answer out of its stdout, tolerating anything else. */
export function parsePrSummary(stdout: string): PrSummary {
    const line = stdout.trim().split('\n').filter(Boolean).pop() ?? '';
    try {
        const p = JSON.parse(line) as Partial<PrSummary>;
        return {
            title: typeof p.title === 'string' && p.title ? p.title : null,
            body: typeof p.body === 'string' && p.body ? p.body : null,
        };
    } catch {
        return { title: null, body: null };
    }
}
/**
 * A branch name is about to become a `-w` path-adjacent argv value and a `gh --head` value. The
 * probe's names come from the checkout itself; the plan's are built here. Either way, assert the
 * shape a git branch can have before anything interpolates it.
 */
export const isBranchName = (name: string): boolean =>
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name) && !name.includes('..');
/**
 * The push credential travels as an env-file value and is read by a git credential helper that
 * git itself spawns through a shell — the same `-e NAME`, never `-e NAME=value` rule the runner
 * obeys, so the token is in no argv anywhere. Pinned because it is the one place this feature
 * touches a secret.
 *
 * The helper is a FILE (scripts/credential-helper.sh) whose content becomes the value of
 * `-c credential.helper=`, so that one file carries no comments — its documentation lives here.
 * The leading `!` is git's own marker (gitcredentials(7)): a bang-prefixed helper value is a
 * shell SNIPPET — git strips the bang and spawns `sh -c '<snippet> <op>'`; without it git
 * prefixes `git credential-` to the whole string and the code never runs. Git appends the
 * operation to the value VERBATIM, so the constant is the file TRIMMED: the file keeps its
 * POSIX trailing newline, but in the value that newline strands ` get` on a second line and
 * the helper exits 127 after answering — git only happens to keep a dead helper's stdout
 * (a dead helper's stdout: `get: 2: get: not found` in the publish container).
 * The scripts suite pins the exact spawn shape and its exit status.
 */
export const CREDENTIAL_HELPER = script('credential-helper.sh').trim();
