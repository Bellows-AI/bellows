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
}: {
    attachments: readonly DraftAttachment[];
    onRemove: (localId: string) => void;
    onRetry: (localId: string) => void;
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
                            aria-label={`Retry ${item.file.name}`}
                            onClick={() => onRetry(item.localId)}
                        >
                            Retry
                        </button>
                    ) : null}
                    <button
                        type="button"
                        className="attachment-action"
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
