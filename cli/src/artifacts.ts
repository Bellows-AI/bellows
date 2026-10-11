import { parseArgs } from 'node:util';
import { HTTP_OK } from './board.js';
import type { ArtifactKind, ArtifactPage, BoardClient } from './board.js';
import { parseOrUsage, UsageError } from './input.js';
import { OUTCOME } from './outcome.js';
import type { CommandResult } from './outcome.js';
import { renderActivity, renderPageNote } from './render.js';
import { BoardError, MALFORMED_RESPONSE_CODE } from './transport.js';

/**
 * The complete retrieval of one stored artifact: every page in order, or a failure — never a
 * partial artifact presented as whole. The attempt is pinned to the first page's, so a newer
 * attempt landing mid-read cannot splice two runs together, and the total must hold still.
 */

export interface ArtifactTarget {
    id: string;
    kind: ArtifactKind;
    /** The attempt to read; absent reads the newest and pins it from the first page. */
    attempt?: number | undefined;
    /** The page size in characters; absent takes the board's default. */
    limit?: number | undefined;
}

export interface WholeArtifact {
    jobId: string;
    kind: ArtifactKind;
    attempt: number;
    /** The driver's own cap at upload: the stored artifact is itself incomplete. */
    truncated: boolean;
    totalCharacters: number;
    pages: number;
    content: string;
}

const JSON_OPTION = { json: { type: 'boolean', default: false } } as const;
const PAGING_OPTIONS = {
    attempt: { type: 'string' },
    offset: { type: 'string' },
    limit: { type: 'string' },
    all: { type: 'boolean', default: false },
} as const;

/** A non-negative (or, with `min` 1, positive) integer flag, refused as usage before any request. */
function parseCount(raw: string | undefined, flag: string, min: number): number | undefined {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min) {
        throw new UsageError(`${flag} must be an integer >= ${min}, got "${raw}"`);
    }
    return value;
}

/** The command line of a job-scoped read: exactly one job id and the flags the command takes. */
function parseJobArgs(args: readonly string[], verb: string, paged: boolean, usage: string) {
    const options = paged ? { ...JSON_OPTION, ...PAGING_OPTIONS } : JSON_OPTION;
    const parsed = parseOrUsage(() => parseArgs({ args: [...args], allowPositionals: true, options }));
    if (parsed.positionals.length !== 1) throw new UsageError(`${verb} needs exactly one job id\n\n${usage}`);
    const values = parsed.values as { attempt?: string; offset?: string; limit?: string; all?: boolean };
    return { id: parsed.positionals[0]!, values };
}

/** `job activity <id>`. */
export async function activityCommand(args: readonly string[], client: BoardClient, usage: string) {
    const { id } = parseJobArgs(args, 'activity', false, usage);
    const activity = await client.activity(id);
    return { outcome: OUTCOME.ok, data: activity, stdout: `${renderActivity(activity)}\n` };
}

/** `job log` / `job transcript`: one page by default, the whole artifact with `--all`. */
export async function artifactCommand(
    kind: ArtifactKind,
    args: readonly string[],
    client: BoardClient,
    usage: string
): Promise<CommandResult> {
    const { id, values: flags } = parseJobArgs(args, kind, true, usage);
    const attempt = parseCount(flags.attempt, '--attempt', 1);
    const offset = parseCount(flags.offset, '--offset', 0);
    const limit = parseCount(flags.limit, '--limit', 1);
    if (flags.all) {
        if (offset !== undefined) throw new UsageError('--all reads from the start; drop --offset');
        const whole = await readWholeArtifact(client, { id, kind, attempt, limit });
        const cut = `${kind} attempt ${whole.attempt}: the stored artifact was itself truncated at upload\n`;
        return { outcome: OUTCOME.ok, data: whole, stdout: whole.content, stderr: whole.truncated ? cut : '' };
    }
    const page = await client.artifactPage(id, kind, { attempt, offset, limit });
    const next = page.offset + page.content.length;
    return {
        outcome: OUTCOME.ok,
        data: { ...page, nextOffset: next < page.totalCharacters ? next : null },
        stdout: page.content,
        stderr: renderPageNote(page),
    };
}

const malformed = (message: string) => new BoardError(message, HTTP_OK, MALFORMED_RESPONSE_CODE);

/** A page failure past the first says how far the read got; the first page's failure is plain. */
function laterPageFailure(error: unknown, target: ArtifactTarget, offset: number, total: number): unknown {
    if (!(error instanceof BoardError)) return error;
    return new BoardError(
        `${error.message} (the ${target.kind} page at offset ${offset} failed after ${offset} of ${total} characters were read; no partial artifact is printed)`,
        error.status,
        error.code
    );
}

/** What a page must agree with the pages before it on, else the artifact moved under the read. */
function checkStable(page: ArtifactPage, target: ArtifactTarget, pinned: number | undefined, total: number | null) {
    const moved =
        (total !== null && page.totalCharacters !== total) || (pinned !== undefined && page.attempt !== pinned);
    if (moved) throw malformed(`the ${target.kind} changed while it was being read (offset ${page.offset})`);
}

export async function readWholeArtifact(client: BoardClient, target: ArtifactTarget): Promise<WholeArtifact> {
    const chunks: string[] = [];
    let pinned = target.attempt;
    let total = 0;
    let offset = 0;
    let truncated = false;
    do {
        let page: ArtifactPage;
        try {
            page = await client.artifactPage(target.id, target.kind, { attempt: pinned, offset, limit: target.limit });
        } catch (error) {
            throw chunks.length === 0 ? error : laterPageFailure(error, target, offset, total);
        }
        checkStable(page, target, pinned, chunks.length === 0 ? null : total);
        if (page.content.length === 0 && page.totalCharacters > offset) {
            throw malformed(
                `the board answered an empty ${target.kind} page at offset ${offset} of ${page.totalCharacters}`
            );
        }
        pinned = page.attempt;
        total = page.totalCharacters;
        truncated = page.truncated;
        chunks.push(page.content);
        offset += page.content.length;
    } while (offset < total);
    return {
        jobId: target.id,
        kind: target.kind,
        attempt: pinned ?? 0,
        truncated,
        totalCharacters: total,
        pages: chunks.length,
        content: chunks.join(''),
    };
}
