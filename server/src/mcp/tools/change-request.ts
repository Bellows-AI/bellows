import { z } from 'zod';
import { CHANGE_REQUEST_PARTS } from '../../forge/change-request-read.js';
import { defineTool, READ_ONLY } from '../tool.js';
import { TaskIdInput } from './task-detail.js';
import { jobPath } from './runs.js';

const FileSchema = z.object({
    oldPath: z.string(),
    newPath: z.string(),
    newFile: z.boolean(),
    deletedFile: z.boolean(),
    renamedFile: z.boolean(),
    omitted: z.boolean().describe("True when GitLab withheld this file's diff (too large): the text is empty."),
    diff: z.string(),
});
const NoteSchema = z.object({
    id: z.number().int(),
    author: z.string().nullable(),
    body: z.string(),
    createdAt: z.string(),
    system: z.boolean(),
});
const StatusSchema = z.object({ name: z.string(), status: z.string(), url: z.string().nullable() });

/** The board's answer: the whole part. The member of the union a part fills is the only one present. */
const ChangeRequestRead = z.object({
    part: z.enum(CHANGE_REQUEST_PARTS),
    number: z.number().int(),
    url: z.string(),
    files: z.array(FileSchema).optional(),
    notes: z.array(NoteSchema).optional(),
    sha: z.string().optional(),
    pipeline: z.object({ status: z.string(), url: z.string().nullable() }).nullable().optional(),
    statuses: z.array(StatusSchema).optional(),
});

const summaryOf = (read: z.output<typeof ChangeRequestRead>): string => {
    const subject = `Merge request !${read.number}`;
    if (read.part === 'diff') return `${subject}: ${read.files?.length ?? 0} changed files`;
    if (read.part === 'notes') return `${subject}: ${read.notes?.length ?? 0} notes, oldest first`;
    return `${subject}: pipeline ${read.pipeline?.status ?? 'none'}, ${read.statuses?.length ?? 0} commit statuses`;
};

export const readChangeRequest = defineTool({
    name: 'read_change_request',
    description:
        "Read the merge request a GitLab task published, one `part` at a time: `diff` (every changed file with its diff), `notes` (oldest first) or `pipeline` (the head pipeline and the head commit's statuses). It is read with the task starter's own GitLab access and only ever the task's own recorded merge request. A part is the whole answer or an error, never a shorter list: an unconfirmed read (GitLab down, a page too large) is inconclusive, a missing or broken GitLab link is a FORGE_GRANT_REQUIRED refusal naming the page to reconnect, a task with no merge request yet is NO_CHANGE_REQUEST, and a GitHub task is CHANGE_REQUEST_READ_UNSUPPORTED (use gh for its pull request).",
    scope: 'factory:read',
    routes: [['GET', '/api/jobs/:id/change-request']],
    annotations: READ_ONLY,
    input: TaskIdInput.extend({ part: z.enum(CHANGE_REQUEST_PARTS).describe('Which part to read.') }).strict(),
    output: ChangeRequestRead,
    run: ({ taskId, part }, ctx) =>
        ctx.call(
            { method: 'GET', url: `${jobPath(taskId)}/change-request?part=${part}` },
            ChangeRequestRead,
            summaryOf
        ),
});
