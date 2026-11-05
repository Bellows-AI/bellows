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

/** The upload's state, said to screen readers only: the square itself shows it. */
function stateText(item: DraftAttachment): string {
    if (item.status === 'failed') return `Failed: ${item.error ?? 'upload failed'}`;
    return item.status === 'uploading' ? 'Uploading…' : 'Ready';
}

/**
 * The chosen files of a draft, one square tile each in a wrapping row: a spinner while the file
 * uploads, then its thumbnail or a file glyph; a failed upload fills the square with a warning
 * that retries on click. The name (and any refusal) is the tooltip and screen-reader text;
 * Remove sits in the corner.
 * The server's refusal sits on the tile it refused, so the other files stay as they were.
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
                <li
                    key={item.localId}
                    className="attachment-tile"
                    data-status={item.status}
                    data-kind={item.objectUrl === null ? 'file' : 'image'}
                    title={item.status === 'failed' ? `${item.file.name} · ${stateText(item)}` : item.file.name}
                >
                    <span className="attachment-media">
                        {item.status === 'uploading' ? (
                            <span className="attachment-spinner" aria-hidden="true" />
                        ) : item.status === 'failed' ? (
                            <button
                                type="button"
                                className="attachment-retry"
                                disabled={locked}
                                aria-label={`Retry ${item.file.name}`}
                                onClick={() => onRetry(item.localId)}
                            >
                                <Icon name="alert-triangle" size={22} />
                            </button>
                        ) : item.objectUrl === null ? (
                            <Icon name="file" size={24} />
                        ) : (
                            <img className="attachment-thumb" src={item.objectUrl} alt="" />
                        )}
                    </span>
                    {/* Name and state are not drawn (the tooltip and the square carry them) but a
                        screen reader still hears both. */}
                    <span className="composer-visually-hidden">{item.file.name}</span>
                    <span className="composer-visually-hidden" role={item.status === 'failed' ? 'alert' : undefined}>
                        {stateText(item)}
                    </span>
                    <button
                        type="button"
                        className="attachment-action attachment-remove"
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
    const showImage = image && !broken && !removed;
    return (
        <li
            className="attachment-chip"
            data-kind={showImage ? 'image' : 'file'}
            title={`${file.name} · ${file.mediaType}`}
        >
            <span className="attachment-media">
                {showImage ? (
                    <img
                        className="attachment-preview"
                        src={`${contentUrl(file.id)}?disposition=inline`}
                        alt={file.name}
                        onError={() => setBroken(true)}
                    />
                ) : (
                    <Icon name="file" size={24} />
                )}
            </span>
            <span className="attachment-body">
                <span className="attachment-name">{file.name}</span>
                <span className="attachment-meta">{sizeLabel(file.size)}</span>
                {removed ? <span className="attachment-state">File removed</span> : null}
                {image && broken && !removed ? (
                    <span className="attachment-state" role="status">
                        Preview unavailable
                    </span>
                ) : null}
            </span>
            {removed ? null : (
                <a
                    className="attachment-action attachment-download"
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
        <ul className="attachment-list attachment-list-history" aria-label="Files on this request">
            {attachments.map((file) => (
                <HistoryFile key={file.id} file={file} />
            ))}
        </ul>
    );
}
