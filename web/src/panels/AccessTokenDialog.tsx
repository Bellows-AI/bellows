import { useEffect, useId, useRef, useState } from 'react';
import { Dialog, DialogPanel, DialogTitle } from '@headlessui/react';
import type { MintResult } from '../api/useAccessTokens.js';

/** The printed-once warning, as the panel has always worded it. */
const SHOWN_ONCE =
    'Shown once — copy it now. Only its hash is stored, and it cannot be read again; a lost token is revoked and reissued.';

/**
 * Create an access token in two steps inside one dialog: a label, then the printed-once moment.
 * Step 1 closes on Cancel, Escape and a backdrop click (never mid-request); step 2 closes only
 * through Done, so a stray click or keypress cannot lose the plaintext. Headless UI owns the focus
 * trap and Escape; no `<form>` because the CSP sends `form-action 'none'`. A refusal stays inline
 * under the field with the dialog open. The plaintext lives in this component's state only until
 * Done.
 */
export function AccessTokenDialog({
    open,
    scope,
    purpose,
    onCreate,
    onCancel,
    onDone,
}: {
    open: boolean;
    scope: 'personal' | 'org';
    /** The scope's one-sentence purpose, shown under the title. */
    purpose: string;
    onCreate: (label: string) => Promise<MintResult>;
    onCancel: () => void;
    onDone: () => void;
}) {
    const [label, setLabel] = useState('');
    const [minted, setMinted] = useState<{ label: string; token: string } | null>(null);
    const [copied, setCopied] = useState(false);
    const [failure, setFailure] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const ids = useId();
    const inputRef = useRef<HTMLInputElement>(null);
    const copyRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        if (!open) return;
        setLabel('');
        setMinted(null);
        setCopied(false);
        setFailure(null);
    }, [open]);

    // A refusal returns focus to the field once it is enabled again; the printed token puts it on Copy.
    useEffect(() => {
        if (minted !== null) copyRef.current?.focus();
        else if (failure !== null && !busy) inputRef.current?.focus();
    }, [minted, failure, busy]);

    const submit = async () => {
        if (busy || label.trim() === '') return;
        setBusy(true);
        setFailure(null);
        try {
            const result = await onCreate(label.trim());
            if (result.ok) setMinted({ label: label.trim(), token: result.token });
            else setFailure(result.error);
        } finally {
            setBusy(false);
        }
    };

    const copy = async () => {
        if (minted === null) return;
        try {
            await navigator.clipboard.writeText(minted.token);
            setCopied(true);
        } catch {
            // Clipboard access can be refused; the token stays on screen to copy by hand.
            setCopied(false);
        }
    };

    const dismiss = () => {
        if (minted === null && !busy) onCancel();
    };
    const kind = scope === 'org' ? 'organization' : 'personal';

    return (
        <Dialog
            open={open}
            onClose={dismiss}
            className="dialog-layer"
            aria-labelledby={`${ids}-title`}
            aria-describedby={`${ids}-sub`}
            initialFocus={inputRef}
        >
            <div className="dialog-backdrop" aria-hidden="true" />
            <div className="dialog-position">
                <DialogPanel className="dialog token-modal">
                    {minted === null ? (
                        <>
                            <DialogTitle as="h2" id={`${ids}-title`}>
                                New {kind} access token
                            </DialogTitle>
                            <p className="picker-help" id={`${ids}-sub`}>
                                {purpose}
                            </p>
                            <div className="picker-field">
                                <label htmlFor={`${ids}-label`}>Label</label>
                                <input
                                    ref={inputRef}
                                    id={`${ids}-label`}
                                    placeholder="what this token is for"
                                    value={label}
                                    disabled={busy}
                                    aria-describedby={`${ids}-hint`}
                                    aria-invalid={failure !== null}
                                    onChange={(e) => setLabel(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') void submit();
                                    }}
                                />
                                <p className="picker-help" id={`${ids}-hint`}>
                                    Shown in the list so you know what to revoke later.
                                </p>
                                {failure ? (
                                    <p className="status" role="alert">
                                        {failure}
                                    </p>
                                ) : null}
                            </div>
                            {/* type="button" throughout: a submitting form would be blocked by form-action 'none'. */}
                            <div className="picker-actions">
                                <button type="button" onClick={onCancel} disabled={busy}>
                                    Cancel
                                </button>
                                <button
                                    type="button"
                                    className="primary"
                                    disabled={busy || label.trim() === ''}
                                    onClick={() => void submit()}
                                >
                                    {busy ? 'Creating…' : 'Create token'}
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <DialogTitle as="h2" id={`${ids}-title`}>
                                Token created: {minted.label}
                            </DialogTitle>
                            <p className="picker-help" id={`${ids}-sub`}>
                                Use it in an <code>Authorization: Bearer</code> header.
                            </p>
                            <p className="banner-warn token-once" role="status">
                                {SHOWN_ONCE}
                            </p>
                            <div className="token-copy-row">
                                <code className="mono token-well">{minted.token}</code>
                                <button
                                    ref={copyRef}
                                    type="button"
                                    className={copied ? 'token-copied' : undefined}
                                    onClick={() => void copy()}
                                >
                                    {copied ? 'Copied' : 'Copy'}
                                </button>
                            </div>
                            <div className="picker-actions">
                                <button type="button" className="primary" onClick={onDone}>
                                    Done
                                </button>
                            </div>
                        </>
                    )}
                </DialogPanel>
            </div>
        </Dialog>
    );
}
