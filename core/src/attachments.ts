/**
 * Task attachments: the accepted formats, the limits and the wire shape. The board serves the
 * limits at `GET /api/attachments/limits`; the CLI and the driver keep copies, pinned by a test.
 */

const BYTES_PER_KIB = 1024;
const KIB_PER_MIB = 1024;
const BYTES_PER_MIB = BYTES_PER_KIB * KIB_PER_MIB;
const MEGAPIXEL = 1_000_000;
const FILE_MIB = 20;
const REQUEST_MIB = 50;
const IMAGE_MEGAPIXELS = 64;

export const MAX_FILES_PER_REQUEST = 10;
export const MAX_FILE_BYTES = FILE_MIB * BYTES_PER_MIB;
export const MAX_REQUEST_BYTES = REQUEST_MIB * BYTES_PER_MIB;
/** The longest edge, and the whole area, an image may declare in its header. */
export const MAX_IMAGE_SIDE = 16_384;
export const MAX_IMAGE_PIXELS = IMAGE_MEGAPIXELS * MEGAPIXEL;

export type AttachmentKind = 'image' | 'document' | 'text';

export interface AttachmentFormat {
    mediaType: string;
    extensions: readonly string[];
    kind: AttachmentKind;
}

/** The eight accepted formats. The type is decided from the bytes, never from a declaration. */
export const ATTACHMENT_FORMATS: readonly AttachmentFormat[] = [
    { mediaType: 'image/png', extensions: ['.png'], kind: 'image' },
    { mediaType: 'image/jpeg', extensions: ['.jpg', '.jpeg'], kind: 'image' },
    { mediaType: 'image/webp', extensions: ['.webp'], kind: 'image' },
    { mediaType: 'application/pdf', extensions: ['.pdf'], kind: 'document' },
    {
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extensions: ['.docx'],
        kind: 'document',
    },
    { mediaType: 'text/plain', extensions: ['.txt'], kind: 'text' },
    { mediaType: 'text/markdown', extensions: ['.md'], kind: 'text' },
    { mediaType: 'text/csv', extensions: ['.csv'], kind: 'text' },
];

/** The lifecycle of an uploaded file: draft (`pending`, `ready`), then bound to a task, then removed. */
export type AttachmentState = 'pending' | 'ready' | 'bound' | 'deleting' | 'deleted';

export interface AttachmentMeta {
    id: string;
    name: string;
    mediaType: string;
    size: number;
    sha256: string;
    state: AttachmentState;
}

/** The body of `GET /api/attachments/limits`. */
export interface AttachmentLimits {
    maxFilesPerRequest: number;
    maxFileBytes: number;
    maxRequestBytes: number;
    maxImageSide: number;
    maxImagePixels: number;
    formats: readonly AttachmentFormat[];
}

/** The request header carrying the percent-encoded display name of an uploaded file. */
export const ATTACHMENT_NAME_HEADER = 'x-attachment-name';
