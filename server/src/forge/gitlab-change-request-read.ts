import { READ_TRANSPORT } from '@factory-ai/core';
import { GitHubReadError } from '../github/pr-read.js';
import { GitHubWriteError } from '../github/pr-write.js';
import type {
    ChangeRequestFile,
    ChangeRequestNote,
    ChangeRequestPart,
    ChangeRequestPartRead,
    ChangeRequestStatus,
} from './change-request-read.js';

/**
 * The reads of one GitLab merge request (docs/gitlab.md): diff, notes, pipeline, page by page. A part is the whole
 * answer or a rejection: a page that is not a clean page, a non-2xx, a page count or a diff size past its cap reject,
 * and none answers a shorter list. The caller's `get` is one bounded request answering the parsed JSON of a 2xx.
 */

type Get = (path: string, signal: AbortSignal) => Promise<unknown>;

const PAGE_SIZE = 100;
/** Pages read before the list is called too long: an endless or runaway listing is no answer. */
export const MAX_PAGES = 20;
const BYTES_PER_KIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
/** The most diff text one read carries; past it the read rejects rather than cutting a file short. */
export const DIFF_BYTE_CAP = 2 * BYTES_PER_MIB;

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const unclean = (what: string) => new GitHubReadError(`${what}: not a clean answer`, READ_TRANSPORT);
const capped = (what: string, cap: string) => new GitHubReadError(`${what}: past the ${cap} cap`, READ_TRANSPORT);

const text = (value: unknown): value is string => typeof value === 'string';
const flag = (value: unknown): boolean => value === true;

function fileOf(entry: unknown): ChangeRequestFile | null {
    if (!isObject(entry)) return null;
    const { old_path: oldPath, new_path: newPath, diff } = entry;
    if (!text(oldPath) || !text(newPath) || !text(diff)) return null;
    return {
        oldPath,
        newPath,
        newFile: flag(entry.new_file),
        deletedFile: flag(entry.deleted_file),
        renamedFile: flag(entry.renamed_file),
        omitted: flag(entry.too_large) || flag(entry.collapsed),
        diff,
    };
}

function noteOf(entry: unknown): ChangeRequestNote | null {
    if (!isObject(entry)) return null;
    const { id, body, created_at: createdAt, author } = entry;
    if (!Number.isInteger(id) || !text(body) || !text(createdAt)) return null;
    const username = isObject(author) && text(author.username) ? author.username : null;
    return { id: id as number, author: username, body, createdAt, system: flag(entry.system) };
}

function statusOf(entry: unknown): ChangeRequestStatus | null {
    if (!isObject(entry)) return null;
    const { name, status, target_url: url } = entry;
    return text(name) && text(status) ? { name, status, url: text(url) ? url : null } : null;
}

/** Every entry of a paged listing, read until an empty page: a short page proves nothing when the forge caps `per_page`. */
async function listed<T>(
    get: Get,
    path: string,
    parse: (entry: unknown) => T | null,
    signal: AbortSignal
): Promise<T[]> {
    const out: T[] = [];
    const joiner = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= MAX_PAGES; page += 1) {
        const answer = await get(`${path}${joiner}per_page=${PAGE_SIZE}&page=${page}`, signal);
        if (!Array.isArray(answer)) throw unclean(path);
        if (answer.length === 0) return out;
        const entries = answer.map(parse);
        if (entries.some((entry) => entry === null)) throw unclean(path);
        out.push(...(entries as T[]));
    }
    throw capped(path, 'page');
}

async function diffOf(get: Get, base: string, signal: AbortSignal): Promise<ChangeRequestPartRead> {
    const files = await listed(get, `${base}/diffs`, fileOf, signal);
    const size = files.reduce((total, file) => total + Buffer.byteLength(file.diff), 0);
    if (size > DIFF_BYTE_CAP) throw capped(`${base}/diffs`, 'byte');
    return { part: 'diff', files };
}

async function notesOf(get: Get, base: string, signal: AbortSignal): Promise<ChangeRequestPartRead> {
    const notes = await listed(get, `${base}/notes?sort=asc&order_by=created_at`, noteOf, signal);
    return { part: 'notes', notes: notes.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id) };
}

async function pipelineOf(
    get: Get,
    { base, project }: { base: string; project: string },
    signal: AbortSignal
): Promise<ChangeRequestPartRead> {
    const mr = await get(base, signal);
    if (!isObject(mr) || !text(mr.sha) || (mr.head_pipeline !== null && !isObject(mr.head_pipeline))) {
        throw unclean(base);
    }
    const head = mr.head_pipeline;
    if (head !== null && (!text(head.status) || (head.web_url !== undefined && !text(head.web_url)))) {
        throw unclean(base);
    }
    const statuses = await listed(get, `${project}/repository/commits/${mr.sha}/statuses`, statusOf, signal);
    return {
        part: 'pipeline',
        sha: mr.sha,
        pipeline: head === null ? null : { status: head.status as string, url: (head.web_url as string) ?? null },
        statuses,
    };
}

/** A write-classified failure of one request, as the read's own rejection: a read never answers a verdict. */
export const asRead =
    (call: (method: 'GET', path: string, signal: AbortSignal) => Promise<unknown>): Get =>
    (path, signal) =>
        call('GET', path, signal).catch((e: unknown) => {
            if (!(e instanceof GitHubWriteError)) throw e;
            throw new GitHubReadError(e.message, READ_TRANSPORT);
        });

export function readMergeRequestPart(
    get: Get,
    { project, number }: { project: string; number: number },
    part: ChangeRequestPart,
    signal: AbortSignal
): Promise<ChangeRequestPartRead> {
    const base = `${project}/merge_requests/${number}`;
    if (part === 'diff') return diffOf(get, base, signal);
    if (part === 'notes') return notesOf(get, base, signal);
    return pipelineOf(get, { base, project }, signal);
}
