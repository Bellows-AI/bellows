import type { ChangeEvent, KeyboardEvent, ReactNode, TextareaHTMLAttributes } from 'react';
import type { AttachmentLimits } from '@factory-ai/core';
import { Icon } from '../components/Icon.js';
import type { DraftAttachment } from '../composer-draft.js';
import { AttachmentChips } from './AttachmentList.js';
import { AttachmentPicker } from './AttachmentPicker.js';

/** The draft's files as the input shows and changes them (the `useAttachments` surface). */
export interface ChatInputFiles {
    attachments: readonly DraftAttachment[];
    add: (files: File[]) => void;
    remove: (localId: string) => void;
    retry: (localId: string) => void;
}

/** The compact shell's breakpoint (`styles/regions/composer.css`): the arrow shows, and return is a new line. */
const COMPACT_QUERY = '(max-width: 900px)';

/**
 * Whether a keystroke is the desktop send: a plain Enter, outside an IME composition, that no
 * earlier handler took (the slash menu's pick), on a screen wider than the compact shell. On the
 * compact shell return is a new line and the arrow sends; Ctrl/⌘+Enter stays each caller's own.
 */
export function isEnterSend(e: KeyboardEvent<HTMLTextAreaElement>, compact: boolean): boolean {
    return (
        e.key === 'Enter' &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.nativeEvent.isComposing &&
        !e.defaultPrevented &&
        !compact
    );
}

const isCompact = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia(COMPACT_QUERY).matches;

/** The round arrow: its accessible name, whether it can fire, and what it does. */
export interface ChatInputSend {
    label: string;
    disabled: boolean;
    busy?: boolean;
    describedBy?: string | undefined;
    onSend: () => void;
}

/**
 * The one chat input, shared by the new-task page and the task's follow-up: the draft's files
 * above, then one rounded card holding a field that grows with its text, the paperclip and the round
 * arrow; caller controls and the status sit in a row below. On a desktop screen Enter sends and
 * Shift+Enter is a new line, through the same `onSend` the arrow calls; on the compact shell
 * return is a new line and the arrow sends. The field is described by
 * whatever describes the arrow, so the reason it cannot send is read on the field too. The
 * visible label is hidden; the field keeps it as its name. Drop is the surrounding
 * `AttachmentDropZone`'s.
 */
export function ChatInput({
    id,
    label,
    placeholder,
    value,
    readOnly,
    onChange,
    fieldProps,
    files,
    limits,
    controls,
    children,
    send,
    status,
}: {
    id: string;
    label: string;
    /** Absent: an empty field, named by its hidden label alone. */
    placeholder?: string;
    value: string;
    readOnly: boolean;
    onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void;
    /** Extra field wiring: paste, keyboard, slash menu, aria. */
    fieldProps?: TextareaHTMLAttributes<HTMLTextAreaElement>;
    files: ChatInputFiles;
    /** Null while the board offers no attachments: no paperclip. */
    limits: AttachmentLimits | null;
    /** Caller controls beside the paperclip (the new task's chips). */
    controls?: ReactNode;
    /** Rendered under the field, above the row (slash menu, length counter). */
    children?: ReactNode;
    send: ChatInputSend;
    /** Rendered beside the arrow (a live region saying why it is dark). */
    status?: ReactNode;
}) {
    const describedBy =
        [fieldProps?.['aria-describedby'], send.describedBy].filter((id) => id !== undefined && id !== '').join(' ') ||
        undefined;
    const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
        fieldProps?.onKeyDown?.(e);
        if (!isEnterSend(e, isCompact())) return;
        e.preventDefault();
        send.onSend();
    };
    return (
        <div className="chat-input">
            <AttachmentChips
                attachments={files.attachments}
                onRemove={files.remove}
                onRetry={files.retry}
                locked={readOnly}
            />
            <label htmlFor={id} className="composer-visually-hidden">
                {label}
            </label>
            <div className="chat-input-box">
                {limits === null ? null : <AttachmentPicker limits={limits} onPick={files.add} disabled={readOnly} />}
                <textarea
                    id={id}
                    className="field chat-input-field"
                    rows={1}
                    placeholder={placeholder}
                    value={value}
                    readOnly={readOnly}
                    {...fieldProps}
                    aria-describedby={describedBy}
                    onKeyDown={onKeyDown}
                    onChange={onChange}
                />
                <button
                    type="button"
                    className="primary chat-input-send"
                    disabled={send.disabled}
                    aria-busy={send.busy || undefined}
                    aria-describedby={send.describedBy}
                    aria-label={send.label}
                    onClick={send.onSend}
                >
                    <Icon name="arrow-up" />
                </button>
            </div>
            {children}
            <div className="chat-input-bar">
                <div className="chat-input-controls">{controls}</div>
                <div className="chat-input-end">{status}</div>
            </div>
        </div>
    );
}
