import { type ClipboardEvent, type DragEvent, useRef } from 'react';
import type { AttachmentLimits } from '@factory-ai/core';
import { Icon } from '../components/Icon.js';

/** The file input's `accept` for the board's formats, so the system dialog hides what would be refused. */
export const acceptOf = (limits: AttachmentLimits): string =>
    limits.formats.flatMap((format) => format.extensions).join(',');

/**
 * The attach control: a button anyone can reach by keyboard, driving a hidden multi-file input
 * that carries its own accessible name. Drop and paste are handled by the surface that owns the
 * text field; this is only the picker.
 */
export function AttachmentPicker({
    limits,
    onPick,
    disabled = false,
}: {
    limits: AttachmentLimits;
    onPick: (files: File[]) => void;
    disabled?: boolean;
}) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <button type="button" className="attachment-add" disabled={disabled} onClick={() => input.current?.click()}>
                <Icon name="plus" />
                Attach files
            </button>
            <input
                ref={input}
                type="file"
                hidden
                disabled={disabled}
                multiple
                accept={acceptOf(limits)}
                aria-label="Attach files"
                onChange={(e) => {
                    onPick(Array.from(e.target.files ?? []));
                    // The same file chosen twice in a row must still fire a change.
                    e.target.value = '';
                }}
            />
        </>
    );
}

/**
 * Drop and paste for a text surface. A drop of files adds them; a paste adds the files on the
 * clipboard (a screenshot) only when it carries no text, so pasting text still inserts text.
 * Nothing is wired while the board offers no attachments.
 */
export function attachmentHandlers(enabled: boolean, add: (files: File[]) => void) {
    if (!enabled) return {};
    return {
        onDragOver: (e: DragEvent<HTMLElement>) => {
            if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        },
        onDrop: (e: DragEvent<HTMLElement>) => {
            const files = Array.from(e.dataTransfer.files);
            if (files.length === 0) return;
            e.preventDefault();
            add(files);
        },
        onPaste: (e: ClipboardEvent<HTMLElement>) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length === 0 || e.clipboardData.getData('text') !== '') return;
            e.preventDefault();
            add(files);
        },
    };
}
