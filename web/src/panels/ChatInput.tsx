import type { ChangeEvent, ReactNode, TextareaHTMLAttributes } from 'react';
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
 * above, then a one-line bordered field that grows with its text, with the paperclip and the round
 * send arrow inside its frame; caller controls and the status sit in a row below. The visible label
 * is hidden; the field keeps it as its name. Drop is the surrounding `AttachmentDropZone`'s.
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
            {controls === undefined && status === undefined ? null : (
                <div className="chat-input-bar">
                    <div className="chat-input-controls">{controls}</div>
                    <div className="chat-input-end">{status}</div>
                </div>
            )}
        </div>
    );
}
