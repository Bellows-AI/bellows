import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { useLocation } from 'react-router-dom';
import { uploadByCapability, type UploadedAttachment, type UploadOutcome } from '../api/uploadByCapability.js';
import { PublicPageHeader } from '../components/PublicPageHeader.js';
import { StateNote } from '../components/StateNote.js';
import { ThemeSelector } from '../components/ThemeSelector.js';
import { PRODUCT_NAME } from '../brand.js';
import { AttachmentDropZone, useFileDropGuard } from '../panels/AttachmentDropZone.js';
import { sizeLabel } from '../panels/AttachmentList.js';

const CAPABILITY_PREFIX = 'fcu_';

/** The single-use link the agent's tool handed out rides in the fragment, so no server or Referer ever sees it. */
function capabilityOf(hash: string): string | null {
    const value = hash.replace(/^#/, '');
    return value.startsWith(CAPABILITY_PREFIX) ? value : null;
}

type Phase =
    | { kind: 'choose'; notice: string | null }
    | { kind: 'uploading'; file: File; sent: number }
    | { kind: 'retry'; file: File; message: string }
    | { kind: 'done'; attachment: UploadedAttachment }
    | { kind: 'final'; message: string };

/**
 * One shell for every phase, so the polite live region below stays mounted and a screen reader hears each change.
 * The heading takes focus when the phase changes: the control that held it has gone.
 */
function UploadShell({
    children,
    announce = '',
    headingRef,
}: {
    children: ReactNode;
    announce?: string;
    headingRef?: Ref<HTMLHeadingElement>;
}) {
    return (
        <>
            <PublicPageHeader context="Upload a file" actions={<ThemeSelector />} />
            <main className="onboarding">
                <h1 ref={headingRef ?? null} tabIndex={-1}>
                    Upload a file to {PRODUCT_NAME}
                </h1>
                <div className="visually-hidden" role="status" aria-live="polite">
                    {announce}
                </div>
                {children}
            </main>
        </>
    );
}

/**
 * The page an MCP client opens to hand a file to the board (docs/mcp.md). It works signed out: the
 * single-use link in the fragment is the credential, sent only as the PUT path. One file per link, so after a
 * success there is nothing left to do here but return to the app.
 */
export function AttachmentUploadPage() {
    const { hash } = useLocation();
    // Read once: the fragment is dropped below, and a later render must not lose the link with it.
    const [capability] = useState(() => capabilityOf(hash));
    const [phase, setPhase] = useState<Phase>({ kind: 'choose', notice: null });
    const input = useRef<HTMLInputElement>(null);
    const heading = useRef<HTMLHeadingElement>(null);
    const shownPhase = useRef(phase.kind);
    useFileDropGuard();

    // Only when the phase actually changed: a StrictMode remount re-runs this effect with the phase unchanged.
    useEffect(() => {
        if (shownPhase.current === phase.kind) return;
        shownPhase.current = phase.kind;
        heading.current?.focus();
    }, [phase.kind]);

    // The link lives only in this page: once read, the address bar, history and any referrer lose it.
    useEffect(() => {
        if (hash !== '') {
            window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
        }
        // Once, on mount: the capability was already taken from `hash` above.
    }, []);

    if (capability === null) {
        return (
            <UploadShell headingRef={heading}>
                <StateNote state="error">
                    This upload link is incomplete. Ask your app for a new link and open it as given.
                </StateNote>
            </UploadShell>
        );
    }

    const send = async (file: File) => {
        setPhase({ kind: 'uploading', file, sent: 0 });
        const outcome: UploadOutcome = await uploadByCapability(capability, file, (sent) =>
            setPhase({ kind: 'uploading', file, sent })
        );
        if (outcome.ok) setPhase({ kind: 'done', attachment: outcome.attachment });
        else if (outcome.next === 'retry') setPhase({ kind: 'retry', file, message: outcome.message });
        else if (outcome.next === 'pick') setPhase({ kind: 'choose', notice: outcome.message });
        else setPhase({ kind: 'final', message: outcome.message });
    };

    const take = (files: File[]) => {
        const [first] = files;
        if (files.length > 1) setPhase({ kind: 'choose', notice: 'This link takes one file. Choose a single file.' });
        else if (first) void send(first);
    };

    if (phase.kind === 'done') {
        return (
            <UploadShell
                headingRef={heading}
                announce={`${phase.attachment.name || 'Your file'} was uploaded. Attachment id ${phase.attachment.id}.`}
            >
                <p>
                    <strong>{phase.attachment.name || 'Your file'}</strong> was uploaded
                    {phase.attachment.size > 0 ? ` (${sizeLabel(phase.attachment.size)})` : ''}.
                </p>
                <p>
                    Attachment id: <code>{phase.attachment.id}</code>
                </p>
                <p>You can close this tab and return to your app. It can now use the file.</p>
            </UploadShell>
        );
    }
    if (phase.kind === 'final') {
        return (
            <UploadShell headingRef={heading}>
                <StateNote state="error">{phase.message}</StateNote>
            </UploadShell>
        );
    }
    if (phase.kind === 'uploading') {
        return (
            <UploadShell headingRef={heading} announce={`Uploading ${phase.file.name}`}>
                <p>
                    Uploading <strong>{phase.file.name}</strong> ({sizeLabel(phase.file.size)})…
                </p>
                <progress aria-label="Upload progress" max={phase.file.size || 1} value={phase.sent} />
            </UploadShell>
        );
    }
    if (phase.kind === 'retry') {
        const file = phase.file;
        return (
            <UploadShell headingRef={heading}>
                <StateNote state="error">{phase.message}</StateNote>
                <p>
                    <strong>{file.name}</strong> ({sizeLabel(file.size)})
                </p>
                <div className="onboarding-actions">
                    <button type="button" onClick={() => void send(file)}>
                        Try again
                    </button>
                    <button type="button" onClick={() => setPhase({ kind: 'choose', notice: null })}>
                        Choose a different file
                    </button>
                </div>
            </UploadShell>
        );
    }
    return (
        <UploadShell headingRef={heading}>
            <p className="onboarding-purpose">
                Your app asked for a file. Choose one to hand it over. This link takes one file, once, and expires soon.
            </p>
            {phase.notice ? <StateNote state="error">{phase.notice}</StateNote> : null}
            <AttachmentDropZone className="upload-zone" accepts={() => true} onFiles={take}>
                <p>Drag a file here, or</p>
                <input
                    ref={input}
                    type="file"
                    hidden
                    data-testid="upload-input"
                    onChange={(e) => {
                        take(Array.from(e.target.files ?? []));
                        e.target.value = '';
                    }}
                />
                <button type="button" onClick={() => input.current?.click()}>
                    Choose a file
                </button>
            </AttachmentDropZone>
        </UploadShell>
    );
}
