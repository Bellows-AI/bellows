import { useState } from 'react';
import type { AttachmentMeta } from '@factory-ai/core';
import { Icon } from '../components/Icon.js';
import type { DraftAttachment } from '../composer-draft.js';

const KIB = 1024;
const MIB = KIB * KIB;

export function sizeLabel(bytes: number): string {
    if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MB`;
    if (bytes >= KIB) return `${Math.round(bytes / KIB)} KB`;
    return `${bytes} B`;
}

const STATE_LABEL: Record<DraftAttachment['status'], string> = {
    uploading: 'Uploading…',
    done: 'Ready',
    failed: 'Failed',
};

/**
 * The chosen files of a draft, one chip each: thumbnail or glyph, name, type and size, the
 * upload's state, and Remove (and Retry once it failed). The server's refusal sits on the chip
 * it refused, so the other files stay as they were.
 */
export function AttachmentChips({
    attachments,
    onRemove,
    onRetry,
    locked = false,
}: {
    attachments: readonly DraftAttachment[];
    onRemove: (localId: string) => void;
    onRetry: (localId: string) => void;
    /** A submission is in flight: the set is frozen. */
    locked?: boolean;
}) {
    if (attachments.length === 0) return null;
    return (
        <ul className="attachment-list" aria-label="Attached files">
            {attachments.map((item) => (
                <li key={item.localId} className="attachment-chip" data-status={item.status}>
                    {item.objectUrl === null ? (
                        <Icon name="file" size={24} />
                    ) : (
                        <img className="attachment-thumb" src={item.objectUrl} alt="" />
                    )}
                    <span className="attachment-body">
                        <span className="attachment-name">{item.file.name}</span>
                        <span className="attachment-meta">
                            {(item.meta?.mediaType ?? item.file.type) || 'file'} · {sizeLabel(item.file.size)}
                        </span>
                        <span className="attachment-state" role={item.status === 'failed' ? 'alert' : undefined}>
                            {item.status === 'failed'
                                ? `${STATE_LABEL.failed}: ${item.error ?? 'upload failed'}`
                                : STATE_LABEL[item.status]}
                        </span>
                    </span>
                    {item.status === 'failed' ? (
                        <button
                            type="button"
                            className="attachment-action"
                            disabled={locked}
                            aria-label={`Retry ${item.file.name}`}
                            onClick={() => onRetry(item.localId)}
                        >
                            Retry
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="attachment-action"
                        disabled={locked}
                        aria-label={`Remove ${item.file.name}`}
                        onClick={() => onRemove(item.localId)}
                    >
                        <Icon name="x" />
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** The image types the content route may serve inline: the preview reads the original, there is no thumbnail route. */
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/webp']);

const contentUrl = (id: string) => `/api/attachments/${id}/content`;

/**
 * One file of a recorded request. The same-origin session cookie authenticates the preview and the
 * download. An image shows from the original; when that read is refused or fails, the row says so
 * instead of a broken image. The download link keeps the server's attachment disposition.
 */
function HistoryFile({ file }: { file: AttachmentMeta }) {
    const [broken, setBroken] = useState(false);
    const removed = file.state === 'deleting' || file.state === 'deleted';
    const image = PREVIEWABLE.has(file.mediaType);
    return (
        <li className="attachment-chip">
            {image && !broken && !removed ? (
                <img
                    className="attachment-preview"
                    src={`${contentUrl(file.id)}?disposition=inline`}
                    alt={file.name}
                    onError={() => setBroken(true)}
                />
            ) : (
                <Icon name="file" size={24} />
            )}
            <span className="attachment-body">
                <span className="attachment-name">{file.name}</span>
                <span className="attachment-meta">
                    {file.mediaType} · {sizeLabel(file.size)}
                </span>
                {removed ? <span className="attachment-state">File removed</span> : null}
                {image && broken && !removed ? (
                    <span className="attachment-state" role="status">
                        Preview unavailable
                    </span>
                ) : null}
            </span>
            {removed ? null : (
                <a
                    className="attachment-action"
                    href={contentUrl(file.id)}
                    download={file.name}
                    aria-label={`Download ${file.name}`}
                >
                    Download
                </a>
            )}
        </li>
    );
}

/** The files a recorded request carried, in the order named. */
export function AttachmentHistory({ attachments }: { attachments: readonly AttachmentMeta[] }) {
    if (attachments.length === 0) return null;
    return (
        <ul className="attachment-list" aria-label="Files on this request">
            {attachments.map((file) => (
                <HistoryFile key={file.id} file={file} />
            ))}
        </ul>
    );
}
