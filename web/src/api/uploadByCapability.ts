import { ATTACHMENT_NAME_HEADER, CONTENT_TYPE_HEADER, OCTET_STREAM_CONTENT_TYPE } from '@factory-ai/core';

/** The attachment the board stored; the rest of its metadata is the agent's to read. */
export interface UploadedAttachment {
    id: string;
    name: string;
    size: number;
}

/**
 * `retry` keeps the picked file for another attempt (the link is still open); `pick` asks for a different file
 * (the link is open, this file was refused); `final` means the link can take nothing more.
 */
export type UploadOutcome =
    | { ok: true; attachment: UploadedAttachment }
    | { ok: false; next: 'retry' | 'pick' | 'final'; message: string };

const HTTP_CREATED = 201;

const NETWORK_FAILURE: UploadOutcome = {
    ok: false,
    next: 'retry',
    message: 'The upload did not finish, so the file was not confirmed stored. Check your connection and try again.',
};

/** Every code docs/mcp.md lists for the upload route, said plainly. Unknown codes fall back to the status. */
const REFUSALS: Record<string, { next: 'retry' | 'pick' | 'final'; message: string }> = {
    UPLOAD_CAPABILITY_INVALID: {
        next: 'final',
        message: 'This upload link is not valid. It may have been revoked. Ask your app for a new link.',
    },
    UPLOAD_CAPABILITY_EXPIRED: {
        next: 'final',
        message: 'This upload link has expired. Ask your app for a new link.',
    },
    UPLOAD_CAPABILITY_SPENT: {
        next: 'final',
        message: 'This upload link was already used for another file. Ask your app for a new link.',
    },
    ATTACHMENT_TOO_LARGE: {
        next: 'pick',
        message: 'That file is larger than this link allows. Choose a smaller file.',
    },
    ATTACHMENT_UNSUPPORTED: {
        next: 'pick',
        message: 'This link does not accept that type of file. Choose a different file.',
    },
    BAD_ATTACHMENT: {
        next: 'pick',
        message: 'That file is empty or could not be read. Choose a different file.',
    },
    ATTACHMENTS_UNAVAILABLE: {
        next: 'retry',
        message: 'The board cannot take uploads right now. Wait a moment and try again; the link is still good.',
    },
};

function outcomeOf(status: number, text: string): UploadOutcome {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        body = null;
    }
    if (
        status === HTTP_CREATED &&
        typeof body === 'object' &&
        body !== null &&
        'id' in body &&
        typeof body.id === 'string'
    ) {
        const meta = body as { id: string; name?: unknown; size?: unknown };
        return {
            ok: true,
            attachment: {
                id: meta.id,
                name: typeof meta.name === 'string' ? meta.name : '',
                size: typeof meta.size === 'number' ? meta.size : 0,
            },
        };
    }
    const code = typeof body === 'object' && body !== null && 'code' in body ? String(body.code) : '';
    const known = REFUSALS[code];
    if (known) return { ok: false, ...known };
    return { ok: false, next: 'retry', message: `The board refused the upload (HTTP ${status}). Try again.` };
}

/**
 * PUT of one file to the single-use link. `XMLHttpRequest` rather than `fetch` because only it reports upload
 * progress. No cookie and no credentials: the capability in the path is the whole credential (docs/mcp.md), and a
 * network failure or abort is "not confirmed", never success.
 */
export function uploadByCapability(
    capability: string,
    file: File,
    onProgress: (sent: number, total: number) => void
): Promise<UploadOutcome> {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('PUT', `/api/attachments/uploads/${encodeURIComponent(capability)}`);
        xhr.withCredentials = false;
        xhr.setRequestHeader(CONTENT_TYPE_HEADER, OCTET_STREAM_CONTENT_TYPE);
        xhr.setRequestHeader(ATTACHMENT_NAME_HEADER, encodeURIComponent(file.name));
        xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) onProgress(e.loaded, e.total);
        };
        xhr.onload = () => resolve(outcomeOf(xhr.status, xhr.responseText));
        xhr.onerror = () => resolve(NETWORK_FAILURE);
        xhr.onabort = () => resolve(NETWORK_FAILURE);
        xhr.ontimeout = () => resolve(NETWORK_FAILURE);
        xhr.send(file);
    });
}
