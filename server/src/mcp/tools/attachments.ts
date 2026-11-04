import { MAX_FILE_BYTES } from '@factory-ai/core';
import { z } from 'zod';
import { refusal } from '../result.js';
import { defineTool, WRITES } from '../tool.js';
import { MAX_NAME_CHARS } from './paging.js';

const MAX_MEDIA_TYPES = 8;

const UploadSchema = z.object({
    id: z.string(),
    state: z.enum(['open', 'completed', 'expired', 'removed']),
    expiresAt: z.string(),
    maxBytes: z.number().int(),
    mediaTypes: z.array(z.string()),
    attachmentId: z.string().nullable(),
    uploadUrl: z.string().optional(),
    pageUrl: z.string().optional(),
    attachment: z
        .object({
            id: z.string(),
            name: z.string(),
            mediaType: z.string(),
            size: z.number().int(),
            sha256: z.string(),
            state: z.string(),
        })
        .nullable()
        .optional(),
});

const summaryOf = (data: z.infer<typeof UploadSchema>): string => {
    if (data.uploadUrl !== undefined) {
        return `Upload ${data.id} is open until ${data.expiresAt} (at most ${data.maxBytes} bytes, one file). PUT the raw file to ${data.uploadUrl} (headers: Content-Type: application/octet-stream, X-Attachment-Name: the percent-encoded file name), or open ${data.pageUrl} in a browser. Then call this tool again with uploadId ${data.id}.`;
    }
    return data.attachmentId
        ? `Upload ${data.id} is ${data.state}: attachment ${data.attachmentId}`
        : `Upload ${data.id} is ${data.state}`;
};

/** The one place the board hands a file to a client that cannot put bytes through MCP: no base64, no local path, no URL fetch. */
export const createAttachmentUpload = defineTool({
    name: 'create_attachment_upload',
    description:
        'Attach a file (screenshot, PDF, DOCX, text, CSV) to a task or follow-up. The board cannot read your local files and no file bytes go through this tool. Call it once per file, with no arguments, to get a single-use upload link that expires in minutes: `uploadUrl` takes one HTTP PUT of the raw file (Content-Type: application/octet-stream, X-Attachment-Name: the percent-encoded file name; for example with curl --upload-file from a shell), `pageUrl` is a browser page where a person picks the file. The link is a secret bound to you: give it only to the tool or person that uploads. Then call this tool again with `uploadId` (the `id` you were given) to read its state; when it is `completed`, pass `attachmentId` in `attachmentIds` of create_task or follow_up_task. A retry of the same PUT with the same bytes returns the same attachmentId; other bytes are refused. `maxBytes` and `mediaTypes` can only narrow the board limits. A local path or a URL is never read or fetched.',
    scope: 'factory:write',
    routes: [
        ['POST', '/api/attachments/upload-requests'],
        ['GET', '/api/attachments/upload-requests/:id'],
    ],
    annotations: WRITES,
    input: z
        .object({
            uploadId: z
                .uuid()
                .optional()
                .describe(
                    'The `id` of an upload you asked for earlier: read its state instead of asking for a new link.'
                ),
            maxBytes: z
                .number()
                .int()
                .min(1)
                .max(MAX_FILE_BYTES)
                .optional()
                .describe(`A smaller size limit than the board's ${MAX_FILE_BYTES} bytes.`),
            mediaTypes: z
                .array(z.string().max(MAX_NAME_CHARS))
                .min(1)
                .max(MAX_MEDIA_TYPES)
                .optional()
                .describe('Only these media types, such as image/png; default every type the board accepts.'),
        })
        .strict(),
    output: UploadSchema,
    async run({ uploadId, maxBytes, mediaTypes }, ctx) {
        if (uploadId !== undefined) {
            if (maxBytes !== undefined || mediaTypes !== undefined) {
                return {
                    outcome: 'refused',
                    result: refusal(
                        'bad_arguments',
                        'uploadId reads an upload; maxBytes and mediaTypes ask for a new one'
                    ),
                };
            }
            return ctx.call(
                { method: 'GET', url: `/api/attachments/upload-requests/${uploadId}` },
                UploadSchema,
                summaryOf
            );
        }
        const body = {
            ...(maxBytes === undefined ? {} : { maxBytes }),
            ...(mediaTypes === undefined ? {} : { mediaTypes }),
        };
        return ctx.call({ method: 'POST', url: '/api/attachments/upload-requests', body }, UploadSchema, summaryOf);
    },
});
