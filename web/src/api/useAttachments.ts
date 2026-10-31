import { useEffect, useState } from 'react';
import {
    ATTACHMENT_NAME_HEADER,
    CONTENT_TYPE_HEADER,
    type AttachmentLimits,
    type AttachmentMeta,
    OCTET_STREAM_CONTENT_TYPE,
} from '@factory-ai/core';
import type { DraftAttachment, FileDraft } from '../composer-draft.js';
import { refusalOf } from './refusal.js';
import { newIdempotencyKey } from './useBatches.js';
import { sizeLabel } from '../panels/AttachmentList.js';
import { HTTP_STATUS_UNAUTHORIZED, reportUnauthenticated } from './useSession.js';

const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export type UploadResult = { ok: true; meta: AttachmentMeta } | { ok: false; error: string };

/** Uploads one file as a raw body; the display name rides percent-encoded in a header. */
export async function uploadAttachment(file: File, uploadKey: string): Promise<UploadResult> {
    try {
        const response = await fetch('/api/attachments', {
            method: 'POST',
            headers: {
                [CONTENT_TYPE_HEADER]: OCTET_STREAM_CONTENT_TYPE,
                [ATTACHMENT_NAME_HEADER]: encodeURIComponent(file.name),
                [IDEMPOTENCY_KEY_HEADER]: uploadKey,
            },
            body: file,
        });
        if (response.status === HTTP_STATUS_UNAUTHORIZED) {
            reportUnauthenticated();
            return { ok: false, error: 'Your session expired' };
        }
        if (!response.ok) return { ok: false, error: (await refusalOf(response, 'Could not upload the file')).error };
        return { ok: true, meta: (await response.json()) as AttachmentMeta };
    } catch (e) {
        return { ok: false, error: (e as Error).message };
    }
}

/** Best effort: a draft the board keeps is swept by its TTL, so a failed delete is not worth a message. */
function deleteUploaded(id: string): void {
    void fetch(`/api/attachments/${id}`, { method: 'DELETE' }).catch(() => undefined);
}

/** The board's limits, read once per mount. Null while unread, and for good when the board has no storage. */
export function useAttachmentLimits(): AttachmentLimits | null {
    const [limits, setLimits] = useState<AttachmentLimits | null>(null);
    useEffect(() => {
        let live = true;
        void fetch('/api/attachments/limits')
            .then(async (response) => (response.ok ? ((await response.json()) as AttachmentLimits) : null))
            .catch(() => null)
            .then((read) => {
                if (live) setLimits(read);
            });
        return () => {
            live = false;
        };
    }, []);
    return limits;
}

/** Where a composer's files live: the shell's store, one draft's worth. */
export interface FileBinding {
    draft: FileDraft;
    update(update: (files: FileDraft) => FileDraft): void;
}

export type FilesBlocker = 'uploading' | 'failed';

export interface Attachments {
    attachments: readonly DraftAttachment[];
    /** Why the draft cannot be submitted: a file still going up, or one that failed. */
    blocker: FilesBlocker | null;
    add(files: readonly File[]): void;
    remove(localId: string): void;
    retry(localId: string): void;
    /** The completed files' ids, in the order they were chosen. */
    readyIds(): string[];
    /** The key of this submission: minted on the first attempt, kept for every retry of it. */
    submissionKey(): string;
}

const IMAGE_PREFIX = 'image/';

/** A new chip: uploading, or failed up front with the reason the limits gave. */
function chipFor(file: File, why: string | null): DraftAttachment {
    return {
        localId: newIdempotencyKey(),
        file,
        objectUrl: file.type.startsWith(IMAGE_PREFIX) ? URL.createObjectURL(file) : null,
        uploadKey: newIdempotencyKey(),
        ...(why === null ? { status: 'uploading' } : { status: 'failed', error: why }),
    };
}

/** Why `file` cannot join `others` under the board's limits, or null. Failed chips are not part of the set. */
function refusal(file: File, others: readonly DraftAttachment[], limits: AttachmentLimits | null): string | null {
    if (limits === null) return null;
    const kept = others.filter((a) => a.status !== 'failed');
    if (file.size > limits.maxFileBytes) return `Larger than the ${sizeLabel(limits.maxFileBytes)} limit per file`;
    if (kept.length >= limits.maxFilesPerRequest) return `At most ${limits.maxFilesPerRequest} files per request`;
    const total = kept.reduce((sum, a) => sum + a.file.size, 0) + file.size;
    if (total > limits.maxRequestBytes) return `Over the ${sizeLabel(limits.maxRequestBytes)} limit for all files`;
    return null;
}

/**
 * `limits` is checked against the accumulated selection; `locked` freezes every mutation while a
 * submission is in flight, so nothing added then can be wiped by the success clear unsent.
 */
export function useAttachments(binding: FileBinding, limits: AttachmentLimits | null, locked: boolean): Attachments {
    const { draft, update } = binding;
    const patch = (localId: string, change: Partial<DraftAttachment>) =>
        update((files) => ({
            ...files,
            attachments: files.attachments.map((a) => (a.localId === localId ? { ...a, ...change } : a)),
        }));
    const upload = async (item: DraftAttachment) => {
        const result = await uploadAttachment(item.file, item.uploadKey);
        // The chip may have been removed, or its draft cleared or handed to another owner, while
        // the bytes were going up: the board then holds a file nothing will ever bind.
        let present = false;
        update((files) => {
            present = files.attachments.some((a) => a.localId === item.localId);
            return {
                ...files,
                attachments: files.attachments.map((a) =>
                    a.localId === item.localId
                        ? result.ok
                            ? { ...a, status: 'done', meta: result.meta }
                            : { ...a, status: 'failed', error: result.error }
                        : a
                ),
            };
        });
        if (result.ok && !present) deleteUploaded(result.meta.id);
    };
    return {
        attachments: draft.attachments,
        blocker: draft.attachments.some((a) => a.status === 'uploading')
            ? 'uploading'
            : draft.attachments.some((a) => a.status === 'failed')
              ? 'failed'
              : null,
        add(files) {
            if (locked || files.length === 0) return;
            const added: DraftAttachment[] = [];
            for (const file of files)
                added.push(chipFor(file, refusal(file, [...draft.attachments, ...added], limits)));
            // The set changed, so a failed submission's key no longer names this request.
            update((held) => ({ attachments: [...held.attachments, ...added], submissionKey: null }));
            for (const item of added) if (item.status === 'uploading') void upload(item);
        },
        remove(localId) {
            const gone = draft.attachments.find((a) => a.localId === localId);
            if (locked || gone === undefined) return;
            if (gone.objectUrl !== null) URL.revokeObjectURL(gone.objectUrl);
            if (gone.meta !== undefined) deleteUploaded(gone.meta.id);
            update((held) => ({
                attachments: held.attachments.filter((a) => a.localId !== localId),
                submissionKey: null,
            }));
        },
        retry(localId) {
            const item = draft.attachments.find((a) => a.localId === localId);
            if (locked || item === undefined || item.status !== 'failed') return;
            const others = draft.attachments.filter((a) => a.localId !== localId);
            const why = refusal(item.file, others, limits);
            if (why !== null) return patch(localId, { error: why });
            patch(localId, { status: 'uploading', error: undefined });
            void upload(item);
        },
        readyIds: () =>
            draft.attachments.flatMap((a) => (a.meta !== undefined && a.status === 'done' ? [a.meta.id] : [])),
        submissionKey() {
            if (draft.submissionKey !== null) return draft.submissionKey;
            const minted = newIdempotencyKey();
            update((held) => ({ ...held, submissionKey: held.submissionKey ?? minted }));
            return minted;
        },
    };
}
